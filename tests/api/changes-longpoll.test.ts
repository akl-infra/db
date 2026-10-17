// [LDB-CH1..CH6] GET /v1/changes?wait= (LEDGER.md L4): a long-poll,
// honoured for every registered client (the `feed:wait` cap is legacy, implied).
// `TEST_LONGPOLL_SLEEP` (a miniflare binding pinned per test, `src/routes/
// changes.ts`'s `resolveSleep`) replaces the real 1s `setTimeout` so these
// run fast and deterministic -- no real waiting anywhere in this file.
import { SELF, env } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Bindings } from "../../src/env";
import { appendAdmin } from "../../src/core/events";
import { fixedClock } from "../../src/core/time";
import { clampWaitSeconds, MAX_WAIT_SECONDS, waitForChanges } from "../../src/core/longpoll";
import { generateKeyPair, seedClient, signHeaders } from "../auth/client-support";
import { bindings, db } from "./support";

const NOW = fixedClock("2026-09-12T00:00:00.000Z");

async function appendBareAdminEvent(): Promise<void> {
  await appendAdmin(db, NOW, { kind: "admin.import_paused", actor: "system:test" });
}

function setSleepSpy(): { calls: number[]; sideEffects: (() => void | Promise<void>)[] } {
  const state = { calls: [] as number[], sideEffects: [] as (() => void | Promise<void>)[] };
  let i = 0;
  (bindings as unknown as { TEST_LONGPOLL_SLEEP: (ms: number) => Promise<void> }).TEST_LONGPOLL_SLEEP = async (ms: number) => {
    state.calls.push(ms);
    const effect = state.sideEffects[i];
    i++;
    if (effect !== undefined) await effect();
  };
  return state;
}

async function signedGetChanges(privateKey: CryptoKey, clientId: string, actor: string, query: string): Promise<Response> {
  const path = `/v1/changes${query}`;
  const headers = await signHeaders({ privateKey, clientId, actor, method: "GET", pathWithQuery: path });
  return SELF.fetch(`https://example.com${path}`, { method: "GET", headers });
}

beforeEach(async () => {
  await db.batch([db.prepare("DELETE FROM events"), db.prepare("DELETE FROM layout_revs")]);
});

afterEach(() => {
  delete (bindings as unknown as { TEST_LONGPOLL_SLEEP?: unknown }).TEST_LONGPOLL_SLEEP;
});

describe("clampWaitSeconds (pure)", () => {
  it("[LDB-CH4] clamps to [0, MAX_WAIT_SECONDS]", () => {
    expect(clampWaitSeconds(-5)).toBe(0);
    expect(clampWaitSeconds(0)).toBe(0);
    expect(clampWaitSeconds(10)).toBe(10);
    expect(clampWaitSeconds(MAX_WAIT_SECONDS)).toBe(MAX_WAIT_SECONDS);
    expect(clampWaitSeconds(9999)).toBe(MAX_WAIT_SECONDS);
    // Non-finite input (never reached through the route -- `parseWait`
    // rejects it with `400 bad_request` first) is defensively 0, not MAX.
    expect(clampWaitSeconds(Number.POSITIVE_INFINITY)).toBe(0);
    expect(clampWaitSeconds(Number.NaN)).toBe(0);
  });
});

