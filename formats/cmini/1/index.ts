// cmini/1 -- cmini's v3 layout detail, minus the record fields (07 §5.1).
// This is the bot's own shape: `keys`/`free`/`magic`/`combos`/`tag`/`blame`
// are kept verbatim, `link` stays in the payload for import fidelity only
// (it is never a record field and no verb reads it). The format's job is to
// hold what cmini holds -- no thumb-row rule, no non-empty-keys rule, both
// violated by live data (07 §0.1).
import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import rawSchema from "./schema.json" with { type: "json" };

export const id: `${string}/${number}` = "cmini/1";
export const schema: object = rawSchema;

export interface Position {
  row: number;
  col: number;
  finger: string;
}

export interface MagicRow {
  inputs: string;
  output: string;
  type?: string;
}

export interface Combo {
  inputs: string;
  output: string;
}

export interface Payload {
  board: "stagger" | "angle" | "ortho" | "mini";
  keys: Record<string, Position>;
  free?: Position[];
  magic?: MagicRow[];
  combos?: Combo[];
  tag?: string;
  blame?: string;
  link?: string;
}

// The format-module contract (07 §5) is self-contained: no import of
// src/formats/registry.ts here (that would be the boundary the wrong way
// round). Row/Held/ValidationResult are structurally the same shapes the
// registry declares.
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

// JSON Pointer escaping (RFC 6901): "~" -> "~0", "/" -> "~1". Needed because
// cmini keys include "/" and "~"-adjacent punctuation as characters (e.g.
// graphite's "/" key), and those become path *segments* below.
function pointerSegment(raw: string): string {
  return raw.replace(/~/g, "~0").replace(/\//g, "~1");
}

interface DupPosition {
  row: number;
  col: number;
  paths: [string, string];
}

// No duplicate positions across `keys` ∪ `free` (07 §5.1). Iterates `keys`
// in object order then `free` in array order, so the reported pair is
// always (first occurrence, first repeat) -- deterministic for a given
// payload regardless of which one looks like "the duplicate".
function findDuplicatePosition(p: Payload): DupPosition | null {
  const seen = new Map<string, string>(); // "row,col" -> path of first occurrence
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

interface DupMagicInputs {
  inputs: string;
  paths: [string, string];
}

// No duplicate `magic[].inputs` (07 §5.1).
function findDuplicateMagicInputs(p: Payload): DupMagicInputs | null {
  const magic = p.magic ?? [];
  const seen = new Map<string, string>(); // inputs -> path of first occurrence
  for (const [i, row] of magic.entries()) {
    const path = `/magic/${i}/inputs`;
    const prior = seen.get(row.inputs);
    if (prior !== undefined) return { inputs: row.inputs, paths: [prior, path] };
    seen.set(row.inputs, path);
  }
  return null;
}

// validate: schema first (ajv), then the two semantic rules 07 §5.1 states
// -- nothing else. Never throws.
export function validate(p: unknown): ValidationResult {
  if (!ajvValidate(p)) {
    const err = ajvValidate.errors?.[0];
    return {
      ok: false,
      error: {
        error: "invalid_payload",
        message: err
          ? (ajv.errorsText([err], { dataVar: "payload" }) as string)
          : "invalid cmini/1 payload",
        path: err?.instancePath || "/",
      },
    };
  }

  // `ajvValidate` narrows `p` from the imported schema.json's inferred JSON
  // shape, not our hand-written Payload interface -- the two structurally
  // agree (that's the whole point of the schema) but TS can't see it.
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

  const dupMagic = findDuplicateMagicInputs(payload);
  if (dupMagic) {
    return {
      ok: false,
      error: {
        error: "invalid_payload",
        message: `duplicate magic inputs '${dupMagic.inputs}' (${dupMagic.paths[0]}, ${dupMagic.paths[1]})`,
        path: dupMagic.paths[1],
      },
    };
  }

  return { ok: true };
}

// lower(p) = p.magic ?? [], typed rows default to "raw" (07 §5.1). cmini/1
// always has a magic concept (never null -- that's for a format with none).
export function lower(p: Payload): Row[] {
  const magic = p.magic ?? [];
  return magic.map((row) => ({ inputs: row.inputs, output: row.output, type: row.type ?? "raw" }));
}

export function hasMagic(p: Payload): boolean {
  return lower(p).length > 0;
}

// S3 fills these in (akl/1, 01 §6.1/§6.2). Empty for now: the registry's
// translate() reads a missing `to[as]` as "held", which is exactly right
// until the translation exists.
export const to: Record<string, (p: Payload) => Payload> = {};
export const from: Record<string, (p: Payload) => Payload> = {};

// The record-level projection used by `?as=cmini/1`, the D12 diff and the
// `full=1` list (07 §5.1). Likes are emitted sorted ascending, never in
// upstream's insertion order -- the D12 diff sorts upstream's the same way
// before comparing.
export interface CminiRecordLike {
  name: string;
  owner: string;
  created_at: string;
  modified_at: string;
  likes: string[];
  payload: Payload;
}

export interface CminiDetail {
  name: string;
  user: string;
  board: Payload["board"];
  tag?: string;
  blame?: string;
  created_at: string;
  modified_at: string;
  likes: string[];
  keys: Record<string, Position>;
  free?: Position[];
  magic?: MagicRow[];
  combos?: Combo[];
  link?: string;
}

export function project(record: CminiRecordLike): CminiDetail {
  const p = record.payload;
  const detail: CminiDetail = {
    name: record.name,
    user: record.owner,
    board: p.board,
    created_at: record.created_at,
    modified_at: record.modified_at,
    likes: [...record.likes].sort(),
    keys: p.keys,
  };
  if (p.tag !== undefined) detail.tag = p.tag;
  if (p.blame !== undefined) detail.blame = p.blame;
  if (p.free !== undefined) detail.free = p.free;
  if (p.magic !== undefined) detail.magic = p.magic;
  if (p.combos !== undefined) detail.combos = p.combos;
  if (p.link !== undefined) detail.link = p.link;
  return detail;
}

// Named alias -- 07 §6 S2 calls it `cminiDetail` in prose, `project` in the
// generic-test vocabulary (S3's roundtrip.test.ts). Both names, one function.
export { project as cminiDetail };
