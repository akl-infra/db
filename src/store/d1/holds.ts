// D1 `HoldStore` and `CutoverStore` (src/store/port.ts). The hold budget is
// not built yet (every hold is granted); the cutover flag is real: the
// `import_state['cutover.mode']` row, read through a 1 s per-isolate cache
// (docs/technical-reference.md "Cutover modes", LDB-CV7).
import type { CutoverStore, HoldStore } from "../port";

export function d1HoldStore(_db: D1Database): HoldStore {
  return {
    async takeHold() {
      return true;
    },
    async releaseHold() {},
  };
}

type Mode = "read_only" | null;

/** How long a read of `import_state['cutover.mode']` is reused: an operator's flip is live within this. */
export const CUTOVER_MODE_CACHE_MS = 1000;
export const CUTOVER_MODE_KEY = "cutover.mode";

// Per isolate, not per store: a Worker builds its store on every request, and the cache has to outlive that. Keyed by the binding.
const modeCache = new WeakMap<object, { at: number; mode: Mode }>();

export function d1CutoverStore(db: D1Database, opts: { nowMs?: () => number; cacheMs?: number } = {}): CutoverStore {
  const clock = opts.nowMs ?? (() => Date.now());
  const ttl = opts.cacheMs ?? CUTOVER_MODE_CACHE_MS;
  return {
    async mode() {
      const t = clock();
      const hit = modeCache.get(db);
      if (hit !== undefined && t - hit.at < ttl) return hit.mode;
      try {
        const row = await db.prepare("SELECT value FROM import_state WHERE key = ?").bind(CUTOVER_MODE_KEY).first<{ value: string }>();
        const v = row?.value;
        const mode: Mode = v === "read_only" ? v : null;
        modeCache.set(db, { at: t, mode });
        return mode;
      } catch (e) {
        // The flag can only add behaviour: a failed read must not turn a request that works today into an error. Keep the last
        // known value (a freeze in force stays in force), else normal; try again on the next request.
        console.error(`cutover: mode read failed: ${e instanceof Error ? e.message : String(e)}`);
        return hit?.mode ?? null;
      }
    },
  };
}
