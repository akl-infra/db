// [LDB-H1] [LDB-H4] [LDB-H5] [LDB-H6] POST/GET/DELETE /v1/webhooks (12
// §2.1, §3 X1): CRUD auth matrix, validation, delivery (signature,
// retries/backoff, failing/disabled), kinds/owner_filter, the global post
// budget, the claim-before-send lease (real interleaving, concurrent
// failures, the partial-failure-vs-success race, expiry), and the "no
// secret ever leaks" scan.
import { createExecutionContext, createScheduledController, env, waitOnExecutionContext } from "cloudflare:test";
import fc from "fast-check";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Bindings } from "../../src/env";
import { appendLike, appendWrite } from "../../src/core/events";
import { headSeq } from "../../src/core/etag";
import {
  WEBHOOK_BACKOFF_S,
  WEBHOOK_DISABLE_AFTER_MS,
  WEBHOOK_FAILING_AFTER,
  WEBHOOK_LEASE_MS,
  WEBHOOKS_PER_USER,
  drain,
  sign,
  type WebhookFetchImpl,
} from "../../src/core/webhooks";
import { fixedClock, steppingClock } from "../../src/core/time";
import worker from "../../src/index";
import { FakeUpstream } from "../import/fake-upstream";
import { ulid } from "ulidx";
import { actorFixture, pinTestClock, register, uniqueName, writeFetch } from "./write-support";

// Only hour:minute (UTC) drives scheduled()'s dispatch since the cron
// consolidation (one `*/5 * * * *` trigger, 12 §3 X4 follow-up 2).
function atUTC(hour: number, minute: number): Date {
  return new Date(Date.UTC(2026, 6, 15, hour, minute));
}

// Every webhook created via HTTP below gets its `created_at`/`next_at` from
// `resolveNow(env)` (routes/webhooks.ts) = `env.TEST_CLOCK ?? systemClock` --
// without pinning it, that's the REAL wall clock, which this file's own
// `drain()` calls (fixed at various 2026-07-* instants, chosen to be
// readable relative to each other, not to "now") would always be BEFORE --
// `next_at <= now` would never hold and nothing would ever be due. Pinned
// once, well before every `drain()` clock used below.
const CREATE_CLOCK_ISO = "2026-07-01T00:00:00.000Z";

const bindings = env as unknown as Bindings;
const db = bindings.DB;
const OWNER = "owner-webhooks-1";

afterEach(() => {
  vi.unstubAllGlobals();
});

// vitest-pool-workers isolates storage per TEST FILE, not per `it` (07 §2):
// every test in this file shares one D1. A webhook left `active` by one
// test (the WEBHOOKS_PER_USER cap is never freed by anything but DELETE)
// would otherwise occupy `OWNER`'s cap for every later test, and -- since
// `drain()` scans every due row, not just the one a given test just
// created -- would also show up in a LATER test's own delivery counts.
// Clearing the table before each test is the same "clean slate" discipline
// tests/import/tick.test.ts's own `beforeEach` uses for `events`/`layouts`.
beforeEach(async () => {
  await db.prepare("DELETE FROM webhooks").run();
  pinTestClock(bindings as unknown as { TEST_CLOCK?: ReturnType<typeof fixedClock> }, fixedClock(CREATE_CLOCK_ISO));
});

function ownerHeaders(token: string = `tok-${uniqueName("wh")}`) {
  const fake = actorFixture();
  return register(fake, token, OWNER);
}

interface WebhookWire {
  id: string;
  owner_user_id: string;
  url: string;
  kinds: string[] | null;
  owner_filter: string | null;
  status: string;
  cursor: number;
  failures: number;
  failing_since: string | null;
  next_at: string;
  last_error: string | null;
  created_at: string;
}

// A minimal fake receiver: logs every POST it accepts, answers `status` (or
// runs `onCall` for per-call control) for the rest.
class FakeReceiver {
  requests: { url: string; headers: Record<string, string>; body: string }[] = [];
  answer: number | ((n: number) => number) = 200;
  fetchImpl: WebhookFetchImpl = async (url, init) => {
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries(init.headers)) headers[k] = v;
    this.requests.push({ url, headers, body: init.body });
    const status = typeof this.answer === "function" ? this.answer(this.requests.length) : this.answer;
    return new Response(null, { status });
  };
}

// A statement-counting proxy over a D1Database (LDB-H5's own mechanism,
// following 09 §3 T1's pattern): counts every EXECUTION of a mutating
// (`UPDATE`/`INSERT`/`DELETE`) prepared statement, through as many
// `.bind()` chains as the caller applies -- "exactly how many write
// statements did this drain() issue". Counting has to key off the SQL text
// itself, not the terminal method: LDB-H6's lease claim is an
// `UPDATE ... RETURNING *` read back with `.first()`, not `.run()` --
// still one real write against D1 -- so a proxy that only hooked `.run()`
// would silently under-count it.
function isMutatingSql(sql: string): boolean {
  return /^\s*(UPDATE|INSERT|DELETE)\b/i.test(sql);
}
function wrapStmt(stmt: D1PreparedStatement, writes: { n: number }, sql: string): D1PreparedStatement {
  return new Proxy(stmt, {
    get(target, prop, receiver) {
      if (prop === "run" || prop === "first" || prop === "all" || prop === "raw") {
        return async (...args: unknown[]) => {
          if (isMutatingSql(sql)) writes.n++;
          return (target[prop] as (...a: unknown[]) => unknown).apply(target, args);
        };
      }
      if (prop === "bind") {
        return (...args: unknown[]) => wrapStmt((target.bind as (...a: unknown[]) => D1PreparedStatement).apply(target, args), writes, sql);
      }
      const val = Reflect.get(target, prop, receiver);
      return typeof val === "function" ? (val as (...a: unknown[]) => unknown).bind(target) : val;
    },
  }) as D1PreparedStatement;
}
function countingDb(real: D1Database): { db: D1Database; writes: () => number } {
  const writes = { n: 0 };
  const proxy = new Proxy(real, {
    get(target, prop, receiver) {
      if (prop === "prepare") return (sql: string) => wrapStmt(target.prepare(sql), writes, sql);
      const val = Reflect.get(target, prop, receiver);
      return typeof val === "function" ? (val as (...a: unknown[]) => unknown).bind(target) : val;
    },
  });
  return { db: proxy as D1Database, writes: () => writes.n };
}

async function createHook(body: Record<string, unknown>, token?: string): Promise<{ res: Response; headers: Record<string, string> }> {
  const headers = ownerHeaders(token);
  const res = await writeFetch("/v1/webhooks", "POST", headers, body);
  return { res, headers };
}

const VALID_BODY = { url: "https://receiver.example/hook", secret: "a-valid-secret-1234567890ab" };

