// The LEGACY "follows upstream" rule (06 §2, D9), pre-0005: true iff the
// record's latest rev-bumping event -- MAGIC-ONLY and (20-spark.md S3a)
// MIGRATED writes excluded, LDB-I2a/I12 below -- (likes and informational
// events excluded too -- they don't bump `rev`) has `via = 'import:cmini'`.
// One indexed query (events_layout on (layout_id, seq)); no flag to go
// stale.
//
// Narrowed by 20-spark.md S3a: renamed from `followsUpstream`. Nothing
// NEW ever reads this directly any more -- `core/upstream.ts`'s
// `upstreamOf` is what every write-path caller reads instead (`prior =
// upstreamOf(db, rec)`), and this function is only ITS permanent fallback
// for a record whose `upstream` column is still null (written before
// 0005, or restored from a pre-0005 dump, LDB-P11), plus the S4 migration
// (which uses it to compute a record's INITIAL `upstream` the same way).
//
// LDB-I12 (design/layout-db/18-command-decisions.md §2 item 1;
// 17-magic-ownership.md's M2 prerequisite; narrowed by S2, S3a): a `PATCH
// {magic}` (or a magic PATCH's cmini/1 -> akl/1 lift, `core/write.ts`'s
// PRE-S2 `patchLayout`) never touched keys/board/name, so it must not
// count as "the latest write" for follows-upstream purposes -- a record
// that was following upstream stayed following through any number of
// magic-only PATCHes. Those PATCHes marked exactly this shape with
// `detail.magic_only: true` on the `updated` event they appended (S2
// deleted that marker: no NEW write ever sets it again, since decision 6
// forks every magic edit like any other write). This walks back past
// every HISTORICAL event carrying the marker (most recent first) -- and,
// S3a's own addition, past every `migrated` event (S4's writes, which
// must never count as "the latest write" for the legacy rule either: a
// migration's own initial `upstream` computation would otherwise see
// itself and loop) -- to the first rev-bumping event that is neither, and
// answers off THAT one's `via`; `false` if every rev-bumping event so far
// is skippable (unreachable for magic-only alone -- a record's first
// event is never `updated` -- but reachable once `migrated` events exist:
// a record with no real history before its own migration).
import type { Bindings } from "../env";

interface FollowsEventRow {
  kind: string;
  via: string;
  detail_json: string | null;
}

function isMagicOnly(detailJson: string | null): boolean {
  if (detailJson === null) return false;
  try {
    const detail = JSON.parse(detailJson) as { magic_only?: unknown };
    return detail.magic_only === true;
  } catch {
    return false;
  }
}

export async function legacyFollows(db: Bindings["DB"], layoutId: string): Promise<boolean> {
  const { results } = await db
    .prepare("SELECT kind, via, detail_json FROM events WHERE layout_id = ? AND rev IS NOT NULL ORDER BY seq DESC")
    .bind(layoutId)
    .all<FollowsEventRow>();
  for (const row of results) {
    if (row.kind === "migrated") continue;
    if (isMagicOnly(row.detail_json)) continue;
    return row.via === "import:cmini";
  }
  return false;
}
