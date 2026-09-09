// akl/1 -- the common format (01-format.md §2): cmini's `keys` map, #261's
// board geometry, the magic-rules authoring shape, a raw-rule escape hatch,
// and a free-form `x`. Self-contained like cmini/1 (07 §5): no import of
// src/formats/registry.ts, and every local import carries an explicit `.ts`
// extension so scripts/goldens.mjs can resolve this module with plain Node
// ESM (see that script's own comment).
import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import rawSchema from "./schema.json" with { type: "json" };
import {
  computeRows,
  findCollision,
  isSingleChar,
  validateMagicSemantics,
  type AdaptiveSwap,
  type ChiralKey,
  type MagicIntent,
  type MagicKey,
  type RawRule,
} from "./magic.ts";
import { fromCmini, toCmini } from "./translate.ts";
import type { Payload as CminiPayload } from "../../cmini/1/index.ts";

export const id: `${string}/${number}` = "akl/1";
// `GET /v1/formats` (07 §6 S6; registry.ts's FormatModule comment explains
// why this is a plain export rather than parsed from OWNERS/README.md).
export const owner = "DB (+ akl.gg)";
export const description =
  "The common format: cmini's keys map, #261's board geometry, an authoring shape for magic rules, a raw-rule escape hatch, and a free-form x. What akl.gg writes and most clients read.";
export const schema: object = rawSchema;

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
  x?: Record<string, unknown>;
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

const X_MAX_BYTES = 16 * 1024;

// Duplicated from src/core/canonical.ts's algorithm (object keys sorted,
// recursively, no whitespace) rather than imported -- format modules must
// stay resolvable by plain Node ESM (scripts/goldens.mjs), which cannot
// resolve src/core/*'s own extensionless imports (see that script's
// comment).
function canonicalBytes(v: unknown): number {
  function stringify(node: unknown): string {
    if (node === undefined) return "null";
    if (node === null || typeof node !== "object") return JSON.stringify(node);
    if (Array.isArray(node)) return "[" + node.map((item) => (item === undefined ? "null" : stringify(item))).join(",") + "]";
    const obj = node as Record<string, unknown>;
    const keys = Object.keys(obj)
      .filter((k) => obj[k] !== undefined)
      .sort();
    return "{" + keys.map((k) => JSON.stringify(k) + ":" + stringify(obj[k])).join(",") + "}";
  }
  return new TextEncoder().encode(stringify(v)).length;
}

function validateX(x: unknown): SemanticError | null {
  if (x === undefined) return null;
  const bytes = canonicalBytes(x);
  if (bytes > X_MAX_BYTES) {
    return { message: `x is ${bytes} bytes canonical, over the ${X_MAX_BYTES}-byte cap`, path: "/x" };
  }
  return null;
}

// validate: schema -> the ported validateRuleSet rules + 01 §2.1's additions
// (positions, board, magic referencing real keys, `except` single code
// points, `x` size) -> the lower()/collision check (07 §5). Never throws.
export function validate(p: unknown): ValidationResult {
  if (!ajvValidate(p)) {
    const err = ajvValidate.errors?.[0];
    return {
      ok: false,
      error: {
        error: "invalid_payload",
        message: err ? (ajv.errorsText([err], { dataVar: "payload" }) as string) : "invalid akl/1 payload",
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

  const xErr = validateX(payload.x);
  if (xErr) return { ok: false, error: { error: "invalid_payload", message: xErr.message, path: xErr.path } };

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

export function lower(p: Payload): Row[] {
  return computeRows(p.magic, p.keys).map(({ inputs, output, type }) => ({ inputs, output, type }));
}

export function hasMagic(p: Payload): boolean {
  return lower(p).length > 0;
}

export const to: Record<string, (p: Payload) => CminiPayload> = {
  "cmini/1": toCmini,
};
export const from: Record<string, (p: CminiPayload) => Payload> = {
  "cmini/1": fromCmini,
};

// Re-exported so isSingleChar-shaped call sites elsewhere in this format
// (fixtures, magic.ts) don't need a second import path.
export { isSingleChar };
