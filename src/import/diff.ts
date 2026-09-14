// The upstream mirror diff (design/layout-db/review/PROPOSAL.md §2.1,
// LEDGER.md L4): shrunk from a full-corpus name-matched comparison to
// "layout count equality + a sampled compare of N random following
// layouts' content hash vs upstream converted to spark" -- the importer's
// own per-tick plan (`import/plan.ts`) already compares state on every
// write path; this diff exists only to catch a class of bug the importer
// itself couldn't (a silent divergence that never triggers a re-fetch).
// Used by both `scripts/diff-upstream.mjs` (a plain Node CLI) and
// `tests/upstream-diff.test.ts` (the daily job) / `tests/import/diff-unit
// .test.ts` (the offline unit half).
//
// Import-boundary note: this file's own relative imports use explicit
// `.ts`/no-bundler-needed paths ON PURPOSE, unlike the rest of `src/import`
// (which imports extensionless, resolved by the Worker's esbuild/Vite in
// tests). `scripts/diff-upstream.mjs` loads this file with PLAIN Node ESM
// (Node 24's native TypeScript stripping, same trick `rehost.mjs` uses for
// `dump/restore.ts`) -- that resolver requires real specifiers and refuses
// TS features it can't erase (confirmed empirically: `src/import/upstream
// .ts`'s `UpstreamClient` uses constructor parameter properties, which
// Node's strip-only mode rejects outright, and `src/import/apply.ts`'s own
// extensionless `../core/events` etc. don't resolve either). So this module
// depends on nothing but `formats/cmini/1/index.ts` (extension-explicit
// throughout, like `scripts/goldens.mjs` already relies on) and
// `core/canonical.ts` (no imports of its own) -- both plain-Node-loadable --
// and re-implements the small slice of upstream-detail parsing and HTTP
// retry it needs rather than importing `apply.ts`/`upstream.ts` across that
// boundary.
import { unescapeGoHtml } from "../core/safejson.ts";
import * as cmini1 from "../../formats/adapters/cmini/index.ts";
import * as spark from "../../formats/spark/1/index.ts";
import { fromCmini } from "../../formats/adapters/cmini/translate.ts";
import { canonical } from "../core/canonical.ts";

// A record's own belief about its upstream link (20-spark.md S3a/S3b,
// LDB-I14) -- mirrors `db/src/core/records.ts`'s `Upstream` type, but
// redeclared here rather than imported: this module stays plain-Node-ESM
// loadable (see the header note above), and that file pulls in the
// Worker's `Bindings` type and more besides.
export interface UpstreamLink {
  source: "cmini";
  id: string;
  state: "following" | "forked";
}

export type FetchImpl = (url: string, init?: { headers?: Record<string, string> }) => Promise<Response>;
export type SleepImpl = (ms: number) => Promise<void>;

function realSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const RETRIES = 3;
const BACKOFF_MS = [1000, 2000, 4000];

// Parses `text` twice and demands the two parses agree (by `canonical()`),
// re-throwing as a parse failure (caught by `fetchJsonRetried`'s retry loop,
// same as a network error) when they don't.
//
// Why: this slice's own local proof (07 §6 S8) hit a REAL, reproduced
// engine bug fetching upstream's ~5.3 MB `?full=1` body under the Node
// version installed in this environment (v25.1.0, V8 14.1.146.11-node.11,
// newer than 07 §2's pinned Node 24 -- unverified whether the pin avoids
// it): the FIRST `JSON.parse` of a freshly-assembled large string
// occasionally decoded one `\uXXXX`-escaped object key (e.g. `&`,
// i.e. `&`) into a single raw backslash, while a second `JSON.parse` of
// the SAME in-memory string (or of a substring re-sliced from it)
// consistently came back correct. A single-record fetch is far smaller
// than the corpus dump this hazard was found on, but the guard is cheap
// and this module no longer has any OTHER place that would have caught it,
// so it stays.
function parseJsonChecked(text: string, url: string): unknown {
  let first: unknown;
  let second: unknown;
  try {
    const fixed = unescapeGoHtml(text); // core/safejson.ts: the V8 escaped-key hazard
    first = JSON.parse(fixed) as unknown;
    second = JSON.parse(fixed) as unknown;
  } catch (e) {
    throw new Error(`invalid JSON from ${url}: ${(e as Error).message}`);
  }
  if (canonical(first) !== canonical(second)) {
    throw new Error(`JSON.parse gave two different results for the same response body from ${url} (parser bug guard)`);
  }
  return first;
}

