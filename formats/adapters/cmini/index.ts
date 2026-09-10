// The cmini adapter (was the registered format `cmini/1`; moved out of
// db/formats/ 's registry by 20-spark.md S1 -- decision 2, "cmini is an
// import source, not a format"). cmini's v3 layout detail, minus the
// record fields (07 §5.1): `keys`/`free`/`magic`/`combos`/`tag`/`blame` are
// kept verbatim, `link` stays in the payload for import fidelity only (it
// is never a record field and no verb reads it). The adapter's job is to
// hold what cmini holds -- no thumb-row rule, no non-empty-keys rule, both
// violated by live data (07 §0.1). NOT in `db/formats/registry.ts`'s
// `REGISTRY`: the Worker's `LEGACY_WRITABLE` shim (`db/src/formats/
// registry.ts`, temporary through S2) is what still accepts a `cmini/1`
// write in S1; every read of a `cmini/1`-stored row goes through
// `storedAsSpark`/`fromCmini`, never this module directly.
import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import rawSchema from "./schema.json" with { type: "json" };
// This file's own translate.ts is the ONE place cmini<->spark/1 is
// implemented (moved from spark/1/translate.ts by 20-spark.md S1, was
// 07 §6 S3's akl/1/translate.ts), so both directions can't drift apart.
// This creates a module cycle (translate.ts imports this file back for
// `cmini1.rows`/`Payload`) that's safe here: `fromCmini`/`toCmini` are
// function declarations (hoisted before either module's top-level code
// runs) and are only ever CALLED well after both modules finish loading.
import { fromCmini, toCmini } from "./translate.ts";
import type { Payload as SparkPayload } from "../../spark/1/index.ts";
// cmini <-> mana2/1 is the composition through spark/1 (12-implementation-
// phase5.md §2.5), never a third direct implementation. This direction
// (cmini -> spark -> mana2) never holds -- spark/1 -> mana2/1 has no held
// cases (12 §2.5's held rows are all mana2 -> spark) -- so, unlike the
// reverse direction (mana2/1/index.ts's own `to["cmini/1"]`), no
// held-passthrough is needed here. No import cycle: mana2/1/translate.ts
// imports nothing from this file.
import { fromSpark as mana2FromSpark } from "../../mana2/1/translate.ts";
import type { Payload as Mana2Payload } from "../../mana2/1/index.ts";

export const id: `${string}/${number}` = "cmini/1";
// `GET /v1/formats` (07 §6 S6; registry.ts's FormatModule comment explains
// why this is a plain export rather than parsed from OWNERS/README.md).
export const owner = "DB";
export const description =
  "cmini's v3 detail JSON verbatim minus the record fields (name/user/likes/created_at/modified_at): board keys free? magic? combos? tag? blame? link?";
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

// rows(p) = p.magic ?? [], typed rows default to "raw" (07 §5.1). cmini
// always has a magic concept (never null -- that's for a format with
// none). Was `lower` -- renamed the same way spark/1's own compile step
// was (20-spark.md S1): `lower` left the `FormatModule` contract, and this
// module isn't in that contract at all anymore, but the rename keeps the
// same word meaning the same thing everywhere in db/formats/.
export function rows(p: Payload): Row[] {
  const magic = p.magic ?? [];
  return magic.map((row) => ({ inputs: row.inputs, output: row.output, type: row.type ?? "raw" }));
}

export function hasMagic(p: Payload): boolean {
  return rows(p).length > 0;
}

// 01 §6.1/§6.2, implemented once in this directory's own translate.ts and
// imported both ways (moved from akl/1/translate.ts by 20-spark.md S1) so
// cmini<->spark/1 can't drift out of sync with itself. Not a `FormatModule`
// `to`/`from` map (this adapter isn't registered) -- kept as plain named
// exports purely so existing call sites (`goldens.mjs`, `mana2-convert-
// parity.test.ts`, `roundtrip.test.ts`) don't need restructuring, keyed by
// spark/1's real id now instead of the old alias-shaped "akl/1".
export const to: Record<string, (p: Payload) => SparkPayload | Mana2Payload> = {
  "spark/1": fromCmini, // cmini -> spark IS §6.1's "fromCmini"
  "mana2/1": (p) => mana2FromSpark(fromCmini(p)), // 12 §2.5's declared composition; never held (see the import comment above)
};
export const from: Record<string, (p: SparkPayload) => Payload> = {
  "spark/1": toCmini, // spark -> cmini IS §6.2's "toCmini"
};

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

// LDB-I10/I11 (M1, design/layout-db/17-magic-ownership.md §3): the same
// projection with `magic` dropped -- what the import's change detection
// (`import/apply.ts`) and the D12 diff (`import/diff.ts`) compare on BOTH
// sides, so neither upstream's magic (never akl.gg's) nor a record's own
// magic (nothing today; akl.gg's rules, once M2 lands) is ever mistaken for
// a content difference. A thin wrapper around `project()` rather than a
// second projection function, so the two can't drift apart on anything but
// this one field.
export function projectNoMagic(record: CminiRecordLike): Omit<CminiDetail, "magic"> {
  const { magic: _magic, ...rest } = project(record);
  return rest;
}

// registry.ts's optional PATCH slot (09 §3 T4) -- see edits.ts. No
// `setMagic`: cmini/1 has no magic idiom of its own (03 §3).
export { edits } from "./edits.ts";
