// spark/1 -- the one stored format (design/layout-db/20-spark.md §1 decision
// 1; was `akl/1`, renamed byte-for-byte -- the payload shape is unchanged).
// cmini's `keys` map, #261's board geometry, the magic-rules authoring
// shape, and a raw-rule escape hatch (21-formats.md D10 dropped the
// free-form `x` field -- there is no cmini export left to round-trip
// through it, and nothing else ever used it). Self-contained (07 §5): no
// import of src/formats/registry.ts, and every local import carries an
// explicit `.ts` extension so scripts/goldens.mjs can resolve this module
// with plain Node ESM (see that script's own comment).
//
// `fromCmini` (the cmini IMPORT) lives at
// `db/formats/adapters/cmini/translate.ts` (20-spark.md S1): cmini is an
// import source now, not a registered format, so the conversion lives with
// the adapter, not here. `toCmini` (the export) was deleted entirely by
// 21-formats.md D5. This format still exports the pure board-word helper
// used to (`cminiBoardWord`, was the private `deriveCminiWord`) -- kept
// because `bot/`'s own board-word reads still call it directly (see that
// module's callers).
import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import rawSchema from "./schema.json" with { type: "json" };
import {
  computeRows,
  findCollision,
  resolveRows,
  isSingleChar,
  validateMagicSemantics,
  type AdaptiveSwap,
  type ChiralKey,
  type MagicIntent,
  type MagicKey,
  type RawRule,
} from "./magic.ts";
// mana2/1's OWN translate.ts is the one place spark/1 <-> mana2/1 is
// implemented (12-implementation-phase5.md §2.5) -- this reciprocal
// registration just re-exports those two functions under spark/1's own
// `to`/`from` maps, the same "one implementation, two registrations"
// pattern this format used for `fromCmini`/`toCmini` before they moved to
// the adapter. No runtime import cycle: mana2/1/translate.ts imports only
// TYPES from this file (erased at compile time), and its one VALUE import
// from this format (`computeRows`) comes from ./magic.ts, not this file.
import { toSpark as mana2ToSpark, fromSpark as mana2FromSpark } from "../../mana2/1/translate.ts";
import type { Payload as Mana2Payload } from "../../mana2/1/index.ts";

export const id: `${string}/${number}` = "spark/1";
// `GET /v1/formats` (07 §6 S6; registry.ts's FormatModule comment explains
// why this is a plain export rather than parsed from OWNERS/README.md).
export const owner = "DB (+ akl.gg)";
export const description =
  "The one stored format: cmini's keys map, #261's board geometry, an authoring shape for magic rules, and a raw-rule escape hatch. What akl.gg writes and most clients read.";
export const schema: object = rawSchema;
export const role: "stored" | "output" = "stored";

export interface Position {
  row: number;
  col: number;
  finger: string;
}

export interface Board {
  kind: "rowstag" | "colstag" | "ortho";
  stagger?: number[];
  cmini?: "stagger" | "angle" | "ortho" | "mini";
}

export type { MagicIntent, MagicKey, ChiralKey, AdaptiveSwap, RawRule };

