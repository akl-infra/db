// [LDB-R6] The write rate limit (09 §2.5): 60 writes / 10 min / actor,
// counted per attempt (accepted or refused), fixed windows, `429
// rate_limited` + `Retry-After`; GET is never counted; the limit is per
// actor; the middleware's placement (not a per-route list) is what covers
// every non-GET route, T3/T4's included.
import { env } from "cloudflare:test";
import { app } from "../../src/index";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Bindings } from "../../src/env";
import type { Clock } from "../../src/core/time";
import { CMINI_PAYLOAD, actorFixture, pinTestClock, register, uniqueName, writeFetch } from "./write-support";

const bindings = env as unknown as Bindings;
const db = bindings.DB;

// A window boundary: any "HH:M0:00" is a multiple of 600s from the epoch
// (a day is 86400s, itself a multiple of 600), so this and +600s/+1200s
// land in three distinct, predictable windows.
const WINDOW_0 = "2026-08-01T00:10:00.000Z";
const WINDOW_1 = "2026-08-01T00:20:00.000Z";

function mutableClock(startIso: string): { clock: Clock; set: (iso: string) => void } {
  let iso = startIso;
  return { clock: () => iso, set: (next: string) => (iso = next) };
}

afterEach(() => {
  vi.unstubAllGlobals();
  delete (bindings as unknown as { TEST_CLOCK?: Clock }).TEST_CLOCK;
});

async function create(headers: Record<string, string>, name = uniqueName("rl")) {
  return writeFetch("/v1/layouts", "POST", headers, { name, format: "cmini/1", payload: CMINI_PAYLOAD });
}

