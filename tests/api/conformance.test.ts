// [LDB-P7] [LDB-R3] The conformance suite: `tests/conformance/**` IS the
// API contract (03 §1, 07 §6 S6). Every case runs against a real
// upstream-100 seed and is asserted byte-exact (status, listed headers,
// `canonical(normalizeIds(body))`); a second test enumerates the live
// route table (`app.routes`) and the error vocabulary (`core/errors.ts`)
// and fails when a required (route, status) pair has no case, so an added
// route or a silently-dropped error path can't go uncovered.
import { env } from "cloudflare:test";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { Bindings } from "../../src/env";
import {
  badRequest,
  identityUnavailable,
  ifMatchRequired,
  importPaused,
  invalidName,
  lastAdmins,
  nameTaken,
  notAdmin,
  notFound,
  notOwner,
  rateLimited,
  stale,
  streamUnavailable,
  tokenInvalid,
  tooManyWebhooks,
  unknownFormat,
  unauthorized,
  unsupportedForFormat,
} from "../../src/core/errors";
import { appendWrite } from "../../src/core/events";
import { fixedClock, type Clock } from "../../src/core/time";
import { app } from "../../src/index";
import type { FetchImpl } from "../../src/import/upstream";
import { FakeDiscord } from "../auth/fake-discord";
import { vectors } from "../auth/client-support";
import { CASES } from "../conformance/manifest";
import { FakeUpstream } from "../import/fake-upstream";
import { CONFORMANCE_CLIENT_ID, assertConformanceCase, seedUpstream100 } from "./support";
import { BOOTSTRAP_ADMIN } from "./write-support";

const bindings = env as unknown as Bindings;
const db = bindings.DB;

// T2's write-route fixtures (09 §3 T2, §4) need an authenticated actor and,
// for `restore`, a tombstone's id (a tombstone has no live name -- byRef's
// name path never reaches it), plus a handful of pre-existing records
// (`cw-put-1`, ...). Seeding these is deliberately NOT in `beforeAll`: every
// write here bumps the shared `layouts`/`authors`/`events` counts that the
// `meta/200` and `authors-list/200` fixtures pin exact literals for, and
// `beforeAll` runs before EVERY case in this file, meta/200 included --
// seeding early would silently drift those two fixtures out from under
// their own committed values. Seeding lazily, memoized, and triggered only
// from the first `layouts-write/*` case's own `it()` keeps every earlier
// case (meta/200 among them) running against the plain `seedUpstream100()`
// state; `CASES`' declared order (the write cases are last) is what makes
// this safe. Referenced from fixture JSON via the placeholders
// `resolvePath` substitutes below -- a fixture file can never embed a
// freshly-minted ulid itself. `CONFORMANCE_CLOCK_ISO` is pinned via
// `TEST_CLOCK` (the same escape hatch tests/api/write-support.ts's
// `pinTestClock` uses) so every write's `created_at`/`modified_at` is byte-
// stable across runs -- required for `canonical(normalizeIds(...))` to
// agree run to run, since `seq` and the record's own literal fields are
// NOT normalized (07 §6 S6: "seeds ... at a FIXED clock").
const CONFORMANCE_CLOCK_ISO = "2026-06-20T00:00:00.000Z";
const CONFORMANCE_OWNER = "800000000000000001";
const CONFORMANCE_TARGET = "810000000000000001";
const CONFORMANCE_RATELIMITED = "820000000000000001"; // T5: an actor no other case's writes touch
// T6: a second write-actor for the handful of new cases whose own `setup`
// runs 2-3 write attempts each (patch-409-name_taken, e.g.) -- keeping
// every one of those on CONFORMANCE_OWNER would push its cumulative
// attempt count (already ~50 across the T2-T5 fixtures) past the 60/10min
// write limit (09 §2.5) partway through this file, 429-ing later cases
// for a reason that has nothing to do with what they're testing.
const CONFORMANCE_OWNER2 = "830000000000000001";
// 10 C1: a second well-known client id, revoked by `admin-clients/delete-200.json`
// -- a fixed id (not one minted by `registerClient`) so that fixture's path
// stays byte-exact; the id doubles as `admin-clients/200.json`'s second row.
const CONFORMANCE_CLIENT_DELETE_ID = "conformance-client-delete-1";
// X1 (12 §3): the fixed id `webhooks/delete-200.json` deletes -- same
// reasoning as `CONFORMANCE_CLIENT_DELETE_ID` above: a fixture path can
// never embed a freshly-minted ULID, so this row is inserted directly (not
// through the route) under a stable, non-ULID id.
const CONFORMANCE_WEBHOOK_DELETE_ID = "conformance-webhook-delete-1";
const CMINI_PAYLOAD = { board: "ortho" as const, keys: {} };
const ID_PLACEHOLDERS: Record<string, string> = {};

