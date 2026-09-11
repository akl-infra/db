// Nightly dump (07 §6 S7, cron `0 3 * * *`): a whole-state snapshot, not a
// tail -- a rehosted service must be able to answer `/v1/changes?since=0`
// (LDB-P6), so `events` carries the WHOLE log. Every table is paged in
// keysets of 500 (mirrors `core/records.ts`'s own cursor style) straight
// into plain arrays of RAW db rows (LayoutDbRow/EventDbRow-shaped, i.e.
// `payload_json` stays a string, `deleted`/`has_magic`/`admin` stay 0/1) --
// the dump is "what's literally in the tables", so `dump/restore.ts` can
// re-insert it with no shape translation at either end. `canonical()` over
// that plain-row shape is what keeps the dump byte-stable for the sha256.
import type { Bindings } from "../env";
import { canonical } from "../core/canonical";
import { readHead } from "../core/etag";
import type { EventDbRow } from "../core/events";
import { readMetaCore } from "../core/meta";
import { rowToRecord, type LayoutDbRow } from "../core/records";
import type { Clock } from "../core/time";
import { list as listFormats } from "../formats/registry";
import { translate as pureTranslate } from "../../formats/registry.ts";

const PAGE_SIZE = 500;

export interface LayoutRevDbRow {
  layout_id: string;
  rev: number;
  event_seq: number;
  format: string;
  payload_json: string;
}
export interface LikeDbRow {
  layout_id: string;
  user_id: string;
  at: string;
}
export interface AuthorDbRow {
  user_id: string;
  name: string;
  first_seen_at: string;
  last_seen_at: string;
  // migrations/0006 (LDB-I17): 'import' | 'user' | 'client'. Absent from a
  // dump written before that migration -- restore.ts reads it as 'import'.
  name_source?: string;
}
export interface AdminDbRow {
  user_id: string;
  added_by: string | null;
  added_at: string;
  note: string | null;
}
export interface ImportStateDbRow {
  key: string;
  value: string;
}
export interface ImportMapDbRow {
  upstream_id: string;
  layout_id: string;
}

export interface DumpMeta {
  layout_count: number;
  author_count: number;
  seq: number;
  revision: string | null;
  layouts_modified_at: string | null;
  authors_modified_at: string | null;
  // `authors_head.version` (migrations/0007, LDB-R9). Absent from a dump
  // written before that migration -- restore.ts reads it as 0, the value
  // 0007 itself seeds.
  authors_version?: number;
  formats: string[];
}

// version 1: bump only if a future dump's shape stops being restorable by an
// older restore.ts -- restoreSql/restoreInto do not currently branch on it.
export interface Dump {
  version: 1;
  date: string; // YYYY-MM-DD, from `now()`'s UTC date (07 §0.1: our clocks are always Z-suffixed ISO)
  meta: DumpMeta;
  records: LayoutDbRow[]; // the WHOLE `layouts` table, tombstones included -- events/layout_revs/import_map reference rows a live-only dump would drop
  layout_revs: LayoutRevDbRow[];
  likes: LikeDbRow[];
  authors: AuthorDbRow[];
  admins: AdminDbRow[];
  events: EventDbRow[]; // the WHOLE log, not a tail (LDB-P6)
  import_state: ImportStateDbRow[];
  import_map: ImportMapDbRow[];
  auth_cache: []; // never dumped -- holds only token hashes, and a rehost starts cold (09 §3)
  webhooks: []; // never dumped -- holds `secret` verbatim; a rehost has no subscriptions, owners re-register (12 §2.1, LDB-H4)
}

export interface LatestJson {
  date: string;
  key: string;
  url: string; // "/v1/dump/<key>", relative to whatever origin serves it
  sha256: string;
  bytes: number;
  layout_count: number;
  seq: number;
}

// 20-spark.md S5 (19 §6.2, LDB-D6): "every layout at every major", the
// dump's own surface for it. One entry per LIVE record (tombstones are
// excluded here -- same convention `GET /v1/layouts` defaults to, and the
// main dump's own `records`/`layout_revs` already carry every tombstone
// for anyone who needs one); `payload` is the record's translation to this
// file's own major, or, when the chain/cross edge holds for it, `held:
// true` + `see` naming the record's own NATIVE format (never this file's
// major -- a consumer reading `held` already knows which file it opened).
export interface LatestMajorRecord {
  id: string;
  name: string;
  owner: string;
  rev: number;
  created_at: string;
  modified_at: string;
  like_count: number;
  has_magic: boolean;
  payload?: unknown;
  held?: true;
  see?: string;
}

