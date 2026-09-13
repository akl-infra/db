import { Hono } from "hono";
import type { Bindings } from "./env";
import { type ActorVariables, requireActorOnWrites } from "./auth/actor";
import { type AuthDeps, resolveActor } from "./auth/discord";
import { idempotencyKeys } from "./auth/idempotency";
import { rateLimitWrites } from "./auth/ratelimit";
import { ApiError, internal } from "./core/errors";
import { cachePut, conditional, etagFor, readHead } from "./core/etag";
import { dumpDue, DUMP_STATE_KEY, readDumpState, writeDump, type DumpState } from "./dump/write";
import { runJob } from "./core/jobs";
import { metaFormats, readMetaCore } from "./core/meta";
import { runNightly } from "./core/nightly";
import { systemClock } from "./core/time";
import type { FetchImpl } from "./import/upstream";
import { tick as cminiTick } from "./import/cmini";
import { diffDue, diffTick, lastDiff, IMPORT_STATE_KEY as LAST_DIFF_KEY, type LastDiffRecord } from "./import/difftick";
import { adminRoute } from "./routes/admin";
import { authorsRoute } from "./routes/authors";
import { changelogRoute } from "./routes/changelog";
import { changesRoute } from "./routes/changes";
import { dumpRoute } from "./routes/dump";
import { formatsRoute } from "./routes/formats";
import { layoutsRoute } from "./routes/layouts";
import { likesRoute } from "./routes/likes";
import { linksRoute } from "./routes/links";
import { moderationRoute } from "./routes/moderation";
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

// The Idempotency-Key gate (L3, src/auth/idempotency.ts) -- mounted right
// after the actor is resolved (it needs `c.get("actor")` for scoping) and
// BEFORE the rate limit, so a genuine replay short-circuits before either
// write-rate counter is ever touched ("charged once per key, not per
// replay"). Scoped to `/v1/layouts*` internally; every other route is a
// no-op pass-through regardless of whether the header is present.
app.use("/v1/*", idempotencyKeys(systemClock));

// The write rate limit (09 §2.5; 10 C1 D8 layers the per-client counter on
// top) -- mounted right after the actor is resolved and before every route,
// so T3's admin routes and T4's PATCH are covered by placement, not by
// listing them here.
app.use("/v1/*", rateLimitWrites(authDeps.now));

// GET /v1/meta -- the service's head: counts, the event cursor, the
// authors version, and the registered formats. Every field comes from a
// real D1 query; a fresh database (no rows anywhere) answers the
// all-zero/null body.
//
// The ETag (LDB-R9..R11) is computed from `readHead` (core/etag.ts) --
// ONE D1 query: the event head, `authors_head`'s row, and (X4) two
// `import_state` records (`last_diff`, and LDB-D8's own `dump.last_at`,
// read here only to answer `health.dump.seq`/`.last_at` below, NOT hashed
// into the tag -- see the `health` comment) -- plus the in-memory format
// registry. That is every input the BODY's `last_diff`/counts are a
// function of, so the ETag changes iff those change:
//   - `last_diff` never bumps `seq` (the diff cron appends no event, 12
//     §6.4); without it in the tag a poller could see 304 forever after a
//     fresh diff run (LDB-M1);
//   - an author-only change (a new id or a rename, from the import or
//     either auth lane) appends no event either; `authors_head` moves on
//     exactly those (migrations/0007's triggers) and never on
//     `last_seen_at` bookkeeping, so a sign-in that keeps its name still
//     gets the bot's per-command check a 304.
// A 304 costs that one query.
const META_STATE_KEYS = [LAST_DIFF_KEY, DUMP_STATE_KEY] as const;

// LDB-M2: `health.dump`/`health.diff` -- `{last_at, [seq,] age_s, stale}`,
// `stale` past 48h (twice the 24h catch-up threshold, LDB-D8, so a genuinely
// stuck job is unambiguous from one merely between ticks). Deliberately
// NOT folded into the ETag above: `age_s` moves every second, so hashing it
// in would defeat every 304/edge-cache hit this route exists for -- a
// client that only ever sees a cached body gets a slightly stale `age_s`
// (bounded by `CACHE_CONTROL`'s max-age), acceptable for an hours-scale
// signal. A `null last_at` (never run) reports `stale: true`.
const HEALTH_STALE_MS = 48 * 60 * 60 * 1000;

interface HealthField {
  last_at: string | null;
  age_s: number | null;
  stale: boolean;
}

function healthOf(lastAt: string | null, nowIso: string): HealthField {
  if (lastAt === null) return { last_at: null, age_s: null, stale: true };
  const age_s = Math.floor((Date.parse(nowIso) - Date.parse(lastAt)) / 1000);
  return { last_at: lastAt, age_s, stale: age_s * 1000 > HEALTH_STALE_MS };
}

