// [LDB-R6] [LDB-R7] The write rate limit (09 §2.5): 60 writes / 10 min /
// actor, counted per attempt (accepted or refused), fixed windows, `429
// rate_limited` + `Retry-After`; GET is never counted; the limit is per
// actor; the middleware's placement (not a per-route list) is what covers
// every non-GET route, T3/T4's included. 10 C1 layers a second, per-client
// counter (300/10min) on top for the client lane. Those are the limits this
// file PINS (TEST_RATE_LIMITS); production's own are 1000 and 5000 per 10
// min (saltorbit 2026-09-11), asserted at the end of the file.
import { SELF, env } from "cloudflare:test";
import { app } from "../../src/index";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CLIENT_LIMIT, WRITE_LIMIT } from "../../src/auth/ratelimit";
import type { Bindings } from "../../src/env";
import { fixedClock, type Clock } from "../../src/core/time";
import { generateKeyPair, seedClient, signHeaders } from "../auth/client-support";
import { AKL_PAYLOAD, actorFixture, pinTestClock, register, uniqueName, writeFetch } from "./write-support";

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

beforeEach(() => {
  (bindings as unknown as { TEST_RATE_LIMITS?: { write: number; client: number } }).TEST_RATE_LIMITS = { write: 60, client: 300 };
});

afterEach(() => {
  vi.unstubAllGlobals();
  delete (bindings as unknown as { TEST_CLOCK?: Clock }).TEST_CLOCK;
  delete (bindings as unknown as { TEST_RATE_LIMITS?: unknown }).TEST_RATE_LIMITS;
});

