// Reads of `layouts` and `layout_formats` (21-formats.md F2, §2.1). Only
// `core/events.ts`'s `commitWrite`/`appendLike` write these tables (LDB-P1,
// the onlywriter test) -- this module only SELECTs.
import type { Bindings } from "../env";

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
  like_count: number;
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
    source: sourceFromRow(row),
  };
}

export async function readById(db: Bindings["DB"], id: string): Promise<LayoutRow | null> {
  const row = await db.prepare("SELECT * FROM layouts WHERE id = ?").bind(id).first<LayoutDbRow>();
  return row === null ? null : rowToLayout(row);
}

export async function readByName(db: Bindings["DB"], name: string): Promise<LayoutRow | null> {
  // `name` is COLLATE NOCASE -- a plain `=` already compares
  // case-insensitively. `deleted = 0` matters here, not just as a filter: a
  // tombstone keeps its literal name (LDB-P8) so a live record can share a
  // name string with a dead one; byName must see the live one and only the
  // live one.
  const row = await db.prepare("SELECT * FROM layouts WHERE name = ? AND deleted = 0").bind(name).first<LayoutDbRow>();
  return row === null ? null : rowToLayout(row);
}

export async function byRef(db: Bindings["DB"], ref: string): Promise<LayoutRow | null> {
  if (isUlidShaped(ref)) {
    const byId = await readById(db, ref);
    if (byId !== null) return byId;
  }
  return readByName(db, ref);
}

// Every `layout_formats` row a layout has, lineage-keyed.
export async function formatsForLayout(db: Bindings["DB"], layoutId: string): Promise<Map<string, FormatRow>> {
  const { results } = await db.prepare("SELECT * FROM layout_formats WHERE layout_id = ?").bind(layoutId).all<FormatDbRow>();
  const out = new Map<string, FormatRow>();
  for (const row of results) out.set(row.lineage, rowToFormat(row));
  return out;
}

// Coordinator review (H1): the list route (plain and `full=1` alike) must
// show EVERY stored format a layout has in its `formats` map, not just the
// one lineage the request's `?format=` happened to join on for filtering
// -- a layout with a second stored lineage (the test-only second lineage,
// or a real future `lw/1`) must show BOTH in `formats` on every row. One
// batched `IN (...)` query per PAGE (chunked the same way
// `likesByLayout` already batches likes), never one query per layout.
export async function formatsForLayouts(db: Bindings["DB"], layoutIds: string[]): Promise<Map<string, Map<string, FormatRow>>> {
  const out = new Map<string, Map<string, FormatRow>>(layoutIds.map((id) => [id, new Map<string, FormatRow>()]));
  for (let i = 0; i < layoutIds.length; i += 90) {
    const chunk = layoutIds.slice(i, i + 90);
    const { results } = await db
      .prepare(`SELECT * FROM layout_formats WHERE layout_id IN (${chunk.map(() => "?").join(",")})`)
      .bind(...chunk)
      .all<FormatDbRow>();
    for (const row of results) out.get(row.layout_id)!.set(row.lineage, rowToFormat(row));
  }
  return out;
}

