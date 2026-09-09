// POST/GET /v1/webhooks, DELETE /v1/webhooks/{id} (12 §3 X1). Glue only --
// no D1 statement here (LDB-W1's rule extended to this file, tests/tools/
// routes-noprepare.test.ts): the pipeline lives in `src/core/webhooks.ts`.
import { Hono } from "hono";
import type { ActorVariables } from "../auth/actor";
import { type AuthDeps, resolveActor } from "../auth/discord";
import type { Bindings } from "../env";
import * as webhooks from "../core/webhooks";
import { badRequest, notAdmin } from "../core/errors";
import { systemClock, type Clock } from "../core/time";
import { KNOWN_KINDS } from "./changes";
import { parseCreateWebhookBody } from "./schemas";

const KNOWN_KINDS_SET = new Set<string>(KNOWN_KINDS);

function checkKinds(kinds: string[] | undefined): void {
  if (kinds === undefined) return;
  for (const k of kinds) {
    if (!KNOWN_KINDS_SET.has(k)) throw badRequest(`unknown kind '${k}'`, "/kinds");
  }
}

async function readJson(req: { json(): Promise<unknown> }): Promise<unknown> {
  try {
    return await req.json();
  } catch {
    throw badRequest("request body must be valid JSON", "/");
  }
}

// Same test-only escape hatch as routes/write.ts's `resolveNow`.
function resolveNow(env: Bindings): Clock {
  return (env as unknown as { TEST_CLOCK?: Clock }).TEST_CLOCK ?? systemClock;
}

// Takes the same `AuthDeps` `index.ts` builds for `requireActorOnWrites`/
// `GET /v1/me` so `GET /v1/webhooks` resolves its actor the identical way
// `GET /v1/admin/admins` does (`requireActorOnWrites` only gates non-GET
// methods, 12 §3: "the GET resolves its own actor").
export function webhooksRoute(authDeps: AuthDeps) {
  const route = new Hono<{ Bindings: Bindings; Variables: ActorVariables }>();

  route.post("/v1/webhooks", async (c) => {
    const actor = c.get("actor");
    const body = parseCreateWebhookBody(await readJson(c.req));
    checkKinds(body.kinds);
    const row = await webhooks.create(c.env.DB, resolveNow(c.env), actor.user_id, body);
    return c.json(row, 201);
  });

  route.get("/v1/webhooks", async (c) => {
    const actor = await resolveActor(c.env, c.req, authDeps);
    if (c.req.query("all") === "1") {
      if (!actor.admin) throw notAdmin();
      return c.json(await webhooks.listAll(c.env.DB));
    }
    return c.json(await webhooks.listForOwner(c.env.DB, actor.user_id));
  });

  route.delete("/v1/webhooks/:id", async (c) => {
    const actor = c.get("actor");
    const id = c.req.param("id");
    await webhooks.remove(c.env.DB, actor.user_id, actor.admin, id);
    return c.json({ removed: id });
  });

  return route;
}
