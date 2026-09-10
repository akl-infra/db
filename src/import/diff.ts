// The D12 mirror diff (07 §6 S8): compares every upstream cmini layout
// against ours over HTTP, on the `cmini/1` projection. Used by both
// `scripts/diff-upstream.mjs` (a plain Node CLI) and `tests/upstream-diff
// .test.ts` (the daily job) / `tests/import/diff-unit.test.ts` (the offline
// unit half).
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
// consistently came back correct -- caught only because `diff-upstream`
// re-fetched and reparsed and got a DIFFERENT, correct answer, making the
// "content differs" it briefly reported a false alarm from a parser
// hiccup, not a real upstream/mirror difference. A silent, intermittent
// false positive like that is exactly what would make LDB-P5's daily job
// untrustworthy (red for no actionable reason) -- so every parse here is
// self-checked against a second parse of the same bytes before it's
// trusted, and a disagreement is treated as failure worth retrying the
// whole fetch for, on the chance a fresh response parses cleanly.
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

// The upstream/ours record shape the D12 diff compares (20-spark.md S3b):
// upstream's detail run through `fromCmini` (the SAME conversion the
// importer writes with), and "ours" already spark-shaped (`d1Ours` via
// `storedAsSpark`, `httpOurs` via `?as=spark/1`) -- comparison happens in
// spark now, never cmini/1.
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
function projectSparkNoMagic(record: SparkRecordLike): unknown {
  const { magic: _magic, ...payload } = record.payload;
  return {
    name: record.name,
    owner: record.owner,
    created_at: record.created_at,
    modified_at: record.modified_at,
    likes: [...record.likes].sort(),
    payload,
  };
}

// LDB-P5 (M1, design/layout-db/17-magic-ownership.md §3): the projection
// compared is magic-less on BOTH sides, the same rule `import/apply.ts`'s
// own change detection applies.
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
// never papered over (07 §6 S8: "that is the D12 finding this slice exists
// to surface").
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

// Our side of one comparison: a `SparkRecordLike` plus the record's id
// (`ref`) and its own `upstream` link, read straight off the wire/D1 (no
// lazy per-record resolution any more -- 20-spark.md S3b, §8 R-H6: both
// `httpOurs` and `d1Ours` already carry it as part of `full()`'s own
// response/row).
export interface OursEntry extends SparkRecordLike {
  ref: string;
  upstream: UpstreamLink | null;
}

export interface UpstreamEntry {
  name: string;
  parsed: UpstreamParse;
}

export interface CorpusDiff {
  matched: number;
  missing: DiffLine[];
  invalidUpstream: DiffLine[];
  contentDiffs: DiffLine[];
  extra: DiffLine[];
  // Name-matched local records that are forked or unlinked (20-spark.md
  // S3b, LDB-P5): informational, never a failure -- a forked record is by
  // definition allowed to differ from upstream.
  divergent: DiffLine[];
  // Name-matched local records with NO upstream link at all (null). After the
  // record migration this can't happen: every name-matched record has an
  // `import_map` row, so a resolved link. Before it, a source that can't
  // apply the legacy rule (`httpOurs`, over the wire) sees legacy rows as
  // null. A FAILURE: "nothing compared" must never read as "clean"
  // (2026-09-11 preview finding).
  unresolved: DiffLine[];
}

