// 20-spark.md S4 (LDB-P12): the record migration -- an OPERATOR-driven
// pass (decision 11, never a cron: `POST /v1/admin/migrate/tick`,
// `routes/admin.ts`, and `scripts/migrate_records_to_spark.py` are the two
// callers) that moves every legacy-stored record (`cmini/1`, `akl/1`) to
// `spark/1` and backfills `upstream` for a record a write already stored
// as spark BETWEEN the 0005 deploy and this run (that write's own rev
// couldn't have known `upstream` yet -- S3a's `upstreamOf` fallback covers
// reads in that window, this migration is what actually converges the
// column).
//
// Selection, conversion and the report shape are exactly `design/layout-db/
// 20-spark.md`'s S4 bullets; nothing here duplicates `storedAsSpark`,
// `nextUpstream` or `upstreamOf` -- it calls them, the same as every other
// writer (S2/S3a/S3b).
import type { Bindings } from "../env";
import { get as getFormat, list as listFormats } from "../formats/registry";
import { storedAsSpark, LEGACY_STORED, lineage, latestId, walk } from "../../formats/registry.ts";
import { appendWrite, RevConflictError } from "./events";
import { readById, type Upstream, type UpstreamState } from "./records";
import type { Clock } from "./time";
import { nextUpstream, upstreamOf } from "./upstream";

// 20-spark.md S5: generalised from a hardcoded `'spark/1'` target to
// "whatever the ONE stored lineage's latest major currently is" -- decision
// 1 pins exactly one stored-role lineage at a time, so `list()` always has
// exactly one `role: "stored"` entry to read the lineage NAME off; `latestId`
// then answers its CURRENT latest, which moves the moment a new major
// registers (`spark/2`, say) with no further change here.
function storedLatestId(): string {
  const stored = listFormats().find((f) => f.role === "stored");
  if (stored === undefined) throw new Error("migrateTick: no registered format with role 'stored'");
  const id = latestId(lineage(stored.id));
  if (id === undefined) throw new Error("migrateTick: unreachable -- a registered module's own lineage has no latest");
  return id;
}

// LDB-P12/§8 R-M3: the selection's own `LIMIT min(limit, 100)` -- a batch
// of 100 stays well under Workers Paid's 1 000 queries/invocation at
// roughly 7 D1 round trips per record (one `readById` here, up to two for
// `upstreamOf`'s legacy fallback, one for the magic-only-latest check when
// the record ends up following, one more `readById` plus a 3-statement
// `batch()` inside `appendWrite` itself).
const MAX_LIMIT = 100;
const DEFAULT_LIMIT = 100;

export interface InvalidEntry {
  id: string;
  name: string;
  format: string;
  path: string;
  message: string;
}

export interface MigrateReport {
  selected: number;
  converted: number;
  by_from: Record<string, number>;
  deleted: number;
  upstream: { following: number; forked: number; null: number };
  legacy_magic_only_following: number;
  invalid: InvalidEntry[];
  raced: number;
  next_after: string | null;
}

export interface MigrateOptions {
  dryRun: boolean;
  after?: string;
  limit?: number;
}

// The selection (20-spark.md S4, generalised by S5's own bullet: "the S4
// selection gains OR major(format) < latest"): ordered by id, `id > after`,
// `LIMIT min(limit, 100)` --
//   format IN (<every LEGACY_STORED id> ++ <every registered major of the
//              stored lineage BELOW its current latest>)
//   OR (upstream_state IS NULL AND id IN (SELECT layout_id FROM import_map))
// -- the first arm is now built from the LIVE registry rather than a
// hardcoded `'spark/1'` literal, so it keeps selecting a stored-lineage
// record that's fallen behind (`spark/1` once `spark/2` is latest) with NO
// further change here; `LEGACY_STORED`'s ids (`akl/1`/`cmini/1`) are
// included unconditionally since they are never chain steps (20-spark.md
// §5's own wording) and must always convert regardless of how many majors
// the stored lineage has. The IN-list is at minimum `LEGACY_STORED`'s two
// ids, so it is never empty (an empty SQL `IN ()` is a syntax error). The
// second arm backfills a record a write already stored as latest between
// the deploy and this run, whose `upstream` the plain "below latest" rule
// would otherwise leave null forever.
function belowLatestFormatIds(latest: string): string[] {
  const name = lineage(latest);
  const latestMajor = Number(latest.slice(name.length + 1));
  const lowerMajors: string[] = [];
  for (let m = 1; m < latestMajor; m++) lowerMajors.push(`${name}/${m}`);
  return [...Object.keys(LEGACY_STORED), ...lowerMajors];
}

