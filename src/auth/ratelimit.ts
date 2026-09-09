// The write rate limit middleware (09 §2.5): mounted on `/v1/*` right
// after `requireActorOnWrites` (src/index.ts) so it sees `c.get("actor")`
// already set, and before every route. Placement, not a per-route list, is
// what makes T3's admin routes and T4's PATCH covered automatically.
import type { MiddlewareHandler } from "hono";
import type { ActorVariables } from "./actor";
import { SAFE_METHODS } from "./actor";
import type { Bindings } from "../env";
import { rateLimited } from "../core/errors";
import { take } from "../core/ratelimit";
import { systemClock, type Clock } from "../core/time";

const WRITE_LIMIT = 60;
const WRITE_WINDOW_SECONDS = 600;

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
    const result = await take(c.env.DB, now, `write:${actor.user_id}`, WRITE_LIMIT, WRITE_WINDOW_SECONDS);
    if (!result.allowed) {
      throw rateLimited(WRITE_LIMIT, WRITE_WINDOW_SECONDS, result.retryAfter);
    }
    await next();
  };
}
