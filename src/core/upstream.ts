// 21-formats.md §2.2 (MF-12): follow state is layout-level. A user write
// forks a following layout iff it is layout-level or to lineage `spark`; a
// write to any other lineage never touches `upstream` at all -- not even
// to re-set it to the same value. The importer never writes a forked
// layout (every import call site is gated on `following` first and guarded
// by `expectN`, LDB-P14).
import type { Bindings } from "../env";
import type { LayoutRow, Upstream } from "./records";

// `touches`: true for a layout-scope write, or a format-scope write on
// lineage `spark`; false for every other lineage (MF-12: "a write to
// another lineage never changes upstream").
export function nextUpstream(prior: Upstream | null, via: string, touches: boolean): Upstream | null {
  if (prior === null) return null;
  if (!touches) return prior;
  if (via === "import:cmini") return { ...prior, state: "following" };
  return { ...prior, state: "forked" };
}

// Read-side: a layout's own `upstream` field, straight off the row. Takes
// `db` (unused) to keep every call site's shape unchanged.
// eslint-disable-next-line @typescript-eslint/no-unused-vars
export async function upstreamOf(db: Bindings["DB"], rec: LayoutRow): Promise<Upstream | null> {
  return rec.upstream;
}
