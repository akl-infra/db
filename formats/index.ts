// @akl/layout-formats -- the barrel (12 §3 X5 item 1). Each registered
// format is also reachable at its own subpath export
// ("@akl/layout-formats/spark/1", etc, package.json's "exports" map) for a
// consumer that only wants one; this module is for a consumer that wants
// all of them, or the registry that moves payloads between them without
// caring which. The cmini adapter (unregistered, 20-spark.md S1) has its
// own subpath ("@akl/layout-formats/adapters/cmini") and no barrel entry
// here -- it isn't part of the registry this barrel mirrors.
export * as spark1 from "./spark/1/index.ts";
export * as mana21 from "./mana2/1/index.ts";
export { list, get, translate, registerForTest, resolveFormat } from "./registry.ts";
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
  ResolvedFormat,
} from "./registry.ts";
