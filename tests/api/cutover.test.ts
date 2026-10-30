// [LDB-CUT1..CUT12] Lane U, the Worker side of the cutover (design/aws-port.md §3, §5.2): the long-poll hold budget and the
// `read_only` / `proxy` modes. Dual-backend: the same file runs on D1 (workers project) and on DynamoDB (ddb project), so both
// stores are held to one behaviour.
import { SELF, store, testStore } from "../harness";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fixedClock } from "../../src/core/time";
import { holdBudgetSeconds } from "../../src/core/longpoll";
import { generateKeyPair, seedClient, signHeaders } from "../auth/client-support";
import { bindings } from "./support";

const NOW = fixedClock("2026-09-12T00:00:00.000Z");
const env = bindings as unknown as Record<string, unknown>;

// One UTC day per test so the day's spend never leaks between tests (the budget rows are shared state).
let dayCounter = 0;
function freshDay(): string {
  dayCounter += 1;
  return `2031-${String(1 + (dayCounter % 12)).padStart(2, "0")}-${String(1 + Math.floor(dayCounter / 12)).padStart(2, "0")}`;
}
const at = (day: string, hhmmss = "12:00:00") => fixedClock(`${day}T${hhmmss}.000Z`);

afterEach(() => {
  for (const k of ["TEST_LONGPOLL_SLEEP", "TEST_CLOCK", "HOLD_BUDGET_SECONDS", "CUTOVER_PROXY_URL", "TEST_CUTOVER_FETCH"]) delete env[k];
});

describe("the hold budget, store level", () => {
  it("[LDB-CUT1] one live hold per client: a second take is declined until the first is released or has expired", async () => {
    const day = freshDay();
    const c = `u-lease-${crypto.randomUUID()}`;
    expect(await store.holds.takeHold(c, 25, at(day), 1000)).toBe(true);
    expect(await store.holds.takeHold(c, 25, at(day), 1000)).toBe(false);
    await store.holds.releaseHold(c, 25);
    expect(await store.holds.takeHold(c, 25, at(day), 1000)).toBe(true);
    // 25 s hold + 5 s slack from 12:00:00: still live at 12:00:30, free again at 12:00:31.
    expect(await store.holds.takeHold(c, 25, at(day, "12:00:30"), 1000)).toBe(false);
    expect(await store.holds.takeHold(c, 25, at(day, "12:00:31"), 1000)).toBe(true);
    // Another client is independent.
    expect(await store.holds.takeHold(`${c}-other`, 25, at(day), 1000)).toBe(true);
  });

  it("[LDB-CUT2] a global hold-seconds budget per UTC day: spend is counted, a declined take leaves no lease, the next day starts fresh", async () => {
    const day = freshDay();
    const [a, b, c, d] = ["a", "b", "c", "d"].map((x) => `u-budget-${x}-${crypto.randomUUID()}`) as [string, string, string, string];
    expect(await store.holds.takeHold(a, 25, at(day), 60)).toBe(true); // 25
    expect(await store.holds.takeHold(b, 25, at(day), 60)).toBe(true); // 50
    expect(await store.holds.takeHold(c, 25, at(day), 60)).toBe(false); // 75 > 60
    expect(await store.holds.takeHold(c, 10, at(day), 60)).toBe(true); // the declined take left no lease; 60 of 60
    expect(await store.holds.takeHold(d, 1, at(day), 60)).toBe(false);
    // Releasing does not refund the day's spend.
    await store.holds.releaseHold(a, 25);
    expect(await store.holds.takeHold(a, 1, at(day), 60)).toBe(false);
    // The next UTC day is a fresh budget.
    const next = new Date(Date.parse(`${day}T00:00:00Z`) + 86400_000).toISOString().slice(0, 10);
    expect(await store.holds.takeHold(a, 25, at(next), 60)).toBe(true);
  });

  it("[LDB-CUT3] the budget argument is the limit (default 20000 on the store); the route enforces only with HOLD_BUDGET_SECONDS set", async () => {
    const day = freshDay();
    const k = `u-default-${crypto.randomUUID()}`;
    expect(await store.holds.takeHold(k, 25, at(day))).toBe(true); // default 20000
    // Unset (or not a positive number) means no budget at all: the route grants every hold and writes nothing.
    expect(holdBudgetSeconds({} as never)).toBeNull();
    expect(holdBudgetSeconds({ HOLD_BUDGET_SECONDS: "45000" } as never)).toBe(45_000);
    for (const bad of ["", "0", "-5", "abc", "NaN"]) expect(holdBudgetSeconds({ HOLD_BUDGET_SECONDS: bad } as never), bad).toBeNull();
  });

  it("[LDB-CUT2] release refunds the unused part of the reservation, to the day it was taken from, so the budget counts real hold seconds", async () => {
    const day = freshDay();
    const [a, b, c] = ["a", "b", "c"].map((x) => `u-refund-${x}-${crypto.randomUUID()}`) as [string, string, string];
    expect(await store.holds.takeHold(a, 25, at(day), 30)).toBe(true); // 25 of 30 reserved
    expect(await store.holds.takeHold(b, 25, at(day), 30)).toBe(false);
    await store.holds.releaseHold(a, 5); // it held 5 s: 20 come back, 5 stay
    expect(await store.holds.takeHold(b, 25, at(day), 30)).toBe(true); // 5 + 25 = 30
    expect(await store.holds.takeHold(c, 1, at(day), 30)).toBe(false);
    await store.holds.releaseHold(b, 99); // more than reserved: nothing to refund, never negative
    expect(await store.holds.takeHold(c, 1, at(day), 30)).toBe(false);
    // Released after midnight, the refund still goes to the day the hold was taken on.
    const d2 = freshDay();
    const late = `${d2}T23:59:50.000Z`;
    const after = new Date(Date.parse(late) + 20_000).toISOString();
    expect(await store.holds.takeHold(c, 25, fixedClock(late), 40)).toBe(true);
    await store.holds.releaseHold(c, 10);
    const next = new Date(Date.parse(`${d2}T00:00:00Z`) + 86400_000).toISOString().slice(0, 10);
    expect(await store.holds.takeHold(a, 40, fixedClock(`${d2}T23:59:55.000Z`), 40)).toBe(false); // c's 10 s still count that day (50 > 40)
    expect(after.slice(0, 10)).toBe(next);
    expect(await store.holds.takeHold(b, 40, fixedClock(after), 40)).toBe(true); // the new day is untouched by the refund
    await store.holds.releaseHold(b, 40);
  });
});

