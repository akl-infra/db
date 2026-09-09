// Webhooks (12-implementation-phase5.md §2.1): all the SQL and the delivery
// loop live here -- `src/routes/webhooks.ts` is glue only (LDB-W1's rule
// extended: `grep prepare src/routes/webhooks.ts` is empty).
//
// No delivery-attempt ledger. Each subscription carries a `cursor` into the
// one event log; delivery is "advance the cursor by POSTing what lies past
// it", at-least-once and in order per hook, idempotent by `seq` on the
// receiver (LDB-H1). A quiet drain (every hook already at the head) costs
// two indexed reads and zero writes (LDB-H5).
import { canonical } from "./canonical";
import { badRequest, notFound, tooManyWebhooks } from "./errors";
import { feed, type Event } from "./events";
import type { Bindings } from "../env";
import { headSeq } from "./etag";
import type { Clock } from "./time";
import { ulid } from "ulidx";

export const WEBHOOK_BACKOFF_S = [60, 600, 3600]; // after failure 1, 2, >=3 (03 §5's 10s is below the cron's 1-min granularity)
export const WEBHOOK_FAILING_AFTER = 3; // consecutive failures -> status 'failing'
export const WEBHOOK_DISABLE_AFTER_MS = 7 * 86_400_000; // failing_since older than this -> 'disabled'
export const WEBHOOKS_PER_USER = 5;
const DUE_PAGE_LIMIT = 20;
const FEED_PAGE_SIZE = 10;
const POST_TIMEOUT_MS = 10_000;
const URL_MAX_LEN = 2048;
const SECRET_MIN_LEN = 16;
const SECRET_MAX_LEN = 256;
const OWNER_FILTER_RE = /^\d{17,20}$/;
const IPV4_RE = /^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/;

export interface WebhookRow {
  id: string;
  owner_user_id: string;
  url: string;
  kinds: string[] | null;
  owner_filter: string | null;
  status: "active" | "failing" | "disabled";
  cursor: number;
  failures: number;
  failing_since: string | null;
  next_at: string;
  last_error: string | null;
  created_at: string;
}

interface WebhookDbRow {
  id: string;
  owner_user_id: string;
  url: string;
  secret: string;
  kinds: string | null;
  owner_filter: string | null;
  status: string;
  cursor: number;
  failures: number;
  failing_since: string | null;
  next_at: string;
  last_error: string | null;
  created_at: string;
}

function rowToWire(r: WebhookDbRow): WebhookRow {
  return {
    id: r.id,
    owner_user_id: r.owner_user_id,
    url: r.url,
    kinds: r.kinds === null ? null : (JSON.parse(r.kinds) as string[]),
    owner_filter: r.owner_filter,
    status: r.status as WebhookRow["status"],
    cursor: r.cursor,
    failures: r.failures,
    failing_since: r.failing_since,
    next_at: r.next_at,
    last_error: r.last_error,
    created_at: r.created_at,
  };
}

// A DB row with `secret` still attached -- `drain()`'s own internal use
// only; never handed to a route.
interface WebhookWithSecret extends WebhookRow {
  secret: string;
}
function rowToInternal(r: WebhookDbRow): WebhookWithSecret {
  return { ...rowToWire(r), secret: r.secret };
}

// host is not an IP literal (a bare IPv4 dotted-quad, or a bracketed IPv6
// literal) -- SSRF is otherwise out of scope (Cloudflare's own fetch cannot
// reach its own internal addresses, 12 §2.1).
function isIpLiteralHost(host: string): boolean {
  if (host.startsWith("[")) return true; // IPv6 literal
  return IPV4_RE.test(host);
}

export interface CreateWebhookBody {
  url: string;
  secret: string;
  kinds?: string[];
  owner_filter?: string;
}

