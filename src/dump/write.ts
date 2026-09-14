// Nightly dump (07 §6 S7; LDB-D8 amended: hour=3 is the preferred slot, but
// any tick catches up once `dump.last_at` is missing or >24h old, `src/
// index.ts`'s `scheduled()`): a whole-state snapshot, not a
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
import type { ClientRow } from "../core/clients";
import { readHead } from "../core/etag";
import type { EventDbRow } from "../core/events";
import { readMetaCore } from "../core/meta";
import type { FormatDbRow, LayoutDbRow } from "../core/records";
import type { Clock } from "../core/time";

const PAGE_SIZE = 500;

export interface LayoutRevDbRow {
  layout_id: string;
  n: number;
  lineage: string | null;
  rev: number;
  event_seq: number;
  format: string | null;
  payload_json: string | null;
}
export interface LikeDbRow {
  layout_id: string;
  user_id: string;
  at: string;
  // LDB-B1 (migrations/0011): who/what this like came from. Absent from a
  // dump written before 0010 -- restore.ts reads it as 'import:cmini'
  // (0010's own column default), same pattern as `authors.name_source`.
  via?: string;
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
  // B2 sticky shadow (migrations/0013): the last name UPSTREAM itself
  // reported for this id. Absent from a dump written before 0012 --
  // restore.ts reads it as null (the column's own default).
  upstream_name?: string | null;
  // LDB-I24 (migrations/0018): the last `modified_at` UPSTREAM itself
  // reported for this id, as of our last fetch-and-apply. Absent from a
  // dump written before 0018 -- restore.ts reads it as null (the column's
  // own default).
  upstream_modified_at?: string | null;
}
// L5 moderation (§4.5, migrations/0014): two more `Dump` arrays -- both
// small, admin-authored tables, dumped/restored whole like every other
// non-event-log table here.
export interface BanDbRow {
  user_id: string;
  by: string;
  at: string;
  reason: string | null;
}
export interface LinkSubmissionDbRow {
  id: string;
  layout_id: string;
  url: string;
  submitted_by: string;
  submitted_at: string;
  status: string;
  decided_by: string | null;
  decided_at: string | null;
  reason: string | null;
}

// LDB-D9: registered client pubkeys/caps -- public data (10 C1 §4: no
// `secret`-shaped column exists on this table at all, unlike `webhooks`),
// so unlike `auth_cache`/`nonces`/`ratelimit`/`webhooks` there is no reason
// to drop it. Dumping it (and `restore.ts` re-inserting it) is what makes a
// rehost keep every bot's registered key instead of needing the admin
// bootstrap redone from scratch.
export type ClientDbRow = ClientRow;

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
  layout_formats: FormatDbRow[]; // 21-formats.md F2: every (layout, lineage) row, live or tombstoned layout alike
  layout_revs: LayoutRevDbRow[];
  likes: LikeDbRow[];
  authors: AuthorDbRow[];
  admins: AdminDbRow[];
  events: EventDbRow[]; // the WHOLE log, not a tail (LDB-P6)
  // LDB-D8: every row EXCEPT this dump's own scheduling bookkeeping key
  // (`dump.last_at`, `dumpDue()` below) -- that key records when THIS VERY
  // dump was written, so including it would make the dump depend on
  // itself (buildDump reads state before writeDump's post-write state
  // update, so a dump never carries its own `dump.last_at` regardless, but
  // TWO dumps taken back-to-back for the same underlying data would still
  // disagree on this one row, since the second read the first's fresh
  // write -- excluding it keeps the dump a pure function of DATA, not of
  // "when did I last dump". A rehost consequently starts with no memory of
  // ever having dumped, which is correct: catch-up (LDB-D8) runs promptly
  // rather than waiting out a stale window it never earned.
  import_state: ImportStateDbRow[];
  import_map: ImportMapDbRow[];
  clients: ClientDbRow[]; // LDB-D9: public pubkeys/caps, restored (dump/restore.ts)
  auth_cache: []; // never dumped -- holds only token hashes, and a rehost starts cold (09 §3)
  bans: BanDbRow[]; // [LDB-MD8] §4.5
  link_submissions: LinkSubmissionDbRow[]; // [LDB-MD8] §4.5
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

// `src/index.ts`'s `GET /v1/meta` body minus the live state it adds on top
// (`last_diff`, `health`, `api`, `deprecations`):
// the SAME `readMetaCore` (core/meta.ts), so the two can't drift;
// `tests/api/dump.test.ts` also compares a dump's `meta` against a live
// `/v1/meta` call.
async function computeMeta(db: Bindings["DB"]): Promise<DumpMeta> {
  return readMetaCore(db, await readHead(db));
}

