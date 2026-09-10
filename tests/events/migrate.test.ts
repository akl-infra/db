// [LDB-P12] `migrateTick` (20-spark.md S4): the operator-driven record
// migration. Every record here is seeded directly via `appendWrite`
// (`upstream: null` throughout, same convention `tests/import/strip.test.ts`'s
// own `seedLegacyMagicRecord` uses) rather than through the real importer
// or write routes -- this slice's own scenario is exactly "what a legacy
// row this system has never touched since 0005 looks like", which the real
// write paths (S2/S3a/S3b) can no longer produce themselves.
import { env } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Bindings } from "../../src/env";
import { appendWrite } from "../../src/core/events";
import { migrateTick } from "../../src/core/migrate";
import * as recordsModule from "../../src/core/records";
import { readById } from "../../src/core/records";
import { fixedClock } from "../../src/core/time";
import { registerForTest, type FormatModule } from "../../src/formats/registry";
import * as spark1 from "../../formats/spark/1/index.ts";

const db = (env as unknown as Bindings).DB;
const clock = fixedClock("2026-09-10T00:00:00.000Z");

beforeEach(async () => {
  await db.batch([
    db.prepare("DELETE FROM events"),
    db.prepare("DELETE FROM layout_revs"),
    db.prepare("DELETE FROM likes"),
    db.prepare("DELETE FROM layouts"),
    db.prepare("DELETE FROM import_map"),
  ]);
});

afterEach(() => {
  vi.restoreAllMocks();
});

async function mapUpstream(upstreamId: string, layoutId: string): Promise<void> {
  await db.prepare("INSERT INTO import_map (upstream_id, layout_id) VALUES (?, ?)").bind(upstreamId, layoutId).run();
}

// A statement-counting proxy over a D1Database (LDB-H5's own mechanism,
// following 09 §3 T1's/tests/import/difftick.test.ts's pattern): counts
// every `.batch()` call -- `appendWrite`'s own writes are ALWAYS one
// `db.batch([...3 statements])`, never a bare `.run()`, so this is the
// dry-run-writes-zero-rows check's own instrument.
function countingBatchDb(real: D1Database): { db: D1Database; batches: () => number } {
  const calls = { n: 0 };
  const proxy = new Proxy(real, {
    get(target, prop, receiver) {
      if (prop === "batch") {
        return (...args: unknown[]) => {
          calls.n++;
          return (target.batch as (...a: unknown[]) => unknown).apply(target, args);
        };
      }
      const val = Reflect.get(target, prop, receiver);
      return typeof val === "function" ? (val as (...a: unknown[]) => unknown).bind(target) : val;
    },
  });
  return { db: proxy as D1Database, batches: () => calls.n };
}

// Minimal, valid spark/1-shaped payload (used both directly for an
// `akl/1`-stored record -- byte-identical to spark/1, decision 1 -- and as
// the `keys`/`board` half of a `cmini/1`-shaped one below).
const SPARK_KEYS = { a: { row: 0, col: 0, finger: "LI" }, b: { row: 0, col: 1, finger: "LM" } };
const SPARK_BOARD = { kind: "ortho", cmini: "ortho" };
const SPARK_MAGIC = { rules: [{ inputs: "ab", output: "ba", type: "raw" }] };

const CMINI_PAYLOAD = { board: "ortho" as const, keys: { a: { row: 0, col: 0, finger: "LI" } } };

// 20-spark.md S5: `migrateTick`'s selection/conversion generalizes to "any
// record below its LINEAGE's latest major", not a hardcoded `spark/1`
// literal. With no real `spark/2` yet, this test-only stand-in extends the
// REAL `spark` lineage (not an unrelated stub lineage -- `storedLatestId()`
// always resolves the first `role: "stored"` module it finds, which is
// always `spark/1`, so the lineage under test here is genuinely `spark`).
// `up`/`down` are the identity: `spark/2`'s payload shape is deliberately
// IDENTICAL to `spark/1`'s, so a real `spark/1` payload exercises the
// generalized selection/conversion path with zero new semantics to model.
const SPARK_2: FormatModule = {
  id: "spark/2",
  owner: "test",
  description: "test-only spark/2 stand-in for LDB-P12's chain-generalization case (20-spark.md S5)",
  schema: spark1.schema,
  role: "stored",
  validate: spark1.validate,
  to: {},
  from: {},
  hasMagic: spark1.hasMagic,
  edits: spark1.edits,
  up: (p: unknown) => p,
  down: (p: unknown) => p,
};