// Validated against `KNOWN_KINDS` by the caller (routes/webhooks.ts) --
// this module only checks shape/length, not vocabulary, so it stays free of
// a `changes.ts` import (core -> core, no route-layer dependency).
function validateBody(body: CreateWebhookBody): void {
  let url: URL;
  try {
    url = new URL(body.url);
  } catch {
    throw badRequest("invalid 'url' (must be a well-formed URL)", "/url");
  }
  if (url.protocol !== "https:") throw badRequest("invalid 'url' (must be https://)", "/url");
  if (isIpLiteralHost(url.hostname)) throw badRequest("invalid 'url' (host may not be an IP literal)", "/url");
  if (body.url.length > URL_MAX_LEN) throw badRequest(`invalid 'url' (must be at most ${URL_MAX_LEN} characters)`, "/url");
  if (body.secret.length < SECRET_MIN_LEN || body.secret.length > SECRET_MAX_LEN) {
    throw badRequest(`invalid 'secret' (must be ${SECRET_MIN_LEN}-${SECRET_MAX_LEN} characters)`, "/secret");
  }
  if (body.owner_filter !== undefined && !OWNER_FILTER_RE.test(body.owner_filter)) {
    throw badRequest("invalid 'owner_filter' (expected a Discord user id)", "/owner_filter");
  }
}