async function selectIds(db: Bindings["DB"], after: string, limit: number, latest: string): Promise<string[]> {
  const belowLatest = belowLatestFormatIds(latest);
  const placeholders = belowLatest.map(() => "?").join(", ");
  const { results } = await db
    .prepare(
      `SELECT id FROM layouts
       WHERE id > ?
         AND (format IN (${placeholders})
              OR (upstream_state IS NULL AND id IN (SELECT layout_id FROM import_map)))
       ORDER BY id
       LIMIT ?`,
    )
    .bind(after, ...belowLatest, limit)
    .all<{ id: string }>();
  return results.map((r) => r.id);
}

// `legacy_magic_only_following` (§1.7, the 67-record flag): a record whose
// resolved state is `following` counts here iff its TRUE latest
// rev-bumping event (unlike `legacyFollows`, this does NOT skip past a
// magic-only one) is marked `magic_only` -- i.e. the ONLY reason the legacy
// rule answers "following" is that it walked back past that PATCH to find
// an `import:cmini` write underneath. A small, deliberate duplicate of
// `core/follows.ts`'s private `isMagicOnly` (that module is S3a's, not
// this slice's to edit) rather than a shared export -- the check this
// slice needs ("is the UNSKIPPED latest event magic-only") is the inverse
// of what `legacyFollows` itself computes, so sharing one helper would mean
// exporting a second, easily-confused function from a file this slice
// doesn't own.
async function latestRevBumpingIsMagicOnly(db: Bindings["DB"], layoutId: string): Promise<boolean> {
  const row = await db
    .prepare("SELECT detail_json FROM events WHERE layout_id = ? AND rev IS NOT NULL ORDER BY seq DESC LIMIT 1")
    .bind(layoutId)
    .first<{ detail_json: string | null }>();
  if (row === null || row.detail_json === null) return false;
  try {
    const detail = JSON.parse(row.detail_json) as { magic_only?: unknown };
    return detail.magic_only === true;
  } catch {
    return false;
  }
}

function upstreamStateKey(upstream: Upstream | null): UpstreamState | "null" {
  return upstream?.state ?? "null";
}

// `up` never holds (LDB-F18/R3) -- this only satisfies the type checker;
// hitting it for real means a registered chain step violates its own
// contract, which `chainViolations`/LDB-F18's own test catches long before
// a migration ever runs.
function assertNotHeld(v: unknown): unknown {
  if (typeof v === "object" && v !== null && (v as { held?: unknown }).held === true) {
    throw new Error("migrateTick: a chain step unexpectedly held (LDB-F18 violation)");
  }
  return v;
}

// convertToLatest(rec, latest) (20-spark.md S5): a legacy-stored record
// (`akl/1`/`cmini/1`) normalizes through `storedAsSpark` FIRST (the one
// converter LDB-F21 allows for a stored legacy payload -- never a chain
// step, decision in S5's own header comment above `selectIds`), then, if
// the stored lineage's latest is past `spark/1`, chains up the rest of the
// way; a record already at a REGISTERED lower major of the stored lineage
// (no real example exists yet -- only the stub lineage in tests) chains up
// directly, `storedAsSpark` never touching it (it isn't a legacy id).
function convertToLatest(rec: { format: string; payload: unknown }, latest: string): { format: string; payload: unknown } {
  if (rec.format in LEGACY_STORED) {
    const base = storedAsSpark(rec.format, rec.payload);
    if (base.format === latest) return base;
    return { format: latest, payload: assertNotHeld(walk(base.format, latest, base.payload)) };
  }
  return { format: latest, payload: assertNotHeld(walk(rec.format, latest, rec.payload)) };
}

