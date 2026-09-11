// The write rate limit middleware (09 §2.5; 10 C1 D8 layers a second,
// per-client counter on top). Mounted on `/v1/*` right after
// `requireActorOnWrites` (src/index.ts) so it sees `c.get("actor")` already
// set, and before every route -- placement, not a per-route list, is what
// makes T3's admin routes and T4's PATCH covered automatically, and is why
// the client-lane counter below needs no route-by-route wiring either.
import type { MiddlewareHandler } from "hono";
import { type ActorVariables, SAFE_METHODS } from "./actor";
import type { Bindings } from "../env";
import { rateLimited } from "../core/errors";
import { take } from "../core/ratelimit";
import { systemClock, type Clock } from "../core/time";

// saltorbit 2026-09-11: "make this much higher, like 1000" (was 60; the magic
// seed of a rebuilt layoutdb tripped it).
export const WRITE_LIMIT = 1000;
const WRITE_WINDOW_SECONDS = 600;
// 10 C1 D8: a rogue-key bound layered on top of the per-actor limit above --
// a real multi-user bot serving a busy channel exceeds one actor's rate, so
// this is 5x the per-actor number, not equal to it.
export const CLIENT_LIMIT = 5 * WRITE_LIMIT;
const CLIENT_WINDOW_SECONDS = 600;

// Test-only, like TEST_CLOCK below: the ratelimit and conformance suites pin
// small limits so they can reach a 429 without thousands of writes.
function resolveLimits(env: Bindings): { write: number; client: number } {
  return (env as unknown as { TEST_RATE_LIMITS?: { write: number; client: number } }).TEST_RATE_LIMITS ?? { write: WRITE_LIMIT, client: CLIENT_LIMIT };
}

// Test-only escape hatch, same shape as `src/routes/write.ts`'s
// `resolveNow()`: pool-workers runs the Worker in the same isolate as the
// test file, so a test can pin the clock (via the `TEST_CLOCK` property on
// `env`) before a `SELF.fetch` call to step across a window boundary
// (tests/api/ratelimit.test.ts). Absent in production.
function resolveNow(env: Bindings, fallback: Clock): Clock {
  return (env as unknown as { TEST_CLOCK?: Clock }).TEST_CLOCK ?? fallback;
}

export function rateLimitWrites(defaultNow: Clock = systemClock): MiddlewareHandler<{ Bindings: Bindings; Variables: ActorVariables }> {
  return async (c, next) => {
    if (SAFE_METHODS.has(c.req.method)) {
      await next();
      return;
    }
    // `requireActorOnWrites` runs first (mounted before this middleware in
    // src/index.ts) and has already 401'd an anonymous request, so `actor`
    // is always set here.
    const actor = c.get("actor");
    const now = resolveNow(c.env, defaultNow);
    const limits = resolveLimits(c.env);

    // Counted on EVERY attempt, both counters, whether or not the write is
    // ultimately accepted (09 §2.5) -- so both `take()` calls run
    // unconditionally rather than short-circuiting on the first refusal.
    const actorResult = await take(c.env.DB, now, `write:${actor.user_id}`, limits.write, WRITE_WINDOW_SECONDS);
    const clientResult = actor.via.startsWith("client:")
      ? await take(c.env.DB, now, `client:${actor.via.slice("client:".length)}`, limits.client, CLIENT_WINDOW_SECONDS)
      : null;

    if (!actorResult.allowed) {
      throw rateLimited(limits.write, WRITE_WINDOW_SECONDS, actorResult.retryAfter, "actor");
    }
    if (clientResult !== null && !clientResult.allowed) {
      throw rateLimited(limits.client, CLIENT_WINDOW_SECONDS, clientResult.retryAfter, "client");
    }
    await next();
  };
}