describe("[LDB-R6] write rate limit", () => {
  it("60 writes pass; the 61st -> 429 rate_limited with Retry-After and no event", async () => {
    const { clock } = mutableClock(WINDOW_0);
    pinTestClock(env as unknown as { TEST_CLOCK?: Clock }, clock);
    const fake = actorFixture();
    const headers = register(fake, `tok-${uniqueName("rl60")}`, "owner-rl-60");

    for (let i = 0; i < 60; i++) {
      const res = await create(headers);
      expect(res.status, `write ${i}`).toBe(201);
    }

    const before = await db.prepare("SELECT COUNT(*) AS n FROM events").first<{ n: number }>();
    const res = await create(headers);
    expect(res.status).toBe(429);
    const body = await res.json<{ error: string; limit: number; window_seconds: number; retry_after: number }>();
    expect(body.error).toBe("rate_limited");
    expect(body.limit).toBe(60);
    expect(body.window_seconds).toBe(600);
    expect(body.retry_after).toBe(600); // fired exactly at the window's own start
    expect(res.headers.get("Retry-After")).toBe("600");

    const after = await db.prepare("SELECT COUNT(*) AS n FROM events").first<{ n: number }>();
    expect(after?.n).toBe(before?.n); // the refused write appended nothing
  });

  it("a refused-for-other-reasons write (400) still counts against the window", async () => {
    const { clock } = mutableClock(WINDOW_0);
    pinTestClock(env as unknown as { TEST_CLOCK?: Clock }, clock);
    const fake = actorFixture();
    const headers = register(fake, `tok-${uniqueName("rl400")}`, "owner-rl-400");

    // 60 bodies that 400 at the schema (an unknown extra key) -- still
    // reach the rate-limit middleware first, since it runs before body
    // parsing.
    for (let i = 0; i < 60; i++) {
      const res = await writeFetch("/v1/layouts", "POST", headers, { bogus: true });
      expect(res.status, `write ${i}`).toBe(400);
    }
    const res = await create(headers);
    expect(res.status).toBe(429);
  });

  it("the window rolls: advancing the clock 10 minutes resets the counter", async () => {
    const { clock, set } = mutableClock(WINDOW_0);
    pinTestClock(env as unknown as { TEST_CLOCK?: Clock }, clock);
    const fake = actorFixture();
    const headers = register(fake, `tok-${uniqueName("rlroll")}`, "owner-rl-roll");

    for (let i = 0; i < 60; i++) await create(headers);
    const refused = await create(headers);
    expect(refused.status).toBe(429);

    set(WINDOW_1);
    const rolled = await create(headers);
    expect(rolled.status).toBe(201);

    // back at WINDOW_0 the old window is unaffected by WINDOW_1's traffic --
    // not retested (the key is windowed, not per-call), the new window's
    // own count is what matters: one write used, 59 remain.
    const row = await db
      .prepare("SELECT n FROM ratelimit WHERE key = ?")
      .bind("write:owner-rl-roll")
      .first<{ n: number }>();
    expect(row?.n).toBe(1);
  });

  it("the counter is per actor: two actors have independent windows", async () => {
    const { clock } = mutableClock(WINDOW_0);
    pinTestClock(env as unknown as { TEST_CLOCK?: Clock }, clock);
    const fake = actorFixture();
    const headersA = register(fake, `tok-${uniqueName("rlA")}`, "owner-rl-a");

    for (let i = 0; i < 60; i++) await create(headersA);
    const refusedA = await create(headersA);
    expect(refusedA.status).toBe(429);

    const headersB = register(fake, `tok-${uniqueName("rlB")}`, "owner-rl-b");
    const okB = await create(headersB);
    expect(okB.status).toBe(201);
  });

  it("[LDB-R6] a GET is never counted, even past 60 requests from the same actor", async () => {
    const { clock } = mutableClock(WINDOW_0);
    pinTestClock(env as unknown as { TEST_CLOCK?: Clock }, clock);
    const fake = actorFixture();
    const headers = register(fake, `tok-${uniqueName("rlget")}`, "owner-rl-get");

    for (let i = 0; i < 65; i++) {
      const res = await writeFetch("/v1/meta", "GET", headers);
      expect(res.status, `get ${i}`).toBe(200);
    }
    const row = await db.prepare("SELECT 1 FROM ratelimit WHERE key = ?").bind("write:owner-rl-get").first();
    expect(row).toBeNull();
  });

  // [LDB-R6] Middleware PLACEMENT, not a per-route list: every non-GET/HEAD/
  // OPTIONS route currently live (T2's write verbs today; T3's admin
  // verbs and T4's PATCH the moment they land, with no change here) is
  // behind `rateLimitWrites` -- proved by exhausting one actor's window and
  // then hitting every such route once, each still refused with 429 before
  // its own body/ownership/etc. logic ever runs.
  it("[LDB-R6] every non-GET route is behind the write rate limit (placement, not a list)", async () => {
    const { clock } = mutableClock(WINDOW_0);
    pinTestClock(env as unknown as { TEST_CLOCK?: Clock }, clock);
    const fake = actorFixture();
    const headers = register(fake, `tok-${uniqueName("rlplace")}`, "owner-rl-placement");

    for (let i = 0; i < 60; i++) await create(headers);

    // Same `concretePath` shape tests/auth/routes.test.ts's LDB-A1
    // enumeration uses: a sub-app's route.path is not always already
    // absolute, so basePath is prefixed on when it isn't.
    const SAFE = new Set(["GET", "HEAD", "OPTIONS", "ALL"]);
    const seen = new Set<string>();
    const routes: { method: string; path: string }[] = [];
    for (const route of app.routes) {
      if (SAFE.has(route.method)) continue;
      const full = route.path.startsWith("/") ? route.path : `${route.basePath}${route.path}`;
      const path = full.replace(/:[^/]+/g, "01ARZ3NDEKTSV4RRFFQ69G5FAV");
      const key = `${route.method} ${path}`;
      if (seen.has(key)) continue;
      seen.add(key);
      routes.push({ method: route.method, path });
    }
    expect(routes.length).toBeGreaterThan(0);

    for (const { method, path } of routes) {
      const res = await writeFetch(path, method, headers, {});
      expect(res.status, `${method} ${path}`).toBe(429);
    }
  });

  it("[LDB-R6] the nightly prune drops buckets older than two windows", async () => {
    const { clock } = mutableClock(WINDOW_0);
    pinTestClock(env as unknown as { TEST_CLOCK?: Clock }, clock);
    const fake = actorFixture();
    const headers = register(fake, `tok-${uniqueName("rlprune")}`, "owner-rl-prune");
    await create(headers);

    const { pruneRateLimits } = await import("../../src/core/ratelimit");
    const { fixedClock } = await import("../../src/core/time");
    // Two windows (1200s) past WINDOW_0's own bucket start.
    await pruneRateLimits(db, fixedClock("2026-08-01T00:30:01.000Z"));

    const row = await db.prepare("SELECT 1 FROM ratelimit WHERE key = ?").bind("write:owner-rl-prune").first();
    expect(row).toBeNull();
  });
});