describe("[LDB-CH1..CH5] GET /v1/changes?wait= gating and behavior", () => {
  it("[LDB-CH3] wait= without the feed:wait cap is ignored: immediate answer, X-Wait-Ignored header, no error", async () => {
    const before = await appendBareAdminEvent().then(() => SELF.fetch("https://example.com/v1/changes"));
    const beforeBody = await before.json<{ next: number }>();

    // Totally unauthenticated -- no signature at all.
    const res = await SELF.fetch("https://example.com/v1/changes?wait=25");
    expect(res.status).toBe(200);
    expect(res.headers.get("X-Wait-Ignored")).toBe("unauthorized");
    const body = await res.json<{ next: number }>();
    expect(body.next).toBe(beforeBody.next); // the immediate page, nothing waited for
  });

  it("[LDB-CH3] a signed client WITHOUT the (legacy, now implied) feed:wait cap is honoured like any registered client (saltorbit 2026-09-13)", async () => {
    const { privateKey, pubkeyB64url } = await generateKeyPair();
    const clientId = `test-client-nowait-${crypto.randomUUID()}`;
    const actor = "800000000000000101";
    await seedClient(db, NOW, { id: clientId, pubkeyB64url, ownerUserId: actor, caps: "act-as-owner-only" }); // no feed:wait

    const res = await signedGetChanges(privateKey, clientId, actor, "?wait=5");
    expect(res.status).toBe(200);
    expect(res.headers.get("X-Wait-Ignored")).toBeNull();
  });

  it("[LDB-CH1] [LDB-CH5] with nothing happening, a held wait returns the immediate page within its budget, at <= wait+1 D1 head-reads", async () => {
    const { privateKey, pubkeyB64url } = await generateKeyPair();
    const clientId = `test-client-wait-${crypto.randomUUID()}`;
    const actor = "800000000000000102";
    await seedClient(db, NOW, { id: clientId, pubkeyB64url, ownerUserId: actor, caps: "act-as-owner-only,feed:wait" });

    const sleeps = setSleepSpy();
    const waitSeconds = 3;
    const res = await signedGetChanges(privateKey, clientId, actor, `?wait=${waitSeconds}`);
    expect(res.status).toBe(200);
    expect(res.headers.get("X-Wait-Ignored")).toBeNull();
    const body = await res.json<{ next: number; items: unknown[] }>();
    expect(Array.isArray(body.items)).toBe(true);

    // waitForChanges sleeps once per check except the last -- ceil(wait)
    // checks total, ceil(wait)-1 sleeps in between (invariant (e): reads
    // during the hold <= wait+1; sleeps are one fewer than reads).
    expect(sleeps.calls.length).toBeLessThanOrEqual(waitSeconds);
    for (const ms of sleeps.calls) expect(ms).toBe(1000);
  });

  it("[LDB-CH2] returns as soon as an event lands mid-wait, without exhausting the full budget", async () => {
    const { privateKey, pubkeyB64url } = await generateKeyPair();
    const clientId = `test-client-wait2-${crypto.randomUUID()}`;
    const actor = "800000000000000103";
    await seedClient(db, NOW, { id: clientId, pubkeyB64url, ownerUserId: actor, caps: "act-as-owner-only,feed:wait" });

    const before = await SELF.fetch("https://example.com/v1/changes");
    const beforeBody = await before.json<{ next: number }>();

    const sleeps = setSleepSpy();
    // On the FIRST sleep (between the 1st and 2nd head-check), append a
    // real event -- the 2nd check should then see it and return, well
    // short of the 20s budget.
    sleeps.sideEffects[0] = async () => {
      await appendBareAdminEvent();
    };

    const res = await signedGetChanges(privateKey, clientId, actor, `?wait=20&since=${beforeBody.next}`);
    expect(res.status).toBe(200);
    const body = await res.json<{ next: number; items: { kind: string }[] }>();
    expect(body.next).toBeGreaterThan(beforeBody.next);
    expect(body.items.some((i) => i.kind === "admin.import_paused")).toBe(true);
    // Returned after the FIRST sleep resolved the event, not all 20.
    expect(sleeps.calls.length).toBeLessThan(20);
  });

  it("[LDB-CH4] wait is clamped to MAX_WAIT_SECONDS even when a caller asks for more", async () => {
    const { privateKey, pubkeyB64url } = await generateKeyPair();
    const clientId = `test-client-wait3-${crypto.randomUUID()}`;
    const actor = "800000000000000104";
    await seedClient(db, NOW, { id: clientId, pubkeyB64url, ownerUserId: actor, caps: "act-as-owner-only,feed:wait" });

    const sleeps = setSleepSpy();
    const res = await signedGetChanges(privateKey, clientId, actor, "?wait=9999");
    expect(res.status).toBe(200);
    // ceil(MAX_WAIT_SECONDS) + 1 reads total -> at most MAX_WAIT_SECONDS
    // sleeps in between, never anywhere near 9999.
    expect(sleeps.calls.length).toBeLessThanOrEqual(MAX_WAIT_SECONDS);
  });

  it("without wait=, behavior is unchanged: immediate, cacheable, no header", async () => {
    const res = await SELF.fetch("https://example.com/v1/changes");
    expect(res.status).toBe(200);
    expect(res.headers.get("X-Wait-Ignored")).toBeNull();
    expect(res.headers.get("Cache-Control")).toBe("public, max-age=10");
    expect(res.headers.get("ETag")).not.toBeNull();
  });
});

