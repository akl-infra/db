// D1 `HoldStore` and `CutoverStore` (src/store/port.ts), design/aws-port.md §3 and §5.2.
//
// Holds (the long-poll budget, LDB-CUT1..CUT5): the same two facts the DynamoDB store keeps, in the existing ephemeral `ratelimit`
// table, so no migration is needed and nothing new is dumped or mirrored:
//   - the lease `hold:<client>`: `window_start` is the epoch second it expires, `n` an opaque per-attempt token;
//   - its reservation `holdrsv:<client>`: `n` the seconds reserved, `window_start` the end of the UTC day they were taken from, so a
//     release (which may come after midnight) refunds the unused part to the right day;
//   - the day's spend `holds:<YYYY-MM-DD>`: `n` is the hold-seconds taken, `window_start` the epoch second the UTC day ENDS (the
//     nightly `pruneRateLimits` drops rows below now-1200, so a day's counter must not look old until the day is over).
// Both are taken in ONE batch (one transaction), the budget row only if this attempt's own lease row is the one in place.
import type { CutoverStore, HoldStore } from "../port";

const DEFAULT_HOLD_BUDGET_SECONDS = 20_000; // design §3; the route passes the configured value
const LEASE_SLACK_SECONDS = 5;

export function d1HoldStore(db: D1Database): HoldStore {
  return {
    async takeHold(clientId, seconds, now, budgetSeconds = DEFAULT_HOLD_BUDGET_SECONDS) {
      const nowMs = Date.parse(now());
      const nowS = Math.floor(nowMs / 1000);
      const s = Math.ceil(seconds);
      const dayStart = new Date(nowMs).toISOString().slice(0, 10);
      const dayEnd = Math.floor(Date.parse(`${dayStart}T00:00:00.000Z`) / 1000) + 86400;
      const expires = nowS + s + LEASE_SLACK_SECONDS;
      const token = 1 + Math.floor(Math.random() * 2 ** 31);
      const leaseKey = `hold:${clientId}`;
      const dayKey = `holds:${dayStart}`;
      const res = await db.batch([
        // The lease, only when none is live and the day has room. An expired lease row is replaced by the conflict clause.
        db
          .prepare(
            `INSERT INTO ratelimit (key, window_start, n)
             SELECT ?1, ?2, ?3
              WHERE NOT EXISTS (SELECT 1 FROM ratelimit WHERE key = ?1 AND window_start >= ?4)
                AND COALESCE((SELECT n FROM ratelimit WHERE key = ?5), 0) + ?6 <= ?7
             ON CONFLICT(key) DO UPDATE SET window_start = excluded.window_start, n = excluded.n`,
          )
          .bind(leaseKey, expires, token, nowS, dayKey, s, budgetSeconds),
        // The spend, only when the lease row in place is this attempt's.
        db
          .prepare(
            `INSERT INTO ratelimit (key, window_start, n)
             SELECT ?1, ?2, ?3
              WHERE EXISTS (SELECT 1 FROM ratelimit WHERE key = ?4 AND window_start = ?5 AND n = ?6)
             ON CONFLICT(key) DO UPDATE SET n = n + excluded.n`,
          )
          .bind(dayKey, dayEnd, s, leaseKey, expires, token),
        // The reservation, only when the lease row in place is this attempt's (what the release refunds from).
        db
          .prepare(
            `INSERT INTO ratelimit (key, window_start, n)
             SELECT ?1, ?2, ?3
              WHERE EXISTS (SELECT 1 FROM ratelimit WHERE key = ?4 AND window_start = ?5 AND n = ?6)
             ON CONFLICT(key) DO UPDATE SET window_start = excluded.window_start, n = excluded.n`,
          )
          .bind(`holdrsv:${clientId}`, dayEnd, s, leaseKey, expires, token),
      ]);
      return (res[0]?.meta.changes ?? 0) === 1;
    },
    async releaseHold(clientId, heldSeconds) {
      const rsv = `holdrsv:${clientId}`;
      const used = Math.max(0, Math.ceil(heldSeconds));
      await db.batch([
        // Give back the reservation's unused seconds to the day it came from (no row, no reservation: nothing to refund).
        db
          .prepare(
            `UPDATE ratelimit
                SET n = MAX(0, n - MAX(0, (SELECT n FROM ratelimit WHERE key = ?1) - ?2))
              WHERE key = 'holds:' || (SELECT date(window_start - 86400, 'unixepoch') FROM ratelimit WHERE key = ?1)`,
          )
          .bind(rsv, used),
        db.prepare("DELETE FROM ratelimit WHERE key IN (?1, ?2)").bind(`hold:${clientId}`, rsv),
      ]);
    },
  };
}

/** How long a read of `import_state['cutover.mode']` is reused (design §5.2: 1 s per isolate). */
const MODE_CACHE_MS = 1000;
const MODE_KEY = "cutover.mode";

type Mode = "read_only" | "proxy" | null;
// Per isolate, not per store: a Worker builds its store on every request, and the cache has to outlive that. Keyed by the binding.
const modeCache = new WeakMap<object, { at: number; mode: Mode }>();

export function d1CutoverStore(db: D1Database, opts: { nowMs?: () => number; cacheMs?: number } = {}): CutoverStore {
  const clock = opts.nowMs ?? (() => Date.now());
  const ttl = opts.cacheMs ?? MODE_CACHE_MS;
  return {
    async mode() {
      const t = clock();
      const hit = modeCache.get(db);
      if (hit !== undefined && t - hit.at < ttl) return hit.mode;
      const row = await db.prepare("SELECT value FROM import_state WHERE key = ?").bind(MODE_KEY).first<{ value: string }>();
      const v = row?.value;
      const mode: Mode = v === "read_only" || v === "proxy" ? v : null;
      modeCache.set(db, { at: t, mode });
      return mode;
    },
  };
}