async function seedLive(name: string) {
  const { record } = await appendWrite(db, fixedClock(CONFORMANCE_CLOCK_ISO), {
    kind: "created",
    name,
    owner: CONFORMANCE_OWNER,
    modified_at: CONFORMANCE_CLOCK_ISO,
    format: "cmini/1",
    payload: CMINI_PAYLOAD,
    actor: CONFORMANCE_OWNER,
    via: "discord",
    hasMagic: false,
  });
  return record;
}

let writeFixturesReady: Promise<void> | null = null;

function ensureWriteFixtures(): Promise<void> {
  if (writeFixturesReady === null) writeFixturesReady = seedWriteFixtures();
  return writeFixturesReady;
}

async function seedWriteFixtures(): Promise<void> {
  const fake = new FakeDiscord();
  fake.setAnswer("conformance-owner-token", {
    kind: "ok",
    id: CONFORMANCE_OWNER,
    username: "conformance-owner",
    global_name: null,
  });
  // admin-admins/200.json's bearer (09 §3 T3) -- BOOTSTRAP_ADMIN is
  // migrations/0001_init.sql's seeded row, so this token resolves to an
  // actor with `admin: true` with no extra DB setup.
  fake.setAnswer("conformance-admin-token", {
    kind: "ok",
    id: BOOTSTRAP_ADMIN,
    username: "conformance-admin",
    global_name: null,
  });
  // T5's rate-limit case (`ratelimit/429`) needs an actor whose write
  // window no other case touches -- CONFORMANCE_OWNER's own window already
  // accumulates one attempt per layouts-write/* case above, which would
  // make a fixed setup-step count fragile against future additions there.
  // T6 reuses the SAME token for every other route's own 429 case (each
  // positioned after `ratelimit/429` in CASES) -- once that case's 60
  // setup POSTs + its own real POST exhaust the window, the actor stays
  // over limit for the rest of the run (the clock never advances), so no
  // second exhaustion dance is needed per route.
  fake.setAnswer("conformance-ratelimited-token", {
    kind: "ok",
    id: CONFORMANCE_RATELIMITED,
    username: "conformance-ratelimited",
    global_name: null,
  });
  // T6's A-group (09 §2.1, §4): every write route's 401 `token_invalid` case
  // needs a bearer Discord itself rejects. No `setAnswer` call for it --
  // `FakeDiscord`'s own default answer (any unregistered token -> 401) IS
  // the fixture, so this token is deliberately absent from the map:
  // "conformance-invalid-token".
  //
  // The 503 `identity_unavailable` cases need Discord to answer something
  // that's neither 200 nor 401 -- `resolveBearer` never caches that outcome
  // (09 §2.2), so every reuse of this token re-hits the fake, unlike the
  // tokens above.
  fake.setAnswer("conformance-unavailable-token", { kind: "status", status: 500 });
  // T6's `not_owner`/403 cases: a second real actor who owns nothing
  // touched by `seedWriteFixtures` -- reuses CONFORMANCE_TARGET (already an
  // `authors` row below, for `transfer`) rather than minting a third id.
  fake.setAnswer("conformance-other-token", {
    kind: "ok",
    id: CONFORMANCE_TARGET,
    username: "conformance-transfer-target",
    global_name: null,
  });
  // T6's second write-actor (see CONFORMANCE_OWNER2's own comment) -- only
  // used as the creator/owner of a record in a handful of write-heavy
  // cases, never as the "other" (non-owner) caller.
  fake.setAnswer("conformance-owner2-token", {
    kind: "ok",
    id: CONFORMANCE_OWNER2,
    username: "conformance-owner2",
    global_name: null,
  });
  vi.stubGlobal("fetch", fake.fetchImpl);
  (bindings as unknown as { TEST_CLOCK?: Clock }).TEST_CLOCK = fixedClock(CONFORMANCE_CLOCK_ISO);

  await db
    .prepare("INSERT OR IGNORE INTO authors (user_id, name, first_seen_at, last_seen_at) VALUES (?, ?, ?, ?)")
    .bind(CONFORMANCE_TARGET, "conformance-transfer-target", CONFORMANCE_CLOCK_ISO, CONFORMANCE_CLOCK_ISO)
    .run();

  await seedLive("cw-put-1");
  await seedLive("cw-put-stale-1");
  await seedLive("cw-delete-1");
  await seedLive("cw-transfer-1");
  // T4's PATCH fixtures do NOT seed a record here (unlike the verbs above):
  // any record seeded in this shared function runs before EVERY
  // layouts-write case and shifts every OTHER case's baked-in `last_write.
  // seq` literal (put-409-stale's, e.g.) by the count added -- instead each
  // patch-*.json fixture creates its own record via its own `request.
  // setup` (the same mechanism post-409-name_taken/put-409-stale already
  // use), scoped to that one case and touching no one else's numbers. T5's
  // two records below predate that lesson and are accepted as a one-time,
  // already-accounted-for shift (put-409-stale's `last_write.seq` literal
  // reflects it) rather than re-plumbed through per-case `setup`.
  await seedLive("cw-like-1"); // T5: dedicated so layouts-like/* never touches another case's record
  await seedLive("QWERTY"); // T5: the bot-parity like refusal (0.1), case-insensitive

  const restoreOk = await seedLive("cw-restore-1");
  await appendWrite(db, fixedClock(CONFORMANCE_CLOCK_ISO), {
    kind: "deleted",
    layoutId: restoreOk.id,
    name: restoreOk.name,
    owner: restoreOk.owner,
    modified_at: CONFORMANCE_CLOCK_ISO,
    format: restoreOk.format,
    payload: restoreOk.payload,
    actor: CONFORMANCE_OWNER,
    via: "discord",
    deleted: true,
  });
  ID_PLACEHOLDERS.__CW_RESTORE_ID__ = restoreOk.id;

  const restoreLive = await seedLive("cw-restore-live-1");
  ID_PLACEHOLDERS.__CW_RESTORE_LIVE_ID__ = restoreLive.id;

  // 10 C1: the two well-known clients `admin-clients/*.json` and
  // `me/200-signed.json` (support.ts's `signed` step) address -- fixed ids,
  // not ones minted by `registerClient`, so those fixtures stay byte-exact.
  await db.batch([
    db
      .prepare(
        `INSERT OR IGNORE INTO clients (id, name, pubkey, owner_user_id, caps, discord_app_id, status, created_at, revoked_at)
         VALUES (?, ?, ?, ?, ?, NULL, 'active', ?, NULL)`,
      )
      .bind(CONFORMANCE_CLIENT_ID, "conformance-client", vectors.keys[0]!.pubkey_b64url, CONFORMANCE_OWNER, "act-as-user", CONFORMANCE_CLOCK_ISO),
    db
      .prepare(
        `INSERT OR IGNORE INTO clients (id, name, pubkey, owner_user_id, caps, discord_app_id, status, created_at, revoked_at)
         VALUES (?, ?, ?, ?, ?, NULL, 'active', ?, NULL)`,
      )
      .bind(
        CONFORMANCE_CLIENT_DELETE_ID,
        "conformance-client-delete",
        vectors.keys[0]!.pubkey_b64url,
        CONFORMANCE_OWNER,
        "act-as-user",
        CONFORMANCE_CLOCK_ISO,
      ),
    // X1: `webhooks/delete-200.json`'s target, owned by CONFORMANCE_OWNER2
    // (not CONFORMANCE_OWNER -- by this point in the suite CONFORMANCE_OWNER
    // is already close enough to its 60-writes/10min limit, from the T2-T6
    // fixtures' own cumulative usage, that a webhook POST/DELETE for it can
    // tip over into a 429; CONFORMANCE_OWNER2 is the same "second write
    // actor" T6 already uses for exactly this reason). Seeded 'disabled'
    // (never 'active') so the nudge -- which fires on EVERY accepted write
    // for the rest of this suite, real `systemClock` and all -- never
    // selects it as due (`status != 'disabled'`) and never mutates it
    // before the delete case gets to it; DELETE only checks ownership/
    // existence, not this row's delivery state.
    db
      .prepare(
        `INSERT OR IGNORE INTO webhooks (id, owner_user_id, url, secret, kinds, owner_filter, status, cursor, failures, failing_since, next_at, last_error, created_at)
         VALUES (?, ?, 'https://receiver.example/delete-target', 'conformance-webhook-secret-1', NULL, NULL, 'disabled', 0, 0, NULL, ?, NULL, ?)`,
      )
      .bind(CONFORMANCE_WEBHOOK_DELETE_ID, CONFORMANCE_OWNER2, CONFORMANCE_CLOCK_ISO, CONFORMANCE_CLOCK_ISO),
  ]);
}

