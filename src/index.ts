import { Hono } from "hono";
import type { Bindings } from "./env";
import { type ActorVariables, requireActorOnWrites, SAFE_METHODS } from "./auth/actor";
import { pruneNonces } from "./auth/client";
import { type AuthDeps, pruneAuthCache, resolveActor } from "./auth/discord";
import { rateLimitWrites } from "./auth/ratelimit";
import { ApiError, internal } from "./core/errors";
import { cachePut, conditional, etagFor, headSeq } from "./core/etag";
import { pruneRateLimits } from "./core/ratelimit";
import { systemClock } from "./core/time";
import { drain as drainWebhooks, type WebhookFetchImpl } from "./core/webhooks";
import { writeDump } from "./dump/write";
import { list as listFormats } from "./formats/registry";
import type { FetchImpl } from "./import/upstream";
import { tick as cminiTick } from "./import/cmini";
import { diffTick, lastDiff } from "./import/difftick";
import { lastDrill } from "./core/admins";
import { adminRoute } from "./routes/admin";
import { authorsRoute } from "./routes/authors";
import { changelogRoute } from "./routes/changelog";
import { changesRoute } from "./routes/changes";
import { dumpRoute } from "./routes/dump";
import { formatsRoute } from "./routes/formats";
import { layoutsRoute } from "./routes/layouts";
import { likesRoute } from "./routes/likes";
import { streamRoute } from "./routes/stream";
import { webhooksRoute } from "./routes/webhooks";
import { writeRoute } from "./routes/write";

const CACHE_CONTROL = "public, max-age=10";

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

// The write rate limit (09 §2.5; 10 C1 D8 layers the per-client counter on
// top) -- mounted right after the actor is resolved and before every route,
// so T3's admin routes and T4's PATCH are covered by placement, not by
// listing them here.
app.use("/v1/*", rateLimitWrites(authDeps.now));

// Production fetchImpl for webhook delivery: real fetch, method+body+signal
// aware (`WebhookFetchImpl`, core/webhooks.ts) unlike `authDeps.fetchImpl`
// above (GET-only, headers-only -- upstream/Discord's own shape).
const webhookFetchImpl: WebhookFetchImpl = (url, init) => fetch(url, init);

// The nudge (12 §2.1): one middleware, registered after `rateLimitWrites`,
// so every accepted write/like/admin action drains once, from one place --
// no route or `core/write.ts` change. `c.res.ok` after `next()` is true
// only for an accepted write (an error response short-circuits via
// `app.onError`, which runs OUTSIDE this middleware's `next()` -- Hono
// invokes error handlers by catching the thrown `ApiError`, so a refused
// write never reaches this line at all, and `c.res` here is always the
// success response when it does). The 30s `waitUntil` bound (0.1) is why
// `WEBHOOK_MAX_POSTS` exists: a nudge posts a bounded batch, the `*/1` cron
// finishes the rest.
app.use("/v1/*", async (c, next) => {
  await next();
  if (!SAFE_METHODS.has(c.req.method) && c.res.ok) {
    const drainPromise = drainWebhooks(c.env, systemClock, {
      fetchImpl: webhookFetchImpl,
      maxPosts: Number(c.env.WEBHOOK_MAX_POSTS),
    });
    c.executionCtx.waitUntil(drainPromise);
    // Test-only observability, same shape as `TEST_CLOCK` (src/routes/
    // write.ts): `SELF.fetch` does NOT wait on `waitUntil` promises before
    // resolving, so a test whose fetch stub has a shorter lifetime than
    // this drain (e.g. it unstubs in `afterEach`) can otherwise leave this
    // promise's own delivery attempt to run against the REAL global fetch
    // after the stub is gone -- in the sandboxed test runtime that's a
    // request to nowhere, which workerd eventually kills as "hung"
    // (harmless to test results, noisy in CI). `tests/api/write-support.ts`'s
    // `writeFetch` awaits this after every call so no test needs to know
    // about it; never read anywhere else, including in production (no
    // `TEST_*` binding exists there to set it from).
    (c.env as unknown as { TEST_LAST_NUDGE?: Promise<unknown> }).TEST_LAST_NUDGE = drainPromise;
  }
});

