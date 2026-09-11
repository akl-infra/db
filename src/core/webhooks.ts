// Webhooks (12-implementation-phase5.md §2.1): all the SQL and the delivery
// loop live here -- `src/routes/webhooks.ts` is glue only (LDB-W1's rule
// extended: `grep prepare src/routes/webhooks.ts` is empty).
//
// No delivery-attempt ledger. Each subscription carries a `cursor` into the
// one event log; delivery is "advance the cursor by POSTing what lies past
// it", at-least-once and in order per hook, idempotent by `seq` on the
// receiver (LDB-H1). A quiet drain (every hook already at the head) costs
// two indexed reads and zero writes (LDB-H5).
//
// Claim-before-send lease (LDB-H6, migrations/0008_webhook_lease.sql):
// `drain()` runs from the after-write nudge on EVERY write and from the
// cron -- overlap is routine. Before touching a due hook's feed page or
// POSTing anything, `drain()` claims it with one CAS UPDATE on
// `lease_id`/`lease_until` (re-checking every due condition, not just the
// lease -- see `drain()`'s own comment on why); `commitOutcome()` CASes its
// outcome on that SAME `lease_id` (not `cursor`) and releases it in the
// same statement. This makes "claim, deliver, commit" one hook's business
// at a time -- two drains can never have POSTs in flight to the same hook
// concurrently, so delivery is genuinely in order per hook, and
// `failures`/`cursor` can never be lost or clobbered by a second attempt
// racing the first. The lease's own clock is read fresh, per hook, at the
// moment of ITS claim -- never a single sample taken once at the top of
// `drain()` -- since a drain touching many due hooks can run for far
// longer, in total, than one lease. The only way a receiver sees a
// duplicate `seq` is a drain that dies (crashes, or is evicted) while
// holding a lease: the hook simply waits out `lease_until`, then the next
// drain claims it and re-delivers from the last committed cursor -- if the
// dead drain's last POST had actually landed, that one seq arrives twice.
// Still at-least-once, never a lost delivery; README.md § Webhooks
// documents the receiver-side half.
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
// LDB-H6: how long a claimed hook's lease is held. Must comfortably cover
// one whole multi-page batch (up to deps.maxPosts POSTs, each bounded by
// POST_TIMEOUT_MS) -- if a real batch would run past it, the holder stops
// itself early (WEBHOOK_LEASE_START_MARGIN_MS below) rather than let the
// lease lapse mid-POST.
export const WEBHOOK_LEASE_MS = 90_000;
// No new POST may START once less than POST_TIMEOUT_MS + this margin
// remains on the lease -- guarantees a POST already in flight when the
// deadline is checked always has time to finish (or time out) and be
// committed before lease_until, so the lease's own CAS in commitOutcome
// still matches under normal operation.
export const WEBHOOK_LEASE_START_MARGIN_MS = 5_000;
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
  // LDB-H6: the claim-before-send lease. Never surfaced on the wire
  // (WebhookRow has no lease_* field) -- purely `drain()`'s own bookkeeping.
  lease_id: string | null;
  lease_until: string | null;
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
    lease_id: null,
    lease_until: null,
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
  // LDB-H6's lease-deadline safety valve reads REAL elapsed time, never the
  // injected business `Clock` (`now`, above): `now` is a business
  // timestamp -- `fixedClock` never advances and `steppingClock` advances
  // in large, test-chosen jumps meant to give successive events
  // distinguishable timestamps, neither of which represents "how much
  // actual wall-clock time has this drain been running". Defaults to
  // `Date.now`; tests override it to exercise the deadline deterministically
  // without needing real delays or fake global timers.
  wallNow?: () => number;
}

export interface DrainStats {
  hooks: number;
  posted: number;
  failed: number;
  disabled: number;
}

