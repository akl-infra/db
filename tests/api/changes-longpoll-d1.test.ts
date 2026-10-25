// D1-only (design/p1-briefs.md E).
// [LDB-CH6] A failing D1 head read during a held `GET /v1/changes?wait=`.
// The fault is injected by wrapping the D1 binding's `prepare`, so this part
// of changes-longpoll.test.ts (which runs on every backend) lives here.
import { SELF, env, testStore } from "../harness";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Bindings } from "../../src/env";
import { fixedClock } from "../../src/core/time";
import { waitForChanges } from "../../src/core/longpoll";
import { generateKeyPair, seedClient, signHeaders } from "../auth/client-support";

const bindings = env as unknown as Bindings;
const db = bindings.DB;
const NOW = fixedClock("2026-09-12T00:00:00.000Z");

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
  await testStore.remove("events", {});
  await testStore.remove("layout_revs", {});
});

afterEach(() => {
  delete (bindings as unknown as { TEST_LONGPOLL_SLEEP?: unknown }).TEST_LONGPOLL_SLEEP;
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
    await seedClient(NOW, { id: clientId, pubkeyB64url, ownerUserId: actor, caps: "act-as-owner-only" });
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
