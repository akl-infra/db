// [LDB-MIR3..MIR10] The recording Store (src/mirror/recorder.ts, observe-d1.ts, sender.ts, platform/workers.ts).
// A full write session through the real Worker, with the tee on, is replayed into a fresh database and must produce
// identical outcomes, seqs, clock reads and rows; the tee must add no D1 round trip and must never change a response.
import { applyD1Migrations } from "cloudflare:test";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { env, store as plainStore } from "../harness";
import { createD1Store } from "../../src/store/d1";
import type { Store } from "../../src/store/port";
import { steppingClock } from "../../src/core/time";
import { decodeTee, RecordedClock, replayClock, TEE_SIG_HEADER, TEE_TS_HEADER, type TeeBatch, type TeeCall } from "../../src/mirror/record";
import { observeD1 } from "../../src/mirror/observe-d1";
import { MIRROR_NOT_RECORDED, MIRROR_WRITES, recordingStore } from "../../src/mirror/recorder";
import { createTeeSender } from "../../src/mirror/sender";
import { TEE_TAG } from "../../src/mirror/tag";
import { teeEnv } from "../../src/mirror/tee-env";
import type { Bindings } from "../../src/env";
import { AKL_PAYLOAD, BOOTSTRAP_ADMIN, actorFixture, pinTestClock, register, uniqueName, writeFetch } from "../api/write-support";

interface TeeEnv {
  DB: D1Database;
  DB_REPLAY: D1Database;
  TEST_MIGRATIONS: Parameters<typeof applyD1Migrations>[1];
  TEE_URL?: string;
  TEE_SECRET?: string;
}
const e = env as unknown as TeeEnv;
const SINK_URL = "https://tee-sink.invalid/ingest";
const SECRET = "test-tee-secret";

const EPHEMERAL = new Set(["nonces", "auth_cache", "ratelimit"]);
const TABLES = [
  "layouts", "layout_formats", "layout_revs", "likes", "events", "authors", "authors_head", "discord_users", "discord_users_head", "layouts_head", "admins", "bans", "clients",
  "idempotency", "import_state", "import_map", "link_submissions", "wpm_submissions", "layout_comments", "comment_likes",
  "moderation_review_history", "modqueue_notifications", "modqueue_delivery_gate", "discord_pending_actions", "discord_reopen_actions",
  "discord_deny_modals", "discord_reopen_confirmations", "discord_rejection_dm_outbox",
];

async function snapshot(db: D1Database): Promise<Record<string, unknown[]>> {
  const out: Record<string, unknown[]> = {};
  for (const t of TABLES) out[t] = (await db.prepare(`SELECT * FROM ${t} ORDER BY rowid`).all()).results;
  return out;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function hmacHex(secret: string, message: string): Promise<string> {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return [...new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(message)))].map((b) => b.toString(16).padStart(2, "0")).join("");
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("every Store method is classified", () => {
  it("[LDB-MIR3] each method of a real store is in exactly one of MIRROR_WRITES / MIRROR_NOT_RECORDED, and the lists name nothing stale", () => {
    const actual = new Map<string, string[]>();
    for (const [area, methods] of Object.entries(plainStore as unknown as Record<string, Record<string, unknown>>)) {
      actual.set(area, Object.keys(methods).filter((m) => typeof methods[m] === "function"));
    }
    const listed = (m: Readonly<Record<string, readonly string[]>>) => new Set(Object.entries(m).flatMap(([a, ms]) => ms.map((x) => `${a}.${x}`)));
    const writes = listed(MIRROR_WRITES);
    const others = listed(MIRROR_NOT_RECORDED);
    const all = new Set([...actual].flatMap(([a, ms]) => ms.map((x) => `${a}.${x}`)));
    expect([...all].filter((m) => !writes.has(m) && !others.has(m))).toEqual([]);
    expect([...writes].filter((m) => !all.has(m))).toEqual([]);
    expect([...others].filter((m) => !all.has(m))).toEqual([]);
    expect([...writes].filter((m) => others.has(m))).toEqual([]);
    // The ephemeral tables' writes are never recorded.
    for (const m of ["auth.insertNonce", "auth.hitWindow", "auth.cacheAuthFailure", "auth.pruneAuthCache", "auth.pruneNonces", "dump.restore"]) {
      expect(writes.has(m)).toBe(false);
    }
    expect(writes.has("auth.pruneRateLimits")).toBe(true);
  });
});

