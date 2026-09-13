// [LDB-V4..V7] design/layout-db/25-api-versioning.md "Enforcement". Pure
// over static data (`db/tests/conformance/manifest.ts`'s `CASES`,
// `db/docs/adoption.md`, `db/CHANGELOG-API.md`, `db/tests/fixtures/
// db-responses/meta.json`) -- no D1/miniflare needed, hence the "node"
// vitest project (vitest.config.ts).
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { API_MAJOR, API_MINOR, DEPRECATIONS, MIN_DEPRECATION_NOTICE_DAYS, deprecationHeadersFor, type RouteDeprecation } from "../../src/core/version";
import { computeRouteTable, type RouteTableRow } from "./route-table";
import { diffShapes, shapeDiffIsEmpty, shapeOf } from "./shape";
import metaFixture from "../fixtures/db-responses/meta.json" with { type: "json" };

const DB_ROOT = path.resolve(import.meta.dirname, "..", "..");
const GOLDEN_PATH = path.join(import.meta.dirname, "route-table.golden.json");
const CHANGELOG_PATH = path.join(DB_ROOT, "CHANGELOG-API.md");

// Flip to true, `npx vitest run tests/contract/contract.test.ts`, flip
// back -- the same "temporarily print/write, never leave it on" convention
// `tests/api/fixture-export.test.ts`'s own `RECORD` uses (this project has
// real fs access, unlike that one's workerd pool, so this one really does
// write the file directly rather than needing a stdout-slicing dance).
const RECORD = false;

function loadGolden(): RouteTableRow[] {
  return JSON.parse(fs.readFileSync(GOLDEN_PATH, "utf8")) as RouteTableRow[];
}

describe("[LDB-V4] the /v1 route-table contract", () => {
  it("[LDB-V4] the live route table (conformance CASES x adoption.md's auth column) matches the committed golden", () => {
    const live = computeRouteTable();

    if (RECORD) {
      fs.writeFileSync(GOLDEN_PATH, JSON.stringify(live, null, 2) + "\n");
      return; // never left true in a commit -- see RECORD's own comment
    }

    const golden = loadGolden();
    const goldenById = new Map(golden.map((r) => [r.id, r]));
    const liveById = new Map(live.map((r) => [r.id, r]));

    const added = [...liveById.keys()].filter((id) => !goldenById.has(id));
    const removed = [...goldenById.keys()].filter((id) => !liveById.has(id));
    const shapeChanges: string[] = [];
    const otherChanges: string[] = [];

    for (const id of liveById.keys()) {
      const g = goldenById.get(id);
      if (g === undefined) continue;
      const l = liveById.get(id)!;
      if (g.method !== l.method || g.route !== l.route || g.status !== l.status) {
        otherChanges.push(`${id}: ${g.method} ${g.route} ${g.status} -> ${l.method} ${l.route} ${l.status}`);
        continue;
      }
      if (g.auth !== l.auth) otherChanges.push(`${id}: auth '${g.auth}' -> '${l.auth}'`);
      if (g.shape === null && l.shape === null) continue;
      if (g.shape === null || l.shape === null) {
        shapeChanges.push(`${id}: body ${g.shape === null ? "absent" : "present"} -> ${l.shape === null ? "absent" : "present"}`);
        continue;
      }
      const diff = diffShapes(g.shape, l.shape);
      if (!shapeDiffIsEmpty(diff)) {
        const parts: string[] = [];
        if (diff.added.length > 0) parts.push(`+${diff.added.join(", +")}`);
        if (diff.removed.length > 0) parts.push(`-${diff.removed.join(", -")}`);
        if (diff.changed.length > 0) parts.push(diff.changed.join(", "));
        shapeChanges.push(`${id}: ${parts.join("; ")}`);
      }
    }

    const anyRemoval = removed.length > 0 || shapeChanges.some((c) => c.includes("-") || c.includes("absent"));
    const drifted = added.length > 0 || removed.length > 0 || shapeChanges.length > 0 || otherChanges.length > 0;

    if (drifted) {
      const lines = [
        "The live /v1 route table drifted from db/tests/contract/route-table.golden.json.",
        "",
        ...(added.length > 0 ? [`New conformance cases (fine if additive): ${added.join(", ")}`] : []),
        ...(removed.length > 0 ? [`REMOVED conformance cases: ${removed.join(", ")}`] : []),
        ...(shapeChanges.length > 0 ? ["Shape changes:", ...shapeChanges.map((c) => `  ${c}`)] : []),
        ...(otherChanges.length > 0 ? ["Other changes:", ...otherChanges.map((c) => `  ${c}`)] : []),
        "",
        anyRemoval
          ? "A field/route REMOVAL or type change is a BREAKING change: it must NOT happen in place under /v1. " +
            "Design a /v2 instead (design/layout-db/25-api-versioning.md 'Policy'), or revert this change."
          : "If this is an intentional ADDITIVE change: bump WIRE_VERSION in db/src/core/etag.ts (with a comment " +
            "naming what changed), add a matching '## 1.<new minor>' entry to db/CHANGELOG-API.md, then set RECORD=true " +
            "in this file, run `npx vitest run tests/contract/contract.test.ts`, set RECORD back to false, and commit " +
            "the regenerated db/tests/contract/route-table.golden.json.",
      ];
      expect.fail(lines.join("\n"));
    }
  });

  it("[LDB-V4] every route in the golden has a real auth lane from adoption.md (never 'unlisted')", () => {
    const golden = loadGolden();
    const unlisted = golden.filter((r) => r.auth === "unlisted").map((r) => r.id);
    expect(unlisted, "adoption.md's endpoint table (§9) is missing an auth entry for these cases' route").toEqual([]);
  });
});

