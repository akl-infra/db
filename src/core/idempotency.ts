// Idempotency-Key (L3, design/layout-db/review/PROPOSAL.md §2.1, review/
// LEDGER.md, audit-bot.md §H3's hazard): an optional header any client may
// send on a mutating /v1/layouts route (writes, likes, restore, transfer)
// so a lost response (a 20s timeout, or a 5xx surfaced after the write
// already committed) can be retried with NO risk of double-applying --
// exactly the hazard that turns a bot's natural retry of a `swap!` into a
// second, undoing swap.
//
// Scope: `(actor scope, key)`. `idempotencyScope` below is the Ed25519
// client's own id on the client lane (`Actor.via` already IS `client:<id>`
// there) or the Discord user id on the bearer lane (`via` is the literal
// `"discord"`, which carries no per-caller id of its own) -- so two
// different clients/users reusing the same key never collide, and neither
// can replay the other's stored response.
//
// The middleware (`auth/idempotency.ts`) is the only caller of everything
// here; this module is pure/D1-only so it can be unit-tested without a
// live Hono request.
import type { Actor } from "../auth/actor";
import type { Bindings } from "../env";
import type { Clock } from "./time";

export const IDEMPOTENCY_WINDOW_MS = 24 * 60 * 60 * 1000;

// "1-128 chars, printable ASCII" (the slice's own scope line) -- 0x20
// (space) through 0x7E inclusive.
const KEY_RE = /^[\x20-\x7E]{1,128}$/;

export function isValidIdempotencyKey(raw: string): boolean {
  return KEY_RE.test(raw);
}

// The client lane's own `via` is already `` `client:${id}` `` (verified by
// `auth/client.ts` -- the SAME string this reuses, never re-derived); the
// bearer lane's `via` is the constant literal `"discord"`, which names no
// caller at all on its own, so the scope falls back to the actor's own
// Discord user id there.
export function idempotencyScope(actor: Actor): string {
  return actor.via === "discord" ? `user:${actor.user_id}` : actor.via;
}

export async function requestHash(body: BufferSource): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", body);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

// A write that fails 4xx is stored too (a retry must replay the SAME 4xx),
// except 429 (a fresh retry should get a fresh rate-limit judgement, not a
// frozen-in-time refusal) and 5xx (the whole point is that a 5xx might not
// reflect what actually happened -- never treat it as gospel to replay).
export function shouldStoreStatus(status: number): boolean {
  if (status === 429) return false;
  if (status >= 500) return false;
  return status >= 200 && status < 500;
}

export interface IdempotencyRow {
  scope: string;
  key: string;
  method: string;
  path: string;
  request_hash: string;
  status: number;
  response_body: string;
  at: string;
}

export function isExpired(row: { at: string }, now: Clock): boolean {
  return new Date(now()).getTime() - new Date(row.at).getTime() >= IDEMPOTENCY_WINDOW_MS;
}

export async function getIdempotency(db: Bindings["DB"], scope: string, key: string): Promise<IdempotencyRow | null> {
  return await db.prepare("SELECT * FROM idempotency WHERE scope = ? AND key = ?").bind(scope, key).first<IdempotencyRow>();
}

// LDB-K7: a reservation -- `status = 0`, `response_body = ''` -- claims
// the (scope, key) pair BEFORE the handler ever runs, so two concurrent
// requests carrying the same fresh key can't both slip past the
// mismatch/replay check (which only ever saw a row AFTER a write
// committed) and both execute. `PENDING_STATUS` is never a real HTTP
// status (100 is the lowest legal one), so it can never be confused with
// a genuinely stored response.
export const PENDING_STATUS = 0;
// How long a reservation is trusted before it's considered abandoned (the
// reserving request's own instance crashed, or is simply still running) --
// much shorter than the 24h key window: this is "is anyone plausibly still
// working on this", not "has this key expired".
export const PENDING_STALE_MS = 60_000;

export function isPending(row: { status: number }): boolean {
  return row.status === PENDING_STATUS;
}

export function isStalePending(row: { at: string }, now: Clock, staleMs: number = PENDING_STALE_MS): boolean {
  return new Date(now()).getTime() - new Date(row.at).getTime() >= staleMs;
}

interface ClaimInput {
  scope: string;
  key: string;
  method: string;
  path: string;
  request_hash: string;
  at: string;
}

// The reservation itself: an INSERT that only lands when nothing at all is
// stored yet for (scope, key). Returns whether THIS call claimed it.
export async function reserveIdempotency(db: Bindings["DB"], row: ClaimInput): Promise<boolean> {
  const result = await db
    .prepare(
      `INSERT INTO idempotency (scope, key, method, path, request_hash, status, response_body, at)
       VALUES (?, ?, ?, ?, ?, ${PENDING_STATUS}, '', ?)
       ON CONFLICT(scope, key) DO NOTHING`,
    )
    .bind(row.scope, row.key, row.method, row.path, row.request_hash, row.at)
    .run();
  return (result.meta.changes ?? 0) > 0;
}

