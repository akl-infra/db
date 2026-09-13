// L5 moderation (§4.1, §4.3): bans, the author display-name override.
// Glue only -- no D1 statement here (LDB-W1,
// `tests/tools/routes-noprepare.test.ts`): every verb lives in
// `core/moderation.ts`. `requireAdmin` here is exactly `routes/admin.ts`'s
// own pattern (`if (!actor.admin) throw notAdmin()`); the GET route
// resolves its own actor the same way `GET /v1/admin/admins` does (only
// non-GET methods pass through `requireActorOnWrites`). (H24, 2026-09-13:
// the like-count override route, §4.2, was removed.)
import { Hono } from "hono";
import type { ActorVariables } from "../auth/actor";
import { type AuthDeps, resolveActor } from "../auth/discord";
import type { Bindings } from "../env";
import * as moderation from "../core/moderation";
import { badRequest, notAdmin } from "../core/errors";
import { systemClock, type Clock } from "../core/time";
import { parseAuthorRenameBody, parseBanBody } from "./schemas";

// Same test-only escape hatch every other write route uses (`src/routes/
// write.ts`'s `resolveNow`) -- absent in production.
function resolveNow(env: Bindings): Clock {
  return (env as unknown as { TEST_CLOCK?: Clock }).TEST_CLOCK ?? systemClock;
}

async function readJson(req: { json(): Promise<unknown> }): Promise<unknown> {
  try {
    return await req.json();
  } catch {
    throw badRequest("request body must be valid JSON", "/");
  }
}

export function moderationRoute(authDeps: AuthDeps) {
  const route = new Hono<{ Bindings: Bindings; Variables: ActorVariables }>();

  route.get("/v1/admin/bans", async (c) => {
    const actor = await resolveActor(c.env, c.req, authDeps);
    if (!actor.admin) throw notAdmin();
    return c.json({ bans: await moderation.listBans(c.env.DB) });
  });

  route.put("/v1/admin/bans/:user_id", async (c) => {
    const actor = c.get("actor");
    if (!actor.admin) throw notAdmin();
    const body = parseBanBody(await readJson(c.req));
    const { row, created } = await moderation.ban(c.env.DB, resolveNow(c.env), actor, c.get("sourceVersion"), c.req.param("user_id"), body.reason);
    return c.json(row, created ? 201 : 200);
  });

  route.delete("/v1/admin/bans/:user_id", async (c) => {
    const actor = c.get("actor");
    if (!actor.admin) throw notAdmin();
    const userId = c.req.param("user_id");
    await moderation.unban(c.env.DB, resolveNow(c.env), actor, c.get("sourceVersion"), userId);
    return c.json({ unbanned: userId });
  });

  route.put("/v1/admin/authors/:user_id", async (c) => {
    const actor = c.get("actor");
    if (!actor.admin) throw notAdmin();
    const body = parseAuthorRenameBody(await readJson(c.req));
    const row = await moderation.renameAuthor(c.env.DB, resolveNow(c.env), actor, c.get("sourceVersion"), c.req.param("user_id"), body.name);
    return c.json(row);
  });

  return route;
}
