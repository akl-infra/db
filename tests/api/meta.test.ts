import { env, SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import type { Bindings } from "../../src/env";
import { fixedClock } from "../../src/core/time";
import { tick } from "../../src/import/cmini";
import { FakeUpstream } from "../import/fake-upstream";

const bindings = env as unknown as Bindings;
const db = bindings.DB;

// The S1 skeleton's only route. Once formats/import land, this test is
// superseded by tests/api/conformance.test.ts (S6); the invariant id moves
// with it (see the S1 table in 07-implementation-phase1.md).
describe("GET /v1/meta", () => {
  it("answers the zero body on a fresh database", async () => {
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
        diff: { last_at: null, age_s: null, stale: true },
      },
    });
  });

  it("[LDB-R2] after the fixture import, counts and seq/revision equal the tables", async () => {
    const fake = new FakeUpstream();
    const clock = fixedClock("2026-06-11T00:00:00.000Z");
    await tick(bindings, clock, fake.fetchImpl, fake.sleepImpl);

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
    // them on a fresh table) and the inserts' own clock -- and
    // `author_count` is the table's.
    const headRow = await db.prepare("SELECT version, modified_at FROM authors_head WHERE id = 1").first<{ version: number; modified_at: string | null }>();
    const countRow = await db.prepare("SELECT COUNT(*) AS n FROM authors").first<{ n: number }>();
    expect(body.authors_version).toBe(headRow!.version);
    expect(body.authors_version).toBe(32);
    expect(body.authors_modified_at).toBe(headRow!.modified_at);
    expect(body.authors_modified_at).toBe("2026-06-11T00:00:00.000Z");
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

  it("[LDB-M2] a dump/diff older than 48h reports stale:true", async () => {
    const at = new Date(Date.now() - 49 * 3600 * 1000).toISOString(); // 49h ago
    await setImportState("dump.last_at", { at, seq: 7, key: "dump-old.json.gz" });
    await setImportState("cmini.last_diff", { at, ok: true });

    const body = await (await fetchMeta()).json<{
      health: { dump: { stale: boolean }; diff: { stale: boolean } };
    }>();

    expect(body.health.dump.stale).toBe(true);
    expect(body.health.diff.stale).toBe(true);
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
});