// Pure: matches upstream entries to ours by `name.toLowerCase()` (03 §1's
// id-first/name-second ref rule doesn't apply here -- upstream's `?full=1`
// carries no id, 07 §0.1). A name-matched pair is content-compared only
// when OUR side's `upstream.state === "following"` (LDB-P5's own wording,
// decision 16: following is the only state the importer/diff ever act on);
// otherwise it's `divergent`. Leftover local names are reported as `extra`
// only when they're `following` (06 §2: a record here that follows
// upstream but upstream no longer lists is a real mirror bug; one that
// doesn't follow is expected local divergence and not reported at all).
export function diffCorpus(upstream: Map<string, UpstreamEntry>, ours: Map<string, OursEntry>): CorpusDiff {
  const missing: DiffLine[] = [];
  const invalidUpstream: DiffLine[] = [];
  const contentDiffs: DiffLine[] = [];
  const divergent: DiffLine[] = [];
  const unresolved: DiffLine[] = [];
  let matched = 0;
  const consumed = new Set<string>();

  for (const [key, up] of upstream) {
    const our = ours.get(key);
    if (our === undefined) {
      missing.push({ name: up.name, path: "/", message: "no local record by this name" });
      continue;
    }
    consumed.add(key);
    if (!up.parsed.ok) {
      invalidUpstream.push({ name: up.name, path: up.parsed.error.path, message: up.parsed.error.message });
      continue;
    }
    if (our.upstream === null) {
      unresolved.push({ name: up.name, path: "/", message: "name-matched local record has no upstream link (a legacy row before the record migration, or a source that cannot resolve it)" });
      continue;
    }
    if (our.upstream.state !== "following") {
      divergent.push({ name: up.name, path: "/", message: "name-matched local record is forked from upstream" });
      continue;
    }
    const cmp = compareRecords(up.parsed.detail, our);
    if (!cmp.equal) {
      contentDiffs.push({ name: up.name, path: cmp.path ?? "/", message: "content differs from upstream" });
      continue;
    }
    matched++;
  }

  const extra: DiffLine[] = [];
  for (const [key, our] of ours) {
    if (consumed.has(key)) continue;
    if (our.upstream?.state === "following") {
      extra.push({
        name: our.name,
        path: "/",
        message: "follows upstream but upstream no longer lists a layout by this name",
      });
    }
  }

  return { matched, missing, invalidUpstream, contentDiffs, extra, divergent, unresolved };
}

// Compared by ID, not by name: upstream's `/authors` is `name -> id` and
// keeps EVERY historical name a user has ever had on file (a rename adds a
// key, never replaces one -- confirmed against the real corpus, 07 §6 S5's
// `applyAuthors` upserts our `authors(user_id PK, name)` row's `name` only
// when it differs, one row per id, "best-effort bookkeeping" -- no reason
// to keep the old alias once we've seen the new one). A name-keyed
// comparison over the real 4174-layout corpus reported 55 "missing" names
// that were, every one, an id we already have under a *different* (more
// current) name -- not a mirror gap, just this shape mismatch (07 §6 S8's
// local proof found this; documented here so it isn't rediscovered as a
// false alarm). The invariant that actually matters -- "we know every id
// upstream currently attributes a layout to, and only those" -- is over
// ids; `aliasCount` (informational, never fails the diff) is how many of
// upstream's name entries are exactly that kind of old alias.
export interface AuthorsDiff {
  missing: { id: string; name: string }[]; // upstream ids we don't have at all (name is one upstream name for it)
  extra: { id: string; name: string }[]; // our ids upstream doesn't have at all
  aliasCount: number;
}

export function diffAuthors(upstream: Record<string, string>, ours: Record<string, string>): AuthorsDiff {
  const upstreamNameById = new Map<string, string>(); // last-wins is fine -- purely for a readable label
  for (const [name, id] of Object.entries(upstream)) upstreamNameById.set(id, name);
  const oursNameById = new Map<string, string>();
  for (const [name, id] of Object.entries(ours)) oursNameById.set(id, name);

  const upstreamIds = new Set(upstreamNameById.keys());
  const oursIds = new Set(oursNameById.keys());

  const missing = [...upstreamIds]
    .filter((id) => !oursIds.has(id))
    .map((id) => ({ id, name: upstreamNameById.get(id)! }));
  const extra = [...oursIds].filter((id) => !upstreamIds.has(id)).map((id) => ({ id, name: oursNameById.get(id)! }));
  const aliasCount = Object.entries(upstream).filter(([name, id]) => oursIds.has(id) && oursNameById.get(id) !== name).length;

  return { missing, extra, aliasCount };
}