describe("[LDB-V5] db/CHANGELOG-API.md tracks every API minor", () => {
  function changelogMinors(): number[] {
    const md = fs.readFileSync(CHANGELOG_PATH, "utf8");
    const out: number[] = [];
    for (const m of md.matchAll(/^## 1\.(\d+)\b/gm)) out.push(Number(m[1]));
    return out;
  }

  it("[LDB-V5] the changelog's newest entry equals the live API_MINOR (WIRE_VERSION)", () => {
    const minors = changelogMinors();
    expect(minors.length, "no '## 1.<n>' entries found in db/CHANGELOG-API.md").toBeGreaterThan(0);
    const newest = Math.max(...minors);
    expect(
      newest,
      `db/CHANGELOG-API.md's newest entry is 1.${newest}, but the live API_MINOR (db/src/core/etag.ts's WIRE_VERSION) is ${API_MINOR}. ` +
        `Whichever changed, bring the other one with it in the same PR.`,
    ).toBe(API_MINOR);
  });

  it("[LDB-V5] every minor from 1 up to the current one has exactly one entry (no gap, no duplicate)", () => {
    const minors = changelogMinors();
    const seen = new Set<number>();
    const dupes = minors.filter((n) => (seen.has(n) ? true : (seen.add(n), false)));
    expect(dupes, "duplicate '## 1.<n>' headings").toEqual([]);
    const expected = Array.from({ length: API_MINOR }, (_, i) => i + 1);
    expect([...seen].sort((a, b) => a - b)).toEqual(expected);
  });
});

describe("[LDB-V6] the site-sync fixture agrees with the API's declared shape", () => {
  it("[LDB-V6] db/tests/fixtures/db-responses/meta.json's shape matches the golden's meta/200 shape", () => {
    // Scoped to meta.json ONLY: it is the one db-responses/ fixture that is
    // a literal, unwrapped copy of a live route's top-level body (LDB-S1a,
    // tests/api/fixture-export.test.ts's own byte-exact check proves that
    // against the LIVE route). authors.json/detail.json/likes.json/
    // layouts-list.json/layouts-full-cmini1.json are the site's `DbSource`
    // POST-PROCESSED shapes (a name-keyed map with likes merged in, a
    // bare unwrapped `items` array, `{user_ids}` instead of the route's own
    // likes shape) -- comparing those to a route's declared wire shape
    // would fail for a reason that has nothing to do with API drift.
    // Extending this check to the other four needs an explicit per-fixture
    // unwrapping rule; not built here (see this slice's report).
    const golden = loadGolden();
    const metaRow = golden.find((r) => r.id === "meta/200");
    expect(metaRow, "golden has no 'meta/200' row").toBeDefined();
    expect(metaRow!.shape, "meta/200's golden shape is null").not.toBeNull();

    const fixtureShape = shapeOf(metaFixture);
    const diff = diffShapes(metaRow!.shape!, fixtureShape);
    expect(
      shapeDiffIsEmpty(diff),
      `db-responses/meta.json's shape disagrees with the golden's declared /v1/meta shape: ${JSON.stringify(diff)}. ` +
        `Either the golden is stale (see the [LDB-V4] case above) or db-responses/meta.json needs regenerating ` +
        `(tests/api/fixture-export.test.ts's own RECORD dance).`,
    ).toBe(true);
  });
});

describe("[LDB-V7] deprecation headers (policy (e))", () => {
  it("[LDB-V7] a route with no matching entry gets no Deprecation/Sunset headers", () => {
    expect(deprecationHeadersFor("GET", "/v1/meta", [])).toEqual({});
    expect(deprecationHeadersFor("GET", "/v1/meta")).toEqual({}); // DEPRECATIONS is empty today
  });

  it("[LDB-V7] a matching entry emits HTTP-date Deprecation/Sunset headers, keyed on METHOD+routePath exactly", () => {
    const entry: RouteDeprecation = {
      route: "GET /v1/old-thing",
      since: "2026-01-01T00:00:00.000Z",
      sunset: "2026-06-01T00:00:00.000Z",
      message: "replaced by GET /v1/new-thing",
    };
    const headers = deprecationHeadersFor("get", "/v1/old-thing", [entry]);
    expect(headers.Deprecation).toBe(new Date(entry.since).toUTCString());
    expect(headers.Sunset).toBe(new Date(entry.sunset).toUTCString());

    // A different method, or a different route, never matches.
    expect(deprecationHeadersFor("POST", "/v1/old-thing", [entry])).toEqual({});
    expect(deprecationHeadersFor("GET", "/v1/old-thing/:ref", [entry])).toEqual({});
  });

  it("[LDB-V7] every real DEPRECATIONS entry gives at least MIN_DEPRECATION_NOTICE_DAYS notice", () => {
    // DEPRECATIONS is empty today (core/version.ts) -- this is a real,
    // executable rule waiting for the first entry, not a no-op: flip
    // `entries` to `DEPRECATIONS` once one exists and this keeps enforcing
    // it (the empty-array case trivially passes, on purpose).
    const entries = DEPRECATIONS;
    const tooSoon = entries.filter((d) => {
      const days = (Date.parse(d.sunset) - Date.parse(d.since)) / (24 * 60 * 60 * 1000);
      return days < MIN_DEPRECATION_NOTICE_DAYS;
    });
    expect(tooSoon.map((d) => d.route), `notice shorter than ${MIN_DEPRECATION_NOTICE_DAYS} days`).toEqual([]);
  });
});

// [LDB-V1] single source of truth: API_MINOR IS WIRE_VERSION (core/
// version.ts imports it directly, never redeclares it) -- if this ever
// drifts apart (a future edit gives API_MINOR its own literal), every
// [LDB-V5] changelog case above still passes against WHICHEVER number
// API_MINOR reports, so this direct-identity check is what actually pins
// "one counter, not two" as an invariant of its own.
describe("[LDB-V1] the API minor is not a second counter", () => {
  it("[LDB-V1] API_MAJOR is the literal 1 (no /v2 registered yet) and API_MINOR re-exports WIRE_VERSION verbatim", async () => {
    expect(API_MAJOR).toBe(1);
    const { WIRE_VERSION } = await import("../../src/core/etag");
    expect(API_MINOR).toBe(WIRE_VERSION);
  });
});