// A small port of `upstream.ts`'s `fetchWithRetry` (see the header note for
// why this isn't imported instead): UA header on every request, 1s/2s/4s
// backoff, 3 attempts.
async function fetchJsonRetried(
  fetchImpl: FetchImpl,
  sleepImpl: SleepImpl,
  ua: string,
  url: string,
): Promise<unknown> {
  let lastErr: unknown;
  for (let attempt = 0; attempt < RETRIES; attempt++) {
    try {
      const res = await fetchImpl(url, { headers: { "User-Agent": ua } });
      if (!res.ok) throw new Error(`${res.status} fetching ${url}`);
      const text = await res.text();
      return parseJsonChecked(text, url);
    } catch (e) {
      lastErr = e;
    }
    if (attempt < RETRIES - 1) await sleepImpl(BACKOFF_MS[attempt]!);
  }
  throw new Error(`failed to fetch ${url} after ${RETRIES} attempts: ${String(lastErr)}`);
}

// A Discord snowflake as the API sends it (number or numeric string) --
// ported from `upstream.ts`'s `parseSnowflake` (see header note).
function parseSnowflake(value: unknown): string | null {
  if (typeof value === "boolean") return null;
  if (typeof value === "number") return Number.isInteger(value) ? String(value) : null;
  if (typeof value === "string" && /^[0-9]+$/.test(value)) return value;
  return null;
}

// ---------------------------------------------------------------------
// The pure comparison core -- no I/O below this line until `diffUpstream`.
// ---------------------------------------------------------------------

