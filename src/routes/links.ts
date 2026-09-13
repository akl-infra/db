// L5 moderation (§4.4): `link` + the moderation queue. Glue only -- no D1
// statement here (LDB-W1, `tests/tools/routes-noprepare.test.ts`); every
// verb lives in `core/links.ts`. Owner/admin ownership on
// `/v1/layouts/:ref/link` reuses `core/write.ts`'s `loadForWrite` (the
// exact "owner OR admin, 404/403 otherwise" rule every other write route
// already shares) -- the GET here resolves its own actor (only non-GET
// methods pass through `requireActorOnWrites`), same pattern
// `routes/moderation.ts`'s `GET /v1/admin/bans` and `routes/admin.ts`'s
// admin GETs use.
import { Hono } from "hono";
import type { ActorVariables } from "../auth/actor";
import { type AuthDeps, resolveActor } from "../auth/discord";
import type { Bindings } from "../env";
import * as links from "../core/links";
import { badRequest, notAdmin } from "../core/errors";
import { loadForWrite } from "../core/write";
import { systemClock, type Clock } from "../core/time";
import { parseLinkBody, parseLinkRejectBody } from "./schemas";

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

// Optional body (mirrors `routes/write.ts`'s restore): `POST .../reject`'s
// `{reason?}` is entirely optional, so an empty body reads as `{}` rather
// than a JSON-parse `bad_request`.
async function readOptionalJson(req: { text(): Promise<string> }): Promise<unknown> {
  const text = await req.text();
  if (text.trim() === "") return {};
  try {
    return JSON.parse(text);
  } catch {
    throw badRequest("request body must be valid JSON", "/");
  }
}

export function linksRoute(authDeps: AuthDeps) {
  const route = new Hono<{ Bindings: Bindings; Variables: ActorVariables }>();

  route.get("/v1/layouts/:ref/link", async (c) => {
    const actor = await resolveActor(c.env, c.req, authDeps);
    const { lwf } = await loadForWrite(c.env.DB, c.req.param("ref"), actor, { allowDeleted: true });
    const result = await links.getLink(c.env.DB, lwf.layout.id);
    return c.json(result);
  });

  route.put("/v1/layouts/:ref/link", async (c) => {
    const actor = c.get("actor");
    const body = parseLinkBody(await readJson(c.req));
    const { lwf, admin } = await loadForWrite(c.env.DB, c.req.param("ref"), actor, { allowDeleted: false });
    const result = await links.submitLink(c.env.DB, resolveNow(c.env), actor, c.get("sourceVersion"), lwf.layout.id, admin, body.url);
    return result.kind === "approved" ? c.json({ link: result.link }, 200) : c.json({ submission: result.submission }, 202);
  });

  route.delete("/v1/layouts/:ref/link", async (c) => {
    const actor = c.get("actor");
    const { lwf, admin } = await loadForWrite(c.env.DB, c.req.param("ref"), actor, { allowDeleted: false });
    const result = await links.clearLink(c.env.DB, resolveNow(c.env), actor, c.get("sourceVersion"), lwf.layout.id, admin);
    return c.json(result);
  });

  const QUEUE_STATUSES = ["pending", "approved", "rejected", "superseded"] as const;

  route.get("/v1/admin/link-queue", async (c) => {
    const actor = await resolveActor(c.env, c.req, authDeps);
    if (!actor.admin) throw notAdmin();
    const raw = c.req.query("status") ?? "pending";
    if (!(QUEUE_STATUSES as readonly string[]).includes(raw)) {
      throw badRequest(`unknown 'status' value '${raw}' (expected one of ${QUEUE_STATUSES.join(", ")})`, "status");
    }
    return c.json({ submissions: await links.listQueue(c.env.DB, raw as (typeof QUEUE_STATUSES)[number]) });
  });

  route.post("/v1/admin/link-queue/:id/approve", async (c) => {
    const actor = c.get("actor");
    if (!actor.admin) throw notAdmin();
    const result = await links.approveSubmission(c.env.DB, resolveNow(c.env), actor, c.get("sourceVersion"), c.req.param("id"));
    return c.json(result);
  });

  route.post("/v1/admin/link-queue/:id/reject", async (c) => {
    const actor = c.get("actor");
    if (!actor.admin) throw notAdmin();
    const body = parseLinkRejectBody(await readOptionalJson(c.req));
    const result = await links.rejectSubmission(c.env.DB, resolveNow(c.env), actor, c.get("sourceVersion"), c.req.param("id"), body.reason);
    return c.json({ submission: result });
  });

  return route;
}
