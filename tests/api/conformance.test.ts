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
import { badRequest, notAdmin, notFound, unknownFormat, unauthorized } from "../../src/core/errors";
import { appendWrite } from "../../src/core/events";
import { fixedClock, type Clock } from "../../src/core/time";
import { app } from "../../src/index";
import { FakeDiscord } from "../auth/fake-discord";
import { CASES } from "../conformance/manifest";
import { assertConformanceCase, seedUpstream100 } from "./support";
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
  // use), scoped to that one case and touching no one else's numbers.

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
      if (kase.id.startsWith("layouts-write/") || kase.id.startsWith("admin-admins/")) await ensureWriteFixtures();
      await assertConformanceCase(kase, resolvePath);
    });
  }
});

// --- enumeration: routes from app.routes, error codes from errors.ts -----

const ERROR_CODES = {
  unauthorized: unauthorized().body.error,
  bad_request: badRequest("x").body.error,
  unknown_format: unknownFormat("x", []).body.error,
  not_found: notFound("x").body.error,
  not_admin: notAdmin().body.error,
};

interface RequiredCase {
  status: number;
  code?: string;
}

// Hand-authored (route semantics aren't derivable from the route table
// itself): which (status[, error code]) pairs a route can actually
// produce. `held` is deliberately absent here -- phase 1's only two
// registered formats (cmini/1, akl/1) translate both ways losslessly
// (01 §6), so a real conformance seed can never produce a genuine `held`
// response; that behaviour is covered instead by held.test.ts's
// test-only format (LDB-F9), in its own isolated storage.
const REQUIRED: Record<string, RequiredCase[]> = {
  "/v1/meta": [{ status: 200 }, { status: 304 }],
  // /v1/me: the user lane (T1). Only the anonymous 401 is reproducible from a
  // static fixture -- a 200 needs a Discord bearer, which discord.test.ts /
  // me.test.ts cover with the injected fake.
  "/v1/me": [{ status: 401, code: ERROR_CODES.unauthorized }],
  "/v1/layouts": [
    { status: 200 },
    { status: 400, code: ERROR_CODES.bad_request },
    { status: 400, code: ERROR_CODES.unknown_format },
    { status: 304 },
  ],
  "/v1/layouts/:ref": [
    { status: 200 },
    { status: 404, code: ERROR_CODES.not_found },
    { status: 400, code: ERROR_CODES.unknown_format },
  ],
  "/v1/layouts/:ref/likes": [{ status: 200 }, { status: 404, code: ERROR_CODES.not_found }],
  "/v1/layouts/:ref/history": [{ status: 200 }, { status: 404, code: ERROR_CODES.not_found }],
  "/v1/layouts/:ref/rev/:n": [
    { status: 200 },
    { status: 404, code: ERROR_CODES.not_found },
    { status: 400, code: ERROR_CODES.bad_request },
    { status: 400, code: ERROR_CODES.unknown_format },
  ],
  "/v1/authors": [{ status: 200 }, { status: 304 }],
  "/v1/authors/:user_id": [{ status: 200 }, { status: 404, code: ERROR_CODES.not_found }],
  "/v1/formats": [{ status: 200 }],
  "/v1/formats/:name/:major/schema.json": [{ status: 200 }, { status: 404, code: ERROR_CODES.not_found }],
  "/v1/changes": [{ status: 200 }, { status: 400, code: ERROR_CODES.bad_request }, { status: 304 }],
  // No dump exists in the conformance seed (only the cmini import tick
  // runs) -- every dump route's only reachable status here is 404
  // (tests/rehost.test.ts and tests/api/dump.test.ts cover the 200/302
  // paths against a real dump).
  "/v1/dump": [{ status: 404, code: ERROR_CODES.not_found }],
  "/v1/dump/latest.json": [{ status: 404, code: ERROR_CODES.not_found }],
  "/v1/dump/:key": [{ status: 404, code: ERROR_CODES.not_found }],
  "/v1/dump/monthly/:key": [{ status: 404, code: ERROR_CODES.not_found }],
  // 09 §3 T3: the enumeration stays GET-only until T6's (method, status)
  // sweep -- POST/DELETE /v1/admin/* aren't required here yet, but this GET
  // is a live route now, so it needs an entry or the sweep below fails.
  "/v1/admin/admins": [
    { status: 200 },
    { status: 401, code: ERROR_CODES.unauthorized },
    { status: 403, code: ERROR_CODES.not_admin },
  ],
};

describe("conformance enumeration", () => {
  const liveGetRoutes = [...new Set(app.routes.filter((r) => r.method === "GET").map((r) => r.path))];
  // REQUIRED stays GET-only (T6's sweep is the slice that rebuilds it as a
  // (method, status) enumeration over every verb -- 09 §3 T6). This second,
  // wider set exists ONLY so a non-GET case (T2's write routes: POST/PUT/
  // DELETE all share a route TABLE path with an existing GET, except
  // restore/transfer which have none) can still be caught if its
  // `routeTemplate` is a typo, without requiring every write verb to gain a
  // REQUIRED row before T6 lands.
  const livePaths = [...new Set(app.routes.map((r) => r.path))];

  it("every live GET route has a REQUIRED entry", () => {
    for (const path of liveGetRoutes) {
      expect(Object.keys(REQUIRED), `route '${path}' has no REQUIRED entry`).toContain(path);
    }
  });

  it("every REQUIRED route is actually live", () => {
    for (const path of Object.keys(REQUIRED)) {
      expect(liveGetRoutes, `REQUIRED references '${path}', not a live route`).toContain(path);
    }
  });

  it("every manifest case names a live route", () => {
    for (const kase of CASES) {
      expect(livePaths, `case '${kase.id}' names unknown route '${kase.routeTemplate}'`).toContain(kase.routeTemplate);
    }
  });

  it("[LDB-P7] [LDB-R3] every (route, required status[, code]) pair has a conformance case", () => {
    const missing: string[] = [];
    for (const [route, required] of Object.entries(REQUIRED)) {
      for (const req of required) {
        const found = CASES.some((kase) => {
          if (kase.routeTemplate !== route || kase.response.status !== req.status) return false;
          if (req.code === undefined) return true;
          const body = kase.response.body as { error?: string } | undefined;
          return body?.error === req.code;
        });
        if (!found) missing.push(`${route} ${req.status}${req.code ? ` (${req.code})` : ""}`);
      }
    }
    expect(missing, `missing conformance cases:\n${missing.join("\n")}`).toEqual([]);
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
