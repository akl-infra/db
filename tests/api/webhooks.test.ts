// [LDB-H1] [LDB-H4] [LDB-H5] POST/GET/DELETE /v1/webhooks (12 §2.1, §3 X1):
// CRUD auth matrix, validation, delivery (signature, retries/backoff,
// failing/disabled), kinds/owner_filter, the global post budget, overlap
// safety, and the "no secret ever leaks" scan.
import { createExecutionContext, createScheduledController, env, waitOnExecutionContext } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Bindings } from "../../src/env";
import { appendLike, appendWrite } from "../../src/core/events";
import { headSeq } from "../../src/core/etag";
import {
  WEBHOOK_BACKOFF_S,
  WEBHOOK_DISABLE_AFTER_MS,
  WEBHOOK_FAILING_AFTER,
  WEBHOOKS_PER_USER,
  drain,
  sign,
  type WebhookFetchImpl,
} from "../../src/core/webhooks";
import { fixedClock } from "../../src/core/time";
import worker from "../../src/index";
import { actorFixture, pinTestClock, register, uniqueName, writeFetch } from "./write-support";

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
// following 09 §3 T1's pattern): counts every `.run()` a prepared
// statement makes, through as many `.bind()` chains as the caller applies.
// `webhooks.ts`'s SQL is exclusively `.prepare(...).bind(...).run()` /
// `.first()` / `.all()` -- no `.batch()` -- so counting `.run()` alone is
// exactly "how many write statements did this drain() issue".
function wrapStmt(stmt: D1PreparedStatement, writes: { n: number }): D1PreparedStatement {
  return new Proxy(stmt, {
    get(target, prop, receiver) {
      if (prop === "run") {
        return async (...args: unknown[]) => {
          writes.n++;
          return (target.run as (...a: unknown[]) => unknown).apply(target, args);
        };
      }
      if (prop === "bind") {
        return (...args: unknown[]) => wrapStmt((target.bind as (...a: unknown[]) => D1PreparedStatement).apply(target, args), writes);
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
      if (prop === "prepare") return (sql: string) => wrapStmt(target.prepare(sql), writes);
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
    it("scans every CRUD response body for the literal secret", async () => {
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

    it("never appears in any event", async () => {
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

      const createLayoutRes = await writeFetch("/v1/layouts", "POST", headers, { name: uniqueName("wh-delivery"), format: "cmini/1", payload: { board: "ortho", keys: {} } });
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

    it("[LDB-H1] overlap: Promise.all([drain(), drain()]) against pending events -- the receiver sees every seq >=once in order, the cursor reaches the head", async () => {
      const createHeaders = ownerHeaders();
      const createRes = await writeFetch("/v1/webhooks", "POST", createHeaders, VALID_BODY);
      const hook = await createRes.json<WebhookWire>();
      for (let i = 0; i < 10; i++) await appendOne();

      const receiver = new FakeReceiver();
      const head = await currentHeadSeq();
      const clock = fixedClock("2026-07-15T00:00:00.000Z");
      await Promise.all([
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
      // At-least-once: both drains read the SAME starting cursor before
      // either commits its compare-and-set, so BOTH can (and here, do)
      // deliver the whole pending range -- duplicates are expected, not a
      // bug (LDB-P3 is what makes duplicates safe for a real subscriber).
      // The real invariant is coverage (every pending seq reaches the
      // receiver at least once) and that each individual drain's own run
      // never posts out of order -- checked by splitting `seen` at its one
      // decrease point (10 events, so at most a two-way split here).
      expect(new Set(seen).size).toBe(10); // every one of the 10 pending events, at least once
      const splitAt = seen.findIndex((s, i) => i > 0 && s < seen[i - 1]!);
      const runs = splitAt === -1 ? [seen] : [seen.slice(0, splitAt), seen.slice(splitAt)];
      for (const run of runs) {
        expect(run).toEqual([...run].sort((a, b) => a - b));
      }

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

    it("[LDB-H5] one delivered batch performs exactly one webhooks UPDATE", async () => {
      const createHeaders = ownerHeaders();
      const createRes = await writeFetch("/v1/webhooks", "POST", createHeaders, VALID_BODY);
      await createRes.json<WebhookWire>();
      await appendOne();
      await appendOne();
      await appendOne();

      const { db: countedDb, writes } = countingDb(db);
      const receiver = new FakeReceiver();
      await drain({ ...bindings, DB: countedDb }, fixedClock("2026-07-17T00:00:00.000Z"), { fetchImpl: receiver.fetchImpl, maxPosts: 25 });
      expect(writes()).toBe(1); // one hook, one UPDATE covering its whole (multi-event) batch
      expect(receiver.requests).toHaveLength(3);
    });
  });

  describe("scheduled() wiring", () => {
    it("the exported scheduled() handler routes '*/1 * * * *' to drainWebhooks()", async () => {
      const createHeaders = ownerHeaders();
      const createRes = await writeFetch("/v1/webhooks", "POST", createHeaders, VALID_BODY);
      const hook = await createRes.json<WebhookWire>();
      await appendOne();

      vi.stubGlobal("fetch", async () => new Response(null, { status: 200 }));
      const ctx = createExecutionContext();
      const controller = createScheduledController({ cron: "*/1 * * * *" });
      await worker.scheduled(controller, bindings, ctx);
      await waitOnExecutionContext(ctx);

      const row = await db.prepare("SELECT cursor FROM webhooks WHERE id = ?").bind(hook.id).first<{ cursor: number }>();
      expect(row!.cursor).toBeGreaterThan(0);
    });

    it("the '0 3 * * *' prune leaves `webhooks` alone", async () => {
      const createHeaders = ownerHeaders();
      const createRes = await writeFetch("/v1/webhooks", "POST", createHeaders, VALID_BODY);
      const hook = await createRes.json<WebhookWire>();

      const ctx = createExecutionContext();
      const controller = createScheduledController({ cron: "0 3 * * *" });
      await worker.scheduled(controller, bindings, ctx);
      await waitOnExecutionContext(ctx);

      const row = await db.prepare("SELECT id FROM webhooks WHERE id = ?").bind(hook.id).first();
      expect(row).not.toBeNull();
    });
  });
});

// --- fixtures: append events directly (bypassing the route/nudge) so a
// delivery test controls exactly when `drain()` runs. ---------------------

let apCounter = 0;
async function appendCreatedLayout() {
  return appendWrite(db, fixedClock("2026-07-01T00:00:00.000Z"), {
    kind: "created",
    name: uniqueName(`wh-fixture-${apCounter++}`),
    owner: "wh-fixture-owner",
    modified_at: "2026-07-01T00:00:00.000Z",
    format: "cmini/1",
    payload: {},
    actor: "wh-fixture-owner",
    via: "discord",
    hasMagic: false,
  });
}

async function appendOne(): Promise<{ seq: number }> {
  const { seq } = await appendCreatedLayout();
  return { seq };
}

async function appendLikeDirect(layoutId: string): Promise<void> {
  await appendLike(db, fixedClock("2026-07-01T00:00:01.000Z"), { kind: "liked", layoutId, userId: "wh-liker", via: "discord" });
}

async function appendWriteAs(owner: string): Promise<void> {
  await appendWrite(db, fixedClock("2026-07-01T00:00:00.000Z"), {
    kind: "created",
    name: uniqueName(`wh-owner-${apCounter++}`),
    owner,
    modified_at: "2026-07-01T00:00:00.000Z",
    format: "cmini/1",
    payload: {},
    actor: owner,
    via: "discord",
    hasMagic: false,
  });
}

async function currentHeadSeq(): Promise<number> {
  return headSeq(db);
}