// T6: two more tombstones for `restore-403-not_owner`/`restore-409-name_taken`
// (09 §3 T6), each addressed only by id (a tombstone has no live name, so a
// case's own `request.setup` -- whose responses are discarded -- can never
// learn one). Deliberately NOT folded into `seedWriteFixtures` above: that
// function runs before EVERY needsSeed case (triggered by the first one,
// "layouts-write/post-201"), so adding events to it shifts the global `seq`
// every earlier-declared case with a baked-in `last_write.seq` literal
// depends on (`put-409-stale`, e.g. -- the exact landmine seedWriteFixtures'
// own comment warns about). This second lazy seed is triggered only by the
// two restore cases that need it, both declared near the end of T6_CASES,
// well after every seq-pinning case earlier in CASES has already run.
let restoreExtrasReady: Promise<void> | null = null;

function ensureRestoreExtras(): Promise<void> {
  if (restoreExtrasReady === null) restoreExtrasReady = seedRestoreExtras();
  return restoreExtrasReady;
}

async function seedRestoreExtras(): Promise<void> {
  const restoreOther = await seedLive("cw-restore-other-1");
  await appendWrite(db, fixedClock(CONFORMANCE_CLOCK_ISO), {
    kind: "deleted",
    layoutId: restoreOther.id,
    name: restoreOther.name,
    owner: restoreOther.owner,
    modified_at: CONFORMANCE_CLOCK_ISO,
    format: restoreOther.format,
    payload: restoreOther.payload,
    actor: CONFORMANCE_OWNER,
    via: "discord",
    deleted: true,
  });
  ID_PLACEHOLDERS.__CW_RESTORE_OTHER_ID__ = restoreOther.id; // 403 not_owner: restored by conformance-other-token

  const restoreTaken = await seedLive("cw-restore-taken-1");
  await appendWrite(db, fixedClock(CONFORMANCE_CLOCK_ISO), {
    kind: "deleted",
    layoutId: restoreTaken.id,
    name: restoreTaken.name,
    owner: restoreTaken.owner,
    modified_at: CONFORMANCE_CLOCK_ISO,
    format: restoreTaken.format,
    payload: restoreTaken.payload,
    actor: CONFORMANCE_OWNER,
    via: "discord",
    deleted: true,
  });
  ID_PLACEHOLDERS.__CW_RESTORE_TAKEN_ID__ = restoreTaken.id; // 409 name_taken: its case's own `setup` re-takes "cw-restore-taken-1" live before restoring
}

