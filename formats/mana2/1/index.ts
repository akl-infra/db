// mana2/1 -- a mana2 `.jsonc` layout object (01-format.md §4: "mana's own
// write format", federation §13). `layout.fingers`/`thumbs` row strings,
// `board.isRowStaggered`/`rowOrColumnStagger` geometry, `fingermap` finger
// digits, an optional flat `magic.rules[]`. Self-contained like every other
// format module (07 §5): no import of src/formats/registry.ts, and every
// local import carries an explicit `.ts` extension so scripts/goldens.mjs
// can resolve this module with plain Node ESM.
//
// This module never reads a raw `.jsonc` FILE -- that is jsonc.ts's job,
// used once (by a fixture-authoring step, not at runtime) to turn
// vendor/mana2/data/layouts/*.jsonc into this format's own JSON fixtures.
// Every function here (`validate`/`lower`/`to`/`from`) takes an
// ALREADY-PARSED payload, exactly like cmini/1 and akl/1.
import Ajv2020 from "ajv/dist/2020.js";
import rawSchema from "./schema.json" with { type: "json" };
import { toAkl, fromAkl } from "./translate.ts";
import type { Payload as AklPayload } from "../../akl/1/index.ts";

export const id: `${string}/${number}` = "mana2/1";
// `GET /v1/formats` (07 §6 S6; registry.ts's FormatModule comment explains
// why this is a plain export rather than parsed from OWNERS/README.md).
export const owner = "Zak (mana2)";
export const description =
  "A mana2 .jsonc layout object (layout.fingers/thumbs, board, fingermap, magic.rules) -- mana's own write format. Layers/combos are todo in mana2's own spec.";
export const schema: object = rawSchema;

export interface Board {
  isRowStaggered?: boolean;
  mirrorLeftRowStagger?: boolean;
  splitAngle?: number;
  rowOrColumnStagger?: number[];
}

export interface Rule {
  inputs: string;
  output: string;
}

export interface Magic {
  magicKeys?: string[] | null;
  rules?: Rule[];
}

export interface Payload {
  layout: {
    fingers: string[];
    thumbs?: string[];
  };
  fingermap: string[];
  board: Board;
  magic?: Magic;
  layers?: unknown;
}

export interface Row {
  inputs: string;
  output: string;
  type?: string;
}

export interface ErrBody {
  error: string;
  message: string;
  [extra: string]: unknown;
}

export type ValidationResult = { ok: true } | { ok: false; error: ErrBody };

const ajv = new Ajv2020({ allErrors: false, strict: true });
const ajvValidate = ajv.compile(rawSchema);

function rowTokens(row: string | undefined): string[] {
  return (row ?? "").trim().split(/\s+/).filter((t) => t.length > 0);
}

const DIGIT_RE = /^[0-9]$/;

interface SemanticError {
  message: string;
  path: string;
}

// fingers/fingermap row-shape agreement (07 §1 X2's brief), refined against
// the real vendored corpus (translate.ts's own header comment has the full
// evidence): a fingermap row must have AT LEAST as many tokens as its
// fingers row (extra trailing entries are unused padding, never a
// shortfall -- five real vendored files rely on exactly this: cyclone row
// 2, knightest/standlight row 1, nystyc row 2, vigil row 2), and every
// fingermap token actually consulted (the first `fingers.length` of them)
// must be a single digit 0-9. `d5.jsonc` -- the one vendored fixture using
// mana2's undocumented tap-hold/directional mini-language -- fails this
// check (its row 0 has 14 fingers tokens against 10 fingermap tokens, the
// opposite direction from the five real shortfalls above): a genuine,
// expected refusal, not a bug (README.md "What it can't express").
function checkRowShapes(p: Payload): SemanticError | null {
  const fingers = p.layout.fingers;
  const fingermap = p.fingermap;
  if (fingermap.length !== fingers.length) {
    // Blame whichever array has FEWER rows (the one a delete mutation
    // actually shrank) -- deterministic and symmetric: deleting a
    // `layout.fingers` row blames `/layout/fingers`, deleting a
    // `fingermap` row blames `/fingermap`, matching mutations.test.ts's
    // generic "path is the mutated leaf or its immediate parent" check
    // for either direction.
    const path = fingermap.length < fingers.length ? "/fingermap" : "/layout/fingers";
    return {
      message: `fingermap has ${fingermap.length} row(s), layout.fingers has ${fingers.length} -- they must match`,
      path,
    };
  }
  for (let r = 0; r < fingers.length; r++) {
    const toks = rowTokens(fingers[r]);
    const fmToks = rowTokens(fingermap[r]);
    if (fmToks.length < toks.length) {
      return {
        message: `fingermap row ${r} has ${fmToks.length} entr${fmToks.length === 1 ? "y" : "ies"}, fewer than layout.fingers row ${r}'s ${toks.length} token(s)`,
        path: `/fingermap/${r}`,
      };
    }
    for (const [i, tok] of fmToks.entries()) {
      if (!DIGIT_RE.test(tok)) {
        return { message: `fingermap row ${r} entry ${i} must be a single digit 0-9, got ${JSON.stringify(tok)}`, path: `/fingermap/${r}` };
      }
    }
  }
  return null;
}

