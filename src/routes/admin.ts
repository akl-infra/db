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
import * as clients from "../core/clients";
import { badRequest, clientAlreadyRevoked, importPaused, importRunning, notAdmin } from "../core/errors";
import { runNightly } from "../core/nightly";
import { revertClientWrites } from "../core/revert";
import { systemClock, fixedClock, type Clock } from "../core/time";
import { writeDump } from "../dump/write";
import { restoreLayout, seedMagic } from "../core/write";
import { tick as cminiTick } from "../import/cmini";
import type { FetchImpl as DiffFetchImpl } from "../import/diff";
import { diffTick, lastDiff } from "../import/difftick";
import { listRestorableUpstreamDeleted, unstallImport } from "../import/recovery";
import type { FetchImpl as UpstreamFetchImpl } from "../import/upstream";
import { parseAdminAddBody, parseRegisterClientBody } from "./schemas";

// Same test-only escape hatch as routes/write.ts's `resolveNow`: a test
// pins `TEST_CLOCK` on the shared `env` object before a `SELF.fetch` call
// to make an admin write's "now" deterministic. Absent in production
// (LDB-G4 -- every real binding has a README row, this isn't one).
function resolveNow(env: Bindings): Clock {
  return (env as unknown as { TEST_CLOCK?: Clock }).TEST_CLOCK ?? systemClock;
}