// One hook's batch: POST each event past its cursor, in seq order, up to
// the feed page, the global `budget` remaining, or the lease's own
// `deadlineMs` (epoch ms; LDB-H6) -- whichever comes first. The POST body
// is the FULL event (`canonical(event)`, the same shape `/v1/changes`'
// items carry -- `layout_id`/`name`/`rev`/`before`/`after`/ etc. included,
// not just the fields this function filters on) so a receiver can actually
// reconstruct state from it (LDB-P3). Stops at the first delivery failure,
// or before starting a POST once `deadlineMs` has passed (`leaseExpiring:
// true` -- not a failure; the caller commits what was delivered and
// releases the lease so the rest is picked up promptly by the next drain).
// Returns the new cursor (the last event successfully posted, or
// `hook.cursor` if none was), how many POSTs this call made, and the
// failure (if any) that stopped it short.
async function deliverBatch(
  hook: WebhookWithSecret,
  events: Event[],
  budget: number,
  fetchImpl: WebhookFetchImpl,
  now: Clock,
  wallNow: () => number,
  deadlineMs: number,
): Promise<{ newCursor: number; posted: number; failure: string | null; leaseExpiring: boolean }> {
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
    if (wallNow() >= deadlineMs) return { newCursor: cursor, posted, failure: null, leaseExpiring: true };
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
      if (!res.ok) return { newCursor: cursor, posted, failure: `receiver answered ${res.status}`, leaseExpiring: false };
    } catch (e) {
      posted++;
      return { newCursor: cursor, posted, failure: e instanceof Error ? e.message : String(e), leaseExpiring: false };
    }
    cursor = event.seq;
  }
  return { newCursor: cursor, posted, failure: null, leaseExpiring: false };
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

// Applies a hook's post-batch outcome via ONE compare-and-set UPDATE keyed
// on the LEASE (`WHERE id = ? AND lease_id = ?leaseId`, LDB-H6), clearing
// the lease in the same statement. Only the drain that currently holds
// `leaseId` can ever match -- a second drain can't have raced this one to
// the same hook (the lease shut that out at claim time), and if THIS
// drain's own lease has since expired (a very slow batch, or a clock skew
// past WEBHOOK_LEASE_MS) `changes = 0` and the outcome is silently
// dropped: the next drain will have already reclaimed and re-delivered
// from the last actually-committed cursor. `hook.failures`/`hook.status`
// come from the row `drain()` re-read at claim time, not the original
// (possibly stale) `due` SELECT, so `failures + 1` here can never lose a
// concurrent increment -- the lease guarantees nothing else is writing
// this row's counters meanwhile.
async function commitOutcome(db: Bindings["DB"], now: Clock, hook: WebhookWithSecret, leaseId: string, outcome: { newCursor: number; failure: string | null }): Promise<void> {
  if (outcome.failure === null) {
    await db
      .prepare(
        `UPDATE webhooks SET cursor = ?, failures = 0, failing_since = NULL, last_error = NULL, status = 'active', next_at = ?, lease_id = NULL, lease_until = NULL
         WHERE id = ? AND lease_id = ?`,
      )
      .bind(outcome.newCursor, now(), hook.id, leaseId)
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
      `UPDATE webhooks SET cursor = ?, failures = ?, failing_since = COALESCE(failing_since, ?), last_error = ?, status = ?, next_at = ?, lease_id = NULL, lease_until = NULL
       WHERE id = ? AND lease_id = ?`,
    )
    .bind(outcome.newCursor, failures, nowIso, outcome.failure, status, nextAt, hook.id, leaseId)
    .run();
}