export async function readFormat(db: Bindings["DB"], layoutId: string, lineage: string): Promise<FormatRow | null> {
  const row = await db.prepare("SELECT * FROM layout_formats WHERE layout_id = ? AND lineage = ?").bind(layoutId, lineage).first<FormatDbRow>();
  return row === null ? null : rowToFormat(row);
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

interface JoinedRow extends LayoutDbRow {
  f_layout_id: string | null;
  f_lineage: string | null;
  f_format: string | null;
  f_rev: number | null;
  f_created_at: string | null;
  f_modified_at: string | null;
  f_payload_json: string | null;
  f_has_magic: number | null;
  f_source_client: string | null;
  f_source_version: string | null;
}

const JOIN_SELECT = `
  SELECT l.*,
    f.layout_id AS f_layout_id, f.lineage AS f_lineage, f.format AS f_format, f.rev AS f_rev,
    f.created_at AS f_created_at, f.modified_at AS f_modified_at, f.payload_json AS f_payload_json,
    f.has_magic AS f_has_magic, f.source_client AS f_source_client, f.source_version AS f_source_version
  FROM layouts l LEFT JOIN layout_formats f ON f.layout_id = l.id
`;

function joinedToFormat(row: JoinedRow): FormatRow | null {
  if (row.f_lineage === null || row.f_format === null || row.f_rev === null || row.f_payload_json === null) return null;
  return rowToFormat({
    layout_id: row.f_layout_id ?? row.id,
    lineage: row.f_lineage,
    format: row.f_format,
    rev: row.f_rev,
    created_at: row.f_created_at ?? row.created_at,
    modified_at: row.f_modified_at ?? row.modified_at,
    payload_json: row.f_payload_json,
    has_magic: row.f_has_magic ?? 0,
    source_client: row.f_source_client,
    source_version: row.f_source_version,
  });
}

function groupJoined(results: JoinedRow[]): LayoutWithFormats | null {
  if (results.length === 0) return null;
  const layout = rowToLayout(results[0]!);
  const formats = new Map<string, FormatRow>();
  for (const row of results) {
    const f = joinedToFormat(row);
    if (f !== null) formats.set(f.lineage, f);
  }
  return { layout, formats };
}

export async function readByIdWithFormats(db: Bindings["DB"], id: string): Promise<LayoutWithFormats | null> {
  const { results } = await db.prepare(`${JOIN_SELECT} WHERE l.id = ?`).bind(id).all<JoinedRow>();
  return groupJoined(results);
}

export async function readByNameWithFormats(db: Bindings["DB"], name: string): Promise<LayoutWithFormats | null> {
  const { results } = await db.prepare(`${JOIN_SELECT} WHERE l.name = ? AND l.deleted = 0`).bind(name).all<JoinedRow>();
  return groupJoined(results);
}

export async function byRefWithFormats(db: Bindings["DB"], ref: string): Promise<LayoutWithFormats | null> {
  if (isUlidShaped(ref)) {
    const byId = await readByIdWithFormats(db, ref);
    if (byId !== null) return byId;
  }
  return readByNameWithFormats(db, ref);
}

// `GET /v1/layouts?format=F`'s sort options (03 §2): `name` is the only
// ascending one (case-insensitive, the column's own COLLATE); the other
// three are all descending.
export type SortKey = "name" | "modified_at" | "created_at" | "like_count";
const SORT_DESC: Record<SortKey, boolean> = {
  name: false,
  modified_at: true,
  created_at: true,
  like_count: true,
};

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
  since?: string; // max(layouts.modified_at, format.modified_at) > since
  likedBy?: string;
  sort: SortKey;
  limit: number;
  cursor?: ListCursor;
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

// The SQL expression for a sort column: `name`/`created_at`/`like_count`
// are layout-only concepts (unaffected by which format was requested);
// `modified_at` is `max(layouts.modified_at, F.modified_at)` (21-formats.md
// §2.2: "the last time anything an F reader sees changed").
function sortExpr(sort: SortKey): string {
  if (sort === "modified_at") return "MAX(l.modified_at, f.modified_at)";
  return `l.${sort}`;
}

interface ListJoinedRow extends LayoutDbRow {
  f_rev: number;
  f_format: string;
  f_created_at: string;
  f_modified_at: string;
  f_payload_json: string;
  f_has_magic: number;
  f_source_client: string | null;
  f_source_version: string | null;
  sort_value: string | number;
}

// Filtered, sorted, keyset-paginated live layouts that have `sourceLineage`
// stored (`deleted = 0` always -- tombstones never appear in a list).
export async function list(db: Bindings["DB"], params: ListParams): Promise<ListPage> {
  const desc = SORT_DESC[params.sort];
  const collate = params.sort === "name" ? " COLLATE NOCASE" : "";
  const dir = desc ? "DESC" : "ASC";
  const sortColExpr = sortExpr(params.sort) + collate;

  const where: string[] = ["l.deleted = 0", "f.lineage = ?"];
  const args: unknown[] = [params.sourceLineage];
  if (params.owner !== undefined) {
    where.push("l.owner = ?");
    args.push(params.owner);
  }
  if (params.hasMagic !== undefined) {
    where.push("f.has_magic = ?");
    args.push(params.hasMagic ? 1 : 0);
  }
  if (params.since !== undefined) {
    where.push(`${sortExpr("modified_at")} > ?`);
    args.push(params.since);
  }
  if (params.likedBy !== undefined) {
    where.push("l.id IN (SELECT layout_id FROM likes WHERE user_id = ?)");
    args.push(params.likedBy);
  }
  if (params.cursor !== undefined) {
    const cmp = desc ? "<" : ">";
    where.push(`(${sortColExpr} ${cmp} ? OR (${sortColExpr} = ? AND l.id > ?))`);
    args.push(params.cursor.sortValue, params.cursor.sortValue, params.cursor.id);
  }

  const sql = `
    SELECT l.*, f.rev AS f_rev, f.format AS f_format, f.created_at AS f_created_at, f.modified_at AS f_modified_at,
      f.payload_json AS f_payload_json, f.has_magic AS f_has_magic, f.source_client AS f_source_client, f.source_version AS f_source_version,
      ${sortColExpr} AS sort_value
    FROM layouts l JOIN layout_formats f ON f.layout_id = l.id
    WHERE ${where.join(" AND ")}
    ORDER BY ${sortColExpr} ${dir}, l.id ASC
    LIMIT ?`;
  args.push(params.limit + 1);

  const { results } = await db.prepare(sql).bind(...args).all<ListJoinedRow>();
  const items: ListItem[] = results.map((row) => ({
    layout: rowToLayout(row),
    format: rowToFormat({
      layout_id: row.id,
      lineage: params.sourceLineage,
      format: row.f_format,
      rev: row.f_rev,
      created_at: row.f_created_at,
      modified_at: row.f_modified_at,
      payload_json: row.f_payload_json,
      has_magic: row.f_has_magic,
      source_client: row.f_source_client,
      source_version: row.f_source_version,
    }),
  }));

  let nextCursor: string | null = null;
  let page = items;
  if (items.length > params.limit) {
    page = items.slice(0, params.limit);
    const last = results[params.limit]!; // one-past-the-page row already fetched; reuse its sort_value/id cheaply
    const lastItem = page[page.length - 1]!;
    nextCursor = encodeCursor({ sortValue: results[params.limit - 1]!.sort_value, id: lastItem.layout.id });
    void last;
  }
  return { items: page, nextCursor };
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
    upstream: l.upstream,
  };
}

export function formatSummaryToWire(f: FormatRow): Record<string, unknown> {
  return {
    rev: f.rev,
    created_at: f.created_at,
    modified_at: f.modified_at,
    has_magic: f.has_magic,
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