// No character (from `layout.fingers`, or the "skip" keyword excepted, or
// `layout.thumbs`) may be used at more than one position -- mirrors
// core/load_layout.go's own `lettersSeenSoFar` uniqueness map (addKeyToLayout
// refuses to add a second key for a rune already seen).
function checkDuplicateChars(p: Payload): SemanticError | null {
  const seen = new Map<string, string>(); // token -> first path it appeared at
  const fingers = p.layout.fingers;
  for (let r = 0; r < fingers.length; r++) {
    const toks = rowTokens(fingers[r]);
    for (let c = 0; c < toks.length; c++) {
      const tok = toks[c]!;
      if (tok === "skip") continue;
      const path = `/layout/fingers/${r}`;
      const prior = seen.get(tok);
      if (prior !== undefined) return { message: `duplicate char ${JSON.stringify(tok)} (first at ${prior}, again at ${path})`, path };
      seen.set(tok, path);
    }
  }
  const thumbs = p.layout.thumbs ?? [];
  for (let h = 0; h < thumbs.length; h++) {
    const toks = rowTokens(thumbs[h]);
    for (const tok of toks) {
      if (tok === "skip") continue;
      const path = `/layout/thumbs/${h}`;
      const prior = seen.get(tok);
      if (prior !== undefined) return { message: `duplicate char ${JSON.stringify(tok)} (first at ${prior}, again at ${path})`, path };
      seen.set(tok, path);
    }
  }
  return null;
}

// No two `magic.rules[]` entries may share `inputs` -- otherwise which one
// fires is ambiguous. cmini/1 refuses the same thing on its own flat
// `magic[]` list (07-implementation-phase1.md §5.1); mana2's rule shape is
// the same "flat list keyed by inputs" idiom, so the same rule applies.
// Named the SECOND occurrence, matching cmini/1's own convention.
function checkDuplicateMagicInputs(p: Payload): SemanticError | null {
  const rules = p.magic?.rules ?? [];
  const seen = new Map<string, number>();
  for (let i = 0; i < rules.length; i++) {
    const inputs = rules[i]!.inputs;
    const prior = seen.get(inputs);
    if (prior !== undefined) {
      return {
        message: `duplicate magic.rules inputs ${JSON.stringify(inputs)} (first at /magic/rules/${prior}/inputs, again at /magic/rules/${i}/inputs)`,
        path: `/magic/rules/${i}/inputs`,
      };
    }
    seen.set(inputs, i);
  }
  return null;
}

// validate: schema (ajv), then the row-shape agreement above, then
// duplicate-char and duplicate-magic-inputs refusal. Never throws.
export function validate(p: unknown): ValidationResult {
  if (!ajvValidate(p)) {
    const err = ajvValidate.errors?.[0];
    return {
      ok: false,
      error: {
        error: "invalid_payload",
        message: err ? (ajv.errorsText([err], { dataVar: "payload" }) as string) : "invalid mana2/1 payload",
        path: err?.instancePath || "/",
      },
    };
  }

  const payload = p as unknown as Payload;

  const shapeErr = checkRowShapes(payload);
  if (shapeErr) return { ok: false, error: { error: "invalid_payload", message: shapeErr.message, path: shapeErr.path } };

  const dupErr = checkDuplicateChars(payload);
  if (dupErr) return { ok: false, error: { error: "invalid_payload", message: dupErr.message, path: dupErr.path } };

  const dupMagicErr = checkDuplicateMagicInputs(payload);
  if (dupMagicErr) return { ok: false, error: { error: "invalid_payload", message: dupMagicErr.message, path: dupMagicErr.path } };

  return { ok: true };
}

// lower(p) = p.magic?.rules ?? [], every row tagged "raw" -- mana2's own
// rule shape ({inputs, output}) carries no type at all (01-format.md §2's
// vocabulary reserves "raw" for exactly this: an escape-hatch row with no
// idiom behind it).
export function lower(p: Payload): Row[] {
  const rules = p.magic?.rules ?? [];
  return rules.map((r) => ({ inputs: r.inputs, output: r.output, type: "raw" }));
}

export function hasMagic(p: Payload): boolean {
  return lower(p).length > 0;
}

export const to: Record<string, (p: Payload) => AklPayload> = {
  "akl/1": toAkl,
};
export const from: Record<string, (p: AklPayload) => Payload> = {
  "akl/1": fromAkl,
};
