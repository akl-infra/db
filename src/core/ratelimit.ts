// The write rate limit (09 §2.5): one atomic D1 statement per attempt --
// counted whether the write is ultimately accepted or refused, so a flood
// costs exactly one row write and nothing else. Fixed windows, keyed by the
// caller (`'write:' || user_id` for the per-actor counter, `'client:' ||
// id` for 10 C1's per-client counter) -- `take()`'s shape is one function
// for both from the start.
import type { Bindings } from "../env";
import type { Clock } from "./time";
import { toStore, type StoreArg } from "../store/arg";

export interface TakeResult {
  allowed: boolean;
  remaining: number;
  retryAfter: number; // seconds until the current window ends; 0 when allowed
}

// No batch is needed here: this is already ONE statement -- the
// upsert's RETURNING clause hands back the post-write count in the same
// round trip, so there is no separate read to race against (09 §2.5's
// whole point: exact under concurrency without a transaction).
export async function take(
  dbArg: StoreArg,
  now: Clock,
  key: string,
  limit: number,
  windowSeconds: number,
): Promise<TakeResult> {
  const store = toStore(dbArg);
  const nowSeconds = Math.floor(new Date(now()).getTime() / 1000);
  const windowStart = Math.floor(nowSeconds / windowSeconds) * windowSeconds;

  const row = await store.auth.hitWindow(key, windowStart);

  const allowed = row.n <= limit;
  return {
    allowed,
    remaining: Math.max(0, limit - row.n),
    retryAfter: allowed ? 0 : row.window_start + windowSeconds - nowSeconds,
  };
}

// Nightly (`0 3 * * *`, wired into src/index.ts's `scheduled()`, alongside
// `pruneAuthCache`): drop buckets more than two windows old. Housekeeping,
// not correctness -- a stale row's own window will never match `nowSeconds`
// again, so `take()` already resets it to 1 on next use regardless.
export async function pruneRateLimits(dbArg: StoreArg, now: Clock): Promise<void> {
  const store = toStore(dbArg);
  const nowSeconds = Math.floor(new Date(now()).getTime() / 1000);
  await store.auth.pruneRateLimits(nowSeconds - 1200);
}
