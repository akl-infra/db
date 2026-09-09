// mana2/1 -- a mana2 `.jsonc` layout object (design/layout-db/12-implementation-
// phase5.md §0.4/§2.5/§X2; 01-format.md §4: "mana's own write format").
// Self-contained like every other format module (07 §5): no import of
// src/formats/registry.ts, and every local import carries an explicit
// `.ts` extension so scripts/goldens.mjs can resolve this module with
// plain Node ESM.
//
// This module never reads a raw `.jsonc` FILE -- that is jsonc.ts's job,
// used by scripts/pick-mana2-fixtures.mjs (not at runtime). Every function
// here (`validate`/`lower`/`to`/`from`) takes an ALREADY-PARSED payload,
// exactly like cmini/1 and akl/1.
import Ajv2020 from "ajv/dist/2020.js";
import rawSchema from "./schema.json" with { type: "json" };
import { toAkl, fromAkl, parseRow, dedupeRulesLastWins } from "./translate.ts";
import type { Payload as AklPayload } from "../../akl/1/index.ts";
// mana2/1 -> cmini/1 is the composition through akl/1 (12-implementation-
// phase5.md §2.5: "to['cmini/1'] = p => toCmini(fromMana2(p))"), held
// passed through (a mana2 payload akl/1 can't express obviously can't
// reach cmini/1 either). No import cycle back to THIS file: akl/1/
// translate.ts imports cmini1 as a value, and cmini/1/index.ts imports
// mana2/1/translate.ts (not this file) as a value; nothing in that chain
// imports mana2/1/index.ts except as an erased type.
import { toCmini } from "../../akl/1/translate.ts";
import type { Payload as CminiPayload } from "../../cmini/1/index.ts";

export const id: `${string}/${number}` = "mana2/1";
// `GET /v1/formats` (07 §6 S6; registry.ts's FormatModule comment explains
// why this is a plain export rather than parsed from OWNERS/README.md).
export const owner = "DB maintainers (a mirror of mana2's loader at the vendored submodule commit -- see README.md; Zak's handle added when confirmed, 12 §1)";
export const description =
  "A mana2 .jsonc layout object (layout.fingers/thumbs, board, fingermap, magic.rules) -- mana's own write format. Tap-hold/directional tokens, >5 keys on one thumb, non-empty combos, and rowstag stagger past the 3rd entry disagreeing with it are held for akl/1.";
export const schema: object = rawSchema;

export interface Board {
  isRowStaggered: boolean;
  mirrorLeftRowStagger?: boolean;
  splitAngle?: number;
  rowOrColumnStagger: number[];
}

export interface Rule {
  inputs: string;
  output: string;
}

export interface Magic {
  magicKeys?: string[] | null;
  rules?: Rule[];
}

export interface Combo {
  inputs: string[];
  output: string;
}

