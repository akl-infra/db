// @akl/layout-formats -- the barrel (12 §3 X5 item 1). Each format is also
// reachable at its own subpath export ("@akl/layout-formats/akl/1", etc,
// package.json's "exports" map) for a consumer that only wants one; this
// module is for a consumer that wants all three, or the registry that
// moves payloads between them without caring which.
export * as cmini1 from "./cmini/1/index.ts";
export * as akl1 from "./akl/1/index.ts";
export * as mana21 from "./mana2/1/index.ts";
export { list, get, translate, registerForTest } from "./registry.ts";
export type {
  Row,
  ValidationResult,
  Held,
  Payload,
  ErrBody,
  EditResult,
  FormatEdits,
  FormatModule,
  TranslateResult,
} from "./registry.ts";