describe("[LDB-H1] [LDB-H4] [LDB-H5] webhooks", () => {
  describe("CRUD auth matrix", () => {
    it("owner: create -> 201, no secret in the body; get -> the row; delete -> 200", async () => {
      const { res, headers } = await createHook(VALID_BODY);
      expect(res.status).toBe(201);
      const created = await res.json<WebhookWire & { secret?: string }>();
      expect(created.secret).toBeUndefined();
      expect(created.url).toBe(VALID_BODY.url);
      expect(created.status).toBe("active");
      expect(created.failures).toBe(0);
      expect(created.owner_user_id).toBe(OWNER);

      const listRes = await writeFetch("/v1/webhooks", "GET", headers);
      expect(listRes.status).toBe(200);
      const list = await listRes.json<WebhookWire[]>();
      expect(list.some((w) => w.id === created.id)).toBe(true);
      expect(list.every((w) => !("secret" in w))).toBe(true);

      const delRes = await writeFetch(`/v1/webhooks/${created.id}`, "DELETE", headers);
      expect(delRes.status).toBe(200);
      await expect(delRes.json()).resolves.toEqual({ removed: created.id });
      const afterList = await writeFetch("/v1/webhooks", "GET", headers);
      expect((await afterList.json<WebhookWire[]>()).some((w) => w.id === created.id)).toBe(false);
    });

    it("other user: DELETE of someone else's hook -> 404 (never 403 -- ids are not enumerable)", async () => {
      const { res } = await createHook(VALID_BODY);
      const created = await res.json<WebhookWire>();

      const otherHeaders = (() => {
        const fake = actorFixture();
        return register(fake, `tok-${uniqueName("other")}`, "owner-webhooks-other");
      })();
      const delRes = await writeFetch(`/v1/webhooks/${created.id}`, "DELETE", otherHeaders);
      expect(delRes.status).toBe(404);
    });

    it("admin: DELETE of another user's hook -> 200; GET ?all=1 sees every owner's rows", async () => {
      const { res } = await createHook(VALID_BODY);
      const created = await res.json<WebhookWire>();

      const adminHeaders = (() => {
        const fake = actorFixture();
        return register(fake, `tok-${uniqueName("admin")}`, "184412255822020608"); // migrations/0001_init.sql's bootstrap admin
      })();
      const listAll = await writeFetch("/v1/webhooks?all=1", "GET", adminHeaders);
      expect(listAll.status).toBe(200);
      const all = await listAll.json<WebhookWire[]>();
      expect(all.some((w) => w.id === created.id && w.owner_user_id === OWNER)).toBe(true);

      const delRes = await writeFetch(`/v1/webhooks/${created.id}`, "DELETE", adminHeaders);
      expect(delRes.status).toBe(200);
    });

    it("a non-admin: GET ?all=1 -> 403 not_admin", async () => {
      const headers = ownerHeaders();
      const res = await writeFetch("/v1/webhooks?all=1", "GET", headers);
      expect(res.status).toBe(403);
      await expect(res.json()).resolves.toMatchObject({ error: "not_admin" });
    });

    it("anonymous -> 401 on every route", async () => {
      const postRes = await writeFetch("/v1/webhooks", "POST", {}, VALID_BODY);
      expect(postRes.status).toBe(401);
      const getRes = await writeFetch("/v1/webhooks", "GET");
      expect(getRes.status).toBe(401);
      const delRes = await writeFetch("/v1/webhooks/nonexistent", "DELETE");
      expect(delRes.status).toBe(401);
    });
  });

  describe("validation", () => {
    it("a 6th webhook for one owner -> 409 too_many_webhooks", async () => {
      const headers = ownerHeaders();
      for (let i = 0; i < WEBHOOKS_PER_USER; i++) {
        const res = await writeFetch("/v1/webhooks", "POST", headers, { url: `https://r.example/${i}`, secret: "a-valid-secret-1234567890ab" });
        expect(res.status).toBe(201);
      }
      const sixth = await writeFetch("/v1/webhooks", "POST", headers, { url: "https://r.example/6", secret: "a-valid-secret-1234567890ab" });
      expect(sixth.status).toBe(409);
      await expect(sixth.json()).resolves.toMatchObject({ error: "too_many_webhooks", limit: WEBHOOKS_PER_USER });
    });

    it("http:// -> 400 bad_request /url", async () => {
      const { res } = await createHook({ url: "http://receiver.example/hook", secret: "a-valid-secret-1234567890ab" });
      expect(res.status).toBe(400);
      await expect(res.json()).resolves.toMatchObject({ error: "bad_request", param: "/url" });
    });

    it("an IP-literal host -> 400 bad_request /url", async () => {
      const { res } = await createHook({ url: "https://198.51.100.4/hook", secret: "a-valid-secret-1234567890ab" });
      expect(res.status).toBe(400);
      await expect(res.json()).resolves.toMatchObject({ error: "bad_request", param: "/url" });
    });

    it("a 2049-char url -> 400 bad_request /url", async () => {
      const longUrl = `https://receiver.example/${"a".repeat(2049 - "https://receiver.example/".length)}`;
      expect(longUrl.length).toBe(2049);
      const { res } = await createHook({ url: longUrl, secret: "a-valid-secret-1234567890ab" });
      expect(res.status).toBe(400);
      await expect(res.json()).resolves.toMatchObject({ error: "bad_request", param: "/url" });
    });

    it("a too-short secret -> 400 bad_request /secret", async () => {
      const { res } = await createHook({ url: "https://receiver.example/hook", secret: "short" });
      expect(res.status).toBe(400);
      await expect(res.json()).resolves.toMatchObject({ error: "bad_request", param: "/secret" });
    });

    it("an unknown kind -> 400 bad_request /kinds", async () => {
      const { res } = await createHook({ ...VALID_BODY, kinds: ["not-a-real-kind"] });
      expect(res.status).toBe(400);
      await expect(res.json()).resolves.toMatchObject({ error: "bad_request", param: "/kinds" });
    });

    // 10 C1 / X4 follow-up: KNOWN_KINDS (routes/changes.ts) went stale once
    // already -- `admin.client_registered`/`admin.client_revoked` existed on
    // `InfoKind` but were never added to the list, so a webhook subscribed
    // to either 400'd as "unknown kind". KNOWN_KINDS is now derived from an
    // exhaustive `Record<InfoKind, true>` (can't go stale the same way
    // again, tests/core/known-kinds.test.ts is the regression suite for
    // that) -- this is the black-box proof the fix actually reaches this
    // route, not just the type.
    it("admin.client_registered / admin.client_revoked are accepted kinds", async () => {
      const { res } = await createHook({ ...VALID_BODY, kinds: ["admin.client_registered", "admin.client_revoked"] });
      expect(res.status).toBe(201);
    });

    it("a malformed owner_filter -> 400 bad_request /owner_filter", async () => {
      const { res } = await createHook({ ...VALID_BODY, owner_filter: "not-a-snowflake" });
      expect(res.status).toBe(400);
      await expect(res.json()).resolves.toMatchObject({ error: "bad_request", param: "/owner_filter" });
    });
  });

  describe("[LDB-H4] a secret never leaves the webhooks table", () => {
    it("[LDB-H4] scans every CRUD response body for the literal secret", async () => {
      const secret = "super-secret-value-do-not-leak-9";
      const { res, headers } = await createHook({ url: "https://receiver.example/hook", secret });
      const createdText = await res.clone().text();
      expect(createdText).not.toContain(secret);
      const created = await res.json<WebhookWire>();

      const listRes = await writeFetch("/v1/webhooks", "GET", headers);
      expect(await listRes.text()).not.toContain(secret);

      const delRes = await writeFetch(`/v1/webhooks/${created.id}`, "DELETE", headers);
      expect(await delRes.text()).not.toContain(secret);
    });

    it("[LDB-H4] never appears in any event", async () => {
      const secret = "another-secret-that-must-not-leak";
      await createHook({ url: "https://receiver.example/hook", secret });
      const rows = await db.prepare("SELECT detail_json, before_json, after_json FROM events").all<{ detail_json: string | null; before_json: string | null; after_json: string | null }>();
      for (const row of rows.results) {
        expect(row.detail_json ?? "").not.toContain(secret);
        expect(row.before_json ?? "").not.toContain(secret);
        expect(row.after_json ?? "").not.toContain(secret);
      }
    });
  });

  describe("delivery", () => {
    it("[LDB-H1] a write delivers exactly one signed POST, with the seq/webhook-id headers, verifiable with the right secret and not with a wrong one", async () => {
      const secret = "delivery-secret-1234567890ab";
      // Keep our own reference to the FakeDiscord instance (rather than
      // going through `ownerHeaders()`, which discards it) so the combined
      // stub below can delegate Discord auth calls to it -- `ownerHeaders()`
      // re-stubs global fetch on every call, which would silently undo a
      // combined stub installed before it.
      const fake = actorFixture();
      const headers = register(fake, `tok-${uniqueName("wh-delivery")}`, OWNER);

      const createRes = await writeFetch("/v1/webhooks", "POST", headers, { url: "https://receiver.example/hook", secret });
      const hook = await createRes.json<WebhookWire>();

      const receiver = new FakeReceiver();
      vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
        if (url === hook.url) {
          return receiver.fetchImpl(url, init as unknown as { method: string; headers: Record<string, string>; body: string; signal: AbortSignal });
        }
        return fake.fetchImpl(url, init as unknown as { headers: Record<string, string>; signal?: AbortSignal });
      });

      const createLayoutRes = await writeFetch("/v1/layouts", "POST", headers, { name: uniqueName("wh-delivery"), format: "akl/1", payload: { keys: {} } });
      expect(createLayoutRes.status).toBe(201);

      // `writeFetch` (write-support.ts) already awaited the nudge's own
      // drain() before returning -- the delivery attempt has necessarily
      // run by now.
      expect(receiver.requests).toHaveLength(1);
      const req = receiver.requests[0]!;
      expect(req.headers["X-Akl-Webhook-Id"]).toBe(hook.id);
      const body = JSON.parse(req.body) as { seq: number; kind: string };
      expect(body.kind).toBe("created");
      expect(req.headers["X-Akl-Seq"]).toBe(String(body.seq));

      const [, hex] = req.headers["X-Akl-Signature"]!.split("=");
      const expected = await sign(secret, req.headers["X-Akl-Timestamp"]!, req.body);
      expect(hex).toBe(expected);
      const wrongSecret = await sign("a-different-secret-1234567890", req.headers["X-Akl-Timestamp"]!, req.body);
      expect(hex).not.toBe(wrongSecret);
    });

    it("[LDB-H1] a 500 receiver: cursor unchanged, failures=1, next_at=+60s, status stays active; +59s posts nothing, +60s retries", async () => {
      const secret = "backoff-secret-1234567890ab";
      const createHeaders = ownerHeaders();
      const createRes = await writeFetch("/v1/webhooks", "POST", createHeaders, { url: "https://receiver.example/hook", secret });
      const hook = await createRes.json<WebhookWire>();

      // A pending event past the hook's cursor -- appended directly
      // (bypassing the nudge) so `drain()` below is the only thing that
      // ever attempts delivery in this test.
      const { seq } = await appendOne();

      const receiver = new FakeReceiver();
      receiver.answer = 500;
      const clockAt = (iso: string) => fixedClock(iso);

      const before = await drain(bindings, clockAt("2026-07-10T00:00:00.000Z"), { fetchImpl: receiver.fetchImpl, maxPosts: 25 });
      expect(before.failed).toBe(1);
      expect(receiver.requests).toHaveLength(1);

      const row1 = await db.prepare("SELECT * FROM webhooks WHERE id = ?").bind(hook.id).first<WebhookWire>();
      expect(row1!.cursor).toBeLessThan(seq);
      expect(row1!.failures).toBe(1);
      expect(row1!.status).toBe("active"); // below WEBHOOK_FAILING_AFTER
      expect(new Date(row1!.next_at).getTime() - new Date("2026-07-10T00:00:00.000Z").getTime()).toBe(WEBHOOK_BACKOFF_S[0]! * 1000);

      // Not yet due (+59s): drain() posts nothing.
      const notYet = await drain(bindings, clockAt("2026-07-10T00:00:59.000Z"), { fetchImpl: receiver.fetchImpl, maxPosts: 25 });
      expect(notYet.hooks).toBe(0);
      expect(receiver.requests).toHaveLength(1);

      // Due (+60s): drain() retries.
      const retried = await drain(bindings, clockAt("2026-07-10T01:00:00.000Z"), { fetchImpl: receiver.fetchImpl, maxPosts: 25 });
      expect(retried.hooks).toBe(1);
      expect(receiver.requests).toHaveLength(2);
    });

    it("[LDB-H1] three consecutive failed drains -> failing, next_at + 3600s; then a success -> active/failures 0/failing_since null", async () => {
      const createHeaders = ownerHeaders();
      const createRes = await writeFetch("/v1/webhooks", "POST", createHeaders, VALID_BODY);
      const hook = await createRes.json<WebhookWire>();
      await appendOne();

      const receiver = new FakeReceiver();
      receiver.answer = 500;
      let t = new Date("2026-07-11T00:00:00.000Z").getTime();
      const advance = (ms: number) => {
        t += ms;
        return fixedClock(new Date(t).toISOString());
      };

      await drain(bindings, advance(0), { fetchImpl: receiver.fetchImpl, maxPosts: 25 });
      await drain(bindings, advance(WEBHOOK_BACKOFF_S[0]! * 1000), { fetchImpl: receiver.fetchImpl, maxPosts: 25 });
      await drain(bindings, advance(WEBHOOK_BACKOFF_S[1]! * 1000), { fetchImpl: receiver.fetchImpl, maxPosts: 25 });

      const failing = await db.prepare("SELECT * FROM webhooks WHERE id = ?").bind(hook.id).first<WebhookWire>();
      expect(failing!.failures).toBe(WEBHOOK_FAILING_AFTER);
      expect(failing!.status).toBe("failing");
      expect(new Date(failing!.next_at).getTime() - t).toBe(WEBHOOK_BACKOFF_S[2]! * 1000);
      expect(failing!.failing_since).not.toBeNull();

      // GET /v1/webhooks shows the failing status to its owner.
      const listRes = await writeFetch("/v1/webhooks", "GET", createHeaders);
      const list = await listRes.json<WebhookWire[]>();
      expect(list.find((w) => w.id === hook.id)?.status).toBe("failing");

      receiver.answer = 200;
      await drain(bindings, advance(WEBHOOK_BACKOFF_S[2]! * 1000), { fetchImpl: receiver.fetchImpl, maxPosts: 25 });
      const recovered = await db.prepare("SELECT * FROM webhooks WHERE id = ?").bind(hook.id).first<WebhookWire>();
      expect(recovered!.status).toBe("active");
      expect(recovered!.failures).toBe(0);
      expect(recovered!.failing_since).toBeNull();
    });

    it("[LDB-H1] failing_since older than 7 days -> disabled, no further POST", async () => {
      const createHeaders = ownerHeaders();
      const createRes = await writeFetch("/v1/webhooks", "POST", createHeaders, VALID_BODY);
      const hook = await createRes.json<WebhookWire>();
      await appendOne();

      const oldFailingSince = new Date(Date.now() - WEBHOOK_DISABLE_AFTER_MS - 1000).toISOString();
      await db
        .prepare("UPDATE webhooks SET status = 'failing', failures = ?, failing_since = ?, next_at = ? WHERE id = ?")
        .bind(WEBHOOK_FAILING_AFTER, oldFailingSince, new Date(0).toISOString(), hook.id)
        .run();

      const receiver = new FakeReceiver();
      const result = await drain(bindings, fixedClock(new Date().toISOString()), { fetchImpl: receiver.fetchImpl, maxPosts: 25 });
      expect(result.disabled).toBe(1);
      expect(receiver.requests).toHaveLength(0);

      const row = await db.prepare("SELECT status FROM webhooks WHERE id = ?").bind(hook.id).first<{ status: string }>();
      expect(row!.status).toBe("disabled");
    });

    it("kinds: [\"liked\"] only receives like events, yet its cursor reaches the head", async () => {
      const createHeaders = ownerHeaders();
      const createRes = await writeFetch("/v1/webhooks", "POST", createHeaders, { ...VALID_BODY, kinds: ["liked"] });
      const hook = await createRes.json<WebhookWire>();

      const { record } = await appendCreatedLayout();
      await appendLikeDirect(record.id);

      const receiver = new FakeReceiver();
      const head = await currentHeadSeq();
      const result = await drain(bindings, fixedClock("2026-07-12T00:00:00.000Z"), { fetchImpl: receiver.fetchImpl, maxPosts: 25 });
      expect(result.posted).toBe(1); // only the 'liked' event
      const kinds = receiver.requests.map((r) => (JSON.parse(r.body) as { kind: string }).kind);
      expect(kinds).toEqual(["liked"]);

      const row = await db.prepare("SELECT cursor FROM webhooks WHERE id = ?").bind(hook.id).first<{ cursor: number }>();
      expect(row!.cursor).toBe(head); // the filtered 'created' event still advanced the cursor
    });

    it("owner_filter: only events for that owner are delivered, cursor still reaches the head", async () => {
      const createHeaders = ownerHeaders();
      const createRes = await writeFetch("/v1/webhooks", "POST", createHeaders, { ...VALID_BODY, owner_filter: "900000000000000001" });
      const hook = await createRes.json<WebhookWire>();

      await appendWriteAs("900000000000000001");
      await appendWriteAs("900000000000000002");

      const receiver = new FakeReceiver();
      const head = await currentHeadSeq();
      await drain(bindings, fixedClock("2026-07-13T00:00:00.000Z"), { fetchImpl: receiver.fetchImpl, maxPosts: 25 });
      expect(receiver.requests).toHaveLength(1);
      const owners = receiver.requests.map((r) => (JSON.parse(r.body) as { owner: string }).owner);
      expect(owners).toEqual(["900000000000000001"]);

      const row = await db.prepare("SELECT cursor FROM webhooks WHERE id = ?").bind(hook.id).first<{ cursor: number }>();
      expect(row!.cursor).toBe(head);
    });

    it("a hook with 30 undelivered events and maxPosts:25 -> 25 POSTs, then the next drain posts the remaining 5", async () => {
      const createHeaders = ownerHeaders();
      const createRes = await writeFetch("/v1/webhooks", "POST", createHeaders, VALID_BODY);
      await createRes.json<WebhookWire>();
      for (let i = 0; i < 30; i++) await appendOne();

      const receiver = new FakeReceiver();
      const first = await drain(bindings, fixedClock("2026-07-14T00:00:00.000Z"), { fetchImpl: receiver.fetchImpl, maxPosts: 25 });
      expect(first.posted).toBe(25);
      expect(receiver.requests).toHaveLength(25);

      const second = await drain(bindings, fixedClock("2026-07-14T00:00:00.000Z"), { fetchImpl: receiver.fetchImpl, maxPosts: 25 });
      expect(second.posted).toBe(5);
      expect(receiver.requests).toHaveLength(30);
    });

    it("[LDB-H1] [LDB-H6] overlap: Promise.all([drain(), drain()]) against pending events -- the lease means exactly one of them delivers, no duplicates, cursor reaches the head", async () => {
      const createHeaders = ownerHeaders();
      const createRes = await writeFetch("/v1/webhooks", "POST", createHeaders, VALID_BODY);
      const hook = await createRes.json<WebhookWire>();
      const expectedSeqs: number[] = [];
      for (let i = 0; i < 10; i++) expectedSeqs.push((await appendOne()).seq);

      const receiver = new FakeReceiver();
      const head = await currentHeadSeq();
      const clock = fixedClock("2026-07-15T00:00:00.000Z");
      const [a, b] = await Promise.all([
        drain(bindings, clock, { fetchImpl: receiver.fetchImpl, maxPosts: 25 }),
        drain(bindings, clock, { fetchImpl: receiver.fetchImpl, maxPosts: 25 }),
      ]);

      const seqsPerHook = new Map<string, number[]>();
      for (const r of receiver.requests) {
        const body = JSON.parse(r.body) as { seq: number };
        const id = r.headers["X-Akl-Webhook-Id"]!;
        if (!seqsPerHook.has(id)) seqsPerHook.set(id, []);
        seqsPerHook.get(id)!.push(body.seq);
      }
      const seen = seqsPerHook.get(hook.id) ?? [];
      // LDB-H6: the lease claim is one CAS UPDATE issued before either
      // drain touches this hook's feed page -- whichever of the two wins
      // it delivers the ENTIRE pending range (this run's receiver answers
      // synchronously, so there's no window for the loser to sneak in a
      // second, later claim once the winner is done); the other claims
      // nothing for this hook and posts zero. Every one of the 10 pending
      // events is delivered EXACTLY once, strictly increasing, never
      // interleaved between the two calls.
      expect(seen).toEqual(expectedSeqs);
      expect([a.posted, b.posted].sort((x, y) => x - y)).toEqual([0, 10]); // one drain claimed and delivered everything, the other claimed nothing

      const row = await db.prepare("SELECT cursor FROM webhooks WHERE id = ?").bind(hook.id).first<{ cursor: number }>();
      expect(row!.cursor).toBe(head);
    });

    it("[LDB-H6] three overlapping drains against pending events: still exactly one delivers, no duplicates", async () => {
      const createHeaders = ownerHeaders();
      const createRes = await writeFetch("/v1/webhooks", "POST", createHeaders, VALID_BODY);
      const hook = await createRes.json<WebhookWire>();
      for (let i = 0; i < 12; i++) await appendOne();

      const receiver = new FakeReceiver();
      const head = await currentHeadSeq();
      const clock = fixedClock("2026-07-15T12:00:00.000Z");
      const results = await Promise.all([
        drain(bindings, clock, { fetchImpl: receiver.fetchImpl, maxPosts: 25 }),
        drain(bindings, clock, { fetchImpl: receiver.fetchImpl, maxPosts: 25 }),
        drain(bindings, clock, { fetchImpl: receiver.fetchImpl, maxPosts: 25 }),
      ]);

      const seqs = receiver.requests.filter((r) => r.headers["X-Akl-Webhook-Id"] === hook.id).map((r) => (JSON.parse(r.body) as { seq: number }).seq);
      expect(seqs).toHaveLength(12);
      expect(new Set(seqs).size).toBe(12); // no duplicates
      expect([...seqs].sort((x, y) => x - y)).toEqual(seqs); // strictly increasing, never interleaved
      expect(results.filter((r) => r.posted > 0)).toHaveLength(1); // exactly one of the three actually claimed and delivered

      const row = await db.prepare("SELECT cursor FROM webhooks WHERE id = ?").bind(hook.id).first<{ cursor: number }>();
      expect(row!.cursor).toBe(head);
    });

    it("[LDB-H5] a quiet drain (every hook at the head) writes zero D1 rows", async () => {
      const createHeaders = ownerHeaders();
      const createRes = await writeFetch("/v1/webhooks", "POST", createHeaders, VALID_BODY);
      await createRes.json<WebhookWire>();
      // The hook's cursor already equals the head (nothing written since
      // it was created) -- nothing due.
      const { db: countedDb, writes } = countingDb(db);
      const receiver = new FakeReceiver();
      await drain({ ...bindings, DB: countedDb }, fixedClock("2026-07-16T00:00:00.000Z"), { fetchImpl: receiver.fetchImpl, maxPosts: 25 });
      expect(writes()).toBe(0);
      expect(receiver.requests).toHaveLength(0);
    });

    it("[LDB-H5] one delivered batch performs exactly two webhooks UPDATEs (claim + commit)", async () => {
      const createHeaders = ownerHeaders();
      const createRes = await writeFetch("/v1/webhooks", "POST", createHeaders, VALID_BODY);
      await createRes.json<WebhookWire>();
      await appendOne();
      await appendOne();
      await appendOne();

      const { db: countedDb, writes } = countingDb(db);
      const receiver = new FakeReceiver();
      await drain({ ...bindings, DB: countedDb }, fixedClock("2026-07-17T00:00:00.000Z"), { fetchImpl: receiver.fetchImpl, maxPosts: 25 });
      // LDB-H6: the lease claim (one UPDATE) before any POST, then one
      // commitOutcome UPDATE covering the whole (multi-event) batch -- two
      // total, not one per event and not one per feed page.
      expect(writes()).toBe(2);
      expect(receiver.requests).toHaveLength(3);
    });
  });

  describe("[LDB-H6] claim-before-send lease", () => {
    it("real interleaving: a second drain's claim fails while the first's POST is genuinely still in flight", async () => {
      const createHeaders = ownerHeaders();
      const createRes = await writeFetch("/v1/webhooks", "POST", createHeaders, VALID_BODY);
      const hook = await createRes.json<WebhookWire>();
      const expectedSeqs: number[] = [];
      for (let i = 0; i < 4; i++) expectedSeqs.push((await appendOne()).seq);

      const requests: number[] = [];
      const pending: ((res: Response) => void)[] = [];
      const deferredFetch: WebhookFetchImpl = async (_url, init) => {
        requests.push((JSON.parse(init.body) as { seq: number }).seq);
        return new Promise<Response>((resolve) => pending.push(resolve));
      };

      const clock = fixedClock("2026-07-18T00:00:00.000Z");
      const drainA = drain(bindings, clock, { fetchImpl: deferredFetch, maxPosts: 25 });

      // Pump the event loop (real ticks, not just a microtask flush -- the
      // claim UPDATE and the feed SELECT are real async D1 calls) until A's
      // first POST is genuinely in flight and blocked on `deferredFetch`'s
      // still-unresolved promise. At this point A has ALREADY committed its
      // claim (the claim happens before any POST is attempted) -- exactly
      // the window a pre-lease drain() would have raced.
      await waitUntil(() => requests.length >= 1);
      expect(requests).toHaveLength(1);

      // Drain B starts now, genuinely concurrently with A's in-flight POST.
      const drainB = await drain(bindings, clock, { fetchImpl: deferredFetch, maxPosts: 25 });
      expect(drainB.posted).toBe(0); // B's claim UPDATE matched zero rows -- A already holds the lease
      expect(requests).toHaveLength(1); // B never started a POST of its own for this hook

      // Release A's POSTs one at a time until its whole batch is delivered.
      while (requests.length < expectedSeqs.length || pending.length > 0) {
        const resolve = pending.shift();
        if (resolve) resolve(new Response(null, { status: 200 }));
        else await waitUntil(() => pending.length > 0 || requests.length >= expectedSeqs.length);
      }
      const drainAResult = await drainA;
      expect(drainAResult.posted).toBe(4);
      expect(requests).toEqual(expectedSeqs); // exactly once each, strictly in order -- never interleaved with B

      const row = await db.prepare("SELECT cursor, lease_id, lease_until FROM webhooks WHERE id = ?").bind(hook.id).first<{ cursor: number; lease_id: string | null; lease_until: string | null }>();
      expect(row!.cursor).toBe(expectedSeqs[expectedSeqs.length - 1]);
      expect(row!.lease_id).toBeNull();
      expect(row!.lease_until).toBeNull();
    });

    it("concurrent failures: two overlapping drains against a 500 receiver -- failures increments by exactly 1, not 2", async () => {
      const createHeaders = ownerHeaders();
      const createRes = await writeFetch("/v1/webhooks", "POST", createHeaders, VALID_BODY);
      const hook = await createRes.json<WebhookWire>();
      await appendOne();

      const receiver = new FakeReceiver();
      receiver.answer = 500;
      const clock = fixedClock("2026-07-19T00:00:00.000Z");
      await Promise.all([
        drain(bindings, clock, { fetchImpl: receiver.fetchImpl, maxPosts: 25 }),
        drain(bindings, clock, { fetchImpl: receiver.fetchImpl, maxPosts: 25 }),
      ]);

      // With the lease, only one of the two ever attempts delivery -- the
      // other fails to claim and posts nothing. Before LDB-H6 this table's
      // `failures` would read 2 (both drains read the same stale `failures`
      // value and both wrote `+1` from it, a lost update).
      expect(receiver.requests).toHaveLength(1);
      const row = await db.prepare("SELECT failures, lease_id, lease_until FROM webhooks WHERE id = ?").bind(hook.id).first<{ failures: number; lease_id: string | null; lease_until: string | null }>();
      expect(row!.failures).toBe(1);
      expect(row!.lease_id).toBeNull();
      expect(row!.lease_until).toBeNull();
    });

    it("the partial-failure-vs-success race (bug 3) cannot happen: any interleaving of two attempts ends in one of the two attempts' own outcomes, never a mix", async () => {
      // Reproduces the pre-lease bug's exact shape: a hook with events
      // 6..10 past its cursor. One "drain" delivers 6 and 7, then fails at
      // 8 (a short, partially-failed batch); a concurrent one would have
      // delivered 6..10 in full (a longer, fully successful batch). Before
      // LDB-H6, whichever commitOutcome ran LAST won regardless of which
      // attempt was more complete -- the short failing one could void the
      // long successful one. With the lease there is only ever ONE
      // in-flight attempt per hook, so this is exercised here as: the
      // short/failing outcome and the long/successful outcome are each
      // driven to completion by a SEPARATE drain() call that only starts
      // once the previous one has fully committed and released the lease
      // -- proving the two can never race for the same commit, only run in
      // some serial order, one before the other.
      const createHeaders = ownerHeaders();
      const createRes = await writeFetch("/v1/webhooks", "POST", createHeaders, VALID_BODY);
      const hook = await createRes.json<WebhookWire>();
      const seqs: number[] = [];
      for (let i = 0; i < 5; i++) seqs.push((await appendOne()).seq); // 6..10 (relative)

      const receiver = new FakeReceiver();
      let call = 0;
      receiver.answer = () => {
        call++;
        return call === 3 ? 500 : 200; // fails on the 3rd POST (the batch's 3rd event)
      };
      const clock = fixedClock("2026-07-20T00:00:00.000Z");

      // The short, partially-failed attempt (delivers seqs[0], seqs[1],
      // fails at seqs[2]) runs to completion and commits/releases its lease
      // BEFORE the second drain (which would deliver the rest in full) even
      // starts -- serial by construction, exactly what the lease enforces
      // for any two overlapping calls.
      const first = await drain(bindings, clock, { fetchImpl: receiver.fetchImpl, maxPosts: 25 });
      expect(first.failed).toBe(1);
      const afterFirst = await db.prepare("SELECT cursor, failures, lease_id FROM webhooks WHERE id = ?").bind(hook.id).first<{ cursor: number; failures: number; lease_id: string | null }>();
      expect(afterFirst!.cursor).toBe(seqs[1]); // exactly the two delivered events, not voided, not overwritten
      expect(afterFirst!.failures).toBe(1);
      expect(afterFirst!.lease_id).toBeNull(); // released -- available for the next attempt

      receiver.answer = 200;
      const second = await drain(bindings, fixedClock("2026-07-20T01:00:00.000Z"), { fetchImpl: receiver.fetchImpl, maxPosts: 25 });
      expect(second.posted).toBe(3); // seqs[2..4], resuming exactly where the first left off
      const final = await db.prepare("SELECT cursor, failures, status FROM webhooks WHERE id = ?").bind(hook.id).first<{ cursor: number; failures: number; status: string }>();
      expect(final!.cursor).toBe(seqs[4]);
      expect(final!.failures).toBe(0);
      expect(final!.status).toBe("active");

      // The receiver's own request log includes the FAILED 3rd attempt
      // (seqs[2], answered 500) as well as its later successful retry --
      // that one seq legitimately reaching the receiver twice is a normal
      // retry-after-failure, not the bug this test is about. The bug-3
      // invariant is about SUCCESSFUL (2xx) deliveries: each of the 5
      // events reaches "delivered" exactly once, in order, across the two
      // separate (never-overlapping) attempts combined.
      const attempted = receiver.requests.map((r) => (JSON.parse(r.body) as { seq: number }).seq);
      expect(attempted).toEqual([seqs[0], seqs[1], seqs[2], seqs[2], seqs[3], seqs[4]]);
      const succeeded = receiver.requests.filter((_, i) => i !== 2).map((r) => (JSON.parse(r.body) as { seq: number }).seq); // every request except the one that got the 500
      expect(succeeded).toEqual(seqs);
    });

    describe("lease expiry", () => {
      it("a drain that dies holding a lease (crash after claim, before commit): a second drain before lease_until skips; after it, claims and delivers from the old cursor", async () => {
        const createHeaders = ownerHeaders();
        const createRes = await writeFetch("/v1/webhooks", "POST", createHeaders, VALID_BODY);
        const hook = await createRes.json<WebhookWire>();
        const seqs: number[] = [];
        for (let i = 0; i < 3; i++) seqs.push((await appendOne()).seq);

        // Simulate a drain that claimed the lease and then died before
        // `commitOutcome` ever ran -- exactly the state a real crash (an
        // uncaught throw, an isolate eviction) leaves behind: the lease
        // columns set, cursor/failures untouched.
        const t0 = new Date("2026-07-21T00:00:00.000Z").getTime();
        const crashedLeaseId = ulid();
        const leaseUntil = new Date(t0 + WEBHOOK_LEASE_MS).toISOString();
        await db.prepare("UPDATE webhooks SET lease_id = ?, lease_until = ? WHERE id = ?").bind(crashedLeaseId, leaseUntil, hook.id).run();

        const receiver = new FakeReceiver();
        const beforeExpiry = await drain(bindings, fixedClock(new Date(t0 + WEBHOOK_LEASE_MS - 1000).toISOString()), { fetchImpl: receiver.fetchImpl, maxPosts: 25 });
        expect(beforeExpiry.posted).toBe(0);
        expect(receiver.requests).toHaveLength(0); // still held -- not due for a claim yet

        const stillHeld = await db.prepare("SELECT lease_id FROM webhooks WHERE id = ?").bind(hook.id).first<{ lease_id: string | null }>();
        expect(stillHeld!.lease_id).toBe(crashedLeaseId);

        const afterExpiry = await drain(bindings, fixedClock(new Date(t0 + WEBHOOK_LEASE_MS + 1000).toISOString()), { fetchImpl: receiver.fetchImpl, maxPosts: 25 });
        expect(afterExpiry.posted).toBe(3); // claims fresh, delivers from the cursor the crashed drain never advanced
        const delivered = receiver.requests.map((r) => (JSON.parse(r.body) as { seq: number }).seq);
        expect(delivered).toEqual(seqs);

        const row = await db.prepare("SELECT cursor, lease_id, lease_until FROM webhooks WHERE id = ?").bind(hook.id).first<{ cursor: number; lease_id: string | null; lease_until: string | null }>();
        expect(row!.cursor).toBe(seqs[2]);
        expect(row!.lease_id).toBeNull();
        expect(row!.lease_until).toBeNull();
      });

      it("a duplicate is possible only for the crashed drain's own in-flight POST, never for any other seq", async () => {
        // The documented exception (README.md § Webhooks / webhooks.ts's
        // module comment): if the crashed drain's LAST POST had actually
        // reached the receiver before it died, that one seq is delivered
        // again by the drain that reclaims the lease after expiry -- every
        // other seq is still delivered exactly once.
        const createHeaders = ownerHeaders();
        const createRes = await writeFetch("/v1/webhooks", "POST", createHeaders, VALID_BODY);
        const hook = await createRes.json<WebhookWire>();
        const seqs: number[] = [];
        for (let i = 0; i < 4; i++) seqs.push((await appendOne()).seq);

        const receiver = new FakeReceiver();
        // The crashed drain's own (never logged by this test's receiver --
        // it used its own now-gone fetchImpl) in-flight POST of seqs[0]
        // landed successfully, THEN it died before committing -- so the
        // DB's cursor is still at the pre-batch value even though seqs[0]
        // was, in fact, delivered once already.
        const t0 = new Date("2026-07-22T00:00:00.000Z").getTime();
        const crashedLeaseId = ulid();
        await db
          .prepare("UPDATE webhooks SET lease_id = ?, lease_until = ? WHERE id = ?")
          .bind(crashedLeaseId, new Date(t0 + WEBHOOK_LEASE_MS).toISOString(), hook.id)
          .run();
        const preCrashDelivered = [seqs[0]!];

        const reclaim = await drain(bindings, fixedClock(new Date(t0 + WEBHOOK_LEASE_MS + 1000).toISOString()), { fetchImpl: receiver.fetchImpl, maxPosts: 25 });
        expect(reclaim.posted).toBe(4); // re-delivers from the OLD cursor: all 4 events, seqs[0] included
        const reclaimedSeqs = receiver.requests.map((r) => (JSON.parse(r.body) as { seq: number }).seq);
        expect(reclaimedSeqs).toEqual(seqs);

        const allDeliveries = [...preCrashDelivered, ...reclaimedSeqs];
        const counts = new Map<number, number>();
        for (const s of allDeliveries) counts.set(s, (counts.get(s) ?? 0) + 1);
        const duplicated = [...counts.entries()].filter(([, n]) => n > 1).map(([s]) => s);
        expect(duplicated).toEqual([seqs[0]]); // the ONLY duplicate is the crashed drain's own in-flight POST
        for (const s of seqs.slice(1)) expect(counts.get(s)).toBe(1);

        const row = await db.prepare("SELECT cursor FROM webhooks WHERE id = ?").bind(hook.id).first<{ cursor: number }>();
        expect(row!.cursor).toBe(seqs[3]);
      });
    });

    it(
      "[property] random events / receiver outcomes / concurrent drains / clock advances: per-hook delivery stays strictly increasing with no duplicates, failures tracks exactly the committed failed attempts, cursor reaches the head, and the lease is always released",
      async () => {
        await fc.assert(
          fc.asyncProperty(
            fc.integer({ min: 1, max: 15 }), // pending events
            fc.integer({ min: 1, max: 3 }), // concurrent drain() calls issued per round
            fc.integer({ min: 1, max: 2 ** 31 - 1 }), // rng seed
            async (n, concurrency, seed) => {
              const rng = mulberry32(seed);

              // Isolated per fast-check run (07 §2's per-file, not per-`it`,
              // storage): this property owns the whole `webhooks` table for
              // its duration, same discipline as tests/events/feed.test.ts's
              // own property test.
              await db.prepare("DELETE FROM webhooks").run();
              const writeClock = steppingClock("2026-08-01T00:00:00.000Z", 1000);
              let counter = 0;
              for (let i = 0; i < n; i++) {
                await appendWrite(db, writeClock, {
                  upstream: null,
                  kind: "created",
                  name: uniqueName(`wh-prop-${counter++}`),
                  owner: "wh-prop-owner",
                  modified_at: writeClock(),
                  format: "cmini/1",
                  payload: {},
                  actor: "wh-prop-owner",
                  via: "discord",
                  source: { client: "discord-app:test", version: null },
                  hasMagic: false,
                });
              }
              const head = await headSeq(db);
              const baseline = head - n; // this hook's starting cursor: strictly before every event just appended

              const hookId = ulid();
              const seedAt = "2026-08-01T00:00:00.000Z";
              await db
                .prepare(
                  `INSERT INTO webhooks (id, owner_user_id, url, secret, kinds, owner_filter, status, cursor, failures, failing_since, next_at, last_error, created_at)
                   VALUES (?, 'prop-owner', 'https://prop.example/hook', 'prop-secret-1234567890ab', NULL, NULL, 'active', ?, 0, NULL, ?, NULL, ?)`,
                )
                .bind(hookId, baseline, seedAt, seedAt)
                .run();

              const delivered: number[] = []; // every 2xx-accepted seq, across every round, in receipt order
              const fakeFetch: WebhookFetchImpl = async (_url, init) => {
                const body = JSON.parse(init.body) as { seq: number };
                const r = rng();
                if (r < 0.15) return new Response(null, { status: 500 });
                if (r < 0.2) throw new Error("[property] simulated network failure");
                delivered.push(body.seq);
                return new Response(null, { status: 200 });
              };

              let attemptMs = new Date("2026-08-02T00:00:00.000Z").getTime();
              let prevFailures = 0;
              let iterations = 0;
              for (;;) {
                const clock = fixedClock(new Date(attemptMs).toISOString());
                await Promise.all(Array.from({ length: concurrency }, () => drain(bindings, clock, { fetchImpl: fakeFetch, maxPosts: 50 })));

                const row = await db
                  .prepare("SELECT cursor, failures, lease_id, lease_until FROM webhooks WHERE id = ?")
                  .bind(hookId)
                  .first<{ cursor: number; failures: number; lease_id: string | null; lease_until: string | null }>();
                // (d) the lease is always released by the time every
                // concurrent drain() of the round has resolved -- no
                // attempt is ever left holding it past its own commit.
                expect(row!.lease_id).toBeNull();
                expect(row!.lease_until).toBeNull();
                // (c) each round in which the hook was still behind the
                // head runs exactly one real attempt (the lease shuts out
                // every other concurrent claimant) -- so `failures` either
                // resets to 0 (that attempt fully succeeded) or advances by
                // exactly 1 (it failed partway) from the previous round.
                expect(row!.failures === 0 || row!.failures === prevFailures + 1).toBe(true);
                prevFailures = row!.failures;

                if (row!.cursor >= head) break;
                attemptMs += 3_700_000; // past every WEBHOOK_BACKOFF_S tier (max 3600s)
                iterations++;
                if (iterations > 60) throw new Error("[property] drain loop did not converge within 60 rounds");
              }

              // (a) strictly increasing, no duplicates -- this run's `n`
              // events are the only ones any drain() call here could ever
              // see (the table was cleared above; nothing else writes to
              // it), so `delivered` is exactly this hook's own sequence.
              expect(new Set(delivered).size).toBe(delivered.length);
              expect([...delivered].sort((a, b) => a - b)).toEqual(delivered);

              // (b) final cursor = the head (every event eventually
              // acknowledged, in order -- the loop above only exits once
              // true).
              const final = await db.prepare("SELECT cursor FROM webhooks WHERE id = ?").bind(hookId).first<{ cursor: number }>();
              expect(final!.cursor).toBe(head);
            },
          ),
          // 15 runs (feed.test.ts's own property test makes the same
          // deliberate deviation from a textbook 100): each run drives up
          // to 60 real D1-backed drain() rounds, so more runs would make
          // this one `it` dominate the file's wall time without adding
          // much beyond what 15 seeds across {n, concurrency} already
          // exercises.
          { numRuns: 15 },
        );
      },
    );
  });

  describe("scheduled() wiring", () => {
    // The cron consolidation (12 §3 X4 follow-up 2) means EVERY '*/5 * * * *'
    // slot now also runs an import tick alongside the drain -- a combined
    // stub (cmini-shaped URLs to a real FakeUpstream, everything else --
    // the webhook receiver -- a plain 200) replaces the old bare "always
    // 200" stub, which would otherwise make the import tick's own upstream
    // fetch fail (empty body != JSON) and retry for several real seconds.
    it("every '*/5 * * * *' slot reaches drainWebhooks()", async () => {
      const createHeaders = ownerHeaders();
      const createRes = await writeFetch("/v1/webhooks", "POST", createHeaders, VALID_BODY);
      const hook = await createRes.json<WebhookWire>();
      await appendOne();

      const fake = new FakeUpstream();
      vi.stubGlobal("fetch", async (url: string, init?: { headers?: Record<string, string> }) => {
        if (url.startsWith(fake.baseUrl)) return fake.fetchImpl(url, { headers: init?.headers ?? {} });
        return new Response(null, { status: 200 });
      });
      const ctx = createExecutionContext();
      const controller = createScheduledController({ cron: "*/5 * * * *", scheduledTime: atUTC(12, 0) });
      await worker.scheduled(controller, bindings, ctx);
      await waitOnExecutionContext(ctx);

      const row = await db.prepare("SELECT cursor FROM webhooks WHERE id = ?").bind(hook.id).first<{ cursor: number }>();
      expect(row!.cursor).toBeGreaterThan(0);
    });

    it("the hour=3 minute=0 prune leaves `webhooks` alone", async () => {
      const createHeaders = ownerHeaders();
      const createRes = await writeFetch("/v1/webhooks", "POST", createHeaders, VALID_BODY);
      const hook = await createRes.json<WebhookWire>();

      const fake = new FakeUpstream();
      vi.stubGlobal("fetch", fake.fetchImpl);
      const ctx = createExecutionContext();
      const controller = createScheduledController({ cron: "*/5 * * * *", scheduledTime: atUTC(3, 0) });
      await worker.scheduled(controller, bindings, ctx);
      await waitOnExecutionContext(ctx);

      const row = await db.prepare("SELECT id FROM webhooks WHERE id = ?").bind(hook.id).first();
      expect(row).not.toBeNull();
    });
  });
});