describe("[LDB-P12] migrateTick", () => {
  it("[LDB-P12] converts legacy formats, backfills a spark-stored record's upstream, skips an invalid payload, and reports the full shape", async () => {
    // 1) cmini/1, plainly following (no magic) -- the ordinary arm-1 case.
    const { record: plain } = await appendWrite(db, clock, {
      kind: "imported",
      name: "migrate-plain",
      owner: "owner-1",
      modified_at: "2026-01-01T00:00:00.000Z",
      format: "cmini/1",
      payload: CMINI_PAYLOAD,
      actor: "system:cmini-import",
      via: "import:cmini",
      source: { client: "system:cmini-import", version: null },
      hasMagic: false,
      upstream: null,
    });
    await mapUpstream("up-plain", plain.id);

    // 2) cmini/1, a tombstone -- selection includes deleted rows (LDB-P8):
    // format/payload/deleted carry forward unchanged, and this one's real
    // latest rev-bumping event (`deleted`, via `discord`) is not
    // `import:cmini`, so it resolves to upstream `null`.
    const { record: tomb } = await appendWrite(db, clock, {
      kind: "imported",
      name: "migrate-tomb",
      owner: "owner-1",
      modified_at: "2026-01-01T00:00:00.000Z",
      format: "cmini/1",
      payload: CMINI_PAYLOAD,
      actor: "system:cmini-import",
      via: "import:cmini",
      source: { client: "system:cmini-import", version: null },
      hasMagic: false,
      upstream: null,
    });
    await mapUpstream("up-tomb", tomb.id);
    await appendWrite(db, clock, {
      kind: "deleted",
      layoutId: tomb.id,
      name: tomb.name,
      owner: tomb.owner,
      modified_at: "2026-01-02T00:00:00.000Z",
      format: "cmini/1",
      payload: CMINI_PAYLOAD,
      actor: "owner-1",
      via: "discord",
      source: { client: "discord-app:test", version: null },
      hasMagic: false,
      deleted: true,
      upstream: null,
    });

    // 3) akl/1 (spark-shaped, decision 1), the 67-record shape (§1.7): a
    // real `import:cmini` write, then a magic-only PATCH marked
    // `detail.magic_only: true` (LDB-I2a/I12's own marker, pre-decision-6) --
    // the legacy rule (`legacyFollows`) skips it and still answers
    // "following", so this counts toward `legacy_magic_only_following`.
    const { record: magicOnly } = await appendWrite(db, clock, {
      kind: "imported",
      name: "migrate-magic67",
      owner: "owner-1",
      modified_at: "2026-01-01T00:00:00.000Z",
      format: "akl/1",
      payload: { keys: SPARK_KEYS, board: SPARK_BOARD },
      actor: "system:cmini-import",
      via: "import:cmini",
      source: { client: "system:cmini-import", version: null },
      hasMagic: false,
      upstream: null,
    });
    await mapUpstream("up-magic67", magicOnly.id);
    await appendWrite(db, clock, {
      kind: "updated",
      layoutId: magicOnly.id,
      name: magicOnly.name,
      owner: magicOnly.owner,
      modified_at: "2026-01-03T00:00:00.000Z",
      format: "akl/1",
      payload: { keys: SPARK_KEYS, board: SPARK_BOARD, magic: SPARK_MAGIC },
      actor: "owner-1",
      via: "discord",
      source: { client: "discord-app:test", version: null },
      hasMagic: true,
      detail: { magic_only: true },
      upstream: null,
    });

    // 4) spark/1, already stored (a write landed between the 0005 deploy
    // and this run) but `upstream_state` still NULL -- the backfill arm.
    const { record: backfill } = await appendWrite(db, clock, {
      kind: "imported",
      name: "migrate-backfill",
      owner: "owner-1",
      modified_at: "2026-01-01T00:00:00.000Z",
      format: "spark/1",
      payload: { keys: SPARK_KEYS, board: SPARK_BOARD },
      actor: "system:cmini-import",
      via: "import:cmini",
      source: { client: "system:cmini-import", version: null },
      hasMagic: false,
      upstream: null,
    });
    await mapUpstream("up-backfill", backfill.id);

    // 5) cmini/1, adapter-invalid: `blame` alone (canonical) is already
    // over spark's 16 KiB `x` cap (R-M2) -- `fromCmini` converts it without
    // throwing, spark's own `validate()` gracefully refuses it.
    const { record: invalid } = await appendWrite(db, clock, {
      kind: "imported",
      name: "migrate-invalid",
      owner: "owner-1",
      modified_at: "2026-01-01T00:00:00.000Z",
      format: "cmini/1",
      payload: { ...CMINI_PAYLOAD, blame: "x".repeat(20000) },
      actor: "system:cmini-import",
      via: "import:cmini",
      source: { client: "system:cmini-import", version: null },
      hasMagic: false,
      upstream: null,
    });

    const report = await migrateTick(db, clock, { dryRun: false, limit: 100 });

    expect(report.selected).toBe(5);
    expect(report.converted).toBe(4);
    expect(report.raced).toBe(0);
    expect(report.by_from).toEqual({ "cmini/1": 2, "akl/1": 1, "spark/1": 1 });
    expect(report.deleted).toBe(1);
    // The tombstone has an import_map row but its real latest rev-bumping
    // event (`deleted`, via `discord`) is not `import:cmini` -- per the
    // 2026-09-10 upstreamOf fix, a mapped record that legacyFollows says
    // isn't following reads `forked`, never `null` (an import_map row IS
    // the link; only a record with NO row at all reads `null`).
    expect(report.upstream).toEqual({ following: 3, forked: 1, null: 0 });
    expect(report.legacy_magic_only_following).toBe(1);
    expect(report.invalid).toHaveLength(1);
    expect(report.invalid[0]).toMatchObject({ id: invalid.id, name: "migrate-invalid", format: "cmini/1", path: "/x" });
    const maxId = [plain.id, tomb.id, magicOnly.id, backfill.id, invalid.id].sort().at(-1);
    expect(report.next_after).toBe(maxId);

    // The 4 converted records: format spark/1, rev+1, everything else
    // (`modified_at`/`created_at`/`deleted`/likes/`has_magic`) unchanged.
    const afterPlain = await readById(db, plain.id);
    expect(afterPlain).toMatchObject({
      format: "spark/1",
      rev: plain.rev + 1,
      modified_at: plain.modified_at,
      created_at: plain.created_at,
      deleted: false,
      has_magic: false,
      like_count: plain.like_count,
      upstream: { source: "cmini", id: "up-plain", state: "following" },
    });
    expect((afterPlain!.payload as { board: { kind: string } }).board.kind).toBe("ortho"); // fromCmini ran

    const afterTomb = await readById(db, tomb.id);
    expect(afterTomb).toMatchObject({
      format: "spark/1",
      deleted: true,
      upstream: { source: "cmini", id: "up-tomb", state: "forked" },
    });

    const afterMagicOnly = await readById(db, magicOnly.id);
    expect(afterMagicOnly).toMatchObject({
      format: "spark/1",
      has_magic: true,
      upstream: { source: "cmini", id: "up-magic67", state: "following" },
    });

    const afterBackfill = await readById(db, backfill.id);
    expect(afterBackfill).toMatchObject({
      format: "spark/1",
      rev: backfill.rev + 1, // still a rev, even though from == to (LDB-P11 is a fold)
      upstream: { source: "cmini", id: "up-backfill", state: "following" },
    });

    // The invalid record is untouched -- still reads through LDB-F21.
    const afterInvalid = await readById(db, invalid.id);
    expect(afterInvalid).toMatchObject({ format: "cmini/1", rev: invalid.rev });

    // The `migrated` event itself: kind/actor/via/source/detail.
    const migratedEvent = await db
      .prepare("SELECT actor, via, source_client, detail_json FROM events WHERE layout_id = ? AND kind = 'migrated'")
      .bind(plain.id)
      .first<{ actor: string; via: string; source_client: string; detail_json: string }>();
    expect(migratedEvent).toMatchObject({ actor: "system:migration", via: "migration", source_client: "system:migration" });
    expect(JSON.parse(migratedEvent!.detail_json)).toEqual({ from: "cmini/1", to: "spark/1", upstream_state: "following" });
  });

  it("[LDB-P12] [LDB-I14] a mapped-but-not-following record (import case 2's own shape) and an imported-then-user-edited record both migrate to 'forked', not null -- and a second real tick converges with zero writes", async () => {
    // Case-2-style: the importer mapped this name to an upstream id (an
    // `import_map` row exists) but never actually wrote this record --
    // its real history is a plain user create. Before the 2026-09-10
    // upstreamOf fix, `legacyFollows` answering false here made the
    // legacy fallback read `null` (R-L6's old text) -- which the
    // migration would then write back as `upstream: null` FOREVER (the
    // arm-2 selection re-matches a spark/1 row with `upstream_state IS
    // NULL` on every subsequent tick, since nothing ever moves it off
    // NULL): a real non-termination bug. The fix: an `import_map` row
    // alone answers `forked`.
    const { record: mappedNotFollowing } = await appendWrite(db, clock, {
      kind: "created",
      name: "migrate-case2",
      owner: "owner-1",
      modified_at: "2026-01-01T00:00:00.000Z",
      format: "cmini/1",
      payload: CMINI_PAYLOAD,
      actor: "owner-1",
      via: "discord",
      source: { client: "discord-app:test", version: null },
      hasMagic: false,
      upstream: null,
    });
    await mapUpstream("up-case2", mappedNotFollowing.id);

    // Imported, then genuinely edited by a user -- a real fork, not an
    // edge case, and the more common of the two ways a mapped record
    // ends up not-following.
    const { record: importedThenEdited } = await appendWrite(db, clock, {
      kind: "imported",
      name: "migrate-imported-edited",
      owner: "owner-1",
      modified_at: "2026-01-01T00:00:00.000Z",
      format: "cmini/1",
      payload: CMINI_PAYLOAD,
      actor: "system:cmini-import",
      via: "import:cmini",
      source: { client: "system:cmini-import", version: null },
      hasMagic: false,
      upstream: null,
    });
    await mapUpstream("up-edited", importedThenEdited.id);
    await appendWrite(db, clock, {
      kind: "updated",
      layoutId: importedThenEdited.id,
      name: importedThenEdited.name,
      owner: importedThenEdited.owner,
      modified_at: "2026-01-03T00:00:00.000Z",
      format: "cmini/1",
      payload: { ...CMINI_PAYLOAD, keys: { ...CMINI_PAYLOAD.keys, b: { row: 0, col: 1, finger: "LM" } } },
      actor: "owner-1",
      via: "discord",
      source: { client: "discord-app:test", version: null },
      hasMagic: false,
      upstream: null,
    });

    const first = await migrateTick(db, clock, { dryRun: false, limit: 100 });
    expect(first.converted).toBe(2);
    expect(first.upstream.forked).toBe(2);
    expect(first.upstream.null).toBe(0);

    const afterCase2 = await readById(db, mappedNotFollowing.id);
    expect(afterCase2).toMatchObject({ format: "spark/1", upstream: { source: "cmini", id: "up-case2", state: "forked" } });
    const afterEdited = await readById(db, importedThenEdited.id);
    expect(afterEdited).toMatchObject({ format: "spark/1", upstream: { source: "cmini", id: "up-edited", state: "forked" } });

    // Converged: `upstream_state` is now 'forked' (NOT NULL), so arm-2's
    // own "upstream_state IS NULL" no longer matches either record --
    // this is exactly the termination property the fix restores. A
    // second real tick selects nothing and writes nothing.
    const { db: countedDb, batches } = countingBatchDb(db);
    const second = await migrateTick(countedDb, clock, { dryRun: false, limit: 100 });
    expect(second.selected).toBe(0);
    expect(second.converted).toBe(0);
    expect(batches()).toBe(0);
  });

  it("[LDB-P12] dry run: identical selection/conversion, zero D1 writes", async () => {
    const { record } = await appendWrite(db, clock, {
      kind: "imported",
      name: "migrate-dry",
      owner: "owner-1",
      modified_at: "2026-01-01T00:00:00.000Z",
      format: "cmini/1",
      payload: CMINI_PAYLOAD,
      actor: "system:cmini-import",
      via: "import:cmini",
      source: { client: "system:cmini-import", version: null },
      hasMagic: false,
      upstream: null,
    });
    await mapUpstream("up-dry", record.id);

    const { db: countedDb, batches } = countingBatchDb(db);
    const report = await migrateTick(countedDb, clock, { dryRun: true, limit: 100 });

    expect(report.selected).toBe(1);
    expect(report.converted).toBe(1);
    expect(report.by_from).toEqual({ "cmini/1": 1 });
    expect(report.upstream).toEqual({ following: 1, forked: 0, null: 0 });
    expect(batches()).toBe(0); // zero D1 writes -- LDB-H5's own instrument

    // The record itself is untouched: still cmini/1, same rev.
    const after = await readById(db, record.id);
    expect(after).toMatchObject({ format: "cmini/1", rev: record.rev });
  });

  it("[LDB-P12] a quiet tick (nothing left to convert or backfill) writes nothing", async () => {
    const { record } = await appendWrite(db, clock, {
      kind: "imported",
      name: "migrate-quiet",
      owner: "owner-1",
      modified_at: "2026-01-01T00:00:00.000Z",
      format: "cmini/1",
      payload: CMINI_PAYLOAD,
      actor: "system:cmini-import",
      via: "import:cmini",
      source: { client: "system:cmini-import", version: null },
      hasMagic: false,
      upstream: null,
    });
    await mapUpstream("up-quiet", record.id);

    const first = await migrateTick(db, clock, { dryRun: false, limit: 100 });
    expect(first.converted).toBe(1);

    const { db: countedDb, batches } = countingBatchDb(db);
    const second = await migrateTick(countedDb, clock, { dryRun: false, limit: 100 });
    expect(second.selected).toBe(0);
    expect(second.converted).toBe(0);
    expect(second.next_after).toBeNull();
    expect(batches()).toBe(0);
  });

  it("[LDB-P12] RevConflictError from a concurrent write is counted as `raced`, not thrown, and the record is left untouched for the next tick", async () => {
    const { record } = await appendWrite(db, clock, {
      kind: "imported",
      name: "migrate-raced",
      owner: "owner-1",
      modified_at: "2026-01-01T00:00:00.000Z",
      format: "cmini/1",
      payload: CMINI_PAYLOAD,
      actor: "system:cmini-import",
      via: "import:cmini",
      source: { client: "system:cmini-import", version: null },
      hasMagic: false,
      upstream: null,
    });
    await mapUpstream("up-raced", record.id);

    // Simulate a user write landing exactly between `migrateTick`'s own
    // per-record `readById` and its `appendWrite` call: `readById` is
    // spied so its FIRST call (the migration's own read) performs a real,
    // independent write before returning the pre-write snapshot it would
    // have returned anyway -- `migrateTick` then computes `expectRev` off
    // a rev the row has already moved past.
    const realReadById = recordsModule.readById;
    vi.spyOn(recordsModule, "readById").mockImplementationOnce(async (d, id) => {
      const rec = await realReadById(d, id);
      await appendWrite(d, clock, {
        kind: "renamed",
        layoutId: id,
        name: "migrate-raced-renamed",
        owner: rec!.owner,
        modified_at: "2026-01-05T00:00:00.000Z",
        format: rec!.format,
        payload: rec!.payload,
        actor: "owner-1",
        via: "discord",
        source: { client: "discord-app:test", version: null },
        hasMagic: false,
        upstream: null,
      });
      return rec;
    });

    const report = await migrateTick(db, clock, { dryRun: false, limit: 100 });
    expect(report.selected).toBe(1);
    expect(report.converted).toBe(0);
    expect(report.raced).toBe(1);
    expect(report.invalid).toEqual([]);

    // The user's concurrent rename survives untouched (rev 1 -> 2 only --
    // the migration's own write never landed on top of it).
    const after = await readById(db, record.id);
    expect(after).toMatchObject({ rev: record.rev + 1, name: "migrate-raced-renamed", format: "cmini/1" });

    // A follow-up tick (no spy this time) picks it up and converts it.
    const second = await migrateTick(db, clock, { dryRun: false, limit: 100 });
    expect(second.converted).toBe(1);
    expect(second.raced).toBe(0);
    const finalRec = await readById(db, record.id);
    expect(finalRec).toMatchObject({ format: "spark/1" });
  });
});