describe("a full write session, recorded and replayed", () => {
  const clock = steppingClock("2026-10-20T00:00:00.000Z", 1000);
  const batches: TeeBatch[] = [];
  const sigChecks: boolean[] = [];
  let sinkFails = 0;
  const session: { calls: TeeCall[]; rows: Record<string, unknown[]>; responses: Array<[string, number, string]> } = { calls: [], rows: {}, responses: [] };
  const O = "owner-mirror-1";
  const U = "user-mirror-1";
  const U2 = "user-mirror-2";

  beforeAll(() => {
    pinTestClock(env as unknown as { TEST_CLOCK?: typeof clock }, clock);
  });
  afterAll(() => {
    delete e.TEE_URL;
    delete e.TEE_SECRET;
  });

  // The Worker runs in this isolate (pool-workers), so setting the vars on the live env turns the tee on for SELF.fetch.
  function teeOn() {
    e.TEE_URL = SINK_URL;
    e.TEE_SECRET = SECRET;
  }
  function teeOff() {
    delete e.TEE_URL;
    delete e.TEE_SECRET;
  }

  function stubFetch(discordFetch: typeof fetch) {
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (url !== SINK_URL) return discordFetch(input as string, init);
      if (sinkFails > 0) {
        sinkFails--;
        return new Response("no", { status: 503 });
      }
      const body = String(init?.body);
      const h = init?.headers as Record<string, string>;
      sigChecks.push(h[TEE_SIG_HEADER] === (await hmacHex(SECRET, `${h[TEE_TS_HEADER]}\n${body}`)));
      batches.push(JSON.parse(body) as TeeBatch);
      return new Response("ok", { status: 200 });
    });
  }

  async function step(label: string, p: Promise<Response>, expected: number): Promise<Response> {
    const res = await p;
    const text = await res.clone().text();
    session.responses.push([label, res.status, text]);
    expect(res.status, `${label}: ${text}`).toBe(expected);
    await sleep(70); // the tee's settle window (25 ms) plus the sink
    return res;
  }

  it("[LDB-MIR4] records the session with the tee on; the sink gets signed, uniquely numbered batches", async () => {
    const fake = actorFixture();
    stubFetch(fake.fetchImpl as typeof fetch);
    teeOn();
    const own = register(fake, "tok-mir-owner", O);
    const usr = register(fake, "tok-mir-user", U);
    const usr2 = register(fake, "tok-mir-user2", U2);
    const adm = register(fake, "tok-mir-admin", BOOTSTRAP_ADMIN);

    const name = uniqueName("mirror-layout");
    const created = await step("create", writeFetch("/v1/layouts", "POST", { ...own, "Idempotency-Key": "mir-key-1" }, { name, format: "spark/1", payload: AKL_PAYLOAD }), 201);
    const layout = (await created.json()) as { id: string };
    await step("create again with the same key (stored replay)", writeFetch("/v1/layouts", "POST", { ...own, "Idempotency-Key": "mir-key-1" }, { name, format: "spark/1", payload: AKL_PAYLOAD }), 201);
    await step("name taken (a thrown ApiError)", writeFetch("/v1/layouts", "POST", usr, { name, format: "spark/1", payload: AKL_PAYLOAD }), 409);
    await step("rename", writeFetch(`/v1/layouts/${layout.id}`, "PATCH", { ...own, "If-Match": "*" }, { name: uniqueName("mirror-renamed") }), 200);
    await step("update", writeFetch(`/v1/layouts/${layout.id}`, "PUT", { ...own, "If-Match": "*" }, { format: "spark/1", payload: { keys: [{ char: "a", row: 1, col: 0, finger: "LP" }] } }), 200);
    await step("like", writeFetch(`/v1/layouts/${layout.id}/like`, "PUT", usr), 200);
    await step("like again (a thrown alreadyLiked)", writeFetch(`/v1/layouts/${layout.id}/like`, "PUT", usr), 409);
    await step("like by a second user", writeFetch(`/v1/layouts/${layout.id}/like`, "PUT", usr2), 200);
    await step("unlike", writeFetch(`/v1/layouts/${layout.id}/like`, "DELETE", usr), 200);
    await step("comment", writeFetch(`/v1/layouts/${layout.id}/comment`, "PUT", usr, { body: "first!" }), 202);
    const mine = (await (await writeFetch(`/v1/layouts/${layout.id}/comment`, "GET", usr)).json()) as { pending: { id: string } };
    await step("approve the comment", writeFetch(`/v1/admin/comment-queue/${mine.pending.id}/approve`, "POST", adm), 200);
    await step("comment again", writeFetch(`/v1/layouts/${layout.id}/comment`, "PUT", usr2, { body: "second" }), 202);
    const mine2 = (await (await writeFetch(`/v1/layouts/${layout.id}/comment`, "GET", usr2)).json()) as { pending: { id: string } };
    await step("reject the comment", writeFetch(`/v1/admin/comment-queue/${mine2.pending.id}/reject`, "POST", adm, { reason: "off topic" }), 200);
    await step("delete own comment", writeFetch(`/v1/layouts/${layout.id}/comment`, "DELETE", usr), 204);
    await step("link submission", writeFetch(`/v1/layouts/${layout.id}/link`, "PUT", own, { url: "https://example.org/mirror" }), 202);
    const queue = (await (await writeFetch("/v1/admin/link-queue?status=pending", "GET", adm)).json()) as { submissions: Array<{ id: string; layout_id: string }> };
    const linkId = queue.submissions.find((x) => x.layout_id === layout.id)!.id;
    await step("approve the link", writeFetch(`/v1/admin/link-queue/${linkId}/approve`, "POST", adm), 200);
    await step("add an admin", writeFetch("/v1/admin/admins", "POST", adm, { user_id: "34567890123456789", note: "mirror" }), 201);
    await step("delete the layout", writeFetch(`/v1/layouts/${layout.id}`, "DELETE", { ...own, "If-Match": "*" }), 200);
    teeOff();

    session.calls = batches.flatMap((b) => b.calls);
    session.rows = await snapshot(e.DB);
    expect(batches.length).toBeGreaterThan(5);
    expect(sigChecks.every(Boolean)).toBe(true);
    expect(batches.every((b) => b.v === 1 && b.direction === "d1->ddb" && b.batchId.length > 8)).toBe(true);
    expect(new Set(batches.map((b) => b.batchId)).size).toBe(batches.length);
  });

  it("[LDB-MIR5] the session covered the writes that matter, errors included, and every event seq is recorded exactly once", () => {
    const methods = new Set(session.calls.map((c) => c.method));
    for (const m of ["events.commitWrite", "events.appendLike", "auth.cacheAuthSuccess", "auth.reserveIdempotency", "auth.completeIdempotency", "comments.submit", "comments.approve", "comments.reject", "comments.deleteOwn", "links.submit", "admin.insertAdmin"]) {
      expect(methods, m).toContain(m);
    }
    expect(session.calls.some((c) => "error" in c.outcome)).toBe(true);
    for (const c of session.calls) {
      expect(c.v).toBe(1);
      expect(MIRROR_WRITES[c.method.split(".")[0]!]).toContain(c.method.split(".")[1]);
    }
    const recorded = session.calls.flatMap((c) => c.seqs);
    const stored = (session.rows.events as Array<{ seq: number }>).map((r) => r.seq);
    expect(stored.length).toBeGreaterThan(8);
    expect([...recorded].sort((a, b) => a - b)).toEqual(stored);
    for (const c of session.calls) expect(c.seqs).toEqual([...c.seqs].sort((a, b) => a - b));
  });

  it("[LDB-MIR6] replayed into a fresh D1 store: the same outcomes, seqs, clock reads and rows", async () => {
    await applyD1Migrations(e.DB_REPLAY, e.TEST_MIGRATIONS);
    const replayed: TeeCall[] = [];
    const target = recordingStore(createD1Store(observeD1(e.DB_REPLAY)), (c) => replayed.push(c));
    for (const c of session.calls) {
      const [area, method] = c.method.split(".") as [string, string];
      const args = (decodeTee(JSON.parse(JSON.stringify(c.args))) as unknown[]).map((a) => (a instanceof RecordedClock ? replayClock(a) : a));
      const fn = (target as unknown as Record<string, Record<string, (...a: unknown[]) => Promise<unknown>>>)[area]![method]!;
      try {
        await fn(...args);
      } catch {
        // the recorded outcome says whether this was expected; compared below
      }
    }
    const strip = (c: TeeCall) => ({ ...c, atMs: 0 });
    expect(replayed.map(strip)).toEqual(session.calls.map(strip));
    expect(await snapshot(e.DB_REPLAY)).toEqual(session.rows);
  });

  it("[LDB-MIR7] the tee changes no response, and with it off nothing is recorded or sent", async () => {
    // A second pass is not byte-comparable (new ids), so compare shape: statuses and error bodies of the refusals.
    const refusal = session.responses.find(([l]) => l.startsWith("name taken"))!;
    expect(JSON.parse(refusal[2])).toMatchObject({ error: "name_taken" });
    const fake = actorFixture();
    stubFetch(fake.fetchImpl as typeof fetch);
    const before = batches.length;
    const own = register(fake, "tok-mir-owner-off", "owner-mirror-off");
    const name = uniqueName("mirror-off");
    expect((await writeFetch("/v1/layouts", "POST", own, { name, format: "spark/1", payload: AKL_PAYLOAD })).status).toBe(201);
    const again = await writeFetch("/v1/layouts", "POST", own, { name, format: "spark/1", payload: AKL_PAYLOAD });
    expect(again.status).toBe(409);
    expect(JSON.parse(await again.text())).toMatchObject({ error: "name_taken" });
    await sleep(70);
    expect(batches.length).toBe(before); // off: nothing recorded, nothing sent
  });

  it("[LDB-MIR8] a failing sink is retried three times, then one TEE_FAILED line, and the write is unaffected", async () => {
    const fake = actorFixture();
    stubFetch(fake.fetchImpl as typeof fetch);
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    const before = batches.length;
    sinkFails = 100;
    const calls: TeeCall[] = [];
    const sender = createTeeSender({ url: SINK_URL, secret: SECRET, direction: "d1->ddb", background: (p) => void p, settleMs: 1, backoffMs: [1, 1] });
    sender.add(session.calls[0]!);
    await sleep(120);
    expect(100 - sinkFails).toBe(3);
    const failed = errors.mock.calls.filter((c) => String(c[0]).startsWith("TEE_FAILED"));
    expect(failed).toHaveLength(1);
    expect(batches.length).toBe(before);
    // and a sink that recovers on the third try gets the batch once
    sinkFails = 2;
    sender.add(session.calls[1]!);
    await sleep(120);
    expect(batches.length).toBe(before + 1);
    errors.mockRestore();
    sinkFails = 0;
    void calls;
  });

  it("[LDB-MIR9] a recording failure never reaches the caller: a throwing sink, an unencodable argument", async () => {
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    const inner = createD1Store(e.DB_REPLAY);
    const throwing = recordingStore(inner, () => {
      throw new Error("sink exploded");
    });
    await expect(throwing.state.put("mir-key", "v")).resolves.toBeUndefined();
    await expect(throwing.state.get("mir-key")).resolves.toBe("v");
    // An argument the codec refuses: the write still happens and returns, the record is dropped with one log line.
    const sunk: TeeCall[] = [];
    const lossy = recordingStore(inner, (c) => sunk.push(c));
    class Odd {
      a = 1;
    }
    const clock = steppingClock("2026-10-22T00:00:00.000Z", 1000);
    await expect(lossy.events.appendAdmin(clock, { kind: "admin.added", actor: "mir-odd", detail: new Odd() })).resolves.toMatchObject({ seq: expect.any(Number) });
    expect(sunk).toEqual([]);
    expect(errors.mock.calls.some((c) => String(c[0]).startsWith("TEE_FAILED"))).toBe(true);
    // A thrown error is the very same object, rethrown.
    const boom = new Error("boom");
    const failing = recordingStore({ ...inner, state: { ...inner.state, put: () => Promise.reject(boom) } } as Store, (c) => sunk.push(c));
    await expect(failing.state.put("k", "v")).rejects.toBe(boom);
    expect(sunk).toHaveLength(1);
    expect(sunk[0]!.outcome).toEqual({ error: { name: "Error", message: "boom" } });
    errors.mockRestore();
  });
});

