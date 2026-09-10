// ETag/304 for the four polled routes (07 §6 S6, 03 §5): `/v1/meta`,
// `/v1/layouts` (list and `full=1`), `/v1/changes`, `/v1/authors`. The
// ETag is `"<head seq>:<sha256(canonical(query))>[:16]"` -- the event log
// head plus a hash of the query, so two different queries against the same
// head get different ETags but the same query at the same head always
// agrees. `headSeq()` is the ONE indexed read (`MAX(seq)`) a route does
// before anything else; a 304 costs exactly that one read.
import type { Context } from "hono";
import { canonical } from "./canonical";

export async function headSeq(db: D1Database): Promise<number> {
  const row = await db.prepare("SELECT MAX(seq) AS seq FROM events").first<{ seq: number | null }>();
  return row?.seq ?? 0;
}

// 20-spark.md S2 (LDB-R1 amended): bumped whenever the WIRE shape changes
// independently of the event log's own head -- spark/1 the stored format,
// the label rule, `/v1/formats`'s `role`/`aliases`, etc. Without this, a
// pre-deploy `If-None-Match` (or an edge-cached body, `caches.default`)
// at an unchanged head seq would keep answering 304/a stale cached body
// with the OLD shape forever.
const WIRE_VERSION = 2;

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