// Reclaims a row already known to be abandoned -- a 24h-expired one
// (whether it finished or not) or a >60s-old still-pending one (its
// reserver crashed or is otherwise never coming back). `expectedAt` is a
// compare-and-swap guard on the exact `at` this caller read: two callers
// racing to take over the SAME stale row can't both succeed (the first to
// land changes `at`, so the second's own WHERE matches zero rows and it
// re-reads to find a fresh reservation instead -- `acquireIdempotencySlot`
// loops on exactly that).
export async function takeOverIdempotency(db: Bindings["DB"], row: ClaimInput & { expectedAt: string }): Promise<boolean> {
  const result = await db
    .prepare(
      `UPDATE idempotency SET method = ?, path = ?, request_hash = ?, status = ${PENDING_STATUS}, response_body = '', at = ?
       WHERE scope = ? AND key = ? AND at = ?`,
    )
    .bind(row.method, row.path, row.request_hash, row.at, row.scope, row.key, row.expectedAt)
    .run();
  return (result.meta.changes ?? 0) > 0;
}

// The reserving request finished normally (2xx/4xx-except-429): the row
// becomes a real, replayable response.
export async function completeIdempotency(db: Bindings["DB"], scope: string, key: string, status: number, responseBody: string, at: string): Promise<void> {
  await db
    .prepare("UPDATE idempotency SET status = ?, response_body = ?, at = ? WHERE scope = ? AND key = ?")
    .bind(status, responseBody, at, scope, key)
    .run();
}

// The reserving request ended 429/5xx: the whole point of NOT storing
// those (`shouldStoreStatus`) is that a retry should get a fresh judgement
// -- so the reservation itself is dropped rather than left dangling
// pending (which would otherwise just sit there and either wrongly
// `409 idempotency_in_progress` a legitimate retry for up to 60s, or, once
// stale, get silently taken over anyway; deleting it outright is simpler
// and immediate).
export async function deleteIdempotency(db: Bindings["DB"], scope: string, key: string): Promise<void> {
  await db.prepare("DELETE FROM idempotency WHERE scope = ? AND key = ?").bind(scope, key).run();
}

export type AcquireResult = { kind: "replay"; row: IdempotencyRow } | { kind: "mismatch" } | { kind: "in_progress" } | { kind: "acquired" };

const MAX_ACQUIRE_ATTEMPTS = 5;

// LDB-K1/K2/K7: the whole decision, one call. Attempts the reservation
// INSERT directly (the common case -- a brand-new key -- costs exactly one
// write, no read); on conflict (something is already stored for this
// (scope, key)) it reads that row and either replays it, refuses it as a
// mismatch, refuses it as still in progress, or -- if it's abandoned --
// takes it over and retries the whole decision, bounded so a persistent
// three-way race can't spin forever (each attempt only fails because
// SOME other caller just won the exact same race, so real contention this
// deep is not expected in practice).
export async function acquireIdempotencySlot(db: Bindings["DB"], now: Clock, req: { scope: string; key: string; method: string; path: string; hash: string }): Promise<AcquireResult> {
  for (let attempt = 0; attempt < MAX_ACQUIRE_ATTEMPTS; attempt++) {
    const claim: ClaimInput = { scope: req.scope, key: req.key, method: req.method, path: req.path, request_hash: req.hash, at: now() };
    if (await reserveIdempotency(db, claim)) return { kind: "acquired" };

    const row = await getIdempotency(db, req.scope, req.key);
    if (row === null) continue; // raced a concurrent 429/5xx cleanup (deleteIdempotency) -- try reserving again

    if (isExpired(row, now)) {
      if (await takeOverIdempotency(db, { ...claim, expectedAt: row.at })) return { kind: "acquired" };
      continue;
    }
    if (!isPending(row)) {
      const matches = row.method === req.method && row.path === req.path && row.request_hash === req.hash;
      return matches ? { kind: "replay", row } : { kind: "mismatch" };
    }
    if (isStalePending(row, now)) {
      if (await takeOverIdempotency(db, { ...claim, expectedAt: row.at })) return { kind: "acquired" };
      continue;
    }
    return { kind: "in_progress" };
  }
  throw new Error("acquireIdempotencySlot: exhausted retries -- persistent contention on one (scope, key)");
}

// Nightly (`core/nightly.ts`) housekeeping only -- correctness never
// depends on this having run: a 24h-expired row (`isExpired`) or a >60s
// stale pending one (`isStalePending`) is already treated as free by
// `acquireIdempotencySlot` on its own, taken over the next time that
// (scope, key) pair is used.
export async function pruneIdempotency(db: Bindings["DB"], now: Clock): Promise<void> {
  const cutoff = new Date(new Date(now()).getTime() - IDEMPOTENCY_WINDOW_MS).toISOString();
  await db.prepare("DELETE FROM idempotency WHERE at < ?").bind(cutoff).run();
}
