import { env, SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import type { Bindings } from "../../src/env";
import { seedUpstream100 } from "./support";
import { API_MAJOR, API_MINOR, API_VERSION_HEADER, apiVersionString } from "../../src/core/version";

const bindings = env as unknown as Bindings;
const db = bindings.DB;

// The S1 skeleton's only route. Once formats/import land, this test is
// superseded by tests/api/conformance.test.ts (S6); the invariant id moves
// with it (see the S1 table in 07-implementation-phase1.md).
describe("GET /v1/meta", () => {
  it("[LDB-A12] answers the zero body on a fresh database (incl. an empty health.clients)", async () => {
    const res = await SELF.fetch("https://example.com/v1/meta");
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toContain("application/json");
    await expect(res.json()).resolves.toEqual({
      layout_count: 0,
      author_count: 0,
      seq: 0,
      revision: null,
      layouts_modified_at: null,
      authors_modified_at: null,
      authors_version: 0, // migrations/0007's seed: no author has ever been written
      formats: ["spark/1", "mana2/1"],
      // X4 (12 §3 X4): {at, ok} | null off import_state's 'cmini.last_diff'
      // row -- it doesn't exist before a diff tick has ever run.
      last_diff: null,
      // LDB-M2: neither the dump nor the diff has ever run -- `stale: true`
      // is the "never run" case, not just "old".
      health: {
        dump: { last_at: null, seq: null, age_s: null, stale: true },
        // [LDB-X2] the cmini importer is gone for good (pine's own upstream
        // dead since 2026-09-15) -- `health.diff` is now PERMANENTLY
        // disabled: true, and its `stale` alarm is forced false regardless
        // of age (a permanently-off job must never read as "stuck").
        diff: { last_at: null, age_s: null, stale: false, disabled: true },
        // [LDB-M3] [LDB-X2] never stalled, never ticked, and `disabled` is
        // now a literal `true` (no more IMPORT_ENABLED to read).
        import: { stalled: null, deletes_24h: 0, deletes_planned: null, deletes_applied: null, deletes_disabled: false, disabled: true },
        // [LDB-A12] saltorbit 2026-09-13 (rogue-trusted-client hardening): no
        // client has ever been suspended on a fresh database.
        // [LDB-A14] saltorbit: no threshold is ever public -- only the suspended list.
        clients: { suspended: [] },
      },
      // [LDB-V3] design/layout-db/25-api-versioning.md: the API's own
      // version block -- distinct from `formats` above (a stored/output
      // FORMAT's own major, unrelated). `minor` is `WIRE_VERSION`
      // (core/etag.ts), already folded into this route's own ETag.
      api: { major: 1, minor: API_MINOR },
      deprecations: [],
    });
  });

  it("[LDB-V3] carries X-AKLDB-API on every response, matching the body's own api block", async () => {
    const res = await SELF.fetch("https://example.com/v1/meta");
    expect(res.headers.get(API_VERSION_HEADER)).toBe(apiVersionString());
    const body = await res.json<{ api: { major: number; minor: number } }>();
    expect(body.api).toEqual({ major: API_MAJOR, minor: API_MINOR });
    expect(`${body.api.major}.${body.api.minor}`).toBe(res.headers.get(API_VERSION_HEADER));
  });

  it("[LDB-R2] after restoring the frozen upstream-100 seed, counts and seq/revision equal the tables", async () => {
    // [LDB-X3] the cmini importer that used to PRODUCE this state is gone
    // (pine's own upstream permanently dead since 2026-09-15) -- this
    // restores the frozen dump instead (`support.ts`'s `seedUpstream100`),
    // byte-identical to what that import run once produced.
    await seedUpstream100();

    const res = await SELF.fetch("https://example.com/v1/meta");
    const body = await res.json<{
      layout_count: number;
      author_count: number;
      seq: number;
      revision: string | null;
      authors_version: number;
      authors_modified_at: string | null;
    }>();

    // LDB-R2 amended (migrations/0007): the author fields are
    // `authors_head`'s row -- one trigger bump per author insert (32 of
    // them on a fresh table) -- and `author_count` is the table's.
    const headRow = await db.prepare("SELECT version, modified_at FROM authors_head WHERE id = 1").first<{ version: number; modified_at: string | null }>();
    const countRow = await db.prepare("SELECT COUNT(*) AS n FROM authors").first<{ n: number }>();
    expect(body.authors_version).toBe(headRow!.version);
    expect(body.authors_version).toBe(32);
    expect(body.authors_modified_at).toBe(headRow!.modified_at);
    expect(body.author_count).toBe(countRow!.n);
    expect(body.layout_count).toBe(100);
    // authors.json has 48 name entries but only 32 distinct user ids (9
    // users have >=2 recorded names -- verified against the fixture); the
    // `authors` table's PRIMARY KEY is user_id (migrations/0001_init.sql,
    // not S5's to change), so 32 is the correct deduped count, not the raw
    // entry count 07 §6 S5's table names.
    expect(body.author_count).toBe(32);

    const eventRow = await db.prepare("SELECT MAX(seq) AS seq, MAX(at) AS at FROM events").first<{ seq: number; at: string }>();
    expect(body.seq).toBe(eventRow!.seq);
    expect(body.revision).toBe(eventRow!.at);
  });
});

// LDB-M2: `health.dump`/`health.diff` -- real wall-clock arithmetic
// (`/v1/index.ts`'s `/v1/meta` route always reads `authDeps.now` ==
// `systemClock`, never `TEST_CLOCK`), so these seed `import_state` rows at
// a fixed OFFSET from `Date.now()` rather than a fixed date.
describe("[LDB-M2] GET /v1/meta health", () => {
  async function setImportState(key: string, value: unknown): Promise<void> {
    await db
      .prepare("INSERT INTO import_state (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
      .bind(key, JSON.stringify(value))
      .run();
  }

  // `health` is deliberately NOT part of the ETag (`src/index.ts`'s own
  // comment) -- these tests seed `import_state` and re-fetch WITHOUT
  // touching `seq`/`authors`/`last_diff`/`last_drill`/formats, so the ETag
  // is identical across sub-tests in this describe and `caches.default`
  // would otherwise hand back a PRIOR test's cached body (same ETag, same
  // request URL). A unique query string per call defeats that cache
  // lookup (`conditional()` matches by the whole request, query included)
  // without needing any cache-busting machinery in the route itself.
  let metaCallN = 0;
  async function fetchMeta(): Promise<Response> {
    metaCallN++;
    return SELF.fetch(`https://example.com/v1/meta?_health_test=${metaCallN}`);
  }

  it("[LDB-M2] a recent dump/diff report stale:false with the recorded seq and a small age_s", async () => {
    const at = new Date(Date.now() - 60_000).toISOString(); // 1 minute ago
    await setImportState("dump.last_at", { at, seq: 42, key: "dump-2026-01-01.json.gz" });
    await setImportState("cmini.last_diff", { at, ok: true });

    const body = await (await fetchMeta()).json<{
      health: { dump: { last_at: string; seq: number; age_s: number; stale: boolean }; diff: { last_at: string; age_s: number; stale: boolean } };
    }>();

    expect(body.health.dump.last_at).toBe(at);
    expect(body.health.dump.seq).toBe(42);
    expect(body.health.dump.stale).toBe(false);
    expect(body.health.dump.age_s).toBeGreaterThanOrEqual(60);
    expect(body.health.dump.age_s).toBeLessThan(120);

    expect(body.health.diff.last_at).toBe(at);
    expect(body.health.diff.stale).toBe(false);
    expect(body.health.diff.age_s).toBeGreaterThanOrEqual(60);
  });

  // [LDB-X2] `health.diff` is permanently disabled -- its `stale` alarm
  // stays forced false regardless of age (a permanently-off job must never
  // read as "stuck"); only `health.dump` still has a real staleness check.
  it("[LDB-M2] a dump older than 48h reports stale:true; the permanently-disabled diff never does", async () => {
    const at = new Date(Date.now() - 49 * 3600 * 1000).toISOString(); // 49h ago
    await setImportState("dump.last_at", { at, seq: 7, key: "dump-old.json.gz" });
    await setImportState("cmini.last_diff", { at, ok: true });

    const body = await (await fetchMeta()).json<{
      health: { dump: { stale: boolean }; diff: { stale: boolean; disabled: boolean } };
    }>();

    expect(body.health.dump.stale).toBe(true);
    expect(body.health.diff.stale).toBe(false);
    expect(body.health.diff.disabled).toBe(true);
  });

  it("[LDB-M2] just under 48h old is not yet stale", async () => {
    // Comfortably short of the 48h line (not an exact-boundary comparison,
    // which would be flaky against the real clock `/v1/meta` reads) --
    // proves `stale` isn't tripping early.
    const at = new Date(Date.now() - 47.5 * 3600 * 1000).toISOString();
    await setImportState("dump.last_at", { at, seq: 1, key: "dump-boundary.json.gz" });

    const body = await (await fetchMeta()).json<{ health: { dump: { stale: boolean } } }>();
    expect(body.health.dump.stale).toBe(false);
  });

  // [LDB-X2] `IMPORT_ENABLED` no longer exists as a binding -- `health.diff.
  // disabled` is now a literal `true`, byte-identical to what `IMPORT_
  // ENABLED=off` already produced right before this change, and the `stale`
  // alarm stays suppressed regardless of the recorded age.
  it("[LDB-X2] health.diff.disabled is permanently true; its stale alarm never fires", async () => {
    const at = new Date(Date.now() - 49 * 3600 * 1000).toISOString(); // 49h ago -- would be stale if live
    await setImportState("cmini.last_diff", { at, ok: true });

    const body = await (await fetchMeta()).json<{ health: { diff: { stale: boolean; disabled: boolean } } }>();
    expect(body.health.diff.disabled).toBe(true);
    expect(body.health.diff.stale).toBe(false);
  });

  // [LDB-M3] `health.import` (2026-09-13, hostile/vanished-upstream
  // visibility): same real-wall-clock posture as dump/diff above -- the
  // rolling 24h delete count is a live D1 query against `events.at`, so
  // these seed rows at a fixed OFFSET from `Date.now()`, never a fixed date.
  it("[LDB-M3] stalled reflects cmini.stalled, renamed at -> since", async () => {
    const since = new Date(Date.now() - 60_000).toISOString();
    await setImportState("cmini.stalled", { at: since, reason: "test: pending deletions exceed the bound" });

    const body = await (await fetchMeta()).json<{ health: { import: { stalled: { since: string; reason: string } | null } } }>();
    expect(body.health.import.stalled).toEqual({ since, reason: "test: pending deletions exceed the bound" });
  });

  it("[LDB-M3] stalled is null once cleared", async () => {
    await db.prepare("DELETE FROM import_state WHERE key = 'cmini.stalled'").run();
    const body = await (await fetchMeta()).json<{ health: { import: { stalled: unknown } } }>();
    expect(body.health.import.stalled).toBeNull();
  });

  it("[LDB-M3] deletes_planned/applied come from cmini.last_tick", async () => {
    await setImportState("cmini.last_tick", { at: new Date().toISOString(), quiet: false, deletes_planned: 7, deletes_applied: 3 });
    const body = await (await fetchMeta()).json<{ health: { import: { deletes_planned: number | null; deletes_applied: number | null } } }>();
    expect(body.health.import.deletes_planned).toBe(7);
    expect(body.health.import.deletes_applied).toBe(3);
  });

  it("[LDB-M3] deletes_planned/applied are null before any tick has ever run", async () => {
    await db.prepare("DELETE FROM import_state WHERE key = 'cmini.last_tick'").run();
    const body = await (await fetchMeta()).json<{ health: { import: { deletes_planned: number | null; deletes_applied: number | null } } }>();
    expect(body.health.import.deletes_planned).toBeNull();
    expect(body.health.import.deletes_applied).toBeNull();
  });

  async function insertUpstreamDeletedEvent(at: string, rev: number | null): Promise<void> {
    await db
      .prepare(
        `INSERT INTO events (at, kind, layout_id, name, owner, format, rev, actor, via, admin, detail_json, before_json, after_json, source_client, source_version)
         VALUES (?, 'upstream_deleted', NULL, NULL, NULL, NULL, ?, 'system:cmini-import', 'import:cmini', 0, NULL, NULL, NULL, NULL, NULL)`,
      )
      .bind(at, rev)
      .run();
  }

  it("[LDB-M3] deletes_24h counts only REAL (rev-bumping) tombstones within the trailing 24h", async () => {
    const within = new Date(Date.now() - 60_000).toISOString(); // 1 minute ago
    const tooOld = new Date(Date.now() - 25 * 3600 * 1000).toISOString(); // 25h ago
    await insertUpstreamDeletedEvent(within, 1); // real tombstone, within window -- counted
    await insertUpstreamDeletedEvent(within, 2); // real tombstone, within window -- counted
    await insertUpstreamDeletedEvent(within, null); // informational-only (not-following) -- NOT counted
    await insertUpstreamDeletedEvent(tooOld, 3); // real tombstone, but outside the 24h window -- NOT counted

    const body = await (await fetchMeta()).json<{ health: { import: { deletes_24h: number } } }>();
    expect(body.health.import.deletes_24h).toBe(2);
  });

  // [LDB-X2] no `IMPORT_ENABLED` binding exists any more -- `disabled` is a
  // literal `true`, byte-identical to what `IMPORT_ENABLED=off` already
  // produced right before this change.
  it("[LDB-X2] health.import.disabled is permanently true", async () => {
    const body = await (await fetchMeta()).json<{ health: { import: { disabled: boolean } } }>();
    expect(body.health.import.disabled).toBe(true);
  });

  it("[LDB-A14] no budget/threshold field is ever on the public /v1/meta (saltorbit: no handbook for destructive clients)", async () => {
    const text = await (await fetchMeta()).text();
    expect(text).not.toMatch(/budget|threshold|window_seconds|"pct"|"effective"/);
    const body = JSON.parse(text) as { health: { import: Record<string, unknown>; clients: Record<string, unknown> } };
    expect(Object.keys(body.health.import).sort()).toEqual([
      "deletes_24h",
      "deletes_applied",
      "deletes_disabled",
      "deletes_planned",
      "disabled",
      "stalled",
    ]);
    expect(Object.keys(body.health.clients)).toEqual(["suspended"]);
  });
});