// POST /v1/webhooks: `cursor` starts at the head, so a new hook receives
// only what happens after it exists.
export async function create(db: Bindings["DB"], now: Clock, owner: string, body: CreateWebhookBody): Promise<WebhookRow> {
  validateBody(body);

  const countRow = await db.prepare("SELECT COUNT(*) AS n FROM webhooks WHERE owner_user_id = ?").bind(owner).first<{ n: number }>();
  if ((countRow?.n ?? 0) >= WEBHOOKS_PER_USER) throw tooManyWebhooks(WEBHOOKS_PER_USER);

  const cursor = await headSeq(db);
  const at = now();
  const row: WebhookDbRow = {
    id: ulid(),
    owner_user_id: owner,
    url: body.url,
    secret: body.secret,
    kinds: body.kinds === undefined ? null : canonical(body.kinds),
    owner_filter: body.owner_filter ?? null,
    status: "active",
    cursor,
    failures: 0,
    failing_since: null,
    next_at: at,
    last_error: null,
    created_at: at,
  };
  await db
    .prepare(
      `INSERT INTO webhooks (id, owner_user_id, url, secret, kinds, owner_filter, status, cursor, failures, failing_since, next_at, last_error, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(row.id, row.owner_user_id, row.url, row.secret, row.kinds, row.owner_filter, row.status, row.cursor, row.failures, row.failing_since, row.next_at, row.last_error, row.created_at)
    .run();
  return rowToWire(row);
}

export async function listForOwner(db: Bindings["DB"], owner: string): Promise<WebhookRow[]> {
  const { results } = await db
    .prepare("SELECT * FROM webhooks WHERE owner_user_id = ? ORDER BY created_at ASC, id ASC")
    .bind(owner)
    .all<WebhookDbRow>();
  return results.map(rowToWire);
}

export async function listAll(db: Bindings["DB"]): Promise<WebhookRow[]> {
  const { results } = await db.prepare("SELECT * FROM webhooks ORDER BY created_at ASC, id ASC").all<WebhookDbRow>();
  return results.map(rowToWire);
}

// DELETE /v1/webhooks/{id}: own, or any as admin; a `ref` that names
// another owner's hook 404s (never 403 -- ids are not enumerable, 12 §2.3).
export async function remove(db: Bindings["DB"], owner: string, isAdmin: boolean, id: string): Promise<void> {
  const row = await db.prepare("SELECT owner_user_id FROM webhooks WHERE id = ?").bind(id).first<{ owner_user_id: string }>();
  if (row === null || (row.owner_user_id !== owner && !isAdmin)) throw notFound(`no webhook '${id}'`, id);
  await db.prepare("DELETE FROM webhooks WHERE id = ?").bind(id).run();
}

// hex HMAC-SHA-256 over `${timestamp}.${body}`, via Web Crypto -- the exact
// bytes a receiver reconstructs from its own copy of `secret` (README.md
// § Webhooks documents the receiver-side half of this contract).
export async function sign(secret: string, timestamp: string, body: string): Promise<string> {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const mac = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`${timestamp}.${body}`));
  return [...new Uint8Array(mac)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export type WebhookFetchImpl = (url: string, init: { method: string; headers: Record<string, string>; body: string; signal: AbortSignal }) => Promise<Response>;

export interface DrainDeps {
  fetchImpl: WebhookFetchImpl;
  maxPosts: number;
}

export interface DrainStats {
  hooks: number;
  posted: number;
  failed: number;
  disabled: number;
}

// One hook's batch: POST each event past its cursor, in seq order, up to
// the feed page or the global `budget` remaining -- whichever is smaller.
// The POST body is the FULL event (`canonical(event)`, the same shape
// `/v1/changes`' items carry -- `layout_id`/`name`/`rev`/`before`/`after`/
// etc. included, not just the fields this function filters on) so a
// receiver can actually reconstruct state from it (LDB-P3). Stops at the
// first delivery failure. Returns the new cursor (the last event
// successfully posted, or `hook.cursor` if none was), how many POSTs this
// call made, and the failure (if any) that stopped it short.
async function deliverBatch(
  hook: WebhookWithSecret,
  events: Event[],
  budget: number,
  fetchImpl: WebhookFetchImpl,
  now: Clock,
): Promise<{ newCursor: number; posted: number; failure: string | null }> {
  let cursor = hook.cursor;
  let posted = 0;
  for (const event of events) {
    const matchesKind = hook.kinds === null || hook.kinds.includes(event.kind);
    const matchesOwner = hook.owner_filter === null || event.owner === hook.owner_filter;
    if (!matchesKind || !matchesOwner) {
      cursor = event.seq; // filtered out -- the cursor still passes it (12 §2.1)
      continue;
    }
    if (posted >= budget) break; // global WEBHOOK_MAX_POSTS bound reached -- what's left waits for the next tick
    const timestamp = String(Math.floor(new Date(now()).getTime() / 1000));
    const body = canonical(event);
    let signature: string;
    try {
      signature = await sign(hook.secret, timestamp, body);
      const res = await fetchImpl(hook.url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "User-Agent": "akl-db-webhooks/1.0",
          "X-Akl-Webhook-Id": hook.id,
          "X-Akl-Seq": String(event.seq),
          "X-Akl-Timestamp": timestamp,
          "X-Akl-Signature": `v1=${signature}`,
        },
        body,
        signal: AbortSignal.timeout(POST_TIMEOUT_MS),
      });
      posted++;
      if (!res.ok) return { newCursor: cursor, posted, failure: `receiver answered ${res.status}` };
    } catch (e) {
      posted++;
      return { newCursor: cursor, posted, failure: e instanceof Error ? e.message : String(e) };
    }
    cursor = event.seq;
  }
  return { newCursor: cursor, posted, failure: null };
}

// Whether `hook` has been failing for longer than WEBHOOK_DISABLE_AFTER_MS
// as of `nowIso` -- shared by the pre-attempt skip (no POST past the
// threshold) and the post-attempt status computation (a failure that pushes
// a hook over the threshold disables it immediately rather than waiting for
// yet another failed attempt).
function isPastDisableThreshold(failingSince: string | null, nowIso: string): boolean {
  if (failingSince === null) return false;
  return new Date(nowIso).getTime() - new Date(failingSince).getTime() > WEBHOOK_DISABLE_AFTER_MS;
}

// Applies a hook's post-batch outcome via ONE compare-and-set UPDATE
// (`WHERE id = ? AND cursor = ?startCursor`, 12 §2.1): two overlapping
// drains (the after-write nudge and the `*/1` cron) cannot double-advance a
// cursor, and a lost race is simply "the other drain already did it" --
// `changes = 0` is not an error, just a no-op.
async function commitOutcome(db: Bindings["DB"], now: Clock, hook: WebhookWithSecret, outcome: { newCursor: number; failure: string | null }): Promise<void> {
  if (outcome.failure === null) {
    await db
      .prepare(
        `UPDATE webhooks SET cursor = ?, failures = 0, failing_since = NULL, last_error = NULL, status = 'active', next_at = ?
         WHERE id = ? AND cursor = ?`,
      )
      .bind(outcome.newCursor, now(), hook.id, hook.cursor)
      .run();
    return;
  }
  const failures = hook.failures + 1;
  const nowIso = now();
  const backoffS = WEBHOOK_BACKOFF_S[Math.min(failures, WEBHOOK_BACKOFF_S.length) - 1]!;
  const nextAt = new Date(new Date(nowIso).getTime() + backoffS * 1000).toISOString();
  const failingSince = hook.failing_since ?? nowIso;
  const status = isPastDisableThreshold(failingSince, nowIso) ? "disabled" : failures >= WEBHOOK_FAILING_AFTER ? "failing" : hook.status;
  await db
    .prepare(
      `UPDATE webhooks SET cursor = ?, failures = ?, failing_since = COALESCE(failing_since, ?), last_error = ?, status = ?, next_at = ?
       WHERE id = ? AND cursor = ?`,
    )
    .bind(outcome.newCursor, failures, nowIso, outcome.failure, status, nextAt, hook.id, hook.cursor)
    .run();
}

// `drain()`: called from the after-write nudge (index.ts's middleware) and
// from the `*/1 * * * *` cron; both callers are safe to overlap (LDB-H1).
export async function drain(env: Bindings, now: Clock, deps: DrainDeps): Promise<DrainStats> {
  const db = env.DB;
  const head = await headSeq(db);
  const nowIso = now();

  // Step 1 (12 §2.1): due hooks -- not disabled, past their backoff, and
  // still behind the head. A hook that is fully caught up (`cursor ==
  // head`) is never selected, so an all-quiet database costs exactly these
  // two indexed reads and zero writes (LDB-H5) -- the loop body below never
  // runs.
  const { results: due } = await db
    .prepare("SELECT * FROM webhooks WHERE status != 'disabled' AND next_at <= ? AND cursor < ? ORDER BY next_at ASC LIMIT ?")
    .bind(nowIso, head, DUE_PAGE_LIMIT)
    .all<WebhookDbRow>();

  let posted = 0;
  let failed = 0;
  let disabled = 0;
  for (const dbRow of due) {
    const hook = rowToInternal(dbRow);

    // A hook whose failing streak has run past the 7-day threshold is
    // disabled here -- one UPDATE, no feed read, no POST (12 §2.1: "one
    // UPDATE, no POST"). A hook that never comes due again (fully caught
    // up while failing) is not swept by this per-row check; it stays
    // 'failing' rather than 'disabled' -- harmless, since nothing is ever
    // attempted for it either way.
    if (isPastDisableThreshold(hook.failing_since, nowIso)) {
      await db.prepare("UPDATE webhooks SET status = 'disabled' WHERE id = ? AND cursor = ?").bind(hook.id, hook.cursor).run();
      disabled++;
      continue;
    }

    if (posted >= deps.maxPosts) break; // global bound: what's left waits for the next tick

    // Pages the feed 10 at a time (FEED_PAGE_SIZE) for THIS hook alone,
    // across as many pages as its share of `deps.maxPosts` allows, so a
    // hook with 30 pending events and budget for 25 gets all 25 in this one
    // drain -- not just its first page (12 §2.1's own worked example). One
    // `commitOutcome` at the end covers the whole multi-page batch (still
    // exactly one `webhooks` UPDATE per hook, LDB-H5).
    let hookCursor = hook.cursor;
    let hookPosted = 0;
    let failure: string | null = null;
    for (;;) {
      const kinds = hook.kinds ?? undefined;
      const { items, next } = await feed(db, hookCursor, FEED_PAGE_SIZE, kinds);
      if (items.length === 0) break; // caught up to the head
      const outcome = await deliverBatch({ ...hook, cursor: hookCursor }, items, deps.maxPosts - posted - hookPosted, deps.fetchImpl, now);
      hookPosted += outcome.posted;
      // An empty/all-filtered page still advances the cursor to `next` even
      // with zero POSTs (12 §2.1: "events filtered out ... count as
      // delivered") -- `deliverBatch` only reaches `next` via its loop when
      // every item in the page was filtered; when at least one matched but
      // failed, `outcome.newCursor` already reflects the right stopping
      // point and must not be overridden.
      hookCursor = outcome.failure === null && outcome.posted === 0 ? Math.max(outcome.newCursor, next) : outcome.newCursor;
      if (outcome.failure !== null) {
        failure = outcome.failure;
        break;
      }
      if (posted + hookPosted >= deps.maxPosts) break; // budget for this hook (and the drain overall) exhausted
      if (items.length < FEED_PAGE_SIZE) break; // short page -- caught up
    }
    posted += hookPosted;
    if (failure !== null) failed++;
    await commitOutcome(db, now, hook, { newCursor: hookCursor, failure });
  }

  return { hooks: due.length, posted, failed, disabled };
}