// A DB whose `MAX(seq)` head read throws on the listed 0-based calls.
function dbFailingHeadReads(real: D1Database, failOn: Set<number>): { db: D1Database; reads: () => number } {
  let n = 0;
  const wrapped = new Proxy(real, {
    get(target, prop) {
      if (prop === "prepare") {
        return (sql: string) => {
          const stmt = target.prepare(sql);
          if (!sql.includes("MAX(seq) AS seq FROM events")) return stmt;
          return new Proxy(stmt, {
            get(st, p) {
              if (p === "first") {
                return async (...a: unknown[]) => {
                  const k = n++;
                  if (failOn.has(k)) throw new Error(`injected D1 failure #${k}`);
                  return (st.first as (...x: unknown[]) => Promise<unknown>)(...a);
                };
              }
              const v = Reflect.get(st, p);
              return typeof v === "function" ? v.bind(st) : v;
            },
          });
        };
      }
      const v = Reflect.get(target, prop);
      return typeof v === "function" ? v.bind(target) : v;
    },
  });
  return { db: wrapped as D1Database, reads: () => n };
}

describe("[LDB-CH6] a failing D1 read during a held wait", () => {
  it("[LDB-CH6] [LDB-CH5] waitForChanges: a throwing head read on attempt k ends the hold early, logs it, never throws", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const sleeps: number[] = [];
      const { db: flaky, reads } = dbFailingHeadReads(db, new Set([2]));
      await waitForChanges(flaky, 1_000_000, 10, async (ms) => void sleeps.push(ms));
      expect(reads()).toBe(3); // attempts 0, 1 fine, 2 threw -> stopped
      expect(sleeps.length).toBe(2);
      expect(spy).toHaveBeenCalledTimes(1);
      expect(String(spy.mock.calls[0]![0])).toContain("attempt 2");

      // Every read failing: still bounded by ceil(wait)+1 (here: 1).
      const all = dbFailingHeadReads(db, new Set([0, 1, 2, 3, 4, 5]));
      await waitForChanges(all.db, 0, 3, async () => {});
      expect(all.reads()).toBeLessThanOrEqual(Math.ceil(3) + 1);
    } finally {
      spy.mockRestore();
    }
  });

  async function heldClient(n: number) {
    const { privateKey, pubkeyB64url } = await generateKeyPair();
    const clientId = `test-client-ch6-${n}-${crypto.randomUUID()}`;
    const actor = `80000000000000020${n}`;
    await seedClient(db, NOW, { id: clientId, pubkeyB64url, ownerUserId: actor, caps: "act-as-owner-only" });
    return { privateKey, clientId, actor };
  }

  it("[LDB-CH6] a head read failing mid-hold still answers 200 with the normal page", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const real = bindings.DB;
    try {
      const { privateKey, clientId, actor } = await heldClient(1);
      const sleeps = setSleepSpy();
      const flaky = dbFailingHeadReads(real, new Set([1])); // 2nd hold read
      (bindings as unknown as { DB: D1Database }).DB = flaky.db;
      const res = await signedGetChanges(privateKey, clientId, actor, "?wait=5");
      expect(res.status).toBe(200);
      const body = await res.json<{ next: number; items: unknown[] }>();
      expect(Array.isArray(body.items)).toBe(true);
      expect(sleeps.calls.length).toBe(1); // one sleep, then the failed read ended the hold
      expect(spy).toHaveBeenCalled();
    } finally {
      (bindings as unknown as { DB: D1Database }).DB = real;
      spy.mockRestore();
    }
  });

  it("[LDB-CH6] a failing final page read is retried once and succeeds -> 200", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const real = bindings.DB;
    try {
      const { privateKey, clientId, actor } = await heldClient(2);
      setSleepSpy();
      // wait=1 -> 2 hold reads (0, 1); read 2 is the page's first try.
      const flaky = dbFailingHeadReads(real, new Set([2]));
      (bindings as unknown as { DB: D1Database }).DB = flaky.db;
      const res = await signedGetChanges(privateKey, clientId, actor, "?wait=1");
      expect(res.status).toBe(200);
      expect(flaky.reads()).toBe(4); // 2 hold + failed try + retry
    } finally {
      (bindings as unknown as { DB: D1Database }).DB = real;
      spy.mockRestore();
    }
  });

  it("[LDB-CH6] a final page read failing twice is still a 500", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const real = bindings.DB;
    try {
      const { privateKey, clientId, actor } = await heldClient(3);
      setSleepSpy();
      const flaky = dbFailingHeadReads(real, new Set([2, 3]));
      (bindings as unknown as { DB: D1Database }).DB = flaky.db;
      const res = await signedGetChanges(privateKey, clientId, actor, "?wait=1");
      expect(res.status).toBe(500);
    } finally {
      (bindings as unknown as { DB: D1Database }).DB = real;
      spy.mockRestore();
    }
  });
});