// MF-13 (LDB-B10 with two tables): `meta` is read FIRST, and every table
// page is read AFTER it (not in one `Promise.all` with `meta`'s own
// queries) -- so every row this dump carries was written at or before
// `meta.seq`'s snapshot instant. A `Promise.all` that started `meta` and
// the table pages at the same moment could let a write land between them
// and be reflected in, say, `layout_formats` but not in `meta.seq`,
// putting the dump BEHIND its own claimed floor: booting from it and
// draining `/v1/changes` from `meta.seq` would then miss that write
// entirely (it precedes the drain's `since`, but the dump's own tables
// don't carry it either).
export async function buildDump(env: Bindings, now: Clock): Promise<Dump> {
  const db = env.DB;
  const date = now().slice(0, 10);

  const meta = await computeMeta(db);

  const [records, layout_formats, layout_revs, likes, authors, admins, events, import_state_all, import_map, clients, bans, link_submissions] = await Promise.all([
    pageBySingleKey<LayoutDbRow>(db, "layouts", "id"),
    pageByCompositeKey<FormatDbRow>(db, "layout_formats", "layout_id", "lineage"),
    pageByCompositeKey<LayoutRevDbRow>(db, "layout_revs", "layout_id", "n"),
    pageByCompositeKey<LikeDbRow>(db, "likes", "layout_id", "user_id"),
    pageBySingleKey<AuthorDbRow>(db, "authors", "user_id"),
    pageBySingleKey<AdminDbRow>(db, "admins", "user_id"),
    pageBySingleKey<EventDbRow>(db, "events", "seq"),
    pageBySingleKey<ImportStateDbRow>(db, "import_state", "key"),
    pageBySingleKey<ImportMapDbRow>(db, "import_map", "upstream_id"),
    pageBySingleKey<ClientDbRow>(db, "clients", "id"),
    pageBySingleKey<BanDbRow>(db, "bans", "user_id"),
    pageBySingleKey<LinkSubmissionDbRow>(db, "link_submissions", "id"),
  ]);

  // LDB-D8: `dump.last_at` is this dump's OWN scheduling bookkeeping (see
  // the `Dump.import_state` comment above) -- filtered out here, not left
  // for `restoreSql` to special-case, so a restored database has no memory
  // of a dump that predates it.
  const import_state = import_state_all.filter((r) => r.key !== DUMP_STATE_KEY);

  return {
    version: 1,
    date,
    meta,
    records,
    layout_formats,
    layout_revs,
    likes,
    authors,
    admins,
    events,
    import_state,
    import_map,
    clients,
    auth_cache: [],
    bans,
    link_submissions,
  };
}

// --- LDB-D8: dump catch-up scheduling -------------------------------------
//
// The nightly dump used to run only when a cron invocation's own
// `event.scheduledTime` landed at exactly hour=3 minute=0 -- a dispatch
// Cloudflare dropped for that one slot (observed for real, 2026-09-09, a
// 9-hour outage) skipped the WHOLE day with no retry and no alarm beyond a
// stale `latest.json`. `import_state['dump.last_at']` now records
// `{at, seq, key}` on every successful write (`writeDump`'s last step
// below); `scheduled()` (`src/index.ts`) still prefers the hour=3 slot (via
// `runNightly`, unconditionally -- also where prunes run), but checks this
// record on every OTHER tick and runs the dump anyway once it is missing or
// >24h old, so a dropped slot is caught within one 5-minute tick of the
// next successful dispatch instead of losing a day. `dumpDue`'s own
// half-open `> 24h` (not `>=`) means a dump exactly 24h old is not yet due
// -- the next tick, 5 minutes later, will be.
export interface DumpState {
  at: string;
  seq: number;
  key: string;
}

export const DUMP_STATE_KEY = "dump.last_at"; // exported for `/v1/meta`'s one-query head (src/index.ts), same reason `import/difftick.ts`'s IMPORT_STATE_KEY is
const DUMP_STALE_MS = 24 * 60 * 60 * 1000;

export async function readDumpState(db: Bindings["DB"]): Promise<DumpState | null> {
  const row = await db.prepare("SELECT value FROM import_state WHERE key = ?").bind(DUMP_STATE_KEY).first<{ value: string }>();
  return row === null ? null : (JSON.parse(row.value) as DumpState);
}

async function writeDumpState(db: Bindings["DB"], state: DumpState): Promise<void> {
  await db
    .prepare("INSERT INTO import_state (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
    .bind(DUMP_STATE_KEY, canonical(state))
    .run();
}

// Pure (no D1, no clock read of its own) so `tests/import/tick.test.ts` can
// property-test it directly: due iff never written, or written >24h before
// `nowIso`.
export function dumpDue(state: DumpState | null, nowIso: string): boolean {
  if (state === null) return true;
  return Date.parse(nowIso) - Date.parse(state.at) > DUMP_STALE_MS;
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
// on the 1st) to R2. Called from `scheduled()`'s hour=3 branch (via
// `runNightly`, after `pruneAuthCache`) or, on any other tick, LDB-D8's own
// catch-up check (`src/index.ts`).
export async function writeDump(env: Bindings, now: Clock): Promise<{ key: string; latest: LatestJson }> {
  const dump = await buildDump(env, now);
  const bytes = new TextEncoder().encode(canonical(dump));
  const gz = await gzip(bytes);
  const sha256 = await sha256Hex(gz);

  // LDB risk C.9 (audit-db.md §H item 9): `buildDump` materializes the
  // whole DB in Worker memory before this point -- not urgent below ~50k
  // events (today's ~4k layouts), but a size regression should be visible
  // in the logs well before it becomes a CPU/memory cliff, so every write
  // logs its own uncompressed/gzipped byte counts.
  console.log(`writeDump: seq=${dump.meta.seq} layouts=${dump.meta.layout_count} bytes=${bytes.byteLength} gzip_bytes=${gz.byteLength}`);

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

  if (dump.date.slice(8, 10) === "01") {
    const monthKey = `monthly/dump-${dump.date.slice(0, 7)}.json.gz`;
    await env.DUMPS.put(monthKey, gz, { httpMetadata: { contentType: "application/gzip" } });
  }

  // LDB-D8: recorded LAST, only once every object above has been written
  // successfully -- a throw partway through (an R2 hiccup, say) leaves the
  // previous `dump.last_at` in place, so the NEXT tick's catch-up check
  // still sees this attempt as not having happened and retries, rather
  // than wrongly believing a dump exists that was never fully written.
  await writeDumpState(env.DB, { at: now(), seq: dump.meta.seq, key });

  return { key, latest };
}