describe("the default build is untouched", () => {
  it("[LDB-MIR11] with TEE_URL or TEE_SECRET unset, teeEnv is the identity and the store is the plain D1 store", () => {
    const ctx = { waitUntil: () => {} };
    const live = env as unknown as Bindings;
    expect(teeEnv(live, ctx)).toBe(live);
    e.TEE_URL = SINK_URL;
    try {
      expect(teeEnv(live, ctx)).toBe(live);
    } finally {
      delete e.TEE_URL;
    }
    e.TEE_SECRET = SECRET;
    try {
      expect(teeEnv(live, ctx)).toBe(live);
    } finally {
      delete e.TEE_SECRET;
    }
    expect((live.DB as unknown as Record<symbol, unknown>)[TEE_TAG]).toBeUndefined();
    // Set, it is a different env whose DB is tagged; the original env is never mutated.
    e.TEE_URL = SINK_URL;
    e.TEE_SECRET = SECRET;
    try {
      const on = teeEnv(live, ctx);
      expect(on).not.toBe(live);
      expect((on.DB as unknown as Record<symbol, unknown>)[TEE_TAG]).toBeDefined();
      expect((live.DB as unknown as Record<symbol, unknown>)[TEE_TAG]).toBeUndefined();
      expect(on.DUMPS).toBe(live.DUMPS);
      expect(teeEnv(on, ctx)).toBe(on);
    } finally {
      delete e.TEE_URL;
      delete e.TEE_SECRET;
    }
  });
});

