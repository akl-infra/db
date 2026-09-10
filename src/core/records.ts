// Reads of the `layouts` table. `appendWrite` (events.ts) is the only code
// that writes it (07 S4, the onlywriter test) -- this module only SELECTs.
import type { Bindings } from "../env";

// 20-spark.md S3a (decision 5, LDB-I14): a record's own belief about its
// upstream link, folded from events (`core/events.ts`'s `appendWrite`
// stores it on every write, `core/upstream.ts`'s `upstreamOf` is the
// read-side fallback for a record this field has never been written on
// yet). `null` = no known link (a plain user record, or one written before
// 0005 and not yet touched -- `upstreamOf`'s legacy fallback covers that
// case, never this type).
export type UpstreamState = "following" | "forked";

export interface Upstream {
  source: "cmini";
  id: string; // the upstream (cmini) id, as text
  state: UpstreamState;
}

// 20-spark.md S3s (decision 14, LDB-P15): who/what made the latest
// rev-bumping write -- `client` is PROVEN (derived from the authenticated
// identity or a system writer's own literal, never a header/body field);
// `version` is the client's own `X-Client-Version` header, validated and
// stored as sent, or `null` if it sent none. Never null once a write has
// ever supplied one (`Write.source` is required) -- only a record whose
// latest rev-bumping event predates 0005 reads this column NULL.
export interface Source {
  client: string;
  version: string | null;
}

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
  upstream: Upstream | null;
  source: Source | null;
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
  upstream_source: string | null; // migrations/0005_spark.sql; all three NULL together or set together
  upstream_id: string | null;
  upstream_state: string | null; // 'following' | 'forked'
  source_client: string | null; // migrations/0005_spark.sql (S3s): NULL iff never rev-bumped since 0005
  source_version: string | null;
}

// A dump/restored row from before 0005 (or a raw JS object built by hand in
// a test) may simply lack these three keys -- `?? null` treats "absent" the
// same as "present and NULL" (LDB-D1/D5 amended: an old-shape dump restores
// NULL).
export function upstreamFromRow(row: {
  upstream_source: string | null | undefined;
  upstream_id: string | null | undefined;
  upstream_state: string | null | undefined;
}): Upstream | null {
  const source = row.upstream_source ?? null;
  if (source === null) return null;
  return { source: source as "cmini", id: row.upstream_id ?? "", state: (row.upstream_state ?? "following") as UpstreamState };
}

// 20-spark.md S3s: a dump/restored row from before 0005 (or a raw JS
// object built by hand in a test) may lack these two keys entirely -- `??
// null` treats "absent" the same as "present and NULL", same convention
// `upstreamFromRow` uses. No "legacy:<via>" synthesis here: unlike
// `/history`/`/rev/{n}` (which read a specific EVENT row that already
// carries its own `via`), a `layouts` row has no `via` column to fall back
// on, so a record whose latest rev-bumping write predates 0005 simply
// reads `source: null` on every route until it is next written.
export function sourceFromRow(row: {
  source_client: string | null | undefined;
  source_version: string | null | undefined;
}): Source | null {
  const client = row.source_client ?? null;
  if (client === null) return null;
  return { client, version: row.source_version ?? null };
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
    upstream: upstreamFromRow(row),
    source: sourceFromRow(row),
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

// `GET /v1/layouts`'s sort options (03 §2): `name` is the only ascending
// one (case-insensitive, the column's own COLLATE); the other three are
// all descending (07 §6 S6: "desc for the three").
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

export interface ListParams {
  owner?: string;
  format?: string;
  hasMagic?: boolean;
  since?: string; // modified_at > since (ISO, compared as text -- 07 §0.1: upstream timestamps are one fixed Z-format, so lexicographic order agrees with chronological order)
  likedBy?: string; // 10 C1: `id IN (SELECT layout_id FROM likes WHERE user_id = ?)` -- combinable with every other filter/sort
  sort: SortKey;
  limit: number; // already validated/clamped by the caller (routes/layouts.ts)
  cursor?: ListCursor;
}

export interface ListPage {
  items: RecordRow[];
  nextCursor: string | null;
}

// Opaque keyset cursor: base64 of `[sortValue, id]` (07 §6 S6). `id` is the
// tie-breaker so paging is a strict total order even when many records
// share one `sortValue` (e.g. `like_count = 0`).
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

function sortValueOf(rec: RecordRow, sort: SortKey): string | number {
  return rec[sort];
}

// Filtered, sorted, keyset-paginated live records (`deleted = 0` always --
// tombstones never appear in a list, 03 §2). Used both for the plain list
// (rows minus payload) and, in pages of 500, for `?full=1`'s stream
// (routes/layouts.ts) -- one function so the two can't disagree on
// ordering or filters.
export async function list(db: Bindings["DB"], params: ListParams): Promise<ListPage> {
  const col = params.sort; // column name == SortKey literal for all four (name/modified_at/created_at/like_count)
  const desc = SORT_DESC[params.sort];
  const collate = params.sort === "name" ? " COLLATE NOCASE" : "";
  const dir = desc ? "DESC" : "ASC";

  const where: string[] = ["deleted = 0"];
  const args: unknown[] = [];
  if (params.owner !== undefined) {
    where.push("owner = ?");
    args.push(params.owner);
  }
  if (params.format !== undefined) {
    where.push("format = ?");
    args.push(params.format);
  }
  if (params.hasMagic !== undefined) {
    where.push("has_magic = ?");
    args.push(params.hasMagic ? 1 : 0);
  }
  if (params.since !== undefined) {
    where.push("modified_at > ?");
    args.push(params.since);
  }
  if (params.likedBy !== undefined) {
    where.push("id IN (SELECT layout_id FROM likes WHERE user_id = ?)");
    args.push(params.likedBy);
  }
  if (params.cursor !== undefined) {
    // Keyset predicate: strictly past (sortValue, id) in the walk's own
    // order. `id` breaks ties regardless of the primary column's
    // direction -- ids are unique, so this alone gives a total order.
    const cmp = desc ? "<" : ">";
    where.push(`(${col}${collate} ${cmp} ? OR (${col}${collate} = ? AND id > ?))`);
    args.push(params.cursor.sortValue, params.cursor.sortValue, params.cursor.id);
  }

  const sql = `SELECT * FROM layouts WHERE ${where.join(" AND ")} ORDER BY ${col}${collate} ${dir}, id ASC LIMIT ?`;
  args.push(params.limit + 1); // one extra row to know whether a next page exists

  const { results } = await db
    .prepare(sql)
    .bind(...args)
    .all<LayoutDbRow>();
  const rows = results.map(rowToRecord);

  let nextCursor: string | null = null;
  let items = rows;
  if (rows.length > params.limit) {
    items = rows.slice(0, params.limit);
    const last = items[items.length - 1]!;
    nextCursor = encodeCursor({ sortValue: sortValueOf(last, params.sort), id: last.id });
  }
  return { items, nextCursor };
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
    upstream: rec.upstream,
    source: rec.source,
    payload: rec.payload,
  };
}