// JSON Pointer escaping (RFC 6901), same rule as `formats/cmini/1/index.ts`'s
// (unexported) `pointerSegment`.
function pointerSegment(raw: string): string {
  return raw.replace(/~/g, "~0").replace(/\//g, "~1");
}

// The first JSON path at which `a` and `b` disagree, or null if they're
// deep-equal. Object keys are walked in sorted order (matching
// `canonical()`'s own key order) so "first" is deterministic regardless of
// which side's insertion order produced the value.
export function pathDiff(a: unknown, b: unknown, path = ""): string | null {
  if (a === b) return null;
  const aArr = Array.isArray(a);
  const bArr = Array.isArray(b);
  const aObj = a !== null && typeof a === "object";
  const bObj = b !== null && typeof b === "object";

  if (aArr && bArr) {
    const len = Math.max(a.length, b.length);
    for (let i = 0; i < len; i++) {
      const sub = pathDiff(a[i], b[i], `${path}/${i}`);
      if (sub !== null) return sub;
    }
    return null;
  }
  if (aArr !== bArr) return path || "/";
  if (aObj && bObj) {
    const ao = a as Record<string, unknown>;
    const bo = b as Record<string, unknown>;
    const keys = [...new Set([...Object.keys(ao), ...Object.keys(bo)])].sort();
    for (const k of keys) {
      const sub = pathDiff(ao[k], bo[k], `${path}/${pointerSegment(k)}`);
      if (sub !== null) return sub;
    }
    return null;
  }
  if (aObj !== bObj) return path || "/";
  // Two scalars, not `===`: JSON.stringify catches the one shape mismatch
  // `===` alone would over-report on (e.g. -0 vs 0, both valid JSON 0).
  return JSON.stringify(a) === JSON.stringify(b) ? null : path || "/";
}

// The upstream/ours record shape the diff compares (20-spark.md S3b):
// upstream's detail run through `fromCmini` (the SAME conversion the
// importer writes with), and "ours" already spark-shaped -- comparison
// happens in spark now, never cmini/1.
export interface SparkRecordLike {
  name: string;
  owner: string;
  created_at: string;
  modified_at: string;
  likes: string[];
  payload: spark.Payload;
}

// The record-level projection this file compares on: `likes` sorted
// (order-insensitive), `magic` dropped on both sides (LDB-I10/I11: upstream's
// magic is never akl.gg's, and a followed record's own -- nothing today;
// akl.gg's rules once M2 lands -- is never a mirror difference either).
// `modified_at` itself is NOT part of the projection (LDB-P5, amended
// 2026-09-14: see that invariant's own note for why).
function projectSparkNoMagic(record: SparkRecordLike): unknown {
  const { magic: _magic, ...payload } = record.payload;
  return {
    name: record.name,
    owner: record.owner,
    created_at: record.created_at,
    likes: [...record.likes].sort(),
    payload,
  };
}

// LDB-P5 (M1, design/layout-db/17-magic-ownership.md §3): the projection
// compared is magic-less on BOTH sides, the same rule `import/apply.ts`'s
// own change detection applies. **Amended 2026-09-14**: also `modified_at`-
// less on both sides -- akldb's `modified_at` is its own layout-scope time
// (it moves only on a name/owner/deletion write, `core/events.ts`'s
// `commitWrite`), not a mirror of upstream's; the importer's own freshness
// is tracked by `import_map.upstream_modified_at` instead (LDB-I24), which
// this public-API-only diff has no way to see. Comparing it here just
// reported real content as "differs" for the same 24 live records LDB-I24
// itself exists to stop re-fetching forever.
export function compareRecords(upstream: SparkRecordLike, ours: SparkRecordLike): { equal: boolean; path: string | null } {
  const u = projectSparkNoMagic(upstream);
  const o = projectSparkNoMagic(ours);
  if (canonical(u) === canonical(o)) return { equal: true, path: null };
  return { equal: false, path: pathDiff(u, o) ?? "/" };
}

const RECORD_FIELDS = new Set(["name", "user", "likes", "created_at", "modified_at"]);

export interface ShapeErr {
  path: string;
  message: string;
}

// The upstream side of one comparison: either a spark-converted
// record-like (name/owner/likes/created_at/modified_at/payload), or the
// shape error that `cmini/1`'s own `validate()`, spark's own `validate()`
// (20-spark.md S3b, LDB-I13), or record-field parsing found -- surfaced,
// never papered over.
export type UpstreamParse = { ok: true; detail: SparkRecordLike } | { ok: false; error: ShapeErr };

// Record-field parsing + `payload = raw minus record fields` + `cmini1
// .validate`, then `fromCmini` + spark's OWN `validate` (20-spark.md S3b,
// LDB-I13: "every live upstream detail's `fromCmini` validates as spark") --
// a payload cmini's own (looser) schema accepts but spark's (magic
// semantics, collisions, the `x` size cap) refuses is reported here as
// `invalidUpstream`, not thrown. Reimplemented here (record-field parsing
// + the cmini shape check) rather than importing `apply.ts`'s
// `parseUpstreamDetail` across the plain-Node boundary, per the header
// note (07 §5.1: `link` stays in the payload; only these five keys are
// ever stripped).
export function parseUpstreamRaw(raw: unknown): UpstreamParse {
  if (typeof raw !== "object" || raw === null) {
    return { ok: false, error: { path: "/", message: "detail is not an object" } };
  }
  const r = raw as Record<string, unknown>;

  if (typeof r.name !== "string") {
    return { ok: false, error: { path: "/name", message: "missing or non-string 'name'" } };
  }
  const owner = parseSnowflake(r.user);
  if (owner === null) {
    return { ok: false, error: { path: "/user", message: "missing or invalid 'user' (not a snowflake)" } };
  }
  if (typeof r.created_at !== "string") {
    return { ok: false, error: { path: "/created_at", message: "missing or non-string 'created_at'" } };
  }
  if (typeof r.modified_at !== "string") {
    return { ok: false, error: { path: "/modified_at", message: "missing or non-string 'modified_at'" } };
  }
  const likes: string[] = [];
  if (r.likes !== undefined) {
    if (!Array.isArray(r.likes)) {
      return { ok: false, error: { path: "/likes", message: "'likes' is not an array" } };
    }
    for (const u of r.likes) {
      const s = parseSnowflake(u);
      if (s === null) return { ok: false, error: { path: "/likes", message: "'likes' contains a non-snowflake value" } };
      likes.push(s);
    }
  }

  const payload: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(r)) {
    if (!RECORD_FIELDS.has(k)) payload[k] = v;
  }
  const check = cmini1.validate(payload);
  if (!check.ok) {
    const path = typeof check.error.path === "string" ? check.error.path : "/";
    return { ok: false, error: { path, message: check.error.message } };
  }

  const sparkPayload = fromCmini(payload as unknown as cmini1.Payload);
  const sparkCheck = spark.validate(sparkPayload);
  if (!sparkCheck.ok) {
    const path = typeof sparkCheck.error.path === "string" ? sparkCheck.error.path : "/";
    return { ok: false, error: { path, message: sparkCheck.error.message } };
  }

  return {
    ok: true,
    detail: {
      name: r.name,
      owner,
      created_at: r.created_at,
      modified_at: r.modified_at,
      likes,
      payload: sparkPayload,
    },
  };
}

export interface DiffLine {
  name: string;
  path: string;
  message: string;
}

// Our side of one sampled comparison: a `SparkRecordLike` plus the
// record's id (`ref`) and its own `upstream` link.
export interface OursEntry extends SparkRecordLike {
  ref: string;
  upstream: UpstreamLink | null;
}

