// "Follows upstream" is derived, not stored (06 §2, D9): true iff the
// record's latest rev-bumping event (likes and informational events
// excluded -- they don't bump `rev`) has `via = 'import:cmini'`. One
// indexed query (events_layout on (layout_id, seq)); no flag to go stale.
import type { Bindings } from "../env";

export async function followsUpstream(db: Bindings["DB"], layoutId: string): Promise<boolean> {
  const row = await db
    .prepare("SELECT via FROM events WHERE layout_id = ? AND rev IS NOT NULL ORDER BY seq DESC LIMIT 1")
    .bind(layoutId)
    .first<{ via: string }>();
  return row?.via === "import:cmini";
}