app.get("/v1/meta", async (c) => {
  const db = c.env.DB;
  const head = await readHead(db, META_STATE_KEYS);
  const [diffRaw, dumpRaw] = head.state;
  const diffRecord = diffRaw === null || diffRaw === undefined ? null : (JSON.parse(diffRaw) as LastDiffRecord);
  const dumpState = dumpRaw === null || dumpRaw === undefined ? null : (JSON.parse(dumpRaw) as DumpState);
  const lastDiffWire = diffRecord === null ? null : { at: diffRecord.at, ok: diffRecord.ok };
  const etag = await etagFor(head.seq, {
    authors: head.authors,
    last_diff: lastDiffWire,
    formats: metaFormats(),
  });
  const short = await conditional(c, etag, CACHE_CONTROL);
  if (short) return short;

  const nowIso = authDeps.now();
  const dumpHealth = healthOf(dumpState?.at ?? null, nowIso);
  const health = {
    dump: { last_at: dumpHealth.last_at, seq: dumpState?.seq ?? null, age_s: dumpHealth.age_s, stale: dumpHealth.stale },
    diff: healthOf(diffRecord?.at ?? null, nowIso),
  };

  const res = c.json({
    ...(await readMetaCore(db, head)),
    last_diff: lastDiffWire,
    health,
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
  // [LDB-MD10] `banned` (like `admin`) is proven fresh every call, never
  // cached, and `/v1/me` is never refused by it (reads unaffected, §4.1).
  return c.json({ user_id: actor.user_id, name: actor.name, via: actor.via, admin: actor.admin, banned: actor.banned });
});

app.route("/", layoutsRoute);
app.route("/", authorsRoute);
app.route("/", formatsRoute);
app.route("/", changesRoute(authDeps));
app.route("/", changelogRoute);
app.route("/", dumpRoute);
app.route("/", writeRoute);
app.route("/", likesRoute);
app.route("/", linksRoute(authDeps));
app.route("/", adminRoute(authDeps));
app.route("/", moderationRoute(authDeps));

app.onError((err, c) => {
  if (err instanceof ApiError) {
    return c.json(err.body, err.status as 400 | 401 | 403 | 404 | 409 | 422 | 429 | 500 | 503, err.headers);
  }
  const e = internal();
  console.error(err); // never in the response body -- see core/errors.ts
  return c.json(e.body, 500);
});

// ONE cron trigger (`*/5 * * * *`, wrangler.toml's `[triggers]`) -- what
// used to be four separate cron strings (`*/1`, `*/5`, `0 3`, `0 4`) are
// now three jobs (the `*/1` webhook drain is gone with the webhook
// subsystem, LEDGER.md L4) dispatched off ONE five-minute tick's own
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
// Fault isolation between the jobs bundled onto one invocation: separate
// cron triggers meant a broken one (say, upstream timing out) could only
// ever wedge ITS OWN schedule -- the nightly prune, the diff, kept running
// on their own triggers regardless. Collapsing onto one dispatch must not
// silently recreate a single point of failure out of previously-
// independent jobs, so each one is caught and logged (`core/jobs.ts`'s
// `runJob`) rather than left to abort every job still queued after it in
// the same invocation (`tests/import/tick.test.ts`'s own "one job's
// failure doesn't block the rest" case is the regression test).
async function scheduled(event: ScheduledController, env: Bindings, _ctx: ExecutionContext): Promise<void> {
  if (event.cron !== "*/5 * * * *") {
    throw new Error(`scheduled(): unrecognized cron '${event.cron}'`);
  }

  const at = new Date(event.scheduledTime);
  const hour = at.getUTCHours();
  const minute = at.getUTCMinutes();

  await runJob("cmini-tick", () => cminiTick(env, systemClock));

  // LDB-D8: the diff runs BEFORE the dump on every invocation (not just
  // production's disjoint hour=4/hour=3 slots) so that on the rare tick
  // where BOTH catch up at once, the dump's own `import_state` snapshot
  // (built inside `runNightly`/`writeDump` below) already reflects the
  // diff's freshly-written `cmini.last_diff` row instead of being one
  // write behind it -- a "producer before snapshotter" ordering, the one
  // pair of jobs here that can otherwise observe each other's state.
  //
  // The old `0 4 * * *`: hour=4 stays the preferred slot; any other tick
  // runs the diff anyway once `cmini.last_diff` (12 §3 X4) is missing or
  // >24h old (LDB-D8), so a dropped hour=4 dispatch is caught within one
  // tick of the next successful one instead of silently skipping a day.
  if (hour === 4 && minute === 0) {
    await runJob("diff-tick", () => diffTick(env, systemClock));
  } else if (diffDue(await lastDiff(env.DB), at.toISOString())) {
    await runJob("diff-tick", () => diffTick(env, systemClock));
  }

  // The old `0 3 * * *`: prune + the nightly dump, delegated to
  // `core/nightly.ts`'s `runNightly` so this exact job list is also what
  // `POST /v1/admin/nightly/tick` (routes/admin.ts) runs -- one job list,
  // two callers, never a second copy to drift out of sync (each of the
  // four still runs even if an earlier one this same minute throws --
  // `runNightly`'s own `runJob` guard). hour=3 stays the preferred slot,
  // unconditional (also where the three prunes run, on their own
  // unrelated-to-catch-up daily cadence); any other tick runs the dump
  // anyway once `dump.last_at` (`dump/write.ts`) is missing or >24h old
  // (LDB-D8) -- same dropped-dispatch protection as the diff, above.
  if (hour === 3 && minute === 0) {
    await runNightly(env, systemClock);
  } else if (dumpDue(await readDumpState(env.DB), at.toISOString())) {
    await runJob("dump-catchup", () => writeDump(env, systemClock));
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