export interface Payload {
  keys: Record<string, Position>;
  free?: Position[];
  board?: Board;
  magic?: MagicIntent;
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
addFormats(ajv);
const ajvValidate = ajv.compile(rawSchema);

// JSON Pointer escaping (RFC 6901) -- same duplication cmini/1/index.ts
// carries; format modules stay self-contained rather than sharing a helper
// module (07 §5).
function pointerSegment(raw: string): string {
  return raw.replace(/~/g, "~0").replace(/\//g, "~1");
}

interface DupPosition {
  row: number;
  col: number;
  paths: [string, string];
}

// No duplicate positions across `keys` ∪ `free` (01 §2.1).
function findDuplicatePosition(p: Payload): DupPosition | null {
  const seen = new Map<string, string>();
  for (const [ch, pos] of Object.entries(p.keys)) {
    const key = `${pos.row},${pos.col}`;
    const path = `/keys/${pointerSegment(ch)}`;
    const prior = seen.get(key);
    if (prior !== undefined) return { row: pos.row, col: pos.col, paths: [prior, path] };
    seen.set(key, path);
  }
  const free = p.free ?? [];
  for (const [i, pos] of free.entries()) {
    const key = `${pos.row},${pos.col}`;
    const path = `/free/${i}`;
    const prior = seen.get(key);
    if (prior !== undefined) return { row: pos.row, col: pos.col, paths: [prior, path] };
    seen.set(key, path);
  }
  return null;
}

function distinctColumns(p: Payload): number {
  const cols = new Set<number>();
  for (const pos of Object.values(p.keys)) cols.add(pos.col);
  for (const pos of p.free ?? []) cols.add(pos.col);
  return cols.size;
}

interface SemanticError {
  message: string;
  path: string;
}

// board.stagger's length matches its kind; board.cmini (when present) must
// name a word compatible with board.kind (01 §2.1).
function validateBoard(p: Payload): SemanticError | null {
  const board = p.board;
  if (board === undefined) return null;

  if (board.stagger !== undefined) {
    const expected = board.kind === "rowstag" ? 3 : board.kind === "colstag" ? distinctColumns(p) : undefined;
    if (expected !== undefined && board.stagger.length !== expected) {
      return {
        message: `board.stagger must have ${expected} entries for board.kind '${board.kind}', got ${board.stagger.length}`,
        path: "/board/stagger",
      };
    }
  }

  if (board.cmini !== undefined) {
    const word = board.cmini;
    const ok =
      word === "stagger" || word === "angle" ? board.kind === "rowstag" : board.kind === "ortho"; // "ortho" | "mini"
    if (!ok) {
      return { message: `board.cmini '${word}' does not agree with board.kind '${board.kind}'`, path: "/board/cmini" };
    }
  }

  return null;
}

// validate: schema -> the ported validateRuleSet rules + 01 §2.1's additions
// (positions, board, magic referencing real keys, `except` single code
// points) -> the lower()/collision check (07 §5). Never throws. 21-formats
// .md D10 dropped the free-form `x` field (and its byte-cap check,
// `validateX`/`canonicalBytes`, that used to run here) -- the schema's
// `additionalProperties: false` now refuses a payload that carries one.
export function validate(p: unknown): ValidationResult {
  if (!ajvValidate(p)) {
    const err = ajvValidate.errors?.[0];
    return {
      ok: false,
      error: {
        error: "invalid_payload",
        message: err ? (ajv.errorsText([err], { dataVar: "payload" }) as string) : "invalid spark/1 payload",
        path: err?.instancePath || "/",
      },
    };
  }

  const payload = p as unknown as Payload;

  const dupPos = findDuplicatePosition(payload);
  if (dupPos) {
    return {
      ok: false,
      error: {
        error: "invalid_payload",
        message: `duplicate position row ${dupPos.row} col ${dupPos.col} (${dupPos.paths[0]}, ${dupPos.paths[1]})`,
        path: dupPos.paths[1],
      },
    };
  }

  const boardErr = validateBoard(payload);
  if (boardErr) return { ok: false, error: { error: "invalid_payload", message: boardErr.message, path: boardErr.path } };

  const magicErr = validateMagicSemantics(payload.magic, payload.keys);
  if (magicErr) return { ok: false, error: { error: "invalid_payload", message: magicErr.message, path: magicErr.path } };

  const rows = computeRows(payload.magic, payload.keys);
  const collision = findCollision(rows);
  if (collision) {
    return {
      ok: false,
      error: {
        error: "magic_collision",
        message: collision.message,
        inputs: collision.inputs,
        from: collision.from,
        path: collision.path,
        ...(collision.hint ? { hint: collision.hint } : {}),
      },
    };
  }

  return { ok: true };
}

// `lower` renamed `compileMagic` (20-spark.md S1): `lower` left the
// `FormatModule` contract entirely (registry.ts's `role` replaces it), so
// every format's own compile step is now just a named export, not a
// registry-dispatched method. Logic byte-identical to the old `lower()`.
export function compileMagic(p: Payload): Row[] {
  return resolveRows(computeRows(p.magic, p.keys)).map(({ inputs, output, type }) => ({ inputs, output, type }));
}

export function hasMagic(p: Payload): boolean {
  return compileMagic(p).length > 0;
}

// board.cmini wins when present; else derived (01 §6.2): rowstag -> the
// only cmini word for a staggered board is "stagger" (the exact amounts
// aren't distinguishable in cmini's vocabulary either way); ortho and
// colstag -> "ortho" (colstag's stagger amounts are lost); "mini" is
// NEVER derived, only ever carried through an explicit hint. Was the
// private `deriveCminiWord` in translate.ts before fromCmini moved to the
// adapter (20-spark.md S1); stayed exported after `toCmini` (the adapter's
// own caller) was deleted entirely (21-formats.md D5) because `bot/`'s own
// board-word reads (`cache/cells.ts`, `cache/provenance.ts`) call it
// directly.
export function cminiBoardWord(board: Board | undefined): "stagger" | "angle" | "ortho" | "mini" {
  if (board?.cmini) return board.cmini;
  if (board === undefined || board.kind === "ortho" || board.kind === "colstag") return "ortho";
  return "stagger";
}

// spark/1 -> mana2/1 never holds (12 §2.5's held cases are all in the
// mana2 -> spark direction). spark's `to` never listed `cmini/1` (20-spark
// .md S1): cmini was always reached through the unregistered adapter, and
// 21-formats.md D5 deleted that read path entirely -- there is no cmini
// export left at all now.
export const to: Record<string, (p: Payload) => Mana2Payload> = {
  "mana2/1": mana2FromSpark,
};
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const from: Record<string, (p: any) => any> = {
  "mana2/1": mana2ToSpark, // can return `{held:true,...}` -- `from` is never called by registry.ts's translate(), see the import comment above
};

// Re-exported so isSingleChar-shaped call sites elsewhere in this format
// (fixtures, magic.ts) don't need a second import path.
export { isSingleChar };

// registry.ts's optional PATCH slot (09 §3 T4) -- see edits.ts.
export { edits } from "./edits.ts";