// X4 (12 §3 X4): "our" side of the diff, behind an interface -- so the same
// pure comparison core above can be driven either from a live HTTP mirror
// (`httpOurs`, the CLI and the daily CI job) or straight from this
// Worker's own D1 (`src/import/difftick.ts`'s `d1Ours`), with NO self-HTTP
// from the diff cron (LDB-C4: the cron reading its own origin over HTTP
// would need to be its own subrequest budget AND could deadlock a
// single-invocation cron against itself under load). `full()` yields every
// live record as a `cmini/1` detail (`OursEntry`), or `{ held: string }`
// naming a record that cannot translate to `cmini/1` at all -- unreachable
// in phase 1 (cmini/1 and akl/1 always translate both ways) but real once
// `mana2/1` or a future advanced format lands (X2), so `diffUpstream`
// reports it rather than assuming it can't happen.
export interface OursSource {
  full(): AsyncIterable<OursEntry | { held: string }>;
  authors(): Promise<Record<string, string>>;
  layoutCount(): Promise<number>;
}

// ---------------------------------------------------------------------
// I/O orchestration -- the live diff (`npm run diff-upstream`, the daily
// job's tests/upstream-diff.test.ts, and (X4) the `0 4 * * *` cron via
// `import/difftick.ts`'s `d1Ours`).
// ---------------------------------------------------------------------

export interface DiffOptions {
  upstreamUrl: string;
  ua: string;
  ours: OursSource;
  fetchImpl?: FetchImpl;
  sleepImpl?: SleepImpl;
}

export interface DiffSummary {
  upstreamCount: number;
  upstreamDupNames: number;
  ourCount: number;
  held: string[]; // our records that read back `held` for as=cmini/1 (unreachable in phase 1; reported, not swallowed)
  layoutCount: { upstream: number; ours: number; equal: boolean };
  authors: AuthorsDiff;
  corpus: CorpusDiff;
  ok: boolean; // true iff every category above is empty/equal
}

interface RawFullResponse {
  layouts: Record<string, unknown>[];
}
interface OurFullItem {
  id: string;
  name: string;
  owner: string;
  created_at: string;
  modified_at: string;
  like_count: number;
  likes?: string[]; // inline on newer builds (W1); older ones need the /likes fallback below
  held?: boolean;
  payload?: unknown;
  // 20-spark.md S3a: `sansPayload` carries this on every list/full=1 row --
  // read straight off the wire, no `/history` lookup (§8 R-H6).
  upstream?: UpstreamLink | null;
}
interface OurFullResponse {
  items: OurFullItem[];
}

// `likes` is inline on both `?full=1&as=cmini/1` items and `/v1/layouts/
// {ref}?as=cmini/1` once it's added (W1, landing alongside this slice) --
// use it when present; otherwise fall back to the separate `/likes`
// endpoint this slice was written against, so `diff-upstream` works
// against either shape without needing to know which one it's talking to.
async function resolveOurLikes(
  fetchImpl: FetchImpl,
  sleepImpl: SleepImpl,
  ua: string,
  dbBaseUrl: string,
  ref: string,
  item: { likes?: string[]; like_count: number },
): Promise<string[]> {
  if (Array.isArray(item.likes)) return item.likes;
  if (item.like_count <= 0) return [];
  const likesRaw = await fetchJsonRetried(fetchImpl, sleepImpl, ua, `${dbBaseUrl}/v1/layouts/${encodeURIComponent(ref)}/likes`);
  return (likesRaw as { user_ids: string[] }).user_ids;
}

// `divergent` (a name-matched local record that's forked or unlinked) is
// informational only -- LDB-P5: it never gates `ok`.
function summaryIsOk(s: Omit<DiffSummary, "ok">): boolean {
  return (
    s.held.length === 0 &&
    s.layoutCount.equal &&
    s.authors.missing.length === 0 &&
    s.authors.extra.length === 0 &&
    s.corpus.missing.length === 0 &&
    s.corpus.invalidUpstream.length === 0 &&
    s.corpus.contentDiffs.length === 0 &&
    s.corpus.extra.length === 0 &&
    s.corpus.unresolved.length === 0
  );
}