// GET /v1/meta -- the service's head: counts, the event cursor, and the
// registered formats. Every field comes from a real D1 query; a fresh
// database (no rows anywhere) answers the all-zero/null body below.
// `seq` doubles as the ETag's head (core/etag.ts) -- read it first, via the
// same one-indexed-read query etag.ts itself would do, so a 304 costs
// exactly that read plus (X4) the two `import_state` PK lookups below:
// `last_diff`/`last_drill` never bump `seq` (neither the diff cron nor a
// drill report appends an event, 12 §6.4), so without folding their own
// `at` into the ETag's query hash a client polling with `If-None-Match`
// could see 304 forever after a fresh diff/drill run -- exactly the
// staleness LDB-M1's meta-watch exists to catch.
app.get("/v1/meta", async (c) => {
  const db = c.env.DB;
  const seq = await headSeq(db);
  const [diffRecord, drillRecord] = await Promise.all([lastDiff(db), lastDrill(db)]);
  const etag = await etagFor(seq, { last_diff_at: diffRecord?.at ?? null, last_drill_at: drillRecord?.at ?? null });
  const short = await conditional(c, etag, CACHE_CONTROL);
  if (short) return short;

  // `seq` is already known from `headSeq()` above -- this second query only
  // needs the head event's `at` (its `revision` timestamp).
  const [layoutRow, authorRow, eventRow] = await Promise.all([
    db
      .prepare(
        "SELECT COUNT(*) AS n, MAX(modified_at) AS modified FROM layouts WHERE deleted = 0",
      )
      .first<{ n: number; modified: string | null }>(),
    db
      .prepare("SELECT COUNT(*) AS n, MAX(last_seen_at) AS modified FROM authors")
      .first<{ n: number; modified: string | null }>(),
    db.prepare("SELECT MAX(at) AS at FROM events").first<{ at: string | null }>(),
  ]);

  const res = c.json({
    layout_count: layoutRow?.n ?? 0,
    author_count: authorRow?.n ?? 0,
    seq,
    revision: eventRow?.at ?? null,
    layouts_modified_at: layoutRow?.modified ?? null,
    authors_modified_at: authorRow?.modified ?? null,
    formats: listFormats().map((f) => f.id), // S3 adds akl/1 alongside cmini/1
    last_diff: diffRecord === null ? null : { at: diffRecord.at, ok: diffRecord.ok },
    last_drill: drillRecord === null ? null : { at: drillRecord.at, ok: drillRecord.ok },
  });
  res.headers.set("ETag", etag);
  res.headers.set("Cache-Control", CACHE_CONTROL);
  await cachePut(c, res.clone());
  return res;
});

// GET /v1/me -- proves the whole auth chain with no write risk (09 §2.1).
// The one GET that needs an actor, so it calls resolveActor itself instead
// of going through requireActorOnWrites (which skips GET/HEAD/OPTIONS).
app.get("/v1/me", async (c) => {
  const actor = await resolveActor(c.env, c.req, authDeps);
  return c.json({ user_id: actor.user_id, name: actor.name, via: actor.via, admin: actor.admin });
});

app.route("/", layoutsRoute);
app.route("/", authorsRoute);
app.route("/", formatsRoute);
app.route("/", changesRoute);
app.route("/", changelogRoute);
app.route("/", dumpRoute);
app.route("/", writeRoute);
app.route("/", likesRoute);
app.route("/", adminRoute(authDeps));
app.route("/", webhooksRoute(authDeps));
app.route("/", streamRoute);

app.onError((err, c) => {
  if (err instanceof ApiError) {
    return c.json(err.body, err.status as 400 | 401 | 403 | 404 | 409 | 429 | 500 | 503, err.headers);
  }
  const e = internal();
  console.error(err); // never in the response body -- see core/errors.ts
  return c.json(e.body, 500);
});

// The three crons from wrangler.toml's [triggers]. `ScheduledController` (not
// the legacy service-worker-format `ScheduledEvent`) is what a modules-
// format Worker's `scheduled` export actually receives -- S1's original
// annotation typechecked only because `@cloudflare/workers-types`'s stable
// index.d.ts doesn't carry `ScheduledController` at all, so nothing here
// caught the mismatch until S5 needed it (07 §6 S5's tick.test.ts drives
// this handler directly via pool-workers' `createScheduledController`).
async function scheduled(event: ScheduledController, env: Bindings, _ctx: ExecutionContext): Promise<void> {
  switch (event.cron) {
    case "*/1 * * * *":
      await drainWebhooks(env, systemClock, { fetchImpl: webhookFetchImpl, maxPosts: Number(env.WEBHOOK_MAX_POSTS) });
      return;
    case "*/5 * * * *":
      await cminiTick(env, systemClock);
      return;
    case "0 3 * * *":
      await pruneAuthCache(env.DB, systemClock);
      await pruneRateLimits(env.DB, systemClock);
      await pruneNonces(env.DB, systemClock);
      await writeDump(env, systemClock);
      return;
    case "0 4 * * *":
      await diffTick(env, systemClock);
      return;
    default:
      throw new Error(`scheduled(): unrecognized cron '${event.cron}'`);
  }
}

// Exported (not just the default) so tests/api/conformance.test.ts can
// enumerate `app.routes` -- the case set it requires is derived from the
// live route table, not copy-pasted alongside it.
export { app };

export default {
  fetch: app.fetch,
  scheduled,
};

// Test-only: LDB-A1's black-box enumeration walks `app.routes` to prove
// requireActorOnWrites gates every non-GET route (tests/auth/routes.test.ts).