// The shrunk "our side" (design/layout-db/review/PROPOSAL.md §2.1, LEDGER.md
// L4): a cheap count, plus a way to draw a random sample of live,
// FOLLOWING layouts (the only ones the diff ever content-compares -- a
// forked record is allowed to differ from upstream by definition, LDB-P5).
// No full-corpus enumeration any more -- `d1Ours` (import/difftick.ts) picks
// the sample with one D1 query; `httpOurs` below pages the (payload-free)
// list route to find candidates, cheap even over HTTP.
export interface OursSource {
  // Live layouts LINKED to upstream (`following` or `forked`) -- the only
  // ones upstream's own `layout_count` can account for. A layout created in
  // akldb itself (bot, client) has no upstream and never counts: akldb is a
  // superset of upstream, not a mirror of it (LDB-P5, amended 2026-09-14).
  linkedLayoutCount(): Promise<number>;
  sampleFollowing(n: number): Promise<OursEntry[]>;
}

// ---------------------------------------------------------------------
// I/O orchestration -- the live diff (`npm run diff-upstream`, the daily
// job's tests/upstream-diff.test.ts, and the `0 4 * * *` cron via
// `import/difftick.ts`'s `d1Ours`).
// ---------------------------------------------------------------------

export const DEFAULT_SAMPLE_SIZE = 50;

export interface DiffOptions {
  upstreamUrl: string;
  ua: string;
  ours: OursSource;
  sampleSize?: number; // default DEFAULT_SAMPLE_SIZE
  fetchImpl?: FetchImpl;
  sleepImpl?: SleepImpl;
}

export interface DiffSummary {
  layoutCount: { upstream: number; ours: number; equal: boolean };
  sampleSize: number; // how many were actually sampled (<= requested, if the corpus is smaller)
  matched: number;
  // a sampled following layout upstream no longer answers for (fetch
  // failed after retries -- deleted, renamed, or a real outage; the diff
  // can't tell those apart from here, so it's reported either way)
  missing: DiffLine[];
  invalidUpstream: DiffLine[];
  contentDiffs: DiffLine[];
  ok: boolean; // true iff every category above is empty/equal
}

function summaryIsOk(s: Omit<DiffSummary, "ok">): boolean {
  return s.layoutCount.equal && s.missing.length === 0 && s.invalidUpstream.length === 0 && s.contentDiffs.length === 0;
}

// X4 (12 §3 X4): `httpOurs` is what `scripts/diff-upstream.mjs` (the CLI)
// and `tests/upstream-diff.test.ts` (the daily CI job) use, both of them
// necessarily off-Worker (a CLI/CI job has no D1 binding to read directly).
// The UA sent here is fixed, not `opts.ua`: these requests all address OUR
// OWN Worker (`dbBaseUrl`), which -- unlike upstream -- never gates on
// User-Agent, so there's nothing for a caller-supplied value to accomplish.
const HTTP_OURS_UA = "akl-db-diff-ours/1.0";

interface ListItem {
  id: string;
  name: string;
  upstream?: UpstreamLink | null;
}
interface ListPage {
  items: ListItem[];
  next_cursor: string | null;
}
interface DetailItem {
  name: string;
  owner: string;
  created_at: string;
  modified_at: string;
  payload?: unknown;
  held?: boolean;
  upstream?: UpstreamLink | null;
}

function pickRandom<T>(items: T[], n: number): T[] {
  const pool = [...items];
  const out: T[] = [];
  while (out.length < n && pool.length > 0) {
    const i = Math.floor(Math.random() * pool.length);
    out.push(pool.splice(i, 1)[0]!);
  }
  return out;
}