// `drain()`: called from the after-write nudge (index.ts's middleware) and
// from the cron; both callers are safe to overlap (LDB-H1) because every
// due hook is claimed (LDB-H6) before its feed page is read or anything is
// POSTed -- never two drains delivering to the same hook at once.
export async function drain(env: Bindings, now: Clock, deps: DrainDeps): Promise<DrainStats> {
  const db = env.DB;
  const wallNow = deps.wallNow ?? Date.now;
  const head = await headSeq(db);
  const nowIso = now();

  // Step 1 (12 §2.1): due hooks -- not disabled, past their backoff, and
  // still behind the head. A hook that is fully caught up (`cursor ==
  // head`) is never selected, so an all-quiet database costs exactly two
  // indexed reads (this SELECT + headSeq's) and zero writes (LDB-H5) -- the
  // loop body below never runs. This SELECT does not filter on the lease: a
  // leased-but-due hook is still listed here (cheap, no write), and simply
  // fails to claim below.
  const { results: due } = await db
    .prepare("SELECT * FROM webhooks WHERE status != 'disabled' AND next_at <= ? AND cursor < ? ORDER BY next_at ASC LIMIT ?")
    .bind(nowIso, head, DUE_PAGE_LIMIT)
    .all<WebhookDbRow>();

  let posted = 0;
  let failed = 0;
  let disabled = 0;
  for (const dbRow of due) {
    // A hook whose failing streak has run past the 7-day threshold is
    // disabled here -- one UPDATE, no feed read, no POST, no lease needed
    // (12 §2.1: "one UPDATE, no POST"). The lease guard on the WHERE
    // clause keeps this from disabling a hook another drain is mid-batch
    // on (its lease_until is in the future, so this UPDATE is a no-op --
    // harmless, the disable is just deferred to whichever drain notices
    // next). A hook that never comes due again (fully caught up while
    // failing) is not swept by this per-row check; it stays 'failing'
    // rather than 'disabled' -- harmless, since nothing is ever attempted
    // for it either way.
    if (isPastDisableThreshold(dbRow.failing_since, nowIso)) {
      await db
        .prepare("UPDATE webhooks SET status = 'disabled' WHERE id = ? AND cursor = ? AND (lease_until IS NULL OR lease_until <= ?)")
        .bind(dbRow.id, dbRow.cursor, nowIso)
        .run();
      disabled++;
      continue;
    }

    if (posted >= deps.maxPosts) break; // global bound: what's left waits for the next tick

    // Claim BEFORE touching this hook's feed page or POSTing anything
    // (LDB-H6): one CAS UPDATE, `RETURNING *` so the row this drain builds
    // its batch from is the just-committed state, not the possibly-stale
    // `due` read above (another drain could have delivered and committed
    // against this hook between that SELECT and here).
    //
    // `claimIso`/`claimWallMs` are taken fresh, right here, per hook -- NOT
    // `nowIso` from the top of `drain()`. A drain can run far longer than
    // one lease across many hooks (`deps.maxPosts` POSTs at up to
    // `POST_TIMEOUT_MS` each can dwarf `WEBHOOK_LEASE_MS`); a hook claimed
    // late in a long drain with a stale `nowIso` would get a `lease_until`
    // that could already be in the past while this drain's own (freshly
    // computed) `deadlineMs` still let it keep POSTing -- reopening the
    // exact race LDB-H6 exists to close (a concurrent drain claiming and
    // delivering to the same hook at once).
    //
    // The claim also re-checks EVERY `due` condition (`status`, `next_at`,
    // `cursor < head`), not just the lease: a hook can stop being due
    // between the `due` SELECT above and this claim -- most importantly, a
    // second drain's own commit landing a FAILURE in between, which sets
    // `next_at` into the future. Without this re-check, this drain would
    // claim and retry immediately anyway, bypassing that backoff entirely
    // (the lease alone only prevents two POSTs in flight at once, not a
    // premature retry after the lease has already been cleanly released).
    //
    // `changes = 0` (no row returned) means the hook is no longer due, OR
    // another drain already holds an unexpired lease -- skip this hook
    // this call, not an error; it will be picked up by a later drain once
    // it's due and the lease (if any) has been released or lapsed.
    const claimIso = now();
    const claimWallMs = wallNow();
    const leaseId = ulid();
    const leaseUntilMs = new Date(claimIso).getTime() + WEBHOOK_LEASE_MS;
    const claimed = await db
      .prepare(
        `UPDATE webhooks SET lease_id = ?, lease_until = ?
         WHERE id = ? AND status != 'disabled' AND next_at <= ? AND cursor < ?
           AND (lease_until IS NULL OR lease_until <= ?)
         RETURNING *`,
      )
      .bind(leaseId, new Date(leaseUntilMs).toISOString(), dbRow.id, claimIso, head, claimIso)
      .first<WebhookDbRow>();
    if (claimed === null) continue;
    const hook = rowToInternal(claimed);
    // No POST this drain starts for this hook may begin past this instant
    // -- guarantees the lease is always released (or expires) before any
    // other drain could plausibly still see it held by a live, healthy
    // attempt (the lease itself is WEBHOOK_LEASE_MS long; this stops
    // issuing new POSTs WEBHOOK_LEASE_START_MARGIN_MS + one POST timeout
    // before it actually lapses). Measured from `claimWallMs` (`wallNow()`
    // at the SAME moment as `claimIso`, above), REAL elapsed time since the
    // claim -- not `leaseUntilMs` (which is `claimIso`, the business clock,
    // plus the lease length): the two clocks can be on entirely different
    // timelines in a test (`fixedClock`/`steppingClock`), and only real
    // elapsed time can ever actually threaten a real lease. In production
    // both clocks are real time, so the two stay in lockstep.
    const deadlineMs = claimWallMs + (WEBHOOK_LEASE_MS - POST_TIMEOUT_MS - WEBHOOK_LEASE_START_MARGIN_MS);

    // Pages the feed 10 at a time (FEED_PAGE_SIZE) for THIS hook alone,
    // across as many pages as its share of `deps.maxPosts` (or the lease
    // deadline) allows, so a hook with 30 pending events and budget for 25
    // gets all 25 in this one drain -- not just its first page (12 §2.1's
    // own worked example). One `commitOutcome` at the end covers the whole
    // multi-page batch -- together with the claim, exactly two `webhooks`
    // UPDATEs per delivered hook (LDB-H5).
    let hookCursor = hook.cursor;
    let hookPosted = 0;
    let failure: string | null = null;
    for (;;) {
      if (wallNow() >= deadlineMs) break; // lease running low -- stop and commit what's delivered, below
      const kinds = hook.kinds ?? undefined;
      const { items, next } = await feed(db, hookCursor, FEED_PAGE_SIZE, kinds);
      if (items.length === 0) break; // caught up to the head
      const outcome = await deliverBatch({ ...hook, cursor: hookCursor }, items, deps.maxPosts - posted - hookPosted, deps.fetchImpl, now, wallNow, deadlineMs);
      hookPosted += outcome.posted;
      // An empty/all-filtered page fully scanned (no failure, no lease cutoff)
      // still advances the cursor to `next` even with zero POSTs (12 §2.1:
      // "events filtered out ... count as delivered") -- when a failure or
      // the lease deadline stopped the page short, `outcome.newCursor`
      // already reflects the right (earlier) stopping point and must not
      // be overridden.
      hookCursor = outcome.failure === null && !outcome.leaseExpiring && outcome.posted === 0 ? Math.max(outcome.newCursor, next) : outcome.newCursor;
      if (outcome.failure !== null) {
        failure = outcome.failure;
        break;
      }
      if (outcome.leaseExpiring) break; // not a failure -- committed as a (possibly partial) success below
      if (posted + hookPosted >= deps.maxPosts) break; // budget for this hook (and the drain overall) exhausted
      if (items.length < FEED_PAGE_SIZE) break; // short page -- caught up
    }
    posted += hookPosted;
    if (failure !== null) failed++;
    // A lease-expiring stop is not a failure -- treat it as a (possibly
    // partial) success: no failure counted, no backoff, `next_at = now` so
    // whatever is left is picked up immediately by the next drain rather
    // than waiting out this drain's own (now-released) lease.
    await commitOutcome(db, now, hook, leaseId, { newCursor: hookCursor, failure });
  }

  return { hooks: due.length, posted, failed, disabled };
}
