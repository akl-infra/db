// Reads of `layouts` and `layout_formats` (21-formats.md F2, §2.1). Only
// `core/events.ts`'s `commitWrite`/`appendLike` write these tables (LDB-P1,
// the onlywriter test) -- this module only SELECTs.
import type { Bindings } from "../env";
import { toStore, type StoreArg } from "../store/arg";

// 20-spark.md S3a (decision 5, LDB-I14), restated by 21-formats.md §2.2:
// follow state is LAYOUT-level (name/owner/deletion and lineage `spark`
// together) -- it lives on `layouts`, never on a `layout_formats` row.
export type UpstreamState = "following" | "forked";

export interface Upstream {
  source: "cmini";
  id: string; // the upstream (cmini) id, as text
  state: UpstreamState;
}

// 20-spark.md S3s (decision 14, LDB-P15), restated by 21-formats.md §2.2:
// who/what made the latest write TO THIS SCOPE -- `layouts.source_*` is the
// latest layout-scope write's source; each `layout_formats` row carries its
// OWN `source_*`, the latest write to that format.
export interface Source {
  client: string;
  version: string | null;
}

// The layout identity (D3): name, owner, likes, deletion, cmini follow
// state. Never carries a payload -- a layout's payloads live in its
// `layout_formats` rows (`FormatRow`, below).
export interface LayoutRow {
  id: string;
  name: string;
  owner: string;
  // `n`: the internal write counter (migrations/0009_formats.sql) --
  // never serialized to the wire (`layoutToWire` below omits it); carried
  // on this internal type because `core/write.ts` needs it to build the
  // next commit's `CommitInput`.
  n: number;
  layout_rev: number;
  created_at: string;
  modified_at: string;
  deleted: boolean;
  // H24 (2026-09-13): `like_count` is ONLY `COUNT(DISTINCT user_id) FROM
  // likes` for this layout -- mods cannot override it (the admin
  // `like_adjust` override shipped in L5 was removed; see db/README.md).
  like_count: number;
  // §4.4 (LDB-MD3/MD5): the layout's APPROVED link, or null. Folded from
  // the latest `link_approved`/`link_cleared` event -- a pending/rejected/
  // superseded submission never reaches this field.
  link: string | null;
  upstream: Upstream | null;
  source: Source | null;
}

// One `layout_formats` row: a layout's payload under one lineage, at
// whatever major it's currently stored at (`format`, e.g. `spark/1`).
export interface FormatRow {
  layout_id: string;
  lineage: string;
  format: string;
  rev: number;
  created_at: string;
  modified_at: string;
  payload: unknown;
  has_magic: boolean;
  // design/alts/07-format.md: beside `has_magic`, same convention (a
  // stored, per-write-recomputed summary of the payload's own content --
  // never trusted from a client, always `module.hasAlts?.(payload) ??
  // false` / `hasCombos`).
  has_alts: boolean;
  has_combos: boolean;
  source: Source | null;
}

// 03 §1: a ref matching this shape is looked up as an id first, then as a
// name; any other ref is a name only. Case-insensitive (upstream ids are
// lowercase, ours are minted uppercase by ulidx).
const ULID_RE = /^[0-7][0-9A-HJKMNP-TV-Z]{25}$/i;
export function isUlidShaped(ref: string): boolean {
  return ULID_RE.test(ref);
}

// The raw `layouts` row shape (D1 stores booleans as 0/1) -- exported so
// events.ts/dump and tests can share the mapping to/from `LayoutRow`.
// `n` is the internal write counter (migrations/0009_formats.sql) --
// deliberately NOT part of `LayoutRow`: it never leaves this module and
// `core/events.ts` (the only other reader, for the concurrency guard).
export interface LayoutDbRow {
  id: string;
  name: string;
  owner: string;
  n: number;
  layout_rev: number;
  created_at: string;
  modified_at: string;
  deleted: number;
  like_count: number;
  // H24: physically still on the `layouts` table (migrations/0015, a dead
  // column left in place -- SQLite can't drop it in D1 reliably) but no
  // code reads or writes it any more; deliberately absent from `LayoutRow`.
  like_adjust: number;
  link: string | null;
  upstream_source: string | null;
  upstream_id: string | null;
  upstream_state: string | null;
  source_client: string | null;
  source_version: string | null;
}

export interface FormatDbRow {
  layout_id: string;
  lineage: string;
  format: string;
  rev: number;
  created_at: string;
  modified_at: string;
  payload_json: string;
  has_magic: number;
  has_alts: number;
  has_combos: number;
  source_client: string | null;
  source_version: string | null;
}