describe("the hold budget, GET /v1/changes?wait=", () => {
  async function client(): Promise<{ privateKey: CryptoKey; clientId: string; actor: string }> {
    const { privateKey, pubkeyB64url } = await generateKeyPair();
    const clientId = `u-hold-${crypto.randomUUID()}`;
    const actor = "800000000000000201";
    await seedClient(NOW, { id: clientId, pubkeyB64url, ownerUserId: actor, caps: "act-as-owner-only" });
    return { privateKey, clientId, actor };
  }
  async function wait(c: { privateKey: CryptoKey; clientId: string; actor: string }, query: string): Promise<Response> {
    const path = `/v1/changes${query}`;
    return SELF.fetch(`https://example.com${path}`, { method: "GET", headers: await signHeaders({ ...c, method: "GET", pathWithQuery: path }) });
  }
  function sleepSpy(effect?: () => Promise<void>): { calls: number } {
    const s = { calls: 0 };
    env.TEST_LONGPOLL_SLEEP = async () => {
      s.calls += 1;
      if (s.calls === 1 && effect) await effect();
    };
    return s;
  }

  it("[LDB-CUT4] over the day's budget a hold is declined: the immediate page, X-Wait-Ignored: budget, no waiting, no error", async () => {
    env.TEST_CLOCK = at(freshDay());
    env.HOLD_BUDGET_SECONDS = "30";
    const c1 = await client();
    const c2 = await client();
    const s = sleepSpy();
    const first = await wait(c1, "?wait=25");
    expect(first.status).toBe(200);
    expect(first.headers.get("X-Wait-Ignored")).toBeNull();
    const calls = s.calls;
    const second = await wait(c2, "?wait=25"); // 25 + 25 > 30
    expect(second.status).toBe(200);
    expect(second.headers.get("X-Wait-Ignored")).toBe("budget");
    expect(s.calls).toBe(calls); // it did not hold
    expect(second.headers.get("ETag")).not.toBeNull();
    expect(second.headers.get("Cache-Control")).toBe("public, max-age=10");
    const body = await second.json<{ items: unknown[] }>();
    expect(Array.isArray(body.items)).toBe(true);
  });

  it("[LDB-CUT5] a second concurrent hold by the same client is declined; the lease is released when the hold ends, and wait=0 takes none", async () => {
    env.TEST_CLOCK = at(freshDay());
    env.HOLD_BUDGET_SECONDS = "100000";
    const c = await client();
    let inner: Response | undefined;
    sleepSpy(async () => {
      inner = await wait(c, "?wait=25"); // mid-hold, same client
    });
    const outer = await wait(c, "?wait=25&since=999999999");
    expect(outer.headers.get("X-Wait-Ignored")).toBeNull();
    expect(inner?.headers.get("X-Wait-Ignored")).toBe("budget");
    // The first hold ended: the client may hold again.
    env.TEST_LONGPOLL_SLEEP = async () => {};
    expect((await wait(c, "?wait=25")).headers.get("X-Wait-Ignored")).toBeNull();
    // wait=0 holds nothing and spends nothing, even with the day exhausted.
    env.HOLD_BUDGET_SECONDS = "1";
    const zero = await wait(c, "?wait=0");
    expect(zero.status).toBe(200);
    expect(zero.headers.get("X-Wait-Ignored")).toBeNull();
  });

  it("[LDB-CUT5] with HOLD_BUDGET_SECONDS unset every hold is granted and nothing is written for it", async () => {
    env.TEST_CLOCK = at(freshDay());
    const c = await client();
    let inner: Response | undefined;
    sleepSpy(async () => {
      inner = await wait(c, "?wait=25"); // mid-hold, same client: no lease exists, so it is not declined either
    });
    const outer = await wait(c, "?wait=25&since=999999999");
    expect(outer.headers.get("X-Wait-Ignored")).toBeNull();
    expect(inner?.headers.get("X-Wait-Ignored")).toBeNull();
    const keys = (await testStore.rows("ratelimit")).map((r) => String(r.key));
    expect(keys.filter((k) => k === `hold:${c.clientId}` || k === `holdrsv:${c.clientId}` || k === `holds:${(env.TEST_CLOCK as () => string)().slice(0, 10)}`)).toEqual([]);
  });

  it("[LDB-CUT5] an unauthenticated wait= is still ignored as unauthorized and takes no hold", async () => {
    const res = await SELF.fetch("https://example.com/v1/changes?wait=25");
    expect(res.headers.get("X-Wait-Ignored")).toBe("unauthorized");
  });
});

