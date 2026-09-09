// The write rate limit (09 §2.5): one atomic D1 statement per attempt --
// counted whether the write is ultimately accepted or refused, so a flood
// costs exactly one row write and nothing else. Fixed 10-minute windows,
// keyed `'write:' || user_id` (`10` C1 adds a second key, `'client:' ||
// id`, through this same function -- `take()`'s shape is built for two
// counters from the start).
import type { Bindings } from "../env";
import type { Clock } from "./time";

export interface TakeResult {
  allowed: boolean;
  remaining: number;
  retryAfter: number; // seconds until the current window ends; 0 when allowed
}

interface RatelimitRow {
  n: number;
  window_start: number;
}

// `db.batch()` is not needed here: this is already ONE statement -- the
// upsert's RETURNING clause hands back the post-write count in the same
// round trip, so there is no separate read to race against (09 §2.5's
// whole point: exact under concurrency without a transaction).
export async function take(
  db: Bindings["DB"],
  now: Clock,
  key: string,
  limit: number,
  windowSeconds: number,
): Promise<TakeResult> {
  const nowSeconds = Math.floor(new Date(now()).getTime() / 1000);
  const windowStart = Math.floor(nowSeconds / windowSeconds) * windowSeconds;

  const row = await db
    .prepare(
      `INSERT INTO ratelimit (key, window_start, n) VALUES (?1, ?2, 1)
       ON CONFLICT(key) DO UPDATE SET
         n = CASE WHEN window_start = excluded.window_start THEN n + 1 ELSE 1 END,
         window_start = excluded.window_start
       RETURNING n, window_start`,
    )
    .bind(key, windowStart)
    .first<RatelimitRow>();
  if (row === null) throw new Error("ratelimit.take: upsert returned no row");

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
export async function pruneRateLimits(db: Bindings["DB"], now: Clock): Promise<void> {
  const nowSeconds = Math.floor(new Date(now()).getTime() / 1000);
  await db
    .prepare("DELETE FROM ratelimit WHERE window_start < ?")
    .bind(nowSeconds - 1200)
    .run();
}