describe("the recorder adds no D1 round trip (LDB-L8 holds)", () => {
  // One round trip = one first/all/run/raw on a statement, or one batch on the database (LDB-L8's own count).
  class CountingStatement {
    constructor(
      readonly inner: D1PreparedStatement,
      private readonly n: { rt: number },
    ) {}
    bind(...v: unknown[]) {
      return new CountingStatement(this.inner.bind(...v), this.n);
    }
    run() {
      this.n.rt++;
      return this.inner.run();
    }
    all() {
      this.n.rt++;
      return this.inner.all();
    }
    first(c?: string) {
      this.n.rt++;
      return c === undefined ? this.inner.first() : this.inner.first(c);
    }
    raw(o?: never) {
      this.n.rt++;
      return this.inner.raw(o);
    }
  }
  function counting(db: D1Database, n: { rt: number }): D1Database {
    return {
      prepare: (q: string) => new CountingStatement(db.prepare(q), n),
      batch: (ss: CountingStatement[]) => {
        n.rt++;
        return db.batch(ss.map((x) => x.inner));
      },
      exec: (q: string) => db.exec(q),
      withSession: (c?: string) => db.withSession(c),
      dump: () => db.dump(),
    } as unknown as D1Database;
  }

  async function workload(s: Store): Promise<void> {
    const clock = steppingClock("2026-10-21T00:00:00.000Z", 1000);
    await s.state.put("rt-key", "1");
    await s.admin.insertAdmin({ user_id: "rt-admin", added_by: "x", added_at: clock(), note: null });
    await s.events.appendAdmin(clock, { kind: "admin.added", actor: "rt-admin", detail: { a: 1 } });
    await s.auth.reserveIdempotency({ scope: "rt", key: "k", method: "POST", path: "/p", request_hash: "h", at: clock() });
    await s.auth.completeIdempotency("rt", "k", 200, "{}", clock());
    await s.auth.touchClientAuthor("rt-author", clock(), clock());
    await s.state.delete("rt-key");
  }

  it("[LDB-MIR10] the same store calls cost the same round trips with and without the recorder", async () => {
    await applyD1Migrations(e.DB_REPLAY, e.TEST_MIGRATIONS);
    const plain = { rt: 0 };
    await workload(createD1Store(counting(e.DB_REPLAY, plain)));
    expect(plain.rt).toBeGreaterThan(5);
    // Back to the state before the first run, so the second takes the same paths.
    for (const q of ["DELETE FROM admins WHERE user_id = 'rt-admin'", "DELETE FROM events WHERE actor = 'rt-admin'", "DELETE FROM idempotency WHERE scope = 'rt'", "DELETE FROM import_state WHERE key = 'rt-key'", "DELETE FROM authors WHERE user_id = 'rt-author'"]) {
      await e.DB_REPLAY.prepare(q).run();
    }
    const seen: TeeCall[] = [];
    const withTee = { rt: 0 };
    await workload(recordingStore(createD1Store(observeD1(counting(e.DB_REPLAY, withTee))), (c) => seen.push(c)));
    expect(withTee.rt).toBe(plain.rt);
    expect(seen.map((c) => c.method)).toEqual(["state.put", "admin.insertAdmin", "events.appendAdmin", "auth.reserveIdempotency", "auth.completeIdempotency", "auth.touchClientAuthor", "state.delete"]);
    expect(seen[2]!.seqs).toHaveLength(1);
  });
});