async function create(headers: Record<string, string>, name = uniqueName("rl")) {
  return writeFetch("/v1/layouts", "POST", headers, { name, format: "spark/1", payload: AKL_PAYLOAD });
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

// 10 C1: the per-client counter, layered on top of the per-actor one above.
// Its own window (WINDOW_C, distinct from WINDOW_0/WINDOW_1 above) so
// nothing here depends on -- or disturbs -- the LDB-R6 tests' clock state.
const WINDOW_C = "2026-08-10T00:00:00.000Z";
const clockC = fixedClock(WINDOW_C);
const WINDOW_C_START = Math.floor(new Date(WINDOW_C).getTime() / 1000 / 600) * 600;

async function seedCounter(key: string, n: number): Promise<void> {
  await db
    .prepare(
      `INSERT INTO ratelimit (key, window_start, n) VALUES (?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET window_start = excluded.window_start, n = excluded.n`,
    )
    .bind(key, WINDOW_C_START, n)
    .run();
}

async function counterFor(key: string): Promise<number> {
  const row = await db.prepare("SELECT n FROM ratelimit WHERE key = ?").bind(key).first<{ n: number }>();
  return row?.n ?? 0;
}

// The LIVE auth clock is always real wall-clock (`authDeps.now = systemClock`
// in src/index.ts -- TEST_CLOCK only overrides a write route's own
// `resolveNow()` for the record's `modified_at`, not signature verification
// or the rate-limit window), so every signed request is timestamped off
// `Date.now()`.
async function signedPost(clientId: string, privateKey: CryptoKey, actor: string, name: string): Promise<Response> {
  const bodyObj = { name, format: "spark/1", payload: AKL_PAYLOAD };
  const bodyText = JSON.stringify(bodyObj);
  const headers = await signHeaders({
    privateKey,
    clientId,
    actor,
    method: "POST",
    pathWithQuery: "/v1/layouts",
    body: new TextEncoder().encode(bodyText),
    timestamp: Math.floor(Date.now() / 1000),
  });
  return SELF.fetch("https://example.com/v1/layouts", {
    method: "POST",
    headers: { ...headers, "Content-Type": "application/json" },
    body: bodyText,
  });
}

describe("[LDB-R7] the per-client counter: 300/10min, on top of the per-actor one", () => {
  // The top-level `afterEach` above (unstubs fetch, clears TEST_CLOCK)
  // covers every test in this describe too -- no second copy needed.
  it("[LDB-R7] at 299, the 300th client-lane write passes; at 300, the 301st is 429 scope: client", async () => {
    pinTestClock(env as unknown as { TEST_CLOCK?: Clock }, clockC);
    const { privateKey, pubkeyB64url } = await generateKeyPair();
    const clientId = uniqueName("rl-client-300");
    // Distinct actors so the PER-ACTOR counter (60/window) never trips first
    // -- LDB-R7 is about the per-client ceiling specifically.
    let actorN = 0;
    const freshActor = () => {
      actorN++;
      return `70${String(actorN).padStart(16, "0")}`;
    };
    await seedClient(db, clockC, { id: clientId, pubkeyB64url, ownerUserId: freshActor(), caps: "act-as-user" });

    await seedCounter(`client:${clientId}`, 299);
    const ok = await signedPost(clientId, privateKey, freshActor(), uniqueName("rl-ok"));
    expect(ok.status).toBe(201);
    expect(await counterFor(`client:${clientId}`)).toBe(300);

    const refused = await signedPost(clientId, privateKey, freshActor(), uniqueName("rl-refused"));
    expect(refused.status).toBe(429);
    const body = await refused.json<{ error: string; scope: string; limit: number }>();
    expect(body.error).toBe("rate_limited");
    expect(body.scope).toBe("client");
    expect(body.limit).toBe(300);
    // Refused attempts still count (09 §2.5: "counted on every attempt").
    expect(await counterFor(`client:${clientId}`)).toBe(301);
  });

  it("60 writes for one actor through the client lane -> the 61st is 429 scope: actor (not client)", async () => {
    pinTestClock(env as unknown as { TEST_CLOCK?: Clock }, clockC);
    const { privateKey, pubkeyB64url } = await generateKeyPair();
    const clientId = uniqueName("rl-client-actor");
    const actor = "710000000000000001";
    await seedClient(db, clockC, { id: clientId, pubkeyB64url, ownerUserId: actor, caps: "act-as-user" });

    await seedCounter(`write:${actor}`, 59);
    const ok = await signedPost(clientId, privateKey, actor, uniqueName("rl-actor-ok"));
    expect(ok.status).toBe(201);

    const refused = await signedPost(clientId, privateKey, actor, uniqueName("rl-actor-refused"));
    expect(refused.status).toBe(429);
    const body = await refused.json<{ error: string; scope: string; limit: number }>();
    expect(body.scope).toBe("actor");
    expect(body.limit).toBe(60);
    // The client counter is nowhere near its own ceiling -- this is the
    // actor limit tripping, not the client one, even on the client lane.
    expect(await counterFor(`client:${clientId}`)).toBeLessThan(300);
  });

  it("a bearer-lane write never creates or touches a client:* ratelimit row", async () => {
    pinTestClock(env as unknown as { TEST_CLOCK?: Clock }, clockC);
    const fake = actorFixture();
    const headers = register(fake, `tok-${uniqueName("rl-bearer")}`, "720000000000000001");
    const before = await db.prepare("SELECT COUNT(*) AS n FROM ratelimit WHERE key LIKE 'client:%'").first<{ n: number }>();

    const res = await writeFetch("/v1/layouts", "POST", headers, {
      name: uniqueName("rl-bearer-post"),
      format: "spark/1",
      payload: AKL_PAYLOAD,
    });
    expect(res.status).toBe(201);

    const after = await db.prepare("SELECT COUNT(*) AS n FROM ratelimit WHERE key LIKE 'client:%'").first<{ n: number }>();
    expect(after?.n).toBe(before?.n);
  });
});

describe("[LDB-R6] [LDB-R7] the production limits: 1000/10min per actor, 5000/10min per client", () => {
  it("[LDB-R6] [LDB-R7] the constants are 1000 and 5x that (saltorbit 2026-09-11: \"make this much higher, like 1000\")", () => {
    expect(WRITE_LIMIT).toBe(1000);
    expect(CLIENT_LIMIT).toBe(5 * WRITE_LIMIT);
  });

  it("[LDB-R6] [LDB-R7] with no override: the 1000th actor write and the 5000th client write pass, the next ones 429", async () => {
    delete (bindings as unknown as { TEST_RATE_LIMITS?: unknown }).TEST_RATE_LIMITS;
    pinTestClock(env as unknown as { TEST_CLOCK?: Clock }, clockC);
    const { privateKey, pubkeyB64url } = await generateKeyPair();
    const clientId = uniqueName("rl-prod");
    const actor = "7100000000000000001";
    await seedClient(db, clockC, { id: clientId, pubkeyB64url, ownerUserId: actor, caps: "act-as-user" });

    await seedCounter(`write:${actor}`, 999);
    expect((await signedPost(clientId, privateKey, actor, uniqueName("rl-prod-ok"))).status).toBe(201);
    const refused = await signedPost(clientId, privateKey, actor, uniqueName("rl-prod-no"));
    expect(refused.status).toBe(429);
    expect(await refused.json()).toMatchObject({ limit: 1000, scope: "actor" });

    await seedCounter(`client:${clientId}`, 4999);
    const actor2 = "7100000000000000002"; // a fresh actor, so the client ceiling is what trips
    expect((await signedPost(clientId, privateKey, actor2, uniqueName("rl-prod-c-ok"))).status).toBe(201);
    const refused2 = await signedPost(clientId, privateKey, actor2, uniqueName("rl-prod-c-no"));
    expect(refused2.status).toBe(429);
    expect(await refused2.json()).toMatchObject({ limit: 5000, scope: "client" });
  });
});