// `migrateTick(db, now, {dryRun, after, limit})`: one batch of the
// migration. `dryRun`: identical selection, conversion and validation --
// zero D1 WRITES (reads are fine: `upstreamOf`'s legacy fallback and the
// magic-only-latest check both read, same as a real run, so the report's
// `upstream`/`legacy_magic_only_following` counts are the SAME preview a
// real run would produce) -- `RevConflictError` can never fire since
// nothing is written, so `raced` stays 0 in dry-run reports by construction.
export async function migrateTick(db: Bindings["DB"], now: Clock, opts: MigrateOptions): Promise<MigrateReport> {
  const limit = Math.min(opts.limit ?? DEFAULT_LIMIT, MAX_LIMIT);
  const after = opts.after ?? "";
  // 20-spark.md S5: the live target, not a hardcoded `spark/1` -- moves
  // automatically once a `spark/2` (or, in tests, a stub lineage's own
  // second major) registers.
  const latest = storedLatestId();
  const latestModule = getFormat(latest);
  if (latestModule === undefined) throw new Error(`migrateTick: unreachable -- '${latest}' is not registered`);

  const ids = await selectIds(db, after, limit, latest);

  const report: MigrateReport = {
    selected: ids.length,
    converted: 0,
    by_from: {},
    deleted: 0,
    upstream: { following: 0, forked: 0, null: 0 },
    legacy_magic_only_following: 0,
    invalid: [],
    raced: 0,
    next_after: ids.length > 0 ? ids[ids.length - 1]! : null,
  };

  for (const id of ids) {
    // Fresh read per record -- immune to `selectIds`' row shape changing
    // independently of this (same reasoning `import/strip.ts`'s own
    // per-record `readById` gives).
    const record = await readById(db, id);
    if (record === null) continue; // defensive: nothing hard-deletes a `layouts` row, so unreachable in practice

    const from = record.format;
    const next = convertToLatest(record, latest);

    const validation = latestModule.validate(next.payload);
    if (!validation.ok) {
      const path = typeof validation.error.path === "string" ? validation.error.path : "/";
      report.invalid.push({ id, name: record.name, format: from, path, message: validation.error.message });
      continue; // write nothing -- the record keeps reading through LDB-F21
    }

    const hasMagic = latestModule.hasMagic(next.payload);
    if (hasMagic !== record.has_magic) {
      // R-M2's own posture, extended: the stored `has_magic` disagreeing
      // with a freshly computed one is exactly as unsafe to write over as
      // a validate() failure -- skip and list, never silently correct it.
      report.invalid.push({
        id,
        name: record.name,
        format: from,
        path: "/has_magic",
        message: `computed hasMagic (${hasMagic}) disagrees with the stored has_magic (${record.has_magic})`,
      });
      continue;
    }

    // `prior` = the record's own field when non-null, else the legacy
    // fallback (`upstreamOf`) -- selection guarantees `record.upstream` is
    // null for every row reaching here (LDB-F16/S2: every write since the
    // 0005 deploy stores `spark/1`, so a legacy-format row's `upstream_*`
    // columns are still all-NULL, untouched since 0005; the backfill arm's
    // own `WHERE upstream_state IS NULL` says the same for a spark-stored
    // one). `nextUpstream(prior, "migrated", ...)` always answers `prior`
    // unchanged -- called anyway, like every other writer, rather than
    // inlining that short-circuit here.
    const prior = await upstreamOf(db, record);
    const upstream = nextUpstream(prior, "migrated", "migration");
    const stateKey = upstreamStateKey(upstream);
    // Computed BEFORE the write below: once this record's own `migrated`
    // event exists, it would (correctly) become the new latest rev-bumping
    // event, and its `detail` carries no `magic_only` key -- checking after
    // the write would silently and wrongly answer `false` for every record
    // this tick just converted.
    const magicOnlyLatest = stateKey === "following" ? await latestRevBumpingIsMagicOnly(db, id) : false;

    if (!opts.dryRun) {
      try {
        await appendWrite(db, now, {
          kind: "migrated",
          layoutId: record.id,
          name: record.name,
          owner: record.owner,
          // `modified_at`/`created_at` unchanged (P12): `created_at` is
          // omitted so `appendWrite` keeps the record's own (it only moves
          // when a write NAMES a new one, `core/events.ts`'s own comment).
          modified_at: record.modified_at,
          format: next.format,
          payload: next.payload,
          actor: "system:migration",
          via: "migration",
          deleted: record.deleted, // unchanged -- a tombstone stays a tombstone
          hasMagic,
          upstream,
          source: { client: "system:migration", version: null },
          detail: { from, to: next.format, upstream_state: stateKey === "null" ? null : stateKey },
          expectRev: record.rev, // LDB-P14: a user write interleaved since this record's own read wins, not this migration
        });
      } catch (e) {
        if (e instanceof RevConflictError) {
          report.raced++; // re-selected on the next tick (this write never landed, so nothing about `record` changed)
          continue;
        }
        throw e;
      }
    }

    report.converted++;
    report.by_from[from] = (report.by_from[from] ?? 0) + 1;
    if (record.deleted) report.deleted++;
    report.upstream[stateKey]++;
    if (magicOnlyLatest) report.legacy_magic_only_following++;
  }

  return report;
}