describe("[LDB-P12] chain generalization (20-spark.md S5): 'below its lineage's latest', not a hardcoded spark/1", () => {
  it("[LDB-P12] once spark/2 registers, a spark/1-stored record is selected and converted, with detail.to naming the new latest", async () => {
    const unregister = registerForTest(SPARK_2);
    try {
      const { record } = await appendWrite(db, clock, {
        kind: "created",
        name: "migrate-chain-gen",
        owner: "owner-1",
        modified_at: "2026-01-01T00:00:00.000Z",
        format: "spark/1",
        payload: { keys: SPARK_KEYS, board: SPARK_BOARD },
        actor: "owner-1",
        via: "discord",
        source: { client: "discord-app:test", version: null },
        hasMagic: false,
        upstream: null,
      });

      const report = await migrateTick(db, clock, { dryRun: false, limit: 100 });
      expect(report.selected).toBe(1);
      expect(report.converted).toBe(1);
      expect(report.by_from).toEqual({ "spark/1": 1 });
      expect(report.upstream).toEqual({ following: 0, forked: 0, null: 1 }); // a plain user create -- no import_map row

      const after = await readById(db, record.id);
      expect(after).toMatchObject({ format: "spark/2", rev: record.rev + 1, modified_at: record.modified_at, has_magic: false });

      const migratedEvent = await db
        .prepare("SELECT detail_json FROM events WHERE layout_id = ? AND kind = 'migrated'")
        .bind(record.id)
        .first<{ detail_json: string }>();
      expect(JSON.parse(migratedEvent!.detail_json)).toEqual({ from: "spark/1", to: "spark/2", upstream_state: null });

      // Converged: a second tick, still with spark/2 registered, selects
      // and writes nothing -- the "below latest" rule now matches nothing.
      const { db: countedDb, batches } = countingBatchDb(db);
      const second = await migrateTick(countedDb, clock, { dryRun: false, limit: 100 });
      expect(second.selected).toBe(0);
      expect(batches()).toBe(0);
    } finally {
      unregister();
    }
  });

  it("[LDB-P12] with spark/2 UNregistered again, migrateTick reverts to selecting only the legacy formats -- the rule reads the LIVE registry every call, not a cached target", async () => {
    const { record: legacyRecord } = await appendWrite(db, clock, {
      kind: "imported",
      name: "migrate-chain-gen-2",
      owner: "owner-1",
      modified_at: "2026-01-01T00:00:00.000Z",
      format: "cmini/1",
      payload: CMINI_PAYLOAD,
      actor: "system:cmini-import",
      via: "import:cmini",
      source: { client: "system:cmini-import", version: null },
      hasMagic: false,
      upstream: null,
    });

    const report = await migrateTick(db, clock, { dryRun: false, limit: 100 });
    expect(report.converted).toBe(1);
    const after = await readById(db, legacyRecord.id);
    expect(after).toMatchObject({ format: "spark/1" }); // spark/2 is not registered in THIS test -- latest is plain spark/1
  });
});