export function upstreamFromRow(row: {
  upstream_source: string | null | undefined;
  upstream_id: string | null | undefined;
  upstream_state: string | null | undefined;
}): Upstream | null {
  const source = row.upstream_source ?? null;
  if (source === null) return null;
  return { source: source as "cmini", id: row.upstream_id ?? "", state: (row.upstream_state ?? "following") as UpstreamState };
}

export function sourceFromRow(row: { source_client: string | null | undefined; source_version: string | null | undefined }): Source | null {
  const client = row.source_client ?? null;
  if (client === null) return null;
  return { client, version: row.source_version ?? null };
}

export function rowToLayout(row: LayoutDbRow): LayoutRow {
  return {
    id: row.id,
    name: row.name,
    owner: row.owner,
    n: row.n,
    layout_rev: row.layout_rev,
    created_at: row.created_at,
    modified_at: row.modified_at,
    deleted: row.deleted !== 0,
    like_count: row.like_count,
    link: row.link,
    upstream: upstreamFromRow(row),
    source: sourceFromRow(row),
  };
}

export function rowToFormat(row: FormatDbRow): FormatRow {
  return {
    layout_id: row.layout_id,
    lineage: row.lineage,
    format: row.format,
    rev: row.rev,
    created_at: row.created_at,
    modified_at: row.modified_at,
    payload: JSON.parse(row.payload_json) as unknown,
    has_magic: row.has_magic !== 0,
    has_alts: row.has_alts !== 0,
    has_combos: row.has_combos !== 0,
    source: sourceFromRow(row),
  };
}

export async function readById(dbArg: StoreArg, id: string): Promise<LayoutRow | null> {
  return toStore(dbArg).layouts.byId(id);
}

export async function readByName(dbArg: StoreArg, name: string): Promise<LayoutRow | null> {
  return toStore(dbArg).layouts.byName(name);
}

export async function byRef(dbArg: StoreArg, ref: string): Promise<LayoutRow | null> {
  return toStore(dbArg).layouts.byRef(ref);
}

// Every `layout_formats` row a layout has, lineage-keyed.
export async function formatsForLayout(dbArg: StoreArg, layoutId: string): Promise<Map<string, FormatRow>> {
  return toStore(dbArg).layouts.formatsForLayout(layoutId);
}

// Coordinator review (H1): the list route (plain and `full=1` alike) must
// show EVERY stored format a layout has in its `formats` map, not just the
// one lineage the request's `?format=` happened to join on for filtering
// -- a layout with a second stored lineage (the test-only second lineage,
// or a real future `lw/1`) must show BOTH in `formats` on every row. One
// batched `IN (...)` query per PAGE (chunked the same way
// `likers` already batches likes), never one query per layout.
export async function formatsForLayouts(dbArg: StoreArg, layoutIds: string[]): Promise<Map<string, Map<string, FormatRow>>> {
  return toStore(dbArg).layouts.formatsForLayouts(layoutIds);
}

export async function readFormat(dbArg: StoreArg, layoutId: string, lineage: string): Promise<FormatRow | null> {
  return toStore(dbArg).layouts.readFormat(layoutId, lineage);
}


// 21-formats.md §2.3: "A GET reads the layouts row and the format row in
// ONE statement, so the two revs it returns are one snapshot" (LDB-B65
// depends on this). One JOIN, one D1 round trip, however many formats the
// layout has (zero rows back for `formats` iff the layout somehow has none
// -- MF-5 says that never happens for a live write path, but a very old
// dump/restore edge case shouldn't crash a read).
export interface LayoutWithFormats {
  layout: LayoutRow;
  formats: Map<string, FormatRow>; // keyed by lineage
}

export async function readByIdWithFormats(dbArg: StoreArg, id: string): Promise<LayoutWithFormats | null> {
  return toStore(dbArg).layouts.byIdWithFormats(id);
}

export async function readByNameWithFormats(dbArg: StoreArg, name: string): Promise<LayoutWithFormats | null> {
  return toStore(dbArg).layouts.byNameWithFormats(name);
}

export async function byRefWithFormats(dbArg: StoreArg, ref: string): Promise<LayoutWithFormats | null> {
  return toStore(dbArg).layouts.byRefWithFormats(ref);
}


// `GET /v1/layouts?format=F`'s sort options (03 §2): `name` is the only
// ascending one (case-insensitive, the column's own COLLATE); the other
// three are all descending.
export type SortKey = "name" | "modified_at" | "created_at" | "like_count";
export interface ListCursor {
  sortValue: string | number;
  id: string;
}

