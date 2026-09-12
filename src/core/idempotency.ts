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

// Upsert, not a bare INSERT: by the time the middleware calls this, either
// no row existed for (scope, key), or the one that did was already found
// expired (`getIdempotency` + `isExpired`, checked by the caller first) --
// so overwriting it is always the right move, and the statement itself is
// safe to run twice with the same arguments (a crash between the write
// committing and this call landing just means the client's own retry
// lands here again with byte-identical values).
export async function storeIdempotency(db: Bindings["DB"], row: IdempotencyRow): Promise<void> {
  await db
    .prepare(
      `INSERT INTO idempotency (scope, key, method, path, request_hash, status, response_body, at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(scope, key) DO UPDATE SET
         method = excluded.method, path = excluded.path, request_hash = excluded.request_hash,
         status = excluded.status, response_body = excluded.response_body, at = excluded.at`,
    )
    .bind(row.scope, row.key, row.method, row.path, row.request_hash, row.status, row.response_body, row.at)
    .run();
}

// Nightly (`core/nightly.ts`) housekeeping only -- correctness never
// depends on this having run: `getIdempotency` + `isExpired` already treat
// an old row as absent, and `storeIdempotency`'s upsert already overwrites
// it cleanly the next time that (scope, key) pair is used.
export async function pruneIdempotency(db: Bindings["DB"], now: Clock): Promise<void> {
  const cutoff = new Date(new Date(now()).getTime() - IDEMPOTENCY_WINDOW_MS).toISOString();
  await db.prepare("DELETE FROM idempotency WHERE at < ?").bind(cutoff).run();
}
