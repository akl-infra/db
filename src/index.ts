import { Hono } from "hono";
import type { Bindings } from "./env";
import { type ActorVariables, requireActorOnWrites, SAFE_METHODS } from "./auth/actor";
import { type AuthDeps, resolveActor } from "./auth/discord";
import { rateLimitWrites } from "./auth/ratelimit";
import { ApiError, internal } from "./core/errors";
import { cachePut, conditional, etagFor, readHead } from "./core/etag";
import { runJob } from "./core/jobs";
import { metaFormats, readMetaCore } from "./core/meta";
import { runNightly } from "./core/nightly";
import { systemClock } from "./core/time";
import { drain as drainWebhooks, type WebhookFetchImpl } from "./core/webhooks";
import type { FetchImpl } from "./import/upstream";
import { tick as cminiTick } from "./import/cmini";
import { diffTick, IMPORT_STATE_KEY as LAST_DIFF_KEY, type LastDiffRecord } from "./import/difftick";
import { DRILL_KEY, type DrillRecord } from "./core/admins";
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

// GET /v1/meta -- the service's head: counts, the event cursor, the
// authors version, and the registered formats. Every field comes from a
// real D1 query; a fresh database (no rows anywhere) answers the
// all-zero/null body.
//
// The ETag (LDB-R9..R11) is computed from `readHead` (core/etag.ts) --
// ONE D1 query: the event head, `authors_head`'s row, and (X4) the two
// `import_state` records -- plus the in-memory format registry. That is
// every input the body is a function of, and the body carries each of
// them, so the ETag changes iff the body does:
//   - `last_diff`/`last_drill` never bump `seq` (neither the diff cron nor
//     a drill report appends an event, 12 §6.4); without them in the tag
//     a poller could see 304 forever after a fresh diff/drill run
//     (LDB-M1);
//   - an author-only change (a new id or a rename, from the import or
//     either auth lane) appends no event either; `authors_head` moves on
//     exactly those (migrations/0007's triggers) and never on
//     `last_seen_at` bookkeeping, so a sign-in that keeps its name still
//     gets the bot's per-command check a 304.
// A 304 costs that one query.
const META_STATE_KEYS = [LAST_DIFF_KEY, DRILL_KEY] as const;

app.get("/v1/meta", async (c) => {
  const db = c.env.DB;
  const head = await readHead(db, META_STATE_KEYS);
  const [diffRaw, drillRaw] = head.state;
  const diffRecord = diffRaw === null || diffRaw === undefined ? null : (JSON.parse(diffRaw) as LastDiffRecord);
  const drillRecord = drillRaw === null || drillRaw === undefined ? null : (JSON.parse(drillRaw) as DrillRecord);
  const lastDiffWire = diffRecord === null ? null : { at: diffRecord.at, ok: diffRecord.ok };
  const lastDrillWire = drillRecord === null ? null : { at: drillRecord.at, ok: drillRecord.ok };
  const etag = await etagFor(head.seq, {
    authors: head.authors,
    last_diff: lastDiffWire,
    last_drill: lastDrillWire,
    formats: metaFormats(),
  });
  const short = await conditional(c, etag, CACHE_CONTROL);
  if (short) return short;

  const res = c.json({
    ...(await readMetaCore(db, head)),
    last_diff: lastDiffWire,
    last_drill: lastDrillWire,
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

// ONE cron trigger (`*/5 * * * *`, wrangler.toml's `[triggers]`) -- what
// used to be four separate cron strings (`*/1`, `*/5`, `0 3`, `0 4`) are
// now four jobs dispatched off ONE five-minute tick's own
// `event.scheduledTime` (UTC), not off `event.cron` (there is only one cron
// string left to switch on). Why: four registered triggers on one Worker
// is four independent things Cloudflare's own scheduler has to keep
// dispatching correctly, and it has -- at least once, observed on the
// deployed service -- simply stopped firing all of them with no error
// surfaced anywhere but a stale `/v1/meta` (the same production incident
// the manual `/v1/admin/*/tick` routes exist for); one trigger is one
// fewer thing that dispatch can silently wedge on, and every job's own
// due-or-not decision is a pure function of the clock, testable as a flat
// enumeration below (`tests/import/tick.test.ts`'s own matrix) rather than
// scattered across which of four cron strings happened to fire.
//
// `ScheduledController` (not the legacy service-worker-format
// `ScheduledEvent`) is what a modules-format Worker's `scheduled` export
// actually receives -- S1's original annotation typechecked only because
// `@cloudflare/workers-types`'s stable index.d.ts doesn't carry
// `ScheduledController` at all, so nothing here caught the mismatch until
// S5 needed it (07 §6 S5's tick.test.ts drives this handler directly via
// pool-workers' `createScheduledController`, which accepts a `scheduledTime`
// override for exactly this file's own tests).
// Fault isolation between the jobs bundled onto one invocation: four
// separate cron triggers meant a broken one (say, upstream timing out)
// could only ever wedge ITS OWN schedule -- webhook delivery, the nightly
// prune, the diff, kept running on their own triggers regardless.
// Collapsing onto one dispatch must not silently recreate a single point
// of failure out of four previously-independent jobs, so each one is
// caught and logged (`core/jobs.ts`'s `runJob`) rather than left to abort
// every job still queued after it in the same invocation
// (`tests/import/tick.test.ts`'s own "one job's failure doesn't block the
// rest" case is the regression test).
async function scheduled(event: ScheduledController, env: Bindings, _ctx: ExecutionContext): Promise<void> {
  if (event.cron !== "*/5 * * * *") {
    throw new Error(`scheduled(): unrecognized cron '${event.cron}'`);
  }

  const at = new Date(event.scheduledTime);
  const hour = at.getUTCHours();
  const minute = at.getUTCMinutes();

  // Every tick: the import cron's own work first, then the webhook drain --
  // so a subscription sees THIS SAME invocation's own import events
  // (imported/upstream_changed/upstream_deleted/...) without waiting for
  // the next five-minute slot. The reverse order has nothing to gain
  // (drainWebhooks has no import events of its own to lose by running
  // second) and would cost every import event one extra tick's worth of
  // webhook latency for no reason -- so `cminiTick` runs first.
  await runJob("cmini-tick", () => cminiTick(env, systemClock));
  await runJob("webhook-drain", () =>
    drainWebhooks(env, systemClock, { fetchImpl: webhookFetchImpl, maxPosts: Number(env.WEBHOOK_MAX_POSTS) }),
  );

  // The old `0 3 * * *`: prune + the nightly dump, delegated to
  // `core/nightly.ts`'s `runNightly` so this exact job list is also what
  // `POST /v1/admin/nightly/tick` (routes/admin.ts) runs -- one job list,
  // two callers, never a second copy to drift out of sync (each of the
  // four still runs even if an earlier one this same minute throws --
  // `runNightly`'s own `runJob` guard).
  if (hour === 3 && minute === 0) {
    await runNightly(env, systemClock);
  }

  // The old `0 4 * * *`: the diff cron (12 §3 X4).
  if (hour === 4 && minute === 0) {
    await runJob("diff-tick", () => diffTick(env, systemClock));
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