export interface LatestMajorFile {
  version: 1;
  date: string;
  format: string; // this file's own major, e.g. "spark/1"
  meta: { layout_count: number; seq: number };
  records: LatestMajorRecord[];
}

// Single-column-PK keyset pager: `SELECT * FROM <table> WHERE <keyCol> > ?
// ORDER BY <keyCol> ASC LIMIT ?`, page after page until a short page ends
// it. `table`/`keyCol` are our own fixed constants below, never request
// input, so string-interpolating them into the SQL is safe.
async function pageBySingleKey<T>(db: Bindings["DB"], table: string, keyCol: string): Promise<T[]> {
  const out: T[] = [];
  let cursor: string | number | null = null;
  for (;;) {
    const sql: string =
      cursor === null
        ? `SELECT * FROM ${table} ORDER BY ${keyCol} ASC LIMIT ?`
        : `SELECT * FROM ${table} WHERE ${keyCol} > ? ORDER BY ${keyCol} ASC LIMIT ?`;
    const args: (string | number)[] = cursor === null ? [PAGE_SIZE] : [cursor, PAGE_SIZE];
    const { results } = await db.prepare(sql).bind(...args).all<T>();
    out.push(...results);
    if (results.length < PAGE_SIZE) break;
    const last = results[results.length - 1] as unknown as Record<string, string | number>;
    cursor = last[keyCol]!;
  }
  return out;
}

// Composite-PK keyset pager (`layout_revs`, `likes`): a single-column cursor
// on `col1` alone would skip or repeat rows when many share one `col1`
// value (e.g. many revs of the same layout), so the predicate is the same
// tuple comparison `core/records.ts`'s `list()` uses for its own cursor.
async function pageByCompositeKey<T>(db: Bindings["DB"], table: string, col1: string, col2: string): Promise<T[]> {
  const out: T[] = [];
  let cursor: [string, number | string] | null = null;
  for (;;) {
    const sql: string =
      cursor === null
        ? `SELECT * FROM ${table} ORDER BY ${col1} ASC, ${col2} ASC LIMIT ?`
        : `SELECT * FROM ${table} WHERE (${col1} > ? OR (${col1} = ? AND ${col2} > ?)) ORDER BY ${col1} ASC, ${col2} ASC LIMIT ?`;
    const args: (string | number)[] = cursor === null ? [PAGE_SIZE] : [cursor[0], cursor[0], cursor[1], PAGE_SIZE];
    const { results } = await db.prepare(sql).bind(...args).all<T>();
    out.push(...results);
    if (results.length < PAGE_SIZE) break;
    const last = results[results.length - 1] as unknown as Record<string, string | number>;
    cursor = [last[col1] as string, last[col2]!];
  }
  return out;
}

// `src/index.ts`'s `GET /v1/meta` body minus `last_diff`/`last_drill`:
// the SAME `readMetaCore` (core/meta.ts), so the two can't drift;
// `tests/api/dump.test.ts` also compares a dump's `meta` against a live
// `/v1/meta` call.
async function computeMeta(db: Bindings["DB"]): Promise<DumpMeta> {
  return readMetaCore(db, await readHead(db));
}

export async function buildDump(env: Bindings, now: Clock): Promise<Dump> {
  const db = env.DB;
  const date = now().slice(0, 10);

  const [meta, records, layout_revs, likes, authors, admins, events, import_state, import_map] = await Promise.all([
    computeMeta(db),
    pageBySingleKey<LayoutDbRow>(db, "layouts", "id"),
    pageByCompositeKey<LayoutRevDbRow>(db, "layout_revs", "layout_id", "rev"),
    pageByCompositeKey<LikeDbRow>(db, "likes", "layout_id", "user_id"),
    pageBySingleKey<AuthorDbRow>(db, "authors", "user_id"),
    pageBySingleKey<AdminDbRow>(db, "admins", "user_id"),
    pageBySingleKey<EventDbRow>(db, "events", "seq"),
    pageBySingleKey<ImportStateDbRow>(db, "import_state", "key"),
    pageBySingleKey<ImportMapDbRow>(db, "import_map", "upstream_id"),
  ]);

  return {
    version: 1,
    date,
    meta,
    records,
    layout_revs,
    likes,
    authors,
    admins,
    events,
    import_state,
    import_map,
    auth_cache: [],
    webhooks: [],
  };
}