// X4 follow-up: `admin-import/tick-200` and `admin-diff/tick-200` are the
// only two cases in this whole suite whose route (`POST /v1/admin/import
// /tick`, `POST /v1/admin/diff/tick`) makes a REAL cmini-upstream fetch,
// not just a Discord one -- `seedWriteFixtures`'s own `vi.stubGlobal
// ("fetch", ...)` answers Discord shapes only, so routing `tick()`/
// `diffTick()`'s upstream call through it would corrupt both. Both routes
// take a test-only `TEST_TICK_FETCH_IMPL` override (same shape as
// `resolveNow`'s `TEST_CLOCK`, `routes/admin.ts`) precisely so this can be
// wired WITHOUT touching the global stub every other case here depends on.
// A freshly constructed `FakeUpstream` serves the exact same upstream-100
// fixture `seedUpstream100()` already imported (`revision: "seed-1"` is a
// fixed default, not random, so its `/meta` canonicalizes identically to
// the one already stored in `cmini.meta_token`) -- the manual import tick
// this enables is thus deterministically QUIET (no drift to pin), and the
// manual diff tick deterministically finds our own already-imported
// records matching it.
let tickFixturesReady: Promise<void> | null = null;

function ensureTickFixtures(): Promise<void> {
  if (tickFixturesReady === null) tickFixturesReady = seedTickFixtures();
  return tickFixturesReady;
}

function seedTickFixtures(): Promise<void> {
  const upstreamFake = new FakeUpstream();
  (bindings as unknown as { TEST_TICK_FETCH_IMPL?: FetchImpl }).TEST_TICK_FETCH_IMPL = upstreamFake.fetchImpl;
  (bindings as unknown as { IMPORT_SOURCE_URL: string }).IMPORT_SOURCE_URL = upstreamFake.baseUrl;
  return Promise.resolve();
}

beforeAll(async () => {
  await seedUpstream100();
});

afterAll(() => {
  vi.unstubAllGlobals();
});

// A fixture path may carry a T2 id-placeholder (`__CW_RESTORE_ID__`) --
// `assertConformanceCase`/`runConformanceRequest` (tests/api/support.ts)
// take this as their `resolvePath` so a write-route fixture can address a
// tombstone's id without ever embedding a freshly-minted ulid itself.
function resolvePath(path: string): string {
  let out = path;
  for (const [token, id] of Object.entries(ID_PLACEHOLDERS)) out = out.replaceAll(token, id);
  return out;
}