export function httpOurs(dbBaseUrl: string, fetchImpl?: FetchImpl, sleepImpl?: SleepImpl): OursSource {
  const doFetch: FetchImpl = fetchImpl ?? ((url, init) => fetch(url, init));
  const doSleep: SleepImpl = sleepImpl ?? realSleep;
  // The plain list route never carries a payload (07 §0.1) and never lists
  // a tombstone (core/records.ts) -- cheap to page in full. Walked ONCE per
  // `httpOurs`: `diffUpstream` asks for the count and the sample together,
  // and both read it. (`/v1/meta.layout_count` is no use for the count: it
  // counts akldb-native layouts too.)
  let listed: Promise<ListItem[]> | undefined;
  function listAll(): Promise<ListItem[]> {
    if (listed === undefined) {
      listed = (async () => {
        const items: ListItem[] = [];
        let cursor: string | undefined;
        for (;;) {
          const qs = new URLSearchParams({ limit: "1000", format: "spark/1" });
          if (cursor !== undefined) qs.set("cursor", cursor);
          const page = (await fetchJsonRetried(doFetch, doSleep, HTTP_OURS_UA, `${dbBaseUrl}/v1/layouts?${qs.toString()}`)) as ListPage;
          items.push(...page.items);
          if (!page.next_cursor) break;
          cursor = page.next_cursor;
        }
        return items;
      })();
    }
    return listed;
  }
  return {
    async linkedLayoutCount() {
      return (await listAll()).filter((item) => (item.upstream ?? null) !== null).length;
    },
    async sampleFollowing(n) {
      const candidates = (await listAll()).filter((item) => item.upstream?.state === "following");
      const picked = pickRandom(candidates, n);
      const out: OursEntry[] = [];
      for (const { id } of picked) {
        const detail = (await fetchJsonRetried(
          doFetch,
          doSleep,
          HTTP_OURS_UA,
          `${dbBaseUrl}/v1/layouts/${encodeURIComponent(id)}?format=spark/1`,
        )) as DetailItem;
        if (detail.held === true || detail.payload === undefined) continue; // unreachable in phase 1 (spark/1 is the one stored lineage)
        const likesRaw = (await fetchJsonRetried(
          doFetch,
          doSleep,
          HTTP_OURS_UA,
          `${dbBaseUrl}/v1/layouts/${encodeURIComponent(id)}/likes`,
        )) as { user_ids: string[] };
        out.push({
          ref: id,
          name: detail.name,
          owner: detail.owner,
          created_at: detail.created_at,
          modified_at: detail.modified_at,
          likes: likesRaw.user_ids,
          payload: detail.payload as spark.Payload,
          upstream: detail.upstream ?? null,
        });
      }
      return out;
    },
  };
}

// Fetches upstream's `/meta` and, for each sampled following layout, its
// single-record detail -- never the whole upstream corpus (07 §6 S8's
// `?full=1` engine-bug investigation no longer applies at this scale, but
// the double-parse guard in `fetchJsonRetried`/`parseJsonChecked` stays
// regardless). Never throws for a *content* difference -- only for a
// layoutCount/sample fetch failure the retries couldn't recover from; the
// caller (script, daily test, or the diff cron) decides what a thrown
// error means.
export async function diffUpstream(opts: DiffOptions): Promise<DiffSummary> {
  const fetchImpl: FetchImpl = opts.fetchImpl ?? ((url, init) => fetch(url, init));
  const sleepImpl: SleepImpl = opts.sleepImpl ?? realSleep;
  const { upstreamUrl, ua, ours } = opts;
  const sampleSize = opts.sampleSize ?? DEFAULT_SAMPLE_SIZE;

  const [upstreamMetaRaw, ourCount, sample] = await Promise.all([
    fetchJsonRetried(fetchImpl, sleepImpl, ua, `${upstreamUrl}/meta`),
    ours.linkedLayoutCount(),
    ours.sampleFollowing(sampleSize),
  ]);
  const upstreamMeta = upstreamMetaRaw as { layout_count?: number };
  const layoutCount = { upstream: upstreamMeta.layout_count ?? -1, ours: ourCount, equal: upstreamMeta.layout_count === ourCount };

  const missing: DiffLine[] = [];
  const invalidUpstream: DiffLine[] = [];
  const contentDiffs: DiffLine[] = [];
  let matched = 0;

  for (const entry of sample) {
    let raw: unknown;
    try {
      raw = await fetchJsonRetried(fetchImpl, sleepImpl, ua, `${upstreamUrl}/layouts/${encodeURIComponent(entry.name.toLowerCase())}`);
    } catch (e) {
      missing.push({ name: entry.name, path: "/", message: `upstream fetch failed: ${(e as Error).message}` });
      continue;
    }
    const parsed = parseUpstreamRaw(raw);
    if (!parsed.ok) {
      invalidUpstream.push({ name: entry.name, path: parsed.error.path, message: parsed.error.message });
      continue;
    }
    const cmp = compareRecords(parsed.detail, entry);
    if (cmp.equal) {
      matched++;
    } else {
      contentDiffs.push({ name: entry.name, path: cmp.path ?? "/", message: "content differs from upstream" });
    }
  }

  const summary = { layoutCount, sampleSize: sample.length, matched, missing, invalidUpstream, contentDiffs };
  return { ...summary, ok: summaryIsOk(summary) };
}
