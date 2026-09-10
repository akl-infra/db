// "Follows upstream" is derived, not stored (06 §2, D9): true iff the
// record's latest rev-bumping event -- MAGIC-ONLY writes excluded, LDB-I12
// below -- (likes and informational events excluded too -- they don't bump
// `rev`) has `via = 'import:cmini'`. One indexed query (events_layout on
// (layout_id, seq)); no flag to go stale.
//
// LDB-I12 (design/layout-db/18-command-decisions.md §2 item 1;
// 17-magic-ownership.md's M2 prerequisite): a `PATCH {magic}` (or a magic
// PATCH's cmini/1 -> akl/1 lift, `core/write.ts`'s `patchLayout`) never
// touches keys/board/name, so it must not count as "the latest write" for
// follows-upstream purposes -- a record that was following upstream stays
// following through any number of magic-only PATCHes. `patchLayout` marks
// exactly this shape with `detail.magic_only: true` on the `updated` event
// it appends; this walks back past every such event (most recent first) to
// the first rev-bumping event that changed something else, and answers off
// THAT one's `via` -- or `false` if every rev-bumping event so far is
// magic-only (unreachable in practice: a record's first event is always
// `created`/`imported`/`transferred`/etc., never `updated`).
import type { Bindings } from "../env";

interface FollowsEventRow {
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

export async function followsUpstream(db: Bindings["DB"], layoutId: string): Promise<boolean> {
  const { results } = await db
    .prepare("SELECT via, detail_json FROM events WHERE layout_id = ? AND rev IS NOT NULL ORDER BY seq DESC")
    .bind(layoutId)
    .all<FollowsEventRow>();
  for (const row of results) {
    if (isMagicOnly(row.detail_json)) continue;
    return row.via === "import:cmini";
  }
  return false;
}
