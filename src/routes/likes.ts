// PUT/DELETE /v1/layouts/{ref}/like (09 §3 T5). Glue only -- no D1
// statement here (LDB-W1, tests/tools/routes-noprepare.test.ts): the
// pipeline lives in `src/core/likes.ts`.
import { Hono } from "hono";
import type { ActorVariables } from "../auth/actor";
import type { Bindings } from "../env";
import { likeLayout, unlikeLayout } from "../core/likes";
import { systemClock, type Clock } from "../core/time";

// Same test-only escape hatch as `src/routes/write.ts`'s `resolveNow()`
// (see there for why); nothing under T5's own tests needs it (likes carry
// no clock-sensitive assertion), kept for parity so a future test can pin
// `modified_at`/`at` the same way every other write route allows.
function resolveNow(env: Bindings): Clock {
  return (env as unknown as { TEST_CLOCK?: Clock }).TEST_CLOCK ?? systemClock;
}

export const likesRoute = new Hono<{ Bindings: Bindings; Variables: ActorVariables }>();

likesRoute.put("/v1/layouts/:ref/like", async (c) => {
  const { like_count } = await likeLayout(c.env, resolveNow(c.env), c.get("actor"), c.req.param("ref"));
  return c.json({ like_count });
});

likesRoute.delete("/v1/layouts/:ref/like", async (c) => {
  const { like_count } = await unlikeLayout(c.env, resolveNow(c.env), c.get("actor"), c.req.param("ref"));
  return c.json({ like_count });
});