// LDB-D6: one file per registered `role: "stored"` major (never an
// `"output"` one like `mana2/1` -- that's what `?as=mana2/1` on the LIST
// route is for, not a per-major snapshot of what's actually stored) --
// every live `layouts` row translated to it, or `held` when the chain/
// cross edge can't show it. Built straight from the SAME `dump.records`
// page the main dump already paged, so this never re-queries D1.
function buildLatestMajorFiles(dump: Dump): { format: string; file: LatestMajorFile }[] {
  const liveRows = dump.records.filter((r) => r.deleted === 0);
  const storedFormats = listFormats()
    .filter((f) => f.role === "stored")
    .map((f) => f.id);

  return storedFormats.map((format) => {
    const records: LatestMajorRecord[] = liveRows.map((row) => {
      const rec = rowToRecord(row);
      const common = {
        id: rec.id,
        name: rec.name,
        owner: rec.owner,
        rev: rec.rev,
        created_at: rec.created_at,
        modified_at: rec.modified_at,
        like_count: rec.like_count,
        has_magic: rec.has_magic,
      };
      if (rec.format === format) return { ...common, payload: rec.payload };
      const result = pureTranslate({ format: rec.format, payload: rec.payload }, format);
      if ("held" in result) return { ...common, held: true, see: rec.format };
      // "unknown" is unreachable here: `format` is drawn from `listFormats()`
      // itself, so it is always registered.
      if ("unknown" in result) throw new Error(`buildLatestMajorFiles: unreachable -- '${format}' resolved unknown`);
      return { ...common, payload: result.payload };
    });
    return {
      format,
      file: {
        version: 1,
        date: dump.date,
        format,
        meta: { layout_count: records.length, seq: dump.meta.seq },
        records,
      },
    };
  });
}

async function gzip(bytes: Uint8Array): Promise<Uint8Array> {
  const cs = new CompressionStream("gzip");
  const writer = cs.writable.getWriter();
  const writeDone = writer.write(bytes).then(() => writer.close());
  const chunks: Uint8Array[] = [];
  const reader = cs.readable.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) chunks.push(value);
  }
  await writeDone;
  const total = chunks.reduce((n, c) => n + c.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    out.set(c, offset);
    offset += c.length;
  }
  return out;
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

// Builds the dump, gzips it, sha256's the gzip bytes, and writes
// `dump-YYYY-MM-DD.json.gz` + `latest.json` (+ `monthly/dump-YYYY-MM.json.gz`
// on the 1st) to R2. Called from `scheduled()`'s `0 3 * * *` branch, after
// `pruneAuthCache` (index.ts).
export async function writeDump(env: Bindings, now: Clock): Promise<{ key: string; latest: LatestJson }> {
  const dump = await buildDump(env, now);
  const bytes = new TextEncoder().encode(canonical(dump));
  const gz = await gzip(bytes);
  const sha256 = await sha256Hex(gz);

  const key = `dump-${dump.date}.json.gz`;
  await env.DUMPS.put(key, gz, { httpMetadata: { contentType: "application/gzip" } });

  const latest: LatestJson = {
    date: dump.date,
    key,
    url: `/v1/dump/${key}`,
    sha256,
    bytes: gz.byteLength,
    layout_count: dump.meta.layout_count,
    seq: dump.meta.seq,
  };
  await env.DUMPS.put("latest.json", canonical(latest), { httpMetadata: { contentType: "application/json" } });

  // LDB-D6: one `latest.<name>-<N>.json` (slash-free, R2-key-safe -- 19
  // §11 Q4) per registered STORED major, plus its own sha256 sidecar; never
  // gzipped (a consumer on that one major wants a plain fetch, same as
  // `latest.json` itself). `latest.json` above is untouched by any of this.
  for (const { format, file } of buildLatestMajorFiles(dump)) {
    const majorKey = `latest.${format.replace("/", "-")}.json`;
    const majorBytes = new TextEncoder().encode(canonical(file));
    await env.DUMPS.put(majorKey, majorBytes, { httpMetadata: { contentType: "application/json" } });
    await env.DUMPS.put(`${majorKey}.sha256`, await sha256Hex(majorBytes), { httpMetadata: { contentType: "text/plain" } });
  }

  if (dump.date.slice(8, 10) === "01") {
    const monthKey = `monthly/dump-${dump.date.slice(0, 7)}.json.gz`;
    await env.DUMPS.put(monthKey, gz, { httpMetadata: { contentType: "application/gzip" } });
  }

  return { key, latest };
}
