// Worker-facing wrapper (07 S2; 12 §3 X5 item 1) around the pure registry
// that now lives at db/formats/registry.ts -- the one place its format
// modules are imported is inside that packaged directory, so this file
// re-exports everything from there and adds the two things that DO need
// src/core/errors.ts: turning a pure `{ unknown: true, known }` translate
// result into a thrown ApiError (07 §5's contract for route handlers --
// `app.onError` in index.ts is the only place an ApiError becomes a
// Response), and a temporary write-compat shim for `cmini/1` (below). One
// list of formats, importable both by the Worker and by
// @akl/layout-formats -- never a second one to drift out of sync.
import { unknownFormat } from "../core/errors";
import * as pureRegistry from "../../formats/registry.ts";
import * as cminiAdapter from "../../formats/adapters/cmini/index.ts";
import type { Payload, FormatModule } from "../../formats/registry.ts";

export type { Row, ValidationResult, Held, Payload, ErrBody, EditResult, FormatEdits, FormatModule } from "../../formats/registry.ts";

export const list = pureRegistry.list;
export const registerForTest = pureRegistry.registerForTest;

// LEGACY_WRITABLE (20-spark.md S1, temporary -- S2 deletes it): `cmini/1`
// is no longer a registered `FormatModule` (it moved to the unregistered
// adapter, db/formats/adapters/cmini/), but S1's own bar is "zero
// wire-behaviour change except format listings" -- every existing write
// call site (`core/write.ts:82`, `:487`; `routes/layouts.ts:76`) and every
// existing test must keep accepting a `cmini/1` write exactly as before
// until S2 wires the real `400 format_not_writable`/`unknown_format`
// refusals. This shim answers only the three fields a write call site
// actually uses (`validate`, `hasMagic`, `edits`) -- `to`/`from` are
// deliberately empty (nothing reads them off this shim; the real
// cmini<->spark conversion for READS is `pureRegistry.translate()`'s own
// `adapter:cmini` branch, not this object).
const LEGACY_WRITABLE: Record<string, FormatModule> = {
  "cmini/1": {
    id: "cmini/1",
    owner: cminiAdapter.owner,
    description: cminiAdapter.description,
    schema: cminiAdapter.schema,
    role: "stored",
    validate: cminiAdapter.validate,
    to: {},
    from: {},
    hasMagic: cminiAdapter.hasMagic,
    edits: cminiAdapter.edits,
  },
};

// get(id): resolves a native registered id or an alias (`akl/1` -> the
// spark/1 module) through the pure registry's `resolveFormat`, falling
// back to `LEGACY_WRITABLE` for `cmini/1` only (S1's write-compat shim).
// Every existing call site keeps working unchanged: `getFormat("akl/1")`
// now returns the SAME module `getFormat("spark/1")` does (their payload
// shape is byte-identical, 20-spark.md §1 decision 1), and
// `getFormat("cmini/1")` returns a module whose `validate`/`hasMagic`/
// `edits` are the exact same functions the old registered `cmini/1`
// format used.
export function get(id: string): FormatModule | undefined {
  const resolved = pureRegistry.resolveFormat(id);
  if (resolved) return resolved.module;
  return LEGACY_WRITABLE[id];
}

export type TranslateResult = { payload: Payload } | { held: true; format: string; see?: string };

export function translate(rec: { format: string; payload: Payload }, as: string): TranslateResult {
  const result = pureRegistry.translate(rec, as);
  if ("unknown" in result) {
    throw unknownFormat(as, result.known);
  }
  return result;
}
