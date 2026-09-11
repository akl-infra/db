// ETag/304 for the four polled routes (07 §6 S6, 03 §5): `/v1/meta`,
// `/v1/layouts` (list and `full=1`), `/v1/changes`, `/v1/authors`. The
// ETag is `"<head seq>:<sha256(canonical(query))>[:16]"` -- the event log
// head plus a hash of the query, so two different queries against the same
// head get different ETags but the same query at the same head always
// agrees. `headSeq()` is the ONE indexed read (`MAX(seq)`) a route does
// before anything else; a 304 costs exactly that one read.
//
// LDB-R9..R11: `/v1/meta` and `/v1/authors` also show AUTHOR data, and an
// author-only change appends no event, so the seq alone can't validate
// them. `/v1/authors` keys on `authors_head.version` alone (its body is a
// function of the `authors` rows and nothing else -- no event moves it);
// `/v1/meta` keys on the seq plus `authors_head` plus the two
// `import_state` records it shows (`readHead`, still one query).
// `authors_head` (migrations/0007) is moved by triggers on every author
// insert, delete or rename, and by nothing else -- never by `last_seen_at`
// bookkeeping.
import type { Context } from "hono";
import { canonical } from "./canonical";

export async function headSeq(db: D1Database): Promise<number> {
  const row = await db.prepare("SELECT MAX(seq) AS seq FROM events").first<{ seq: number | null }>();
  return row?.seq ?? 0;
}

// `authors_head`'s one row (migrations/0007).
export interface AuthorsHead {
  version: number;
  modifiedAt: string | null;
}

// `/v1/authors`' whole validator: one primary-key read.
export async function authorsHead(db: D1Database): Promise<AuthorsHead> {
  const row = await db
    .prepare("SELECT version, modified_at FROM authors_head WHERE id = 1")
    .first<{ version: number; modified_at: string | null }>();
  return { version: row?.version ?? 0, modifiedAt: row?.modified_at ?? null };
}

export interface Head {
  seq: number;
  authors: AuthorsHead;
  // `import_state.value` for each of `readHead`'s `stateKeys`, in order
  // (`null` when the key has no row).
  state: (string | null)[];
}

// `/v1/meta`'s whole validator in ONE round trip: the event head
// (`MAX(seq)` on the INTEGER PRIMARY KEY), `authors_head`'s row, and one
// `import_state` primary-key lookup per `stateKeys` entry -- each a
// scalar subquery, so a 304 costs one D1 query of indexed reads.
export async function readHead(db: D1Database, stateKeys: readonly string[] = []): Promise<Head> {
  const cols = [
    "(SELECT MAX(seq) FROM events) AS seq",
    "(SELECT version FROM authors_head WHERE id = 1) AS authors_version",
    "(SELECT modified_at FROM authors_head WHERE id = 1) AS authors_modified_at",
    ...stateKeys.map((_, i) => `(SELECT value FROM import_state WHERE key = ?${i + 1}) AS state_${i}`),
  ];
  const row = await db
    .prepare(`SELECT ${cols.join(", ")}`)
    .bind(...stateKeys)
    .first<Record<string, string | number | null>>();
  return {
    seq: (row?.seq as number | null) ?? 0,
    authors: {
      version: (row?.authors_version as number | null) ?? 0,
      modifiedAt: (row?.authors_modified_at as string | null) ?? null,
    },
    state: stateKeys.map((_, i) => (row?.[`state_${i}`] as string | null | undefined) ?? null),
  };
}

// 20-spark.md S2 (LDB-R1 amended): bumped whenever the WIRE shape changes
// independently of the event log's own head -- spark/1 the stored format,
// the label rule, `/v1/formats`'s `role`/`aliases`, etc. Without this, a
// pre-deploy `If-None-Match` (or an edge-cached body, `caches.default`)
// at an unchanged head seq would keep answering 304/a stale cached body
// with the OLD shape forever.
// 21-formats.md §2.3: bumped again -- several formats per layout, scoped
// If-Match tokens, `layout_rev` replacing the bare `rev`, `?format=`
// required. No cached 304/edge-cached body from before this slice can keep
// serving the old shape at an unchanged head seq.
const WIRE_VERSION = 3;

export async function etagFor(headSeqValue: number, query: unknown): Promise<string> {
  const hash = await sha256Hex(canonical({ wireVersion: WIRE_VERSION, query: query ?? null }));
  return `"${headSeqValue}:${hash.slice(0, 16)}"`;
}

async function sha256Hex(s: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

// `If-None-Match` may be `*` or a comma-separated list of etags, weak or
// strong. RFC 7232 §3.2 says If-None-Match uses the WEAK comparison
// (`W/"x"` matches `"x"`), and that is not academic here: Cloudflare
// rewrites a strong ETag to `W/"…"` whenever it compresses the response
// body (every client that sends `Accept-Encoding: gzip, br` -- Node's
// fetch, browsers), so a well-behaved client echoes the weak form back
// and, under a strict compare, never sees a 304 (2026-09-10, the spark
// bot's once-a-minute `/v1/meta` heartbeat from Fly got a 200 every time
// while the SAME header from elsewhere happened to be answered by the
// edge cache's own weak-aware match). Ours are always strong on the way
// out; strip `W/` on the way in and compare the opaque tags.
function etagMatches(header: string, etag: string): boolean {
  if (header.trim() === "*") return true;
  const wanted = stripWeak(etag);
  return header
    .split(",")
    .map((s) => stripWeak(s.trim()))
    .includes(wanted);
}

function stripWeak(tag: string): string {
  return tag.startsWith("W/") ? tag.slice(2) : tag;
}

// Returns a 304 (same ETag + Cache-Control, no body) when the request's
// `If-None-Match` already matches, or a cached 200 when `caches.default`
// holds one for the same ETag; otherwise null (the caller does the real
// work and calls `cachePut` on the result). `caches.default` is inert on
// `*.workers.dev` (07 §0.1) -- both the match and the later put are
// best-effort, wrapped in try/catch so a Worker running there behaves
// exactly as if there were no edge cache at all.
export async function conditional(c: Context, etag: string, cacheControl: string): Promise<Response | null> {
  const inm = c.req.header("If-None-Match");
  if (inm !== undefined && etagMatches(inm, etag)) {
    return new Response(null, { status: 304, headers: { ETag: etag, "Cache-Control": cacheControl } });
  }

  try {
    const hit = await caches.default.match(c.req.raw);
    if (hit !== undefined && hit.headers.get("ETag") === etag) return hit;
  } catch {
    // caches.default unavailable (e.g. *.workers.dev) -- fall through
  }

  return null;
}

// Stores a freshly-built response (which must already carry the ETag and
// Cache-Control headers `conditional()` was called with) into the edge
// cache. Called with a clone -- the caller still owns the response it
// returns to the client. Best-effort, same reasoning as `conditional()`.
export async function cachePut(c: Context, res: Response): Promise<void> {
  try {
    await caches.default.put(c.req.raw, res);
  } catch {
    // best-effort only
  }
}
