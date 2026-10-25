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
import { platformOf } from "../app";
import { toStore, type StoreArg } from "../store/arg";

export async function headSeq(dbArg: StoreArg): Promise<number> {
  return toStore(dbArg).head.headSeq();
}

// `authors_head`'s one row (migrations/0007).
export interface AuthorsHead {
  version: number;
  modifiedAt: string | null;
}

// `/v1/authors`' whole validator: one primary-key read.
export async function authorsHead(dbArg: StoreArg): Promise<AuthorsHead> {
  return toStore(dbArg).head.authorsHead();
}

export interface Head {
  seq: number;
  authors: AuthorsHead;
  // `import_state.value` for each of `readHead`'s `stateKeys`, in order
  // (`null` when the key has no row).
  state: (string | null)[];
  // LDB-M3/LDB-I22: the rolling-24h `upstream_deleted` tombstone count, as
  // of `deletesSinceIso` -- folded into this SAME query (one more scalar
  // subquery) rather than a separate `.prepare()` call, so `/v1/meta`'s
  // own "at most 4 prepares" budget (LDB-R9) doesn't grow. 0 when
  // `deletesSinceIso` wasn't passed (every caller but `/v1/meta`).
  deletes24h: number;
}

// `/v1/meta`'s whole validator in ONE round trip: the event head
// (`MAX(seq)` on the INTEGER PRIMARY KEY), `authors_head`'s row, one
// `import_state` primary-key lookup per `stateKeys` entry, and (when asked)
// the rolling delete count -- each a scalar subquery, so a 304 costs one
// D1 query of indexed reads.
export async function readHead(dbArg: StoreArg, stateKeys: readonly string[] = [], deletesSinceIso?: string): Promise<Head> {
  return toStore(dbArg).head.readHead(stateKeys, deletesSinceIso);
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
// L5 moderation (§4.5, LDB-MD3): bumped 3 -> 4 -- every layout wire shape
// gained `like_adjust`/`link`. H24 (2026-09-13): bumped 4 -> 5 -- the admin
// like-count override was removed, so `like_adjust` disappears from every
// layout wire shape again (`link` stays). design/layout-db/23-geometry.md
// (LDB-F27..F33): bumped 5 -> 6 -- spark/1's own payload shape changed
// (`keys` a char-keyed map -> an ordered array with optional `char`,
// `board` a `{kind, stagger, cmini}` object -> one required word, the `TB`
// finger dropped, magic's `default`/`same`/`opposite` tagged instead of
// bare strings) -- no cached 304/edge-cached body from before this slice
// can keep serving the old spark/1 shape at an unchanged head seq.
//
// [LDB-V1] 2026-09-13 (design/layout-db/25-api-versioning.md): this
// counter IS the API's own minor version, exported as `WIRE_VERSION` and
// re-exposed by `core/version.ts` as `API_MINOR` -- every one of the
// comments above is a real changelog entry of a `/v1` wire-shape change,
// which is exactly what a client-facing minor version is supposed to
// enumerate. Giving the API a second, independently-bumped counter would
// let the two drift (one bumped, the other forgotten); reusing this one
// makes that structurally impossible. From here on, an entry above (or a
// new one) is also a line in `db/CHANGELOG-API.md` -- `tests/contract/
// contract.test.ts`'s [LDB-V5] case fails the build otherwise. Bumped 6 ->
// 7 by the versioning slice itself (`db/CHANGELOG-API.md` 1.7): `GET
// /v1/meta` gained `api: {major, minor}` and `deprecations: []`, and every
// response (success or error) gained the `X-AKLDB-API` header
// (`core/version.ts`) -- additive, so this is the FIRST entry made under
// the policy it introduces, not exempt from it.
// 8 (2026-09-13): `GET /v1/changes?wait=` is honoured for EVERY request
//   signed on the client lane -- the `feed:wait` extra cap is implied, never
//   required (saltorbit: "any registered client should get this by default").
//   Response shapes unchanged; the route table's auth column changed.
// 9 (2026-09-13): hostile/vanished-upstream defenses (LDB-I22/I23/I25/I26/M3):
//   `/v1/meta.health.import` block (stalled/deletes_24h/budget/planned/applied/
//   disabled), `POST /v1/admin/import/unstall`, `POST /v1/admin/import/
//   restore-deleted`, event kind `admin.import_unstalled`. Additive.
// 10 (2026-09-13): rogue-trusted-client hardening (db/README.md's "Rogue
//   trusted client" runbook) -- `GET /v1/meta`'s `health` gained
//   `clients: {suspended, budget}`; three new admin routes (`POST
//   /v1/admin/clients/{id}/suspend`, `/reactivate`, `/revert`); `clients
//   .status` gained a new value, `suspended` (`GET /v1/admin/clients`'
//   own `status` field can now read it). Additive only -- no existing
//   field, route or status value changed meaning.
// 11 (2026-09-13): `health.clients.budget` and `health.import.deletes_budget_24h`
//   REMOVED from `/v1/meta` hours after 1.9/1.10 introduced them (saltorbit: no
//   public handbook for destructive clients / hostile upstreams). A corrective
//   removal, not a /v2: both fields were live under two hours and no client
//   ever read them (LDB-A14).
// 12 (2026-09-13): design/layout-db/26-no-board.md -- spark/1's `board` field
//   is gone (the format is edited in place, 21-formats.md D11, same as 6
//   above): every stored payload and every `?format=spark/1` body loses the
//   key, `PATCH` loses its `board` edit, `?format=mana2/1` always lowers to
//   the ANSI row stagger. No cached 304/edge-cached body from before this
//   slice can keep serving a payload WITH `board` at an unchanged head seq.
// 13 (2026-09-13): design/layout-db/27-magic-emit.md -- a magic key's rule is
//   `{after, emit}` (what the key emits after its context), no longer
//   `{after, output}` with `output` repeating the context; `after` may be an
//   n-gram. Same class as 6/12 (the stored format edited in place, D11). No
//   cached 304/edge-cached body from before this slice can keep serving a
//   payload with the old rule shape at an unchanged head seq.
// 14 (2026-09-15, LDB-I27, saltorbit: "pine has taken down his api"): cmini's
//   own upstream is gone -- `GET /v1/meta`'s `health.diff` and
//   `health.import` each gain a `disabled` boolean (mirrors the new
//   `IMPORT_ENABLED` kill switch, forces `health.diff.stale` false while
//   it's off). Additive only.
// 15 (2026-09-26, LDB-X2): the cmini importer removed for good (pine's own
//   upstream has been permanently dead since 1.14/LDB-I27, and stays that
//   way) -- REMOVAL, not additive, done in place under /v1 on the same
//   "no consumer" basis the webhooks/SSE removal used (LEDGER.md L4,
//   `25-api-versioning.md` §2's finding 8, this doc's own policy): every
//   route here is admin-only, consumed only by this repo's own site.
//   Gone: `POST /v1/admin/import/{pause,resume,tick,unstall,
//   restore-deleted}`, `POST /v1/admin/diff/tick`, `GET /v1/admin/health`,
//   error codes `import_paused`/`import_running`. `health.diff`/
//   `health.import` STAY on `/v1/meta` (no shape change), now
//   unconditionally `disabled: true` rather than a live switch -- byte-
//   identical to what `IMPORT_ENABLED=off` already produced. `upstream`
//   stays on every layout, frozen. Every `admin.import_*`/`admin.diff_*`
//   event kind stays valid, queryable history.
// 16 (LDB-I28, docs/decisions/23-geometry.md §4.6a): new admin route
//   `POST /v1/admin/relabel-magic-thumbs` -- the one-off pass that corrects
//   the 18 catalog layouts whose cmini magic key(s) (`@`/`*`) were imported
//   at row >= 3 under a placeholder non-thumb finger; they are thumb keys.
//   Additive only.
// 17 (2026-09-21, LDB-F42, the row-minus-one decision): `spark/1`'s
//   `Key.row` minimum widens from 0 to -1 (maximum unchanged at 4) -- a row
//   ABOVE the 3x10 alpha block is now storable as `row: -1` (the number
//   row); rows 0/1/2 keep their existing meaning everywhere. A client
//   validating a fetched record against a cached copy of the OLD schema
//   (minimum 0) rejects a record that now has a number row -- readers
//   should treat `row` as a signed integer >= -1, not assume 0 is the
//   minimum. Purely additive to `/v1` (a domain widening, not a shape
//   change): no existing field, route or stored payload changes meaning,
//   and no migration rewrites any existing row (nothing stored ever had
//   row -1 before this).
// 18 (2026-09-29, LDB-F43, #333 closed): a space (`" "`) is accepted as
//   an ordinary `keys[].char` -- `validate()` no longer refuses it. Purely
//   additive to `/v1` (a domain widening, exactly like 17's row -1): no
//   existing field, route or stored payload changes meaning, no migration
//   touches any stored row (nothing stored ever had a `" "` key before
//   this, since every prior write attempting one was refused).
// 19 (2026-09-30, LDB-F44..F47, design/alts/07-format.md): spark/1 gains
//   two additive optional top-level fields, `alts` (per-context alternate
//   fingerings) and `combos` (two-key chords), plus their `has_alts`/
//   `has_combos` envelope flags beside `has_magic` (`formats["spark/1"]`,
//   `?has_alts=`/`?has_combos=` list filters) and PATCH edits `setAlts`/
//   `setCombos`. mana2/1's `fromSpark`/`toSpark` gain a two-key-combo
//   lifting; the cmini adapter no longer drops `combos`. Purely additive:
//   every payload valid before this stays valid and reads the same;
//   `migrations/0020_alts_combos.sql` only adds columns/indexes, backfilled
//   to a no-op for every existing row (nothing stored could carry either
//   field before this slice).
// 20 (2026-10-18, LDB-MD13): privacy fix, not a new feature -- a non-approved
//   mod-queue submission is private to admins, so the public feed's
//   `link_submitted`/`link_rejected` events now carry only `submission_id`
//   in `detail` (the pending `url` and the moderator's `reason` are gone,
//   including from rows stored before this change). The bump also
//   invalidates every cached `/v1/changes` page that still held them.
// 21 (2026-10-18, LDB-WPM1..LDB-WPM10, docs/decisions/28-wpm-records.md):
//   WPM (typing-speed) records per layout -- `POST /v1/wpm`, `GET /v1/wpm`,
//   `POST /v1/admin/wpm`, and the `GET /v1/admin/wpm-queue` family; three new
//   event kinds (`wpm_submitted`, `wpm_approved`, `wpm_rejected`); the dump
//   gains `wpm_submissions`. Purely additive: no existing route, field or
//   event changes meaning, and `migrations/0022_wpm_submissions.sql` only
//   creates a table and its indexes.
// 22 (2026-10-18, LDB-CMT1..LDB-CMT10, docs/decisions/29-layout-comments.md):
//   layout comments -- `PUT`/`DELETE`/`GET /v1/layouts/{ref}/comment`,
//   `GET /v1/layouts/{ref}/comments` and the `/v1/admin/comment-queue`
//   family; five new event kinds (`comment_submitted`, `comment_approved`,
//   `comment_rejected`, `comment_removed`, `comment_deleted`), none carrying
//   comment text; the dump gains `layout_comments`. Purely additive:
//   `migrations/0023_layout_comments.sql` only creates a table and its
//   indexes.
// 23 (2026-10-19, LDB-CMT2, docs/decisions/29-layout-comments.md): behaviour
//   change, no shape change -- every comment is queued (`202`, pending), admins
//   included; the `201` admin instant-approve of 22 is gone.
// 24 (2026-10-19, LDB-CMT17, docs/decisions/29-layout-comments.md): new
//   public bulk `/v1/comment-counts` route.
// 25 (2026-10-19, LDB-MD20): versioned moderation reopen and private history.
// 26 (2026-10-19, LDB-WPM15): Discord WPM proofs require verified authorship.
// 27 (2026-10-19, LDB-WPM16): private WPM submission status lookup.
// 28 (2026-10-20, LDB-WPM17): private immutable Discord receipt binding.
// 29 (2026-10-20, LDB-F48..F50, design/alts/43-skip-magic-wire.md): spark/1's
//   `magic_keys[].rules[].after` may also be a 2-item array `[a, b | null]`
//   (`[a, null]` = a skip rule, "after `a` and any one character"), and a
//   magic key may default to `{"kind":"skip_repeat"}`; a chiral key may carry `"skip": true` (LDB-F51,
//   section 2e: same/opposite by the hand two back, array rows). The compiled rows of
//   such a payload carry array `inputs`/`output` (null = the any-middle
//   wildcard); `?as=mana2/1` drops them (a documented loss). Purely
//   additive: every string-only payload validates and lowers as before; no
//   migration (nothing stored changes).
// 30 (2026-10-25, LDB-A16..A18, docs/decisions/31-read-only-clients.md): the
//   `read-only` extra cap, the `client_read_only` 403, the extended
//   `validateCaps` message, and read-only clients not upserting authors. No
//   stored shape changes; no migration.
// 31 (2026-10-25, LDB-WPM18..LDB-WPM20): WPM `user_name` falls back to the
//   Discord name (new `discord_users`, migrations/0036) when authors has none
//   or only the id; `POST /v1/wpm` takes an optional `user_name`; new
//   `POST /v1/admin/discord-users/refresh`; `GET /v1/wpm`'s ETag folds in
//   `discord_users_head`. Additive; one new table, no existing column moves.
export const WIRE_VERSION = 31;

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
    const hit = await platformOf(c).cache.match(c.req.raw);
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
    await platformOf(c).cache.put(c.req.raw, res);
  } catch {
    // best-effort only
  }
}