describe("the cutover modes", () => {
  // The mode is cached for 1 s per isolate (store.cutover.mode), so a flip is visible after the cache has run out.
  const cacheExpiry = () => new Promise<void>((r) => setTimeout(r, 1100));
  async function setMode(mode: string | null): Promise<void> {
    if (mode === null) await store.state.delete("cutover.mode");
    else await store.state.put("cutover.mode", mode);
    await cacheExpiry();
  }
  beforeEach(async () => {
    env.CUTOVER_ARMED = "on";
    await setMode(null);
  });
  afterEach(async () => {
    await setMode(null);
    delete env.CUTOVER_ARMED;
  });

  async function signedPost(clientId: string, privateKey: CryptoKey, actor: string, path: string, body: string, extra: Record<string, string> = {}): Promise<Response> {
    const bytes = new TextEncoder().encode(body);
    const headers = await signHeaders({ privateKey, clientId, actor, method: "POST", pathWithQuery: path, body: bytes });
    return SELF.fetch(`https://example.com${path}`, { method: "POST", headers: { ...headers, "Content-Type": "application/json", ...extra }, body });
  }
  async function newClient(): Promise<{ clientId: string; privateKey: CryptoKey; actor: string }> {
    const { privateKey, pubkeyB64url } = await generateKeyPair();
    const clientId = `u-mode-${crypto.randomUUID()}`;
    const actor = "800000000000000202";
    await seedClient(NOW, { id: clientId, pubkeyB64url, ownerUserId: actor, caps: "act-as-owner-only" });
    return { clientId, privateKey, actor };
  }

  it("[LDB-CUT6] with no mode set (or an unknown value) nothing changes: reads and writes are handled as ever", async () => {
    const c = await newClient();
    expect((await SELF.fetch("https://example.com/v1/meta")).status).toBe(200);
    const w = await signedPost(c.clientId, c.privateKey, c.actor, "/v1/layouts", "{}");
    expect(w.status).not.toBe(503);
    await setMode("garbage");
    expect((await SELF.fetch("https://example.com/v1/meta")).status).toBe(200);
    expect((await signedPost(c.clientId, c.privateKey, c.actor, "/v1/layouts", "{}")).status).not.toBe(503);
  });

  it("[LDB-CUT6] unarmed (CUTOVER_ARMED unset, production D1 today) the stored flags are never read: read_only and jobs.enabled=off change nothing", async () => {
    delete env.CUTOVER_ARMED;
    const c = await newClient();
    await setMode("read_only");
    await store.state.put("jobs.enabled", "off");
    try {
      expect((await signedPost(c.clientId, c.privateKey, c.actor, "/v1/layouts", "{}")).status).not.toBe(503);
      const { createExecutionContext, createScheduledController, waitOnExecutionContext } = await import("../harness");
      const worker = (await import("../../src/index")).default;
      const logs: string[] = [];
      const spy = vi.spyOn(console, "log").mockImplementation((m: unknown) => void logs.push(String(m)));
      try {
        const ctx = createExecutionContext();
        await worker.scheduled(createScheduledController({ scheduledTime: new Date("2031-05-05T03:00:00Z"), cron: "*/5 * * * *" }), bindings, ctx);
        await waitOnExecutionContext(ctx);
      } finally {
        spy.mockRestore();
      }
      expect(logs.some((l) => l.includes("skipped,"))).toBe(false);
    } finally {
      await store.state.delete("jobs.enabled");
    }
  });

  it("[LDB-CUT7] read_only: writes get 503 read_only with Retry-After, reads continue, HEAD included", async () => {
    const c = await newClient();
    await setMode("read_only");
    const w = await signedPost(c.clientId, c.privateKey, c.actor, "/v1/layouts", "{}");
    expect(w.status).toBe(503);
    expect(w.headers.get("Retry-After")).toBe("5");
    const body = await w.json<{ error: string; message: string; retry_after: number }>();
    expect(body.error).toBe("read_only");
    expect(body.retry_after).toBe(5);
    expect(w.headers.get("X-AKLDB-API")).not.toBeNull();
    for (const method of ["GET", "HEAD"]) expect((await SELF.fetch("https://example.com/v1/meta", { method })).status, method).toBe(200);
    // Back to normal as soon as the flag is cleared.
    await setMode(null);
    expect((await signedPost(c.clientId, c.privateKey, c.actor, "/v1/layouts", "{}")).status).not.toBe(503);
  });

  it("[LDB-CUT8] read_only sits after the actor and before idempotency and the rate limit: anonymous is still 401, a frozen write is neither charged nor stored", async () => {
    const c = await newClient();
    await setMode("read_only");
    const anon = await SELF.fetch("https://example.com/v1/layouts", { method: "POST", body: "{}" });
    expect(anon.status).toBe(401);
    const before = await testStore.count("ratelimit", { key: `write:${c.actor}` });
    const idemBefore = await testStore.count("idempotency");
    const res = await signedPost(c.clientId, c.privateKey, c.actor, "/v1/layouts", "{}", { "Idempotency-Key": `k-${crypto.randomUUID()}` });
    expect(res.status).toBe(503);
    expect(await testStore.count("ratelimit", { key: `write:${c.actor}` })).toBe(before);
    expect(await testStore.count("idempotency")).toBe(idemBefore);
  });

  it("[LDB-CUT9] read_only also freezes the Discord interaction POST", async () => {
    await setMode("read_only");
    const res = await SELF.fetch("https://example.com/discord/interactions", { method: "POST", body: "{}" });
    expect(res.status).toBe(503);
    expect((await res.json<{ error: string }>()).error).toBe("read_only");
  });

  it("[LDB-CUT10] proxy forwards method, path, query, headers and body to CUTOVER_PROXY_URL and returns the answer as is", async () => {
    const seen: { url: string; method: string; headers: Headers; body: string }[] = [];
    env.CUTOVER_PROXY_URL = "https://aws.example.test/base";
    env.TEST_CUTOVER_FETCH = async (url: string, init: RequestInit) => {
      seen.push({ url, method: String(init.method), headers: new Headers(init.headers), body: init.body ? new TextDecoder().decode(init.body as ArrayBuffer) : "" });
      return new Response('{"from":"aws"}', { status: 418, headers: { "Content-Type": "application/json", ETag: '"aws-etag"', "X-AKLDB-API": "9.9", Location: "/elsewhere" } });
    };
    await setMode("proxy");
    const res = await SELF.fetch("https://example.com/v1/layouts/abc?x=1&y=2", {
      method: "PATCH",
      headers: { Authorization: "Bearer tok", "If-Match": '"layout:3"', "X-Custom": "yes" },
      body: '{"name":"n"}',
    });
    expect(res.status).toBe(418);
    expect(await res.text()).toBe('{"from":"aws"}');
    expect(res.headers.get("ETag")).toBe('"aws-etag"');
    expect(res.headers.get("X-AKLDB-API")).toBe("9.9"); // the AWS answer's own, not rebuilt locally
    expect(res.headers.get("Location")).toBe("/elsewhere");
    expect(seen).toHaveLength(1);
    const s = seen[0]!;
    expect(s.url).toBe("https://aws.example.test/v1/layouts/abc?x=1&y=2");
    expect(s.method).toBe("PATCH");
    expect(s.body).toBe('{"name":"n"}');
    expect(s.headers.get("authorization")).toBe("Bearer tok");
    expect(s.headers.get("if-match")).toBe('"layout:3"');
    expect(s.headers.get("x-custom")).toBe("yes");
    expect(s.headers.get("x-akldb-proxied")).toBe("1");
    expect(s.headers.get("host")).toBeNull();
    // GET carries no body; HEAD and the Discord path are forwarded too.
    await SELF.fetch("https://example.com/v1/meta");
    expect(seen[1]!.method).toBe("GET");
    expect(seen[1]!.body).toBe("");
    await SELF.fetch("https://example.com/discord/interactions", { method: "POST", body: "raw" });
    expect(seen[2]!.url).toBe("https://aws.example.test/discord/interactions");
    expect(seen[2]!.body).toBe("raw");
  });

  it("[LDB-CUT11] proxy never loops or half-works: an already-proxied request is served locally; a missing URL or a failing upstream is a 500, never a local answer", async () => {
    let calls = 0;
    env.CUTOVER_PROXY_URL = "https://aws.example.test";
    env.TEST_CUTOVER_FETCH = async () => {
      calls += 1;
      throw new Error("connection refused");
    };
    await setMode("proxy");
    const loop = await SELF.fetch("https://example.com/v1/meta", { headers: { "X-Akldb-Proxied": "1" } });
    expect(loop.status).toBe(200);
    expect(calls).toBe(0);
    const down = await SELF.fetch("https://example.com/v1/meta");
    expect(down.status).toBe(500);
    expect((await down.json<{ error: string }>()).error).toBe("internal");
    delete env.CUTOVER_PROXY_URL;
    const unset = await SELF.fetch("https://example.com/v1/meta");
    expect(unset.status).toBe(500);
    expect(calls).toBe(1);
  });

  it("[LDB-CUT12] a cutover mode skips the scheduled jobs: nothing may write after the final seq", async () => {
    const { createExecutionContext, createScheduledController, waitOnExecutionContext } = await import("../harness");
    const worker = (await import("../../src/index")).default;
    const run = async () => {
      const ctx = createExecutionContext();
      await worker.scheduled(createScheduledController({ scheduledTime: new Date("2031-05-05T03:00:00Z"), cron: "*/5 * * * *" }), bindings, ctx);
      await waitOnExecutionContext(ctx);
    };
    await setMode("read_only");
    const logs: string[] = [];
    const spy = vi.spyOn(console, "log").mockImplementation((m: unknown) => void logs.push(String(m)));
    await run();
    spy.mockRestore();
    expect(logs.some((l) => l.includes("skipped, a cutover mode is on"))).toBe(true);
  });

  it("[LDB-CUT12] the jobs flag off makes a scheduled tick a no-op, as data (STATE/jobs.enabled), with no mode set", async () => {
    const { createExecutionContext, createScheduledController, waitOnExecutionContext } = await import("../harness");
    const worker = (await import("../../src/index")).default;
    await store.state.put("jobs.enabled", "off");
    const logs: string[] = [];
    const spy = vi.spyOn(console, "log").mockImplementation((m: unknown) => void logs.push(String(m)));
    try {
      const ctx = createExecutionContext();
      await worker.scheduled(createScheduledController({ scheduledTime: new Date("2031-05-05T03:00:00Z"), cron: "*/5 * * * *" }), bindings, ctx);
      await waitOnExecutionContext(ctx);
    } finally {
      spy.mockRestore();
      await store.state.delete("jobs.enabled");
    }
    expect(logs.some((l) => l.includes("skipped, jobs are disabled"))).toBe(true);
  });
});
