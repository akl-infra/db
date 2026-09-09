// Admin routes (09 §3 T3): list/add/remove admins, pause/resume the cmini
// import. Glue only, same discipline `routes/write.ts` follows for LDB-W1 --
// every D1 statement lives in `core/admins.ts`. `GET /v1/admin/admins`
// resolves its own actor (like `GET /v1/me` in `index.ts`) because
// `requireActorOnWrites` only gates non-GET methods; the other four routes
// read the actor that middleware already set via `c.get("actor")`.
import { Hono } from "hono";
import type { ActorVariables } from "../auth/actor";
import { type AuthDeps, resolveActor } from "../auth/discord";
import type { Bindings } from "../env";
import * as admins from "../core/admins";
import { canonical } from "../core/canonical";
import * as clients from "../core/clients";
import { badRequest, notAdmin } from "../core/errors";
import { systemClock, type Clock } from "../core/time";
import { lastDiff } from "../import/difftick";
import { parseAdminAddBody, parseDrillReportBody, parseRegisterClientBody } from "./schemas";

// 12 §3 X4: "detail?: object <= 4 KB" -- measured on the canonical encoding,
// same posture as every other byte-length bound in this codebase (webhook
// `secret`, client `pubkey`).
const DRILL_DETAIL_MAX_BYTES = 4096;

// Same test-only escape hatch as routes/write.ts's `resolveNow`: a test
// pins `TEST_CLOCK` on the shared `env` object before a `SELF.fetch` call
// to make an admin write's "now" deterministic. Absent in production
// (LDB-G4 -- every real binding has a README row, this isn't one).
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

// Takes the same `AuthDeps` `index.ts` builds for `requireActorOnWrites`/
// `GET /v1/me` (real fetch + clock in production, injected in tests) so the
// one GET route here resolves its actor the identical way.
export function adminRoute(authDeps: AuthDeps) {
  const route = new Hono<{ Bindings: Bindings; Variables: ActorVariables }>();

  route.get("/v1/admin/admins", async (c) => {
    const actor = await resolveActor(c.env, c.req, authDeps);
    if (!actor.admin) throw notAdmin();
    return c.json(await admins.list(c.env.DB));
  });

  route.post("/v1/admin/admins", async (c) => {
    const actor = c.get("actor");
    if (!actor.admin) throw notAdmin();
    const body = parseAdminAddBody(await readJson(c.req));
    const { row, created } = await admins.add(c.env.DB, resolveNow(c.env), actor.user_id, body.user_id, body.note);
    return c.json(row, created ? 201 : 200);
  });

  route.delete("/v1/admin/admins/:user_id", async (c) => {
    const actor = c.get("actor");
    if (!actor.admin) throw notAdmin();
    const userId = c.req.param("user_id");
    await admins.remove(c.env.DB, resolveNow(c.env), actor.user_id, userId);
    return c.json({ removed: userId });
  });

  route.post("/v1/admin/import/pause", async (c) => {
    const actor = c.get("actor");
    if (!actor.admin) throw notAdmin();
    await admins.setImportPaused(c.env.DB, resolveNow(c.env), actor.user_id, true);
    return c.json({ paused: true });
  });

  route.post("/v1/admin/import/resume", async (c) => {
    const actor = c.get("actor");
    if (!actor.admin) throw notAdmin();
    await admins.setImportPaused(c.env.DB, resolveNow(c.env), actor.user_id, false);
    return c.json({ paused: false });
  });

  // 10 C1: the client lane's registration routes. `pubkey` never appears in
  // the event `detail` (core/clients.ts); `GET` lists it anyway -- public
  // keys are public by design (02 §3.1).
  route.post("/v1/admin/clients", async (c) => {
    const actor = c.get("actor");
    if (!actor.admin) throw notAdmin();
    const body = parseRegisterClientBody(await readJson(c.req));
    const row = await clients.registerClient(c.env.DB, resolveNow(c.env), actor.user_id, body);
    return c.json(row, 201);
  });

  route.delete("/v1/admin/clients/:id", async (c) => {
    const actor = c.get("actor");
    if (!actor.admin) throw notAdmin();
    const id = c.req.param("id");
    const result = await clients.revokeClient(c.env.DB, resolveNow(c.env), actor.user_id, id);
    if (result === null) throw clients.unknownClientId(id);
    return c.json(result);
  });

  route.get("/v1/admin/clients", async (c) => {
    const actor = await resolveActor(c.env, c.req, authDeps);
    if (!actor.admin) throw notAdmin();
    return c.json(await clients.listClients(c.env.DB));
  });

  // 12 §3 X4: accepts and stores a signed drill report. The drill itself
  // (a rehost + the conformance suite, run against a real deployed dump)
  // runs on Fly, outside this Worker (⚠ saltorbit, `08 §2` item 2) -- this
  // route only records what it was told, on the client lane (`scripts/
  // report-drill.mjs`, act-as-owner-only) or a bearer, same as every other
  // admin write here.
  route.post("/v1/admin/drill", async (c) => {
    const actor = c.get("actor");
    if (!actor.admin) throw notAdmin();
    const body = parseDrillReportBody(await readJson(c.req));
    if (body.detail !== undefined) {
      const bytes = new TextEncoder().encode(canonical(body.detail)).length;
      if (bytes > DRILL_DETAIL_MAX_BYTES) throw badRequest(`'detail' exceeds ${DRILL_DETAIL_MAX_BYTES} bytes`, "/detail");
    }
    await admins.recordDrill(c.env.DB, resolveNow(c.env), actor.user_id, body.ok, body.detail);
    return c.json({ recorded: true });
  });

  // 12 §3 X4: the full `last_diff`/`last_drill` bodies -- `/v1/meta` only
  // ever serves `{at, ok}` off the same two `import_state` rows (12 §6.7:
  // "the public poll stays small").
  route.get("/v1/admin/health", async (c) => {
    const actor = await resolveActor(c.env, c.req, authDeps);
    if (!actor.admin) throw notAdmin();
    const [diff, drill] = await Promise.all([lastDiff(c.env.DB), admins.lastDrill(c.env.DB)]);
    return c.json({ last_diff: diff, last_drill: drill });
  });

  return route;
}