// 21-formats.md §2.4: every list read names a format. `sourceLineage` is
// the lineage whose `layout_formats` row actually backs this read -- equal
// to `lineage(format)` when `format` is stored, or the ONE registered
// stored lineage that reaches it when `format` is an output format
// (`formats/registry.ts`'s `outputSourceLineage`, resolved by the caller).
export interface ListParams {
  sourceLineage: string;
  owner?: string;
  hasMagic?: boolean;
  // design/alts/07-format.md: `?has_alts=`/`?has_combos=`, mirroring
  // `?has_magic=` exactly (same column family, same filter shape).
  hasAlts?: boolean;
  hasCombos?: boolean;
  since?: string; // max(layouts.modified_at, format.modified_at) > since
  likedBy?: string;
  sort: SortKey;
  limit: number;
  cursor?: ListCursor;
  // Coordinator review (LOW, third batch): the plain list (no payload in
  // its own wire shape, H1) doesn't need this query to fetch or parse
  // `payload_json` at all UNLESS the caller could actually need to
  // translate a row (an older major of a chained lineage, or an output
  // format) -- routes/layouts.ts's plain-list handler passes `false` only
  // when it can PROVE, from the registry alone (no DB read), that no row
  // in the result can possibly need it. Defaults to `true` (unset ==
  // fetch it) so `?full=1`'s own call, which always needs the payload, is
  // unaffected.
  withPayload?: boolean;
}

export interface ListItem {
  layout: LayoutRow;
  format: FormatRow; // the source lineage's own stored row (translated to the requested format by the caller)
}

export interface ListPage {
  items: ListItem[];
  nextCursor: string | null;
}

export function encodeCursor(cursor: ListCursor): string {
  return btoa(JSON.stringify([cursor.sortValue, cursor.id]));
}

export function decodeCursor(raw: string): ListCursor | null {
  try {
    const parsed: unknown = JSON.parse(atob(raw));
    if (!Array.isArray(parsed) || parsed.length !== 2) return null;
    const [sortValue, id] = parsed as [unknown, unknown];
    if ((typeof sortValue !== "string" && typeof sortValue !== "number") || typeof id !== "string") return null;
    return { sortValue, id };
  } catch {
    return null;
  }
}

// Filtered, sorted, keyset-paginated live layouts that have `sourceLineage`
// stored (`deleted = 0` always -- tombstones never appear in a list).
export async function list(dbArg: StoreArg, params: ListParams): Promise<ListPage> {
  return toStore(dbArg).layouts.list(params);
}

// The public wire shape for a layout's own fields (21-formats.md §2.3) --
// everything EXCEPT `formats`/`format`/`payload`/`derived_from`, which
// depend on what was requested and are added by the caller.
export function layoutToWire(l: LayoutRow): Record<string, unknown> {
  return {
    id: l.id,
    name: l.name,
    owner: l.owner,
    layout_rev: l.layout_rev,
    created_at: l.created_at,
    modified_at: l.modified_at,
    deleted: l.deleted,
    like_count: l.like_count,
    // §4.4 (LDB-MD3): `link` is the approved value only (pending/rejected/
    // superseded never reach any public wire, LDB-MD5).
    link: l.link,
    upstream: l.upstream,
  };
}

export function formatSummaryToWire(f: FormatRow): Record<string, unknown> {
  return {
    rev: f.rev,
    created_at: f.created_at,
    modified_at: f.modified_at,
    has_magic: f.has_magic,
    has_alts: f.has_alts,
    has_combos: f.has_combos,
    source: f.source,
  };
}

export function formatsMapToWire(formats: Map<string, FormatRow>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const f of formats.values()) out[f.format] = formatSummaryToWire(f);
  return out;
}

// The full §2.3 wire shape: the layout's own fields, `formats`, and
// (whenever this read/write concerns one) `format`/`payload`/`derived_from`.
// A pure layout-scope write (rename/transfer/delete/restore) omits `extra`
// entirely -- it concerns no format (D4).
export function fullWire(layout: LayoutRow, formats: Map<string, FormatRow>, extra?: { format: string; payload: unknown; derived_from?: string }): Record<string, unknown> {
  return {
    ...layoutToWire(layout),
    formats: formatsMapToWire(formats),
    ...(extra !== undefined
      ? { format: extra.format, payload: extra.payload, ...(extra.derived_from !== undefined ? { derived_from: extra.derived_from } : {}) }
      : {}),
  };
}
