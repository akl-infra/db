// Admin routes (09 §3 T3): list/add/remove admins. Glue only, same
// discipline `routes/write.ts` follows for LDB-W1 -- every D1 statement
// lives in `core/admins.ts`. `GET /v1/admin/admins` resolves its own actor
// (like `GET /v1/me` in `index.ts`) because `requireActorOnWrites` only
// gates non-GET methods; the other routes read the actor that middleware
// already set via `c.get("actor")`.
import { Hono } from "hono";
import type { ActorVariables } from "../auth/actor";
import { type AuthDeps, resolveActor } from "../auth/discord";
import type { Bindings } from "../env";
import * as admins from "../core/admins";
import * as clients from "../core/clients";
import { badRequest, clientAlreadyRevoked, notAdmin } from "../core/errors";
import { runNightly } from "../core/nightly";
import { revertClientWrites } from "../core/revert";
import { systemClock, fixedClock, type Clock } from "../core/time";
import { writeDump } from "../dump/write";
import { seedMagic } from "../core/write";
import { parseAdminAddBody, parseRegisterClientBody } from "./schemas";

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

// `POST .../suspend` takes an optional `{reason}` -- an empty/absent body
// is a normal call (a human clicking a button rarely types a reason), so
// this tolerates that instead of `readJson`'s "must be valid JSON" refusal.
async function readJsonOptional(req: { text(): Promise<string> }): Promise<Record<string, unknown>> {
  const text = await req.text();
  if (text.trim().length === 0) return {};
  try {
    const parsed: unknown = JSON.parse(text);
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error();
    return parsed as Record<string, unknown>;
  } catch {
    throw badRequest("request body must be a valid JSON object", "/");
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

  // X4 follow-up 3: a manual kick for the `hour=3, minute=0` nightly job set
  // (the three prunes + the R2 dump, `core/nightly.ts`'s `runNightly`) --
  // production reason: Cloudflare's cron dispatch is not currently firing
  // for this account, and even locally `wrangler dev --test-scheduled`'s
  // `/__scheduled` endpoint ignores a `?time=` override (07 §6 S5's own
  // doc), so there was no way -- production OR local -- to force the
  // nightly dump short of waiting for a real 03:00Z. Calls the EXACT SAME
  // `runNightly()` `src/index.ts`'s `scheduled()` calls for the real cron
  // (tests/api/admin.test.ts's own spy proves the two call sites share one
  // implementation) -- no "paused" gate exists for this job set, so no
  // pre-check.
  route.post("/v1/admin/nightly/tick", async (c) => {
    const actor = c.get("actor");
    if (!actor.admin) throw notAdmin();
    const now = resolveNow(c.env);
    const result = await runNightly(c.env, now);
    await admins.recordManualTick(c.env.DB, now, actor.user_id, "nightly", { at: result.at, jobs: result.jobs, dump: result.dump });
    return c.json(result);
  });

  // The cutover follow-up (design/layout-db/23-geometry.md, "admin dump
  // route"): a way to write a fresh daily dump ON DEMAND, via the EXACT
  // SAME path `scheduled()`'s hour=3 nightly job (and LDB-D8's own
  // catch-up check) uses (`dump/write.ts`'s `writeDump`) -- needed because
  // the cutover imports into a wiped DB and the bot/site rebuild boot from
  // the daily dump, so an operator can't wait for the next 03:00Z tick.
  // `at` is captured once and threaded through as a FIXED clock so the
  // response's `written_at` is byte-identical to what `writeDump` itself
  // records as `dump.last_at`/`latest.json`'s own timestamp, never two
  // separately-sampled "now"s that could disagree by a few milliseconds.
  route.post("/v1/admin/dump", async (c) => {
    const actor = c.get("actor");
    if (!actor.admin) throw notAdmin();
    const at = resolveNow(c.env)();
    const { latest } = await writeDump(c.env, fixedClock(at));
    return c.json({ seq: latest.seq, layout_count: latest.layout_count, written_at: at });
  });

  // design/layout-db/23-geometry.md §10.1: the one-time magic re-seed after a
  // wipe (system lane inside, admin lane outside) -- `{ ref, magic }` ->
  // `core/write.ts`'s `seedMagic` (actor `system:magic-seed`, via
  // `seed:aklgg`, keeps/sets `upstream.state = following`). Returns the
  // record's spark/1 rev and `has_magic` like any format write would.
  route.post("/v1/admin/magic-seed", async (c) => {
    const actor = c.get("actor");
    if (!actor.admin) throw notAdmin();
    const body = (await readJson(c.req)) as { ref?: unknown; magic?: unknown };
    if (typeof body.ref !== "string" || body.ref.length === 0) throw badRequest("`ref` must be a non-empty string");
    if (body.magic === null || typeof body.magic !== "object" || Array.isArray(body.magic)) throw badRequest("`magic` must be an object");
    const out = await seedMagic(c.env, resolveNow(c.env), body.ref, body.magic, null);
    const row = out.formats.get("spark")!;
    return c.json({ id: out.layout.id, name: out.layout.name, rev: row.rev, has_magic: row.has_magic, upstream: out.layout.upstream });
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

  // [LDB-A11] saltorbit 2026-09-13 ("rogue trusted client" hardening): an
  // EXPLICIT, admin-triggered suspend -- distinct from the automatic
  // destructive-write-budget trip (`core/clients.ts`'s
  // `checkDestructiveBudget`, `actor: "system:budget-guard"`), same
  // underlying `suspendClient`. Idempotent past the first suspend
  // (`revokeClient`'s own shape); refuses to touch a REVOKED client
  // (revoke is terminal).
  route.post("/v1/admin/clients/:id/suspend", async (c) => {
    const actor = c.get("actor");
    if (!actor.admin) throw notAdmin();
    const id = c.req.param("id");
    const body = await readJsonOptional(c.req);
    const reason = typeof body.reason === "string" && body.reason.length > 0 ? body.reason : "manual admin suspension";
    const result = await clients.suspendClient(c.env.DB, resolveNow(c.env), actor.user_id, id, reason);
    if (result === null) throw clients.unknownClientId(id);
    if (result.status === "revoked") throw clientAlreadyRevoked();
    return c.json(result);
  });

  // [LDB-A11] the reverse: only `suspended -> active` moves; idempotent on
  // an already-active client, refused on a revoked one.
  route.post("/v1/admin/clients/:id/reactivate", async (c) => {
    const actor = c.get("actor");
    if (!actor.admin) throw notAdmin();
    const id = c.req.param("id");
    const result = await clients.reactivateClient(c.env.DB, resolveNow(c.env), actor.user_id, id);
    if (result === null) throw clients.unknownClientId(id);
    if (result.status === "revoked") throw clientAlreadyRevoked();
    return c.json(result);
  });

  // [LDB-A13] the bulk-undo half of the runbook: walks this client's own
  // destructive writes since `since` (newest -> oldest) and reverts each
  // one from its own history -- `dry_run: true` returns the plan only,
  // writing nothing. Bounded per call (`next`, an event seq cursor);
  // idempotent (a second run reverts nothing new); never touches a record
  // this client didn't write, and never overrides a later write some
  // OTHER actor made on the same scope (`core/revert.ts`'s own header).
  route.post("/v1/admin/clients/:id/revert", async (c) => {
    const actor = c.get("actor");
    if (!actor.admin) throw notAdmin();
    const id = c.req.param("id");
    const known = await clients.listClients(c.env.DB);
    if (!known.some((k) => k.id === id)) throw clients.unknownClientId(id);
    const body = (await readJson(c.req)) as { since?: unknown; dry_run?: unknown; cursor?: unknown; limit?: unknown };
    if (typeof body.since !== "string" || body.since.length === 0) throw badRequest("`since` must be a non-empty ISO timestamp string", "/since");
    const dryRun = body.dry_run === true;
    const cursor = typeof body.cursor === "number" ? body.cursor : undefined;
    const limit = typeof body.limit === "number" ? body.limit : undefined;
    const result = await revertClientWrites(c.env.DB, resolveNow(c.env), actor.user_id, id, body.since, { dryRun, cursor, limit });
    return c.json(result);
  });

  return route;
}
