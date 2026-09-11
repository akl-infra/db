// Worker-facing wrapper (07 S2; 12 §3 X5 item 1) around the pure registry
// that now lives at db/formats/registry.ts -- the one place its format
// modules are imported is inside that packaged directory, so this file
// re-exports everything from there and adds the one thing that DOES need
// src/core/errors.ts: turning a pure `{ unknown: true, known }` translate
// result into a thrown ApiError (07 §5's contract for route handlers --
// `app.onError` in index.ts is the only place an ApiError becomes a
// Response). One list of formats, importable both by the Worker and by
// @akl/layout-formats -- never a second one to drift out of sync.
//
// 21-formats.md D5/D12: every alias is gone (`akl/1`, `cmini/1`'s
// `adapter:cmini` read path) -- `get()` now resolves ONLY a registered id,
// so `get("cmini/1")` answers `undefined`, exactly what `core/write.ts`'s
// `validatePayload` needs to refuse a `cmini/1` write with `400
// unknown_format` (LDB-F16).
import { unknownFormat } from "../core/errors";
import * as pureRegistry from "../../formats/registry.ts";
import type { Payload, FormatModule } from "../../formats/registry.ts";

export type { Row, ValidationResult, Held, Payload, ErrBody, EditResult, FormatEdits, FormatModule } from "../../formats/registry.ts";

export const list = pureRegistry.list;
export const registerForTest = pureRegistry.registerForTest;

// 20-spark.md S5: the chain primitives, re-exported for `core/write.ts`,
// `core/migrate.ts` and `routes/formats.ts` -- pure functions, nothing here
// needs `core/errors.ts`.
export const lineage = pureRegistry.lineage;
export const majorOf = pureRegistry.majorOf;
export const latestOf = pureRegistry.latestOf;
export const latestId = pureRegistry.latestId;
export const path = pureRegistry.path;
export const walk = pureRegistry.walk;
export const hasEdge = pureRegistry.hasEdge;
export const chainViolations = pureRegistry.chainViolations;

// 21-formats.md §2.5 (MF-10): re-exported for `core/write.ts`'s read
// resolution and `routes/layouts.ts`'s list/get/rev routes.
export const reachingLineages = pureRegistry.reachingLineages;
export const outputSourceLineage = pureRegistry.outputSourceLineage;

// get(id): resolves a registered id through the pure registry's
// `resolveFormat`. `getFormat("cmini/1")` answers `undefined` (never
// registered) and `getFormat("mana2/1")`'s WRITABILITY is `core/write.ts`'s
// own concern (role check) -- this function only resolves an id to a
// module, it never judges writability.
export function get(id: string): FormatModule | undefined {
  return pureRegistry.resolveFormat(id)?.module;
}

// Re-exported for `core/write.ts`, which needs the `{module, label}` shape
// itself (to distinguish "not registered" from "registered but not
// writable"), not just the resolved module `get()` throws away.
export const resolveFormat = pureRegistry.resolveFormat;

export type TranslateResult = { payload: Payload } | { held: true; format: string; see?: string };

export function translate(rec: { format: string; payload: Payload }, as: string): TranslateResult {
  const result = pureRegistry.translate(rec, as);
  if ("unknown" in result) {
    throw unknownFormat(as, result.known);
  }
  return result;
}
