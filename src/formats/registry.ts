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
// 20-spark.md S2: `LEGACY_WRITABLE` (S1's temporary `cmini/1` write-compat
// shim) is deleted here -- `get()` now resolves ONLY a registered id or an
// alias whose target is a registered `FormatModule` (`akl/1` -> spark/1);
// `cmini/1`'s target is the unregistered adapter (`resolveFormat`'s own
// `adapter:cmini` special case), so `get("cmini/1")` now answers
// `undefined` -- exactly what `core/write.ts`'s `validatePayload` needs to
// refuse a `cmini/1` write with `400 unknown_format` (LDB-F16).
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

// get(id): resolves a native registered id or an alias (`akl/1` -> the
// spark/1 module) through the pure registry's `resolveFormat`.
// `getFormat("akl/1")` returns the SAME module `getFormat("spark/1")` does
// (their payload shape is byte-identical, 20-spark.md §1 decision 1);
// `getFormat("cmini/1")` and `getFormat("mana2/1")`'s WRITABILITY are
// `core/write.ts`'s own concern (role check) -- this function only
// resolves an id to a module, it never judges writability.
export function get(id: string): FormatModule | undefined {
  return pureRegistry.resolveFormat(id)?.module;
}

export type TranslateResult = { payload: Payload } | { held: true; format: string; see?: string };

export function translate(rec: { format: string; payload: Payload }, as: string): TranslateResult {
  const result = pureRegistry.translate(rec, as);
  if ("unknown" in result) {
    throw unknownFormat(as, result.known);
  }
  return result;
}