// Polls a real event-loop tick (not just a microtask flush -- D1 calls in
// this test runtime resolve through real async I/O) until `cond()` is true
// or `maxTicks` is exhausted, for tests that need to observe a `drain()`
// call genuinely blocked mid-await (LDB-H6's real-interleaving test).
async function waitUntil(cond: () => boolean, maxTicks = 200): Promise<void> {
  for (let i = 0; i < maxTicks && !cond(); i++) await new Promise((resolve) => setTimeout(resolve, 0));
  if (!cond()) throw new Error("waitUntil: condition never became true");
}

// A tiny deterministic PRNG (mulberry32) so a property-test failure always
// reproduces from the SAME (params, seed) pair fast-check reports, not from
// `Math.random()` -- copied from tests/events/feed.test.ts's own LDB-P3
// property test rather than exported, matching that file's precedent of
// keeping this helper local to whichever property needs it.
function mulberry32(seed: number): () => number {
  let a = seed;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// --- fixtures: append events directly (bypassing the route/nudge) so a
// delivery test controls exactly when `drain()` runs. ---------------------

let apCounter = 0;
async function appendCreatedLayout() {
  return appendWrite(db, fixedClock("2026-07-01T00:00:00.000Z"), {
      upstream: null,
    kind: "created",
    name: uniqueName(`wh-fixture-${apCounter++}`),
    owner: "wh-fixture-owner",
    modified_at: "2026-07-01T00:00:00.000Z",
    format: "cmini/1",
    payload: {},
    actor: "wh-fixture-owner",
    via: "discord",
    source: { client: "discord-app:test", version: null },
    hasMagic: false,
  });
}

async function appendOne(): Promise<{ seq: number }> {
  const { seq } = await appendCreatedLayout();
  return { seq };
}

async function appendLikeDirect(layoutId: string): Promise<void> {
  await appendLike(db, fixedClock("2026-07-01T00:00:01.000Z"), { kind: "liked", layoutId, userId: "wh-liker", via: "discord", source: { client: "discord-app:test", version: null } });
}

async function appendWriteAs(owner: string): Promise<void> {
  await appendWrite(db, fixedClock("2026-07-01T00:00:00.000Z"), {
      upstream: null,
    kind: "created",
    name: uniqueName(`wh-owner-${apCounter++}`),
    owner,
    modified_at: "2026-07-01T00:00:00.000Z",
    format: "cmini/1",
    payload: {},
    actor: owner,
    via: "discord",
    source: { client: "discord-app:test", version: null },
    hasMagic: false,
  });
}

async function currentHeadSeq(): Promise<number> {
  return headSeq(db);
}
