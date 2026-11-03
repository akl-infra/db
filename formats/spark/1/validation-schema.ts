// The schema spark/1's validators are generated from (scripts/build-validators.mjs writes validate.generated.ts and
// validate-all.generated.ts from it; tests/formats/validators-equivalence.test.ts compiles it at run time and compares). Pure
// data: no ajv import, so the format module never loads ajv.
import rawSchema from "./schema.json" with { type: "json" };

// LDB-F35 (design/layout-db/22-spark-spec.md §6): `export const schema`
// in index.ts is `rawSchema` verbatim -- what `GET /v1/formats/spark/1/
// schema.json` serves, byte-identical to schema.json on disk, pinned by
// `tests/conformance/formats-schema/200.json`. The validator itself
// compiles a separate, never-exported CLONE with ajv's `discriminator`
// keyword added to `magicDefault` (so `chiralValue`, its `$ref`, gets it
// too) -- a hint that changes WHICH oneOf branch ajv reports an error
// from, never which payloads validate (every discriminator branch here
// was already `type: "object"`; `additionalProperties: false` and each
// branch's own `required`/`const` on `kind` already made the branches
// mutually exclusive) or what the served schema document says. Keeping
// this out of schema.json means this row costs no WIRE_VERSION bump and
// touches no conformance fixture -- a client vendoring or diffing the
// served schema sees no change at all.
export function withDiscriminatorHint(s: typeof rawSchema): object {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- schema.json's shape isn't typed; this only ever runs once, over $defs.magicDefault
  const clone = structuredClone(s) as any;
  const magicDefault = clone.$defs.magicDefault;
  magicDefault.type = "object";
  magicDefault.discriminator = { propertyName: "kind" };
  return clone;
}
export const validationSchema = withDiscriminatorHint(rawSchema);