describe("conformance fixtures", () => {
  for (const kase of CASES) {
    it(kase.id, async () => {
      // T3's admin-admins/*, T5's layouts-like/*/ratelimit/*, and T6's
      // A-group/403/404/409 cases across every route are all seeded by the
      // same lazy fixture set as T2's layouts-write/* -- one memoized seed,
      // triggered by the manifest's own `needsSeed` flag rather than a
      // hand-listed set of id prefixes (07 §6 S6/09 §3 T2's comment above
      // explains why this can't be `beforeAll`; manifest.ts's `needsSeed`
      // doc explains why a flag replaced the prefix list).
      if (kase.needsSeed) {
        await ensureWriteFixtures();
      }
      // T6: the two restore cases that need a second, later-seeded pair of
      // tombstones (see `seedRestoreExtras`'s comment above).
      if (kase.id === "layouts-write/restore-403-not_owner" || kase.id === "layouts-write/restore-409-name_taken") {
        await ensureRestoreExtras();
      }
      // X4 follow-up: the two manual-tick success cases need a working
      // upstream fetch stub (see `seedTickFixtures`'s own comment above).
      if (kase.id === "admin-import/tick-200" || kase.id === "admin-diff/tick-200") {
        await ensureTickFixtures();
      }
      // X1: this one case needs the Free-plan setting (`STREAM_MAX_MS =
      // "0"`) for the DURATION of its own request only -- every other case
      // in this file (including `changes-stream/200`) runs under the real
      // test default (`500`, `vitest.config.ts`'s miniflare `bindings`).
      if (kase.id === "changes-stream/503-stream_unavailable") {
        (bindings as unknown as { STREAM_MAX_MS: string }).STREAM_MAX_MS = "0";
        try {
          await assertConformanceCase(kase, resolvePath);
        } finally {
          (bindings as unknown as { STREAM_MAX_MS: string }).STREAM_MAX_MS = "500";
        }
        return;
      }
      await assertConformanceCase(kase, resolvePath);
    });
  }
});

// --- enumeration: routes from app.routes, error codes from errors.ts -----
// T6 (09 §3 T6, §4): REQUIRED is now a full (method, status[, code]) sweep,
// keyed "METHOD /path" (Hono's own path-template spelling) over EVERY live
// route, not just GET. A route or a (route, status, code) with no fixture
// case fails the enumeration test below; a fixture case naming a
// (route, status, code) not in REQUIRED fails it too (LDB-P7/LDB-R3's
// "both directions" property).

const ERROR_CODES = {
  unauthorized: unauthorized().body.error,
  token_invalid: tokenInvalid().body.error,
  identity_unavailable: identityUnavailable().body.error,
  bad_request: badRequest("x").body.error,
  if_match_required: ifMatchRequired().body.error,
  // No dedicated constructor -- a format's `validate()`/an `edits.set*`
  // returns this literal directly (formats/cmini/1/index.ts, edits.ts).
  invalid_payload: "invalid_payload",
  invalid_name: invalidName("x", "x").body.error,
  unknown_format: unknownFormat("x", []).body.error,
  not_owner: notOwner("x", "x").body.error,
  not_admin: notAdmin().body.error,
  not_found: notFound("x").body.error,
  name_taken: nameTaken("x").body.error,
  stale: stale({ rev: 1 }, { seq: 1, at: "x", actor: "x", via: "x", kind: "x", admin: false }).body.error,
  last_admins: lastAdmins(1).body.error,
  rate_limited: rateLimited(60, 600, 600, "actor").body.error,
  unsupported_for_format: unsupportedForFormat("x", "x").body.error,
  too_many_webhooks: tooManyWebhooks(5).body.error,
  stream_unavailable: streamUnavailable().body.error,
  import_paused: importPaused().body.error,
};
interface RequiredCase {
  status: number;
  code?: string;
}

