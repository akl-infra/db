// Worker-facing wrapper (07 S2; 12 §3 X5 item 1) around the pure registry
// that now lives at db/formats/registry.ts -- the one place its three
// format modules are imported is inside that packaged directory, so this
// file re-exports everything from there and adds the one bit that DOES
// need src/core/errors.ts: turning a pure `{ unknown: true, known }`
// translate result into a thrown ApiError (07 §5's contract for route
// handlers -- `app.onError` in index.ts is the only place an ApiError
// becomes a Response). One list of formats, importable both by the Worker
// and by @akl/layout-formats -- never a second one to drift out of sync.
import { unknownFormat } from "../core/errors";
import * as pureRegistry from "../../formats/registry.ts";
import type { Payload } from "../../formats/registry.ts";

export type { Row, ValidationResult, Held, Payload, ErrBody, EditResult, FormatEdits, FormatModule } from "../../formats/registry.ts";

export const list = pureRegistry.list;
export const get = pureRegistry.get;
export const registerForTest = pureRegistry.registerForTest;

export type TranslateResult = { payload: Payload } | { held: true; format: string; see?: string };

export function translate(rec: { format: string; payload: Payload }, as: string): TranslateResult {
  const result = pureRegistry.translate(rec, as);
  if ("unknown" in result) {
    throw unknownFormat(as, result.known);
  }
  return result;
}