// X4 (12 §3 X4): `httpOurs` is today's pre-refactor "our side" behaviour,
// unchanged, just moved behind `OursSource` -- what `scripts/diff-upstream.mjs`
// (the CLI) and `tests/upstream-diff.test.ts` (the daily CI job) still use,
// both of them necessarily off-Worker (a CLI/CI job has no D1 binding to
// read directly). The UA sent here is fixed, not `opts.ua`: these requests
// all address OUR OWN Worker (`dbBaseUrl`), which -- unlike upstream (0.1)
// -- never gates on User-Agent, so there's nothing for a caller-supplied
// value to accomplish.
const HTTP_OURS_UA = "akl-db-diff-ours/1.0";

export function httpOurs(dbBaseUrl: string, fetchImpl?: FetchImpl, sleepImpl?: SleepImpl): OursSource {
  const doFetch: FetchImpl = fetchImpl ?? ((url, init) => fetch(url, init));
  const doSleep: SleepImpl = sleepImpl ?? realSleep;
  return {
    async *full() {
      // 20-spark.md S3b: reads `?as=spark/1` (was `cmini/1`) -- comparison
      // happens in spark now, and the item's own `upstream` (§8 R-H6) means
      // no per-leftover `/history` follow-up is needed any more.
      const raw = await fetchJsonRetried(doFetch, doSleep, HTTP_OURS_UA, `${dbBaseUrl}/v1/layouts?full=1&as=spark/1`);
      const ourFull = raw as OurFullResponse;
      if (!Array.isArray(ourFull.items)) throw new Error(`${dbBaseUrl}/v1/layouts?full=1&as=spark/1 is not {items: [...]}`);
      for (const item of ourFull.items) {
        if (item.held === true || item.payload === undefined) {
          yield { held: item.name };
          continue;
        }
        const likes = await resolveOurLikes(doFetch, doSleep, HTTP_OURS_UA, dbBaseUrl, item.id, item);
        yield {
          ref: item.id,
          name: item.name,
          owner: item.owner,
          created_at: item.created_at,
          modified_at: item.modified_at,
          likes,
          payload: item.payload as spark.Payload,
          upstream: item.upstream ?? null,
        };
      }
    },
    async authors() {
      return (await fetchJsonRetried(doFetch, doSleep, HTTP_OURS_UA, `${dbBaseUrl}/v1/authors`)) as Record<string, string>;
    },
    async layoutCount() {
      const meta = (await fetchJsonRetried(doFetch, doSleep, HTTP_OURS_UA, `${dbBaseUrl}/v1/meta`)) as { layout_count?: number };
      return meta.layout_count ?? -1;
    },
  };
}