// The A-group every authenticated route shares (09 §4: "every authenticated
// route has all three"). `RL` is 429 `rate_limited`, appended separately
// (write routes only) -- NOT part of `A` itself (09 §4's table lists it
// after "A", never inside it: `GET /v1/me` and `GET /v1/admin/admins` get
// `A` with no 429, since `rateLimitWrites` skips GET/HEAD/OPTIONS same as
// `requireActorOnWrites`, 09 §2.1/§2.5).
const A: RequiredCase[] = [
  { status: 401, code: ERROR_CODES.unauthorized },
  { status: 401, code: ERROR_CODES.token_invalid },
  { status: 503, code: ERROR_CODES.identity_unavailable },
];
const RL: RequiredCase = { status: 429, code: ERROR_CODES.rate_limited };
// Hand-authored (route semantics aren't derivable from the route table
// itself): which (status[, error code]) pairs a route can actually
// produce. `held` is deliberately absent here -- phase 1's only two
// registered formats (cmini/1, akl/1) translate both ways losslessly
// (01 §6), so a real conformance seed can never produce a genuine `held`
// response; that behaviour is covered instead by held.test.ts's
// test-only format (LDB-F9), in its own isolated storage.
const REQUIRED: Record<string, RequiredCase[]> = {
  // --- phase 1 (unauthenticated GET routes; S6's set, unchanged) --------
  "GET /v1/meta": [{ status: 200 }, { status: 304 }],
  "GET /v1/layouts": [
    { status: 200 },
    { status: 400, code: ERROR_CODES.bad_request },
    { status: 400, code: ERROR_CODES.unknown_format },
    { status: 304 },
  ],
  "GET /v1/layouts/:ref": [
    { status: 200 },
    { status: 404, code: ERROR_CODES.not_found },
    { status: 400, code: ERROR_CODES.unknown_format },
  ],
  "GET /v1/layouts/:ref/likes": [{ status: 200 }, { status: 404, code: ERROR_CODES.not_found }],
  "GET /v1/layouts/:ref/history": [{ status: 200 }, { status: 404, code: ERROR_CODES.not_found }],
  "GET /v1/layouts/:ref/rev/:n": [
    { status: 200 },
    { status: 404, code: ERROR_CODES.not_found },
    { status: 400, code: ERROR_CODES.bad_request },
    { status: 400, code: ERROR_CODES.unknown_format },
  ],
  "GET /v1/authors": [{ status: 200 }, { status: 304 }],
  "GET /v1/authors/:user_id": [{ status: 200 }, { status: 404, code: ERROR_CODES.not_found }],
  "GET /v1/formats": [{ status: 200 }],
  "GET /v1/formats/:name/:major/schema.json": [{ status: 200 }, { status: 404, code: ERROR_CODES.not_found }],
  // X3 (12 §3 X3, §6.6): `layout=` unknown -> 404, same as `/v1/layouts/:ref`.
  "GET /v1/changes": [
    { status: 200 },
    { status: 400, code: ERROR_CODES.bad_request },
    { status: 304 },
    { status: 404, code: ERROR_CODES.not_found },
  ],
  // No dump exists in the conformance seed (only the cmini import tick
  // runs) -- every dump route's only reachable status here is 404
  // (tests/rehost.test.ts and tests/api/dump.test.ts cover the 200/302
  // paths against a real dump).
  "GET /v1/dump": [{ status: 404, code: ERROR_CODES.not_found }],
  "GET /v1/dump/latest.json": [{ status: 404, code: ERROR_CODES.not_found }],
  "GET /v1/dump/:key": [{ status: 404, code: ERROR_CODES.not_found }],
  "GET /v1/dump/monthly/:key": [{ status: 404, code: ERROR_CODES.not_found }],

  // --- phase 2: the user lane (T1) ---------------------------------------
  "GET /v1/me": [{ status: 200 }, ...A],
  // --- phase 2: write verbs on the record (T2, T4) -----------------------
  "POST /v1/layouts": [
    { status: 201 },
    ...A,
    { status: 400, code: ERROR_CODES.bad_request },
    { status: 400, code: ERROR_CODES.invalid_name },
    { status: 400, code: ERROR_CODES.invalid_payload },
    { status: 400, code: ERROR_CODES.unknown_format },
    { status: 409, code: ERROR_CODES.name_taken },
    RL,
  ],
  "PUT /v1/layouts/:ref": [
    { status: 200 },
    ...A,
    { status: 400, code: ERROR_CODES.bad_request },
    { status: 400, code: ERROR_CODES.if_match_required },
    { status: 400, code: ERROR_CODES.invalid_payload },
    { status: 400, code: ERROR_CODES.unknown_format },
    { status: 403, code: ERROR_CODES.not_owner },
    { status: 404, code: ERROR_CODES.not_found },
    { status: 409, code: ERROR_CODES.stale },
    RL,
  ],
  "PATCH /v1/layouts/:ref": [
    { status: 200 },
    ...A,
    { status: 400, code: ERROR_CODES.bad_request },
    { status: 400, code: ERROR_CODES.if_match_required },
    { status: 400, code: ERROR_CODES.invalid_name },
    { status: 400, code: ERROR_CODES.invalid_payload },
    { status: 400, code: ERROR_CODES.unsupported_for_format },
    { status: 403, code: ERROR_CODES.not_owner },
    { status: 404, code: ERROR_CODES.not_found },
    { status: 409, code: ERROR_CODES.name_taken },
    { status: 409, code: ERROR_CODES.stale },
    RL,
  ],
  "DELETE /v1/layouts/:ref": [
    { status: 200 },
    ...A,
    { status: 400, code: ERROR_CODES.bad_request },
    { status: 400, code: ERROR_CODES.if_match_required },
    { status: 403, code: ERROR_CODES.not_owner },
    { status: 404, code: ERROR_CODES.not_found },
    { status: 409, code: ERROR_CODES.stale },
    RL,
  ],
  "POST /v1/layouts/:ref/restore": [
    { status: 200 },
    ...A,
    { status: 400, code: ERROR_CODES.bad_request },
    { status: 403, code: ERROR_CODES.not_owner },
    { status: 404, code: ERROR_CODES.not_found },
    { status: 409, code: ERROR_CODES.name_taken },
    RL,
  ],
  "POST /v1/layouts/:ref/transfer": [
    { status: 200 },
    ...A,
    { status: 400, code: ERROR_CODES.bad_request },
    { status: 400, code: ERROR_CODES.if_match_required },
    { status: 403, code: ERROR_CODES.not_owner },
    { status: 404, code: ERROR_CODES.not_found },
    RL,
  ],
  // --- phase 2: likes (T5) ------------------------------------------------
  "PUT /v1/layouts/:ref/like": [
    { status: 200 },
    ...A,
    { status: 400, code: ERROR_CODES.bad_request },
    { status: 404, code: ERROR_CODES.not_found },
    RL,
  ],
  "DELETE /v1/layouts/:ref/like": [
    { status: 200 },
    ...A,
    { status: 400, code: ERROR_CODES.bad_request },
    { status: 404, code: ERROR_CODES.not_found },
    RL,
  ],

  // --- phase 2: admins as data (T3) --------------------------------------
  "GET /v1/admin/admins": [{ status: 200 }, ...A, { status: 403, code: ERROR_CODES.not_admin }],
  "POST /v1/admin/admins": [
    { status: 201 },
    { status: 200 }, // idempotent re-add
    ...A,
    { status: 400, code: ERROR_CODES.bad_request },
    { status: 403, code: ERROR_CODES.not_admin },
    RL,
  ],
  "DELETE /v1/admin/admins/:user_id": [
    { status: 200 },
    ...A,
    { status: 403, code: ERROR_CODES.not_admin },
    { status: 404, code: ERROR_CODES.not_found },
    { status: 409, code: ERROR_CODES.last_admins },
    RL,
  ],
  "POST /v1/admin/import/pause": [{ status: 200 }, ...A, { status: 403, code: ERROR_CODES.not_admin }, RL],
  "POST /v1/admin/import/resume": [{ status: 200 }, ...A, { status: 403, code: ERROR_CODES.not_admin }, RL],
  // X4 follow-up: manual cron triggers.
  "POST /v1/admin/import/tick": [
    { status: 200 },
    ...A,
    { status: 403, code: ERROR_CODES.not_admin },
    { status: 409, code: ERROR_CODES.import_paused },
    RL,
  ],
  "POST /v1/admin/diff/tick": [{ status: 200 }, ...A, { status: 403, code: ERROR_CODES.not_admin }, RL],

  // --- phase 2: the client lane's admin routes (10 C1) -------------------
  // No 409 (client ids are freshly minted ULIDs, no name-uniqueness
  // surface); POST is not idempotent, so no 200-idempotent row either.
  "GET /v1/admin/clients": [{ status: 200 }, ...A, { status: 403, code: ERROR_CODES.not_admin }],
  "POST /v1/admin/clients": [
    { status: 201 },
    ...A,
    { status: 400, code: ERROR_CODES.bad_request },
    { status: 403, code: ERROR_CODES.not_admin },
    RL,
  ],
  "DELETE /v1/admin/clients/:id": [
    { status: 200 },
    ...A,
    { status: 403, code: ERROR_CODES.not_admin },
    { status: 404, code: ERROR_CODES.not_found },
    RL,
  ],

  // --- phase 5: webhooks + the stream (12 §3 X1) -------------------------
  "POST /v1/webhooks": [
    { status: 201 },
    ...A,
    { status: 400, code: ERROR_CODES.bad_request },
    { status: 409, code: ERROR_CODES.too_many_webhooks },
    RL,
  ],
  "GET /v1/webhooks": [{ status: 200 }, ...A, { status: 403, code: ERROR_CODES.not_admin }],
  "DELETE /v1/webhooks/:id": [{ status: 200 }, ...A, { status: 404, code: ERROR_CODES.not_found }, RL],
  // No `A` -- unauthenticated, same as `GET /v1/changes` (12 §2.2).
  "GET /v1/changes/stream": [
    { status: 200 },
    { status: 400, code: ERROR_CODES.bad_request },
    { status: 503, code: ERROR_CODES.stream_unavailable },
  ],

  // --- phase 5: the changelog page (12 §3 X3) -----------------------------
  // No `A` -- public, unauthenticated, same posture as `/v1/changes`.
  "GET /admin/changelog": [
    { status: 200 },
    { status: 304 },
    { status: 400, code: ERROR_CODES.bad_request },
    { status: 404, code: ERROR_CODES.not_found },
  ],

  // --- phase 5: the diff cron's drill/health routes (12 §3 X4) -----------
  "POST /v1/admin/drill": [
    { status: 200 },
    ...A,
    { status: 400, code: ERROR_CODES.bad_request },
    { status: 403, code: ERROR_CODES.not_admin },
    RL,
  ],
  "GET /v1/admin/health": [{ status: 200 }, ...A, { status: 403, code: ERROR_CODES.not_admin }],
};
describe("conformance enumeration", () => {
  // `app.routes` also lists the two `app.use("/v1/*", ...)` middleware
  // registrations (`requireActorOnWrites`, `rateLimitWrites`) as method
  // "ALL" -- not a route a client can address, so it's excluded here
  // rather than given a REQUIRED entry.
  const liveRoutes = [...new Set(app.routes.filter((r) => r.method !== "ALL").map((r) => `${r.method} ${r.path}`))];

  it("every live route has a REQUIRED entry", () => {
    for (const route of liveRoutes) {
      expect(Object.keys(REQUIRED), `route '${route}' has no REQUIRED entry`).toContain(route);
    }
  });

  it("every REQUIRED route is actually live", () => {
    for (const route of Object.keys(REQUIRED)) {
      expect(liveRoutes, `REQUIRED references '${route}', not a live route`).toContain(route);
    }
  });

  it("every manifest case names a live (method, route)", () => {
    for (const kase of CASES) {
      const route = `${kase.request.method} ${kase.routeTemplate}`;
      expect(liveRoutes, `case '${kase.id}' names unknown route '${route}'`).toContain(route);
    }
  });

  it("[LDB-P7] [LDB-R3] every (route, required status[, code]) pair has a conformance case", () => {
    const missing: string[] = [];
    for (const [route, required] of Object.entries(REQUIRED)) {
      for (const req of required) {
        const found = CASES.some((kase) => {
          if (`${kase.request.method} ${kase.routeTemplate}` !== route || kase.response.status !== req.status) return false;
          if (req.code === undefined) return true;
          const body = kase.response.body as { error?: string } | undefined;
          return body?.error === req.code;
        });
        if (!found) missing.push(`${route} ${req.status}${req.code ? ` (${req.code})` : ""}`);
      }
    }
    expect(missing, `missing conformance cases:\n${missing.join("\n")}`).toEqual([]);
  });

  it("[LDB-P7] [LDB-R3] every case names a (route, status[, code]) pair that is REQUIRED", () => {
    const extra: string[] = [];
    for (const kase of CASES) {
      const route = `${kase.request.method} ${kase.routeTemplate}`;
      const required = REQUIRED[route] ?? [];
      const body = kase.response.body as { error?: string } | undefined;
      const code = kase.response.status >= 400 ? body?.error : undefined;
      const known = required.some(
        (req) => req.status === kase.response.status && (req.code === undefined ? code === undefined : req.code === code),
      );
      if (!known) extra.push(`${kase.id} -> ${route} ${kase.response.status}${code ? ` (${code})` : ""}`);
    }
    expect(extra, `cases naming a (route, status, code) not in REQUIRED:\n${extra.join("\n")}`).toEqual([]);
  });

  it("every case body claiming an error code carries 'error' and 'message'", () => {
    for (const kase of CASES) {
      if (kase.response.status < 400) continue;
      if (kase.response.body === undefined) continue; // 304s
      const body = kase.response.body as { error?: unknown; message?: unknown };
      expect(typeof body.error, `case '${kase.id}' body.error`).toBe("string");
      expect(typeof body.message, `case '${kase.id}' body.message`).toBe("string");
    }
  });
});
