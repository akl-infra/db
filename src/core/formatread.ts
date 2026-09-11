// 21-formats.md §2.5: resolving a `?format=F` read against a layout's own
// stored `layout_formats` rows. `translate()` (formats/registry.ts) still
// operates on one {format, payload} pair -- this module decides WHICH
// stored row to hand it: the layout's own row of `lineage(F)` when `F` is a
// stored-role format, or the layout's row of the ONE registered stored
// lineage that reaches `F` (`outputSourceLineage`, MF-10) when `F` is an
// output-role format. Stored formats are never derived (§2.5): a request
// for a stored format ALWAYS reads that lineage's own row, never a
// cross-lineage edge.
import { formatAbsent, held, unknownFormat } from "./errors";
import type { FormatRow } from "./records";
import { get as getFormat, lineage, list as listFormats, outputSourceLineage, translate } from "../formats/registry";

export interface ResolvedRead {
  format: string; // == the requested `as`
  payload: unknown;
  derived_from?: string; // present iff `as` is an output format (§2.5)
}

export function resolveReadFormat(formats: Map<string, FormatRow>, as: string): ResolvedRead {
  const mod = getFormat(as);
  if (mod === undefined) {
    throw unknownFormat(
      as,
      listFormats().map((f) => f.id),
    );
  }

  if (mod.role === "stored") {
    const row = formats.get(lineage(as));
    if (row === undefined) throw formatAbsent(as);
    if (row.format === as) return { format: as, payload: row.payload };
    // A within-lineage chain (an older/newer major of the SAME lineage,
    // LDB-F18/P13) -- unreachable today (spark/mana2 are each one major)
    // but real for the stub lineage's tests.
    const result = translate({ format: row.format, payload: row.payload }, as);
    if ("held" in result) throw held(result.format, result.see);
    return { format: as, payload: result.payload };
  }

  // Output format (mana2/1 today): derive from the ONE stored lineage
  // registered to reach it (MF-10) -- never search across whatever this
  // PARTICULAR layout happens to have stored, so there is nothing to
  // disambiguate at read time.
  const source = outputSourceLineage(as);
  if (source === undefined) throw formatAbsent(as); // no registered source at all -- nothing to derive from
  const row = formats.get(lineage(source));
  if (row === undefined) throw formatAbsent(as); // this layout doesn't have that source lineage stored
  const result = translate({ format: row.format, payload: row.payload }, as);
  if ("held" in result) throw held(result.format, result.see);
  return { format: as, payload: result.payload, derived_from: row.format };
}

// `GET /v1/layouts?format=F`'s list resolution: which stored lineage
// actually backs the read (`core/records.ts`'s `list()` joins on it
// directly). Unlike `resolveReadFormat`, this never touches a specific
// layout's rows -- it's purely "what registry says F resolves from".
export function sourceLineageFor(as: string): { lineage: string } | { unknown: true; known: string[] } | { absent: true } {
  const mod = getFormat(as);
  if (mod === undefined) {
    return { unknown: true, known: listFormats().map((f) => f.id) };
  }
  if (mod.role === "stored") return { lineage: lineage(as) };
  const source = outputSourceLineage(as);
  if (source === undefined) return { absent: true };
  return { lineage: lineage(source) };
}