// X4 follow-up: same shape as `resolveNow`, for `POST /v1/admin/import
// /tick`/`.../diff/tick`'s own upstream fetch. `cminiTick`/`diffTick` both
// already accept an optional `fetchImpl` (production default: real
// `fetch`) -- this only lets a test inject a fake one without going
// through the SAME global `fetch` stub actor resolution uses (which, in
// tests/api/conformance.test.ts, answers Discord shapes only and would be
// corrupted by also being asked cmini-upstream questions). Absent in
// production, same as `TEST_CLOCK`. Untyped at the storage site and cast
// per call site: `import/cmini.ts`'s and `import/diff.ts`'s own
// `FetchImpl` types differ only in whether `init` is required (both are
// always called with one in practice), and are otherwise the same shape a
// real fetchImpl (e.g. `tests/import/fake-upstream.ts`'s) satisfies either
// way.
function resolveTickFetchImpl(env: Bindings): unknown {
  return (env as unknown as { TEST_TICK_FETCH_IMPL?: unknown }).TEST_TICK_FETCH_IMPL;
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

  // X4 follow-up: a manual kick for the `*/5` import cron -- production
  // reason: Cloudflare's cron dispatch has, at least once, simply stopped
  // firing for the deployed Worker's registered triggers (0 scheduled
  // invocations over 25 minutes, no error surfaced anywhere but a stale
  // `/v1/meta`), leaving operators no way to force a tick short of waiting
  // it out. Calls the EXACT SAME `tick()` `src/index.ts`'s `scheduled()`
  // calls for the real cron (tests/api/admin.test.ts's own spy proves the
  // two call sites share one implementation) -- refuses while paused
  // (`admins.isImportPaused`) rather than paying for a call that would
  // silently no-op the same way the cron itself does.
  route.post("/v1/admin/import/tick", async (c) => {
    const actor = c.get("actor");
    if (!actor.admin) throw notAdmin();
    if (await admins.isImportPaused(c.env.DB)) throw importPaused();
    const now = resolveNow(c.env);
    const result = await cminiTick(c.env, now, resolveTickFetchImpl(c.env) as UpstreamFetchImpl | undefined);
    // B4 (design/layout-db/review/audit-db.md B4): `tick()` itself took the
    // `cmini.running` lock and found it already held -- a cron overlap
    // would just skip quietly (that's the whole point of the lock for the
    // unattended path), but a manual kick should tell its caller loudly
    // rather than report `{ran: true}` for a tick that never actually ran.
    if (result.stats.skipped_locked) throw importRunning();
    await admins.recordManualTick(c.env.DB, now, actor.user_id, "import", result.stats);
    return c.json({ ran: true, ...result.stats });
  });

  // LDB-I25 (hostile/vanished-upstream recovery, design/HARD-REQUIREMENTS.md's
  // spirit -- saltorbit 2026-09-13): lift `cmini.stalled` deliberately. This is
  // a MANUAL OVERRIDE, not a fix -- the next tick (cron or `.../import/
  // tick` above) re-plans from scratch, so an upstream that is STILL
  // short-listing (LDB-I6) or STILL mass-deleting (LDB-I3/I22) re-stalls
  // immediately, on that very next tick. No "was it even stalled" pre-
  // check: unstalling a non-stalled import is a harmless no-op that still
  // logs (an operator's explicit action is worth the changelog either way).
  route.post("/v1/admin/import/unstall", async (c) => {
    const actor = c.get("actor");
    if (!actor.admin) throw notAdmin();
    const now = resolveNow(c.env);
    // `seq` deliberately not in the response -- same posture as
    // `DELETE /v1/admin/admins/:user_id` above (it discards `admins.remove`'s
    // own `{seq}` too): an internal event-log counter, order-dependent
    // across an entire test run, not something a fixed conformance fixture
    // should ever pin.
    const { wasStalled } = await unstallImport(c.env.DB, now, actor.user_id, actor.via);
    return c.json({ unstalled: true, was_stalled: wasStalled });
  });

  // LDB-I26: bulk-restore `upstream_deleted` tombstones since a timestamp
  // -- the last-resort recovery for a hostile/broken upstream that got
  // past the automatic guards before they existed, or while the kill
  // switch (`IMPORT_DELETES=off`, LDB-I23) was off. Reuses `restoreLayout`
  // (core/write.ts) per record -- the exact same path an owner's own
  // restore takes, one write per layout, never a bespoke bulk-write path.
  // `since` is required (an ISO instant); `limit` bounds how many this ONE
  // call restores (never the whole history in one shot); `dry_run: true`
  // answers with the candidate list and touches no data at all.
  const RESTORE_DELETED_DEFAULT_LIMIT = 200;
  const RESTORE_DELETED_MAX_LIMIT = 500;
  route.post("/v1/admin/import/restore-deleted", async (c) => {
    const actor = c.get("actor");
    if (!actor.admin) throw notAdmin();
    const body = (await readJson(c.req)) as { since?: unknown; limit?: unknown; dry_run?: unknown };
    if (typeof body.since !== "string" || Number.isNaN(Date.parse(body.since))) {
      throw badRequest("`since` must be an ISO 8601 timestamp string", "/since");
    }
    const sinceIso = new Date(body.since).toISOString();
    let limit = RESTORE_DELETED_DEFAULT_LIMIT;
    if (body.limit !== undefined) {
      if (typeof body.limit !== "number" || !Number.isInteger(body.limit) || body.limit <= 0) {
        throw badRequest("`limit` must be a positive integer", "/limit");
      }
      limit = body.limit;
    }
    limit = Math.min(limit, RESTORE_DELETED_MAX_LIMIT);
    const dryRun = body.dry_run === true;

    const candidates = await listRestorableUpstreamDeleted(c.env.DB, sinceIso, limit);
    if (dryRun) {
      return c.json({
        dry_run: true,
        count: candidates.length,
        would_restore: candidates.map((r) => ({ id: r.layoutId, name: r.name, deleted_at: r.deletedAt })),
      });
    }

    const now = resolveNow(c.env);
    const version = c.get("sourceVersion");
    const restored: { id: string; name: string }[] = [];
    const errors: { id: string; name: string; message: string }[] = [];
    for (const candidate of candidates) {
      try {
        const result = await restoreLayout(c.env, now, actor, candidate.layoutId, {}, version);
        restored.push({ id: result.layout.id, name: result.layout.name });
      } catch (e) {
        errors.push({ id: candidate.layoutId, name: candidate.name, message: e instanceof Error ? e.message : String(e) });
      }
    }
    return c.json({ dry_run: false, count: restored.length, restored, errors });
  });

  // Same treatment for the diff cron (`0 4 * * *`, `import/difftick.ts`) --
  // no "paused" switch exists for it, so no pre-check.
  route.post("/v1/admin/diff/tick", async (c) => {
    const actor = c.get("actor");
    if (!actor.admin) throw notAdmin();
    const now = resolveNow(c.env);
    const record = await diffTick(c.env, now, resolveTickFetchImpl(c.env) as DiffFetchImpl | undefined);
    await admins.recordManualTick(c.env.DB, now, actor.user_id, "diff", record);
    return c.json({ ran: true, ...record });
  });

  // X4 follow-up 3: a manual kick for the `hour=3, minute=0` nightly job set
  // (the three prunes + the R2 dump, `core/nightly.ts`'s `runNightly`) --
  // same production reason as import/tick and diff/tick above: Cloudflare's
  // cron dispatch is not currently firing for this account, and even
  // locally `wrangler dev --test-scheduled`'s `/__scheduled` endpoint
  // ignores a `?time=` override (07 §6 S5's own doc), so there was no way
  // -- production OR local -- to force the nightly dump short of waiting
  // for a real 03:00Z. Calls the EXACT SAME `runNightly()` `src/index.ts`'s
  // `scheduled()` calls for the real cron (tests/api/admin.test.ts's own
  // spy proves the two call sites share one implementation) -- no "paused"
  // gate exists for this job set (unlike import/tick), so no pre-check.
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

  // 12 §3 X4: the full `last_diff` body -- `/v1/meta` only ever serves
  // `{at, ok}` off the same `import_state` row (12 §6.7: "the public poll
  // stays small").
  route.get("/v1/admin/health", async (c) => {
    const actor = await resolveActor(c.env, c.req, authDeps);
    if (!actor.admin) throw notAdmin();
    const diff = await lastDiff(c.env.DB);
    return c.json({ last_diff: diff });
  });

  return route;
}
