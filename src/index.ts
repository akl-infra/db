import { Hono } from "hono";
import type { Bindings } from "./env";
import { type ActorVariables, requireActorOnWrites } from "./auth/actor";
import { type AuthDeps, pruneAuthCache, resolveActor } from "./auth/discord";
import { ApiError, internal } from "./core/errors";
import { systemClock } from "./core/time";
import { list as listFormats } from "./formats/registry";
import type { FetchImpl } from "./import/upstream";
import { tick as cminiTick } from "./import/cmini";

const app = new Hono<{ Bindings: Bindings; Variables: ActorVariables }>();

// Production deps for the user lane: real fetch, real clock. Tests never
// exercise this path directly -- they inject their own fake `fetchImpl`
// against `resolveBearer`/`resolveActor`, or stub the global `fetch` for a
// black-box `SELF.fetch` request (same pattern `import/cmini.ts`'s default
// param and tests/import/tick.test.ts's `vi.stubGlobal` already use).
const authDeps: AuthDeps = { fetchImpl: ((url, init) => fetch(url, init)) as FetchImpl, now: systemClock };

// Gates every non-GET/HEAD/OPTIONS request under /v1/* on a resolved actor
// (09 §2.1) -- registered before any route, so no write route, present or
// future, can be reached without it.
app.use("/v1/*", requireActorOnWrites(authDeps));

// GET /v1/meta -- the service's head: counts, the event cursor, and the
// registered formats. Every field comes from a real D1 query; a fresh
// database (no rows anywhere) answers the all-zero/null body below.
app.get("/v1/meta", async (c) => {
  const db = c.env.DB;
  const [layoutRow, authorRow, eventRow] = await Promise.all([
    db
      .prepare(
        "SELECT COUNT(*) AS n, MAX(modified_at) AS modified FROM layouts WHERE deleted = 0",
      )
      .first<{ n: number; modified: string | null }>(),
    db
      .prepare("SELECT COUNT(*) AS n, MAX(last_seen_at) AS modified FROM authors")
      .first<{ n: number; modified: string | null }>(),
    db.prepare("SELECT MAX(seq) AS seq, MAX(at) AS at FROM events").first<{
      seq: number | null;
      at: string | null;
    }>(),
  ]);

  return c.json({
    layout_count: layoutRow?.n ?? 0,
    author_count: authorRow?.n ?? 0,
    seq: eventRow?.seq ?? 0,
    revision: eventRow?.at ?? null,
    layouts_modified_at: layoutRow?.modified ?? null,
    authors_modified_at: authorRow?.modified ?? null,
    formats: listFormats().map((f) => f.id), // S3 adds akl/1 alongside cmini/1
  });
});

// GET /v1/me -- proves the whole auth chain with no write risk (09 §2.1).
// The one GET that needs an actor, so it calls resolveActor itself instead
// of going through requireActorOnWrites (which skips GET/HEAD/OPTIONS).
app.get("/v1/me", async (c) => {
  const actor = await resolveActor(c.env, c.req.raw, authDeps);
  return c.json({ user_id: actor.user_id, name: actor.name, via: actor.via, admin: actor.admin });
});

// T1 lands no real write routes yet (T2 adds POST/PUT/PATCH/DELETE on
// /v1/layouts); this one exists only so LDB-A1's black-box enumeration has
// at least one non-GET route to prove requireActorOnWrites actually gates
// something end-to-end, rather than asserting on Hono internals. T2 removes
// it once real write routes exist to enumerate instead.
// Throwaway write route so tests/auth/routes.test.ts can prove the write
// gate end to end before T2 lands real write routes (T2 deletes this).
// Answers only when the test-only TEST_ROUTES binding is set (vitest's
// miniflare config); production has no such var, so this is a 404 there --
// and the gate still runs first either way.
app.post("/v1/__test/write", (c) =>
  (c.env as { TEST_ROUTES?: string }).TEST_ROUTES === "1" ? c.json({ ok: true }) : c.notFound(),
);

app.onError((err, c) => {
  if (err instanceof ApiError) {
    return c.json(err.body, err.status as 400 | 401 | 403 | 404 | 409 | 429 | 500 | 503, err.headers);
  }
  const e = internal();
  console.error(err); // never in the response body -- see core/errors.ts
  return c.json(e.body, 500);
});

// The two crons from wrangler.toml's [triggers]. `ScheduledController` (not
// the legacy service-worker-format `ScheduledEvent`) is what a modules-
// format Worker's `scheduled` export actually receives -- S1's original
// annotation typechecked only because `@cloudflare/workers-types`'s stable
// index.d.ts doesn't carry `ScheduledController` at all, so nothing here
// caught the mismatch until S5 needed it (07 §6 S5's tick.test.ts drives
// this handler directly via pool-workers' `createScheduledController`).
async function scheduled(event: ScheduledController, env: Bindings, _ctx: ExecutionContext): Promise<void> {
  switch (event.cron) {
    case "*/5 * * * *":
      await cminiTick(env, systemClock);
      return;
    case "0 3 * * *":
      await pruneAuthCache(env.DB, systemClock);
      // TODO(S7): src/dump/write.ts
      return;
    default:
      throw new Error(`scheduled(): unrecognized cron '${event.cron}'`);
  }
}

export default {
  fetch: app.fetch,
  scheduled,
};

// Test-only: LDB-A1's black-box enumeration walks `app.routes` to prove
// requireActorOnWrites gates every non-GET route (tests/auth/routes.test.ts).
export { app };