export interface Payload {
  layout: {
    fingers: string[];
    thumbs?: string[];
  };
  fingermap: string[];
  board: Board;
  magic?: Magic;
  combos?: Combo[];
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

function invalid(message: string, path: string): SemanticError {
  return { message, path };
}

// Token grammar (core/load_layout.go's tokeniseLayoutFileRow/parseList,
// ported in translate.ts's `parseRow`) + duplicate-key refusal
// ("Duplicate keys are not allowed. If you need them, implement them
// through magic", the loader's own message, verbatim) across
// `layout.fingers` and `layout.thumbs` together (addKeyToLayout's own
// `lettersSeenSoFar` map spans both). A cell's `hold` (the second slot of
// a plain two-word tap-hold) counts too -- addKeyToLayout registers both.
function checkGrammarAndDuplicates(p: Payload): SemanticError | null {
  const seen = new Map<string, string>(); // resolved char -> path of first occurrence
  function claim(char: string, path: string): SemanticError | null {
    const prior = seen.get(char);
    if (prior !== undefined) {
      return invalid("Duplicate keys are not allowed. If you need them, implement them through magic", path);
    }
    seen.set(char, path);
    return null;
  }

  for (let y = 0; y < p.layout.fingers.length; y++) {
    const path = `/layout/fingers/${y}`;
    const parsed = parseRow(p.layout.fingers[y]!);
    if ("message" in parsed) return invalid(parsed.message, path);
    for (const { resolution } of parsed) {
      if (resolution.isSkip) continue;
      if (resolution.tap !== undefined) {
        const err = claim(resolution.tap, path);
        if (err) return err;
      }
      if (resolution.hold !== undefined) {
        const err = claim(resolution.hold, path);
        if (err) return err;
      }
    }
  }

  const thumbs = p.layout.thumbs ?? [];
  for (let h = 0; h < thumbs.length; h++) {
    const path = `/layout/thumbs/${h}`;
    const parsed = parseRow(thumbs[h]!);
    if ("message" in parsed) return invalid(parsed.message, path);
    for (const { resolution } of parsed) {
      if (resolution.isSkip) continue;
      if (resolution.tap !== undefined) {
        const err = claim(resolution.tap, path);
        if (err) return err;
      }
      if (resolution.hold !== undefined) {
        const err = claim(resolution.hold, path);
        if (err) return err;
      }
    }
  }

  return null;
}

// A grouped cell (tap-hold/directional) counts as ONE column, same as the
// real loader's `root.children` indexing -- `cellCount` mirrors that via
// `parseRow`'s own cell list rather than a naive whitespace split.
function cellCount(row: string): number {
  const parsed = parseRow(row);
  return "message" in parsed ? rowTokens(row).length : parsed.length; // grammar errors are caught earlier; this fallback only sizes an already-invalid row
}

// `fingermap.length == fingers.length`; each row's fingermap has >= as
// many entries as the fingers row has CELLS (grouped tokens count once);
// every fingermap entry present is a single digit 0-9 (checked for ALL
// entries, including unused padding -- 0.4: "every entry an integer 0-9").
function checkFingermap(p: Payload): SemanticError | null {
  if (p.fingermap.length !== p.layout.fingers.length) {
    const path = p.fingermap.length < p.layout.fingers.length ? "/fingermap" : "/layout/fingers";
    return invalid(`fingermap has ${p.fingermap.length} row(s), layout.fingers has ${p.layout.fingers.length} -- they must match`, path);
  }
  for (let y = 0; y < p.layout.fingers.length; y++) {
    const cells = cellCount(p.layout.fingers[y]!);
    const digits = rowTokens(p.fingermap[y]);
    if (digits.length < cells) {
      return invalid(
        `fingermap row ${y} has ${digits.length} entr${digits.length === 1 ? "y" : "ies"}, fewer than layout.fingers row ${y}'s ${cells} cell(s)`,
        `/fingermap/${y}`,
      );
    }
    for (const [i, d] of digits.entries()) {
      if (!DIGIT_RE.test(d)) return invalid(`fingermap row ${y} entry ${i} must be a single digit 0-9, got ${JSON.stringify(d)}`, `/fingermap/${y}`);
    }
  }
  return null;
}

// core/load_layout.go's own error text, verbatim (including its trailing
// apostrophe typo in the column-staggered message).
function checkStaggerLength(p: Payload): SemanticError | null {
  const s = p.board.rowOrColumnStagger;
  if (p.board.isRowStaggered) {
    if (s.length < p.layout.fingers.length) {
      return invalid(
        "An error occurred whilst parsing the layout shape.\nFor row staggered layouts the number of entries for `rowOrColumnStagger` must match the height of the layout.",
        "/board/rowOrColumnStagger",
      );
    }
    return null;
  }
  const width = p.layout.fingers.length === 0 ? 0 : Math.max(...p.layout.fingers.map((row) => cellCount(row)));
  if (s.length < width) {
    return invalid(
      "An error occurred whilst parsing the layout shape.\nFor column staggered layouts the number of entries for `rowOrColumnStagger`' must match the width of the layout.",
      "/board/rowOrColumnStagger",
    );
  }
  return null;
}

// combos[{inputs, output}]: every char in `inputs` must be one of this
// layout's own resolved keys (0.4: "every char must be a key").
function checkCombos(p: Payload): SemanticError | null {
  if (!p.combos || p.combos.length === 0) return null;
  const keys = new Set<string>();
  for (let y = 0; y < p.layout.fingers.length; y++) {
    const parsed = parseRow(p.layout.fingers[y]!);
    if ("message" in parsed) continue; // already refused above
    for (const { resolution } of parsed) if (resolution.tap !== undefined) keys.add(resolution.tap);
  }
  for (const thumb of p.layout.thumbs ?? []) {
    const parsed = parseRow(thumb);
    if ("message" in parsed) continue;
    for (const { resolution } of parsed) if (resolution.tap !== undefined) keys.add(resolution.tap);
  }
  for (let i = 0; i < p.combos.length; i++) {
    const combo = p.combos[i]!;
    for (let j = 0; j < combo.inputs.length; j++) {
      const chars = [...combo.inputs[j]!];
      for (const c of chars) {
        if (!keys.has(c)) return invalid(`combos[${i}].inputs[${j}] names ${JSON.stringify(c)}, not one of this layout's keys`, `/combos/${i}/inputs/${j}`);
      }
    }
  }
  return null;
}

// validate: schema (ajv), then 0.4's rules in the loader's own order:
// token grammar + duplicate keys, fingermap shape, stagger length, combo
// chars. Never throws.
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

  const grammarErr = checkGrammarAndDuplicates(payload);
  if (grammarErr) return { ok: false, error: { error: "invalid_payload", message: grammarErr.message, path: grammarErr.path } };

  const fingermapErr = checkFingermap(payload);
  if (fingermapErr) return { ok: false, error: { error: "invalid_payload", message: fingermapErr.message, path: fingermapErr.path } };

  const staggerErr = checkStaggerLength(payload);
  if (staggerErr) return { ok: false, error: { error: "invalid_payload", message: staggerErr.message, path: staggerErr.path } };

  const comboErr = checkCombos(payload);
  if (comboErr) return { ok: false, error: { error: "invalid_payload", message: comboErr.message, path: comboErr.path } };

  return { ok: true };
}

// lower(p) = magic.rules deduped last-wins (mana2's own load-time
// semantics -- a later rule with the same `inputs` replaces the earlier
// one), every row tagged "raw" (mana2's rule shape carries no type at
// all).
export function lower(p: Payload): Row[] {
  const rules = dedupeRulesLastWins(p.magic?.rules ?? []);
  return rules.map((r) => ({ inputs: r.inputs, output: r.output, type: "raw" }));
}

export function hasMagic(p: Payload): boolean {
  return lower(p).length > 0;
}

type HeldResult = { held: true; reason: string };

export const to: Record<string, (p: Payload) => AklPayload | CminiPayload | HeldResult> = {
  "akl/1": toAkl,
  "cmini/1": (p) => {
    const akl = toAkl(p);
    if ((akl as HeldResult).held === true) return akl as HeldResult;
    return toCmini(akl as AklPayload);
  },
};
export const from: Record<string, (p: AklPayload) => Payload> = {
  "akl/1": fromAkl,
};

// registry.ts's optional PATCH slot (09 §3 T4) -- see edits.ts.
// `setFingermap` only: `setBoard`/`setMagic` are `unsupported_for_format`
// (12 §2.5's decision #9 -- a mana user edits the file, not the API).
export { edits } from "./edits.ts";