// 2026-09-11 preview dry run (c7): `slataline` (following, stored `cmini/1`)
// still carried upstream cmini magic, because the M1 strip route ran on
// production only, and its rows lifted to an invalid spark rule. Separately,
// the M2-seeded records all counted 0 in `legacy_magic_only_following`,
// because a later `imported` event sat on top of the seed's magic-only one.
describe("[LDB-P12] M1 strip on migration, and the seeded-record count", () => {
  const MAGIC_CMINI = {
    board: "ortho" as const,
    keys: { a: { row: 0, col: 0, finger: "LI" }, b: { row: 0, col: 1, finger: "LM" } },
    magic: [{ inputs: "ab", output: "ba" }],
  };

  async function lastDetail(layoutId: string): Promise<Record<string, unknown>> {
    const row = await db
      .prepare("SELECT detail_json FROM events WHERE layout_id = ? AND rev IS NOT NULL ORDER BY seq DESC LIMIT 1")
      .bind(layoutId)
      .first<{ detail_json: string | null }>();
    return JSON.parse(row?.detail_json ?? "{}") as Record<string, unknown>;
  }

  it("[LDB-P12] a FOLLOWING cmini/1 record's upstream cmini magic is dropped on conversion (M1), recorded on the event and in the report", async () => {
    const { record } = await appendWrite(db, clock, {
      kind: "imported",
      name: "strip-following",
      owner: "owner-1",
      modified_at: "2026-01-01T00:00:00.000Z",
      format: "cmini/1",
      payload: MAGIC_CMINI,
      actor: "system:cmini-import",
      via: "import:cmini",
      source: { client: "system:cmini-import", version: null },
      hasMagic: true,
      upstream: null,
    });
    await mapUpstream("up-strip-following", record.id);

    const report = await migrateTick(db, clock, { dryRun: false });
    expect(report.invalid).toEqual([]);
    expect(report.magic_stripped).toBe(1);
    expect(report.converted).toBe(1);

    const after = await readById(db, record.id);
    expect(after?.format).toBe("spark/1");
    expect((after?.payload as { magic?: unknown }).magic).toBeUndefined();
    expect(after?.has_magic).toBe(false);
    expect(after?.upstream?.state).toBe("following");
    expect(after?.modified_at).toBe("2026-01-01T00:00:00.000Z");
    expect(await lastDetail(record.id)).toMatchObject({ from: "cmini/1", to: "spark/1", magic_stripped: true });

    // Idempotent: the converted record is spark now, so nothing is re-selected.
    const again = await migrateTick(db, clock, { dryRun: false });
    expect(again.selected).toBe(0);
  });

  it("[LDB-P12] a NOT-following (forked) cmini/1 record keeps its magic, lifted to spark", async () => {
    const { record } = await appendWrite(db, clock, {
      kind: "imported",
      name: "strip-forked",
      owner: "owner-1",
      modified_at: "2026-01-01T00:00:00.000Z",
      format: "cmini/1",
      payload: MAGIC_CMINI,
      actor: "system:cmini-import",
      via: "import:cmini",
      source: { client: "system:cmini-import", version: null },
      hasMagic: true,
      upstream: null,
    });
    await mapUpstream("up-strip-forked", record.id);
    await appendWrite(db, clock, {
      kind: "updated",
      layoutId: record.id,
      name: record.name,
      owner: record.owner,
      modified_at: "2026-01-02T00:00:00.000Z",
      format: "cmini/1",
      payload: { ...MAGIC_CMINI, tag: "edited" },
      actor: "owner-1",
      via: "discord",
      source: { client: "discord-app:test", version: null },
      hasMagic: true,
      upstream: null,
    });

    const report = await migrateTick(db, clock, { dryRun: false });
    expect(report.invalid).toEqual([]);
    expect(report.magic_stripped).toBe(0);

    const after = await readById(db, record.id);
    expect(after?.format).toBe("spark/1");
    expect(after?.upstream?.state).toBe("forked");
    expect(after?.has_magic).toBe(true);
    expect((after?.payload as { magic?: unknown }).magic).toBeDefined();
    expect(await lastDetail(record.id)).not.toHaveProperty("magic_stripped");
  });

  it("[LDB-P12] the dry run reports the same strip without writing", async () => {
    const { record } = await appendWrite(db, clock, {
      kind: "imported",
      name: "strip-dry",
      owner: "owner-1",
      modified_at: "2026-01-01T00:00:00.000Z",
      format: "cmini/1",
      payload: MAGIC_CMINI,
      actor: "system:cmini-import",
      via: "import:cmini",
      source: { client: "system:cmini-import", version: null },
      hasMagic: true,
      upstream: null,
    });
    await mapUpstream("up-strip-dry", record.id);
    const report = await migrateTick(db, clock, { dryRun: true });
    expect(report.magic_stripped).toBe(1);
    expect(report.invalid).toEqual([]);
    const after = await readById(db, record.id);
    expect(after?.format).toBe("cmini/1");
    expect(after?.has_magic).toBe(true);
  });

  it("[LDB-P12] a seeded record counts and is named even when a later import sits on top of the seed's magic-only event", async () => {
    const { record } = await appendWrite(db, clock, {
      kind: "imported",
      name: "seeded-then-imported",
      owner: "owner-1",
      modified_at: "2026-01-01T00:00:00.000Z",
      format: "akl/1",
      payload: { keys: SPARK_KEYS, board: SPARK_BOARD },
      actor: "system:cmini-import",
      via: "import:cmini",
      source: { client: "system:cmini-import", version: null },
      hasMagic: false,
      upstream: null,
    });
    await mapUpstream("up-seeded", record.id);
    await appendWrite(db, clock, {
      kind: "updated",
      layoutId: record.id,
      name: record.name,
      owner: record.owner,
      modified_at: "2026-01-01T00:00:00.000Z",
      format: "akl/1",
      payload: { keys: SPARK_KEYS, board: SPARK_BOARD, magic: SPARK_MAGIC },
      actor: "system:migration-m2",
      via: "client:m2-seed",
      source: { client: "client:m2-seed", version: null },
      hasMagic: true,
      detail: { magic_only: true },
      upstream: null,
    });
    // An upstream change afterwards: the importer rewrites keys/board and
    // carries the record's own magic forward (LDB-I11).
    await appendWrite(db, clock, {
      kind: "imported",
      layoutId: record.id,
      name: record.name,
      owner: record.owner,
      modified_at: "2026-02-01T00:00:00.000Z",
      format: "akl/1",
      payload: { keys: SPARK_KEYS, board: SPARK_BOARD, magic: SPARK_MAGIC },
      actor: "system:cmini-import",
      via: "import:cmini",
      source: { client: "system:cmini-import", version: null },
      hasMagic: true,
      detail: { source: "cmini", upstream_id: "up-seeded" },
      upstream: null,
    });

    const report = await migrateTick(db, clock, { dryRun: false });
    expect(report.invalid).toEqual([]);
    expect(report.legacy_magic_only_following).toBe(1);
    expect(report.legacy_magic_only_following_names).toEqual(["seeded-then-imported"]);
    const after = await readById(db, record.id);
    expect(after?.upstream?.state).toBe("following");
    expect(after?.has_magic).toBe(true);
  });
});