// Fetches upstream, reads `opts.ours` for the other side, matches by name.
// 20-spark.md S3b (§8 R-H6): follow status comes straight off each
// `OursEntry.upstream`, read eagerly as part of `ours.full()` itself -- no
// per-leftover `/history` follow-up any more. Never throws for a *content*
// difference -- only for a network/shape failure the retries couldn't
// recover from; the caller (script, daily test, or X4's cron) decides what
// a thrown error means.
export async function diffUpstream(opts: DiffOptions): Promise<DiffSummary> {
  const fetchImpl: FetchImpl = opts.fetchImpl ?? ((url, init) => fetch(url, init));
  const sleepImpl: SleepImpl = opts.sleepImpl ?? realSleep;
  const { upstreamUrl, ua, ours } = opts;

  const [upstreamFullRaw, upstreamAuthorsRaw, upstreamMetaRaw, ourAuthorsRaw, ourLayoutCount] = await Promise.all([
    fetchJsonRetried(fetchImpl, sleepImpl, ua, `${upstreamUrl}/layouts?full=1`),
    fetchJsonRetried(fetchImpl, sleepImpl, ua, `${upstreamUrl}/authors`),
    fetchJsonRetried(fetchImpl, sleepImpl, ua, `${upstreamUrl}/meta`),
    ours.authors(),
    ours.layoutCount(),
  ]);

  const upstreamFull = upstreamFullRaw as RawFullResponse;
  if (!Array.isArray(upstreamFull.layouts)) throw new Error("upstream /layouts?full=1 is not {layouts: [...]}");

  // Upstream's own dedupe rule (07 §0.1: names are unique among live
  // records -- a duplicate here is itself a finding, so entries that
  // collide are dropped from the comparable map and counted separately,
  // same posture as `upstream.ts`'s `full()`.
  const upstream = new Map<string, UpstreamEntry>();
  const dupNames = new Set<string>();
  for (const raw of upstreamFull.layouts) {
    const name = typeof raw.name === "string" ? raw.name : undefined;
    if (name === undefined) continue;
    const key = name.toLowerCase();
    if (upstream.has(key) || dupNames.has(key)) {
      upstream.delete(key);
      dupNames.add(key);
      continue;
    }
    upstream.set(key, { name, parsed: parseUpstreamRaw(raw) });
  }

  const held: string[] = [];
  const ours_ = new Map<string, OursEntry>();
  for await (const item of ours.full()) {
    if ("held" in item) {
      held.push(item.held);
      continue;
    }
    ours_.set(item.name.toLowerCase(), item);
  }

  const corpus = diffCorpus(upstream, ours_);

  // A record the bulk comparison flags as differing gets ONE more look
  // before being reported, through a FRESH single-record upstream fetch --
  // rebuilt as a `SparkRecordLike`, re-compared. Why: this slice's own local
  // proof (07 §6 S8) found that `JSON.parse` of the ~5 MB upstream `?full=1`
  // body can -- reproduced identically under Node 24.20.0 and 26.8.1, so not
  // specific to one Node build -- silently substitute a literal backslash
  // for a `\uXXXX`-escaped key character (upstream's own `&`/`<`), and that
  // the wrong decoding is sometimes STABLE across repeated parses of the
  // very same bytes (so `parseJsonChecked`'s double-parse guard alone
  // doesn't catch every case), while every small single-record fetch in
  // that investigation parsed correctly, every time. That hazard is
  // specific to a big single-string JSON.parse -- it lives on the UPSTREAM
  // side only here: `ours` either never does one at all (`d1Ours`, X4:
  // every record is a separate, small D1 read, `JSON.parse`d individually)
  // or already ran the SAME double-parse-checked `fetchJsonRetried` while
  // building `ours_` above (`httpOurs`) -- so a second fetch of OUR OWN
  // side buys nothing further, and this reconfirmation re-reads only
  // upstream, comparing against the `ours_` entry already in hand.
  const confirmedContentDiffs: DiffLine[] = [];
  let reconfirmedMatches = 0;
  for (const diff of corpus.contentDiffs) {
    const key = diff.name.toLowerCase();
    const ourEntry = ours_.get(key);
    if (ourEntry === undefined) {
      confirmedContentDiffs.push(diff); // unreachable: `diff.name` came from `ours_` itself
      continue;
    }
    const upRawSingle = await fetchJsonRetried(fetchImpl, sleepImpl, ua, `${upstreamUrl}/layouts/${encodeURIComponent(key)}`);
    const upParsedSingle = parseUpstreamRaw(upRawSingle);
    if (!upParsedSingle.ok) {
      confirmedContentDiffs.push({ name: diff.name, path: upParsedSingle.error.path, message: upParsedSingle.error.message });
      continue;
    }
    const recheck = compareRecords(upParsedSingle.detail, ourEntry);
    if (recheck.equal) {
      reconfirmedMatches++;
    } else {
      confirmedContentDiffs.push({
        name: diff.name,
        path: recheck.path ?? "/",
        message: "content differs from upstream (confirmed via a fresh upstream refetch)",
      });
    }
  }
  corpus.contentDiffs = confirmedContentDiffs;
  corpus.matched += reconfirmedMatches;

  const upstreamMeta = upstreamMetaRaw as { layout_count?: number };
  const layoutCount = {
    upstream: upstreamMeta.layout_count ?? -1,
    ours: ourLayoutCount,
    equal: upstreamMeta.layout_count === ourLayoutCount,
  };

  const authors = diffAuthors(upstreamAuthorsRaw as Record<string, string>, ourAuthorsRaw);

  const summary = { upstreamCount: upstream.size, upstreamDupNames: dupNames.size, ourCount: ours_.size, held, layoutCount, authors, corpus };
  return { ...summary, ok: summaryIsOk(summary) };
}
