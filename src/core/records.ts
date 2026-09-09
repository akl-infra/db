// Reads of the `layouts` table. `appendWrite` (events.ts) is the only code
// that writes it (07 S4, the onlywriter test) -- this module only SELECTs.
import type { Bindings } from "../env";

export interface RecordRow {
  id: string;
  name: string;
  owner: string;
  rev: number;
  created_at: string;
  modified_at: string;
  deleted: boolean;
  like_count: number;
  has_magic: boolean;
  format: string;
  payload: unknown;
}

// 03 §1: a ref matching this shape is looked up as an id first, then as a
// name; any other ref is a name only. Case-insensitive (upstream ids are
// lowercase, ours are minted uppercase by ulidx).
const ULID_RE = /^[0-7][0-9A-HJKMNP-TV-Z]{25}$/i;
export function isUlidShaped(ref: string): boolean {
  return ULID_RE.test(ref);
}

// The raw `layouts` row shape (D1 stores booleans as 0/1 and the payload as
// a JSON string) -- exported so events.ts and tests can share the mapping
// to/from `RecordRow` instead of re-deriving it.
export interface LayoutDbRow {
  id: string;
  name: string;
  owner: string;
  rev: number;
  created_at: string;
  modified_at: string;
  deleted: number;
  format: string;
  payload_json: string;
  like_count: number;
  has_magic: number;
}

export function rowToRecord(row: LayoutDbRow): RecordRow {
  return {
    id: row.id,
    name: row.name,
    owner: row.owner,
    rev: row.rev,
    created_at: row.created_at,
    modified_at: row.modified_at,
    deleted: row.deleted !== 0,
    like_count: row.like_count,
    has_magic: row.has_magic !== 0,
    format: row.format,
    payload: JSON.parse(row.payload_json) as unknown,
  };
}

export async function readById(db: Bindings["DB"], id: string): Promise<RecordRow | null> {
  const row = await db.prepare("SELECT * FROM layouts WHERE id = ?").bind(id).first<LayoutDbRow>();
  return row === null ? null : rowToRecord(row);
}

export async function readByName(db: Bindings["DB"], name: string): Promise<RecordRow | null> {
  // `name` is COLLATE NOCASE (migrations/0001_init.sql) -- a plain `=`
  // already compares case-insensitively. `deleted = 0` matters here, not
  // just as a filter: a tombstone keeps its literal name (01 §1) so a live
  // record can share a name string with a dead one (layouts_name_live only
  // constrains live rows) -- byName must see the live one and only the live
  // one (LDB-P8: unreadable by name from the moment of deletion).
  const row = await db
    .prepare("SELECT * FROM layouts WHERE name = ? AND deleted = 0")
    .bind(name)
    .first<LayoutDbRow>();
  return row === null ? null : rowToRecord(row);
}

export async function byRef(db: Bindings["DB"], ref: string): Promise<RecordRow | null> {
  if (isUlidShaped(ref)) {
    const byId = await readById(db, ref);
    if (byId !== null) return byId;
  }
  return readByName(db, ref);
}

// Minimal stub: every live record, unfiltered, name order. S6 replaces this
// with owner/format/has_magic/since filters, sort options and keyset
// pagination (07 §6 S6) -- kept here (rather than left unexported) so S6
// extends one function instead of inventing the read path from scratch.
export async function list(db: Bindings["DB"]): Promise<RecordRow[]> {
  const { results } = await db
    .prepare("SELECT * FROM layouts WHERE deleted = 0 ORDER BY name")
    .all<LayoutDbRow>();
  return results.map(rowToRecord);
}

// The public wire shape (01-format.md §1) -- a fresh plain object so
// callers never leak a reference into internal row-reading state.
export function toWire(rec: RecordRow): Record<string, unknown> {
  return {
    id: rec.id,
    name: rec.name,
    owner: rec.owner,
    rev: rec.rev,
    created_at: rec.created_at,
    modified_at: rec.modified_at,
    deleted: rec.deleted,
    like_count: rec.like_count,
    has_magic: rec.has_magic,
    format: rec.format,
    payload: rec.payload,
  };
}
