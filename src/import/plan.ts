// planTick (07 §6 S5): pure -- (list, local state) -> actions. No D1, no
// network, no clock reads of its own (`now` is passed in) -- LDB-I3/I6's
// tests rely on this being a plain function of its input.
import type { UpstreamListEntry } from "./upstream";

export interface LocalMapRow {
  upstreamId: string;
  layoutId: string;
  name: string;
  // B2 sticky shadow (design/layout-db/review/audit-db.md B2, migrations/
  // 0012): the last name UPSTREAM itself reported for this id, distinct
  // from `name` (the layout's own current name, which may be a stable
  // shadow permanently different from what upstream calls it). Null for a
  // pre-migration row -- falls back to `name`.
  upstreamName: string | null;
  modified_at: string;
  like_count: number;
  deleted: boolean;
}

export interface DeleteAction {
  upstreamId: string;
  layoutId: string;
}

export interface PlanInput {
  list: UpstreamListEntry[];
  local: LocalMapRow[];
  lastFull: string | null; // ISO, or null if a full pass has never completed
  // The sorted upstream id boundary an IN-PROGRESS sweep has covered so far
  // (exclusive -- ids > cursor are still due), or null when no sweep is
  // running. A write-capped tick can only cover a slice of the live set in
  // one pass (07 §6 S5: "the initial import completes in <=9 ticks" only
  // holds if a sweep resumes where it left off instead of restarting from
  // the top every tick -- without a cursor, a capped tick can never even
  // finish importing a corpus bigger than one cap, because every
  // already-imported id keeps re-qualifying for "full pass due" and
  // crowding out the ones still unprocessed).
  fullPassCursor: string | null;
  now: string; // ISO
  // LDB-I22 (saltorbit 2026-09-13, "concerned about the cmini owner crashing
  // out and deleting their db when this goes live"): the count of
  // `upstream_deleted` TOMBSTONES this service has actually APPLIED
  // (rev-bumping, `import/apply.ts`'s `applyDelete` following branch --
  // never the informational not-following variant) in the trailing 24h,
  // as of `now`. Passed in rather than read here so `planTick` stays a
  // plain function of its input (the caller, `import/cmini.ts`, computes
  // it with one indexed D1 query); defaults to 0 so every pre-existing
  // caller/test that never heard of this budget keeps behaving exactly as
  // it did before this field existed.
  deletesAppliedLast24h?: number;
}

export type PlanResult =
  | { kind: "collapsed"; reason: string }
  | {
      kind: "ok";
      // `fetch`: ids with a real reason to fetch (new, changed, tombstoned-
      // but-still-listed) -- always prioritized. `fetchFullPassOnly`: ids
      // that would need no fetch at all except the daily full pass wants
      // them re-verified (already narrowed to `id > fullPassCursor`, sorted
      // -- see `fullPassCursor` above). Kept apart from `fetch` (rather than
      // one merged, sorted list) so a write-capped tick spends its budget on
      // real backlog first.
      fetch: string[];
      fetchFullPassOnly: string[];
      delete: DeleteAction[]; // empty when bounded out (see deleteStalled)
      // LDB-M3: `count` is how many WOULD have been deleted this tick --
      // kept even though `delete` itself is emptied out, so a caller (the
      // health endpoint) can report the real severity of a stall instead
      // of a misleading 0.
      deleteStalled: { reason: string; count: number } | null;
      isFullPass: boolean;
    };

const DAY_MS = 24 * 60 * 60 * 1000;

// LDB-I22: the rolling 24h delete budget. The per-tick bound (LDB-I3,
// `bound` below) alone lets a "slow drip" through -- 5% of live records
// every 5-minute tick, 288 ticks/day, is the whole corpus gone in a day.
// This bounds the TOTAL applied in any trailing 24h window instead, same
// floor-or-percentage shape as the per-tick bound so both read the same
// way. Numbers (saltorbit 2026-09-13's ask, chosen from the catalog's real
// churn): production's entire event history (45,257 events as of
// 2026-09-13, `GET /v1/changes?kinds=upstream_deleted` paged to
// completion) contains ZERO `upstream_deleted` events of any kind, ever --
// cmini layouts essentially never get deleted upstream in practice, so
// there is no real daily figure to beat, only headroom to bound a
// hypothetical hostile/broken upstream against. `max(20, 2% of live)`
// mirrors the per-tick bound's own `max(5, 5%)` shape at four ticks'
// worth of percentage and four times the floor -- generous next to an
// observed real maximum of 0/day, while still capping a worst-case
// mass-deletion day at ~2% of the corpus instead of ~100% (5% x 288
// ticks) the old per-tick-only guard allowed.
export const ROLLING_DELETE_BUDGET_MIN = 20;
export const ROLLING_DELETE_BUDGET_PCT = 0.02;

export function rollingDeleteBudget(liveCount: number): number {
  return Math.max(ROLLING_DELETE_BUDGET_MIN, ROLLING_DELETE_BUDGET_PCT * liveCount);
}

function isFullPassDue(lastFull: string | null, now: string): boolean {
  if (lastFull === null) return true;
  return Date.parse(now) - Date.parse(lastFull) >= DAY_MS;
}

export function planTick(input: PlanInput): PlanResult {
  const { list, local, lastFull, fullPassCursor, now, deletesAppliedLast24h = 0 } = input;

  const liveLocal = local.filter((r) => !r.deleted);
  const liveCount = liveLocal.length;

  // Collapse guard (LDB-I6): a list shorter than half the live record
  // count stalls the WHOLE tick -- checked before anything else so a
  // truncated/broken list response never reaches the delete logic below.
  if (liveCount > 0 && list.length < 0.5 * liveCount) {
    return {
      kind: "collapsed",
      reason: `list has ${list.length} entries, fewer than half of ${liveCount} live local records`,
    };
  }

  // A sweep already in progress (a cursor exists) keeps going regardless of
  // the 24h check -- it only started because the check was once true, and
  // must run to completion (07 §6 S5's write cap means that can take more
  // than one tick) before `lastFull` moves and the check can go false again.
  const isFullPass = fullPassCursor !== null || isFullPassDue(lastFull, now);
  const localByUpstreamId = new Map(local.map((r) => [r.upstreamId, r]));
  const listedIds = new Set(list.map((e) => e.id));

  const fetchSet = new Set<string>();
  const fullPassOnlySet = new Set<string>();
  for (const entry of list) {
    const row = localByUpstreamId.get(entry.id);
    if (row === undefined) {
      fetchSet.add(entry.id); // new upstream id
      continue;
    }
    if (row.modified_at !== entry.modified_at) {
      fetchSet.add(entry.id);
      continue;
    }
    // LDB-B1 (design/layout-db/review/audit-db.md B1): likes are a union,
    // never reverted, so a local like_count that's HIGHER than upstream's
    // (extra likes made through us upstream will never see) is not itself
    // a reason to fetch -- that would refetch this id forever with nothing
    // to apply. Only upstream having MORE likes than we've recorded is a
    // real signal we might be missing one to union in.
    if ((entry.like_count ?? 0) > row.like_count) {
      fetchSet.add(entry.id);
      continue;
    }
    // B2 sticky shadow: compare against the last name UPSTREAM reported
    // (`upstreamName`), never our own possibly-shadowed `name` -- a
    // following layout's stable shadow otherwise looks "changed" forever
    // and gets re-fetched (and, absent apply.ts's own sticky fix, re-
    // collided) every tick.
    if ((row.upstreamName ?? row.name) !== entry.name) {
      fetchSet.add(entry.id);
      continue;
    }
    if (row.deleted) {
      fetchSet.add(entry.id); // tombstoned locally but still listed -- a possible resurrection
      continue;
    }
    if (isFullPass && (fullPassCursor === null || entry.id > fullPassCursor)) {
      fullPassOnlySet.add(entry.id); // daily full pass: recheck content even with no cheap signal of change
    }
  }

  // Prune bound (LDB-I3): map rows no longer listed are delete candidates.
  const deleteCandidates: DeleteAction[] = local
    .filter((r) => !r.deleted && !listedIds.has(r.upstreamId))
    .map((r) => ({ upstreamId: r.upstreamId, layoutId: r.layoutId }));

  const bound = Math.max(5, 0.05 * liveCount);
  let del = deleteCandidates;
  let deleteStalled: { reason: string; count: number } | null = null;
  if (deleteCandidates.length > bound) {
    del = [];
    deleteStalled = {
      reason: `${deleteCandidates.length} pending deletions exceed the per-tick bound (max(5, 5% of ${liveCount}) = ${bound})`,
      count: deleteCandidates.length,
    };
  } else {
    // LDB-I22: even within the per-tick bound, applying these would push
    // the ROLLING 24h total over budget -- stall ALL of this tick's
    // deletes (never partially apply the difference) exactly like the
    // per-tick guard does, so the two behave identically from a caller's
    // point of view (one `deleteStalled` shape either way).
    const budget = rollingDeleteBudget(liveCount);
    if (deletesAppliedLast24h + deleteCandidates.length > budget) {
      del = [];
      deleteStalled = {
        reason:
          `${deletesAppliedLast24h} deletions already applied in the trailing 24h plus ${deleteCandidates.length} pending ` +
          `would exceed the rolling 24h budget (max(${ROLLING_DELETE_BUDGET_MIN}, ${ROLLING_DELETE_BUDGET_PCT * 100}% of ${liveCount}) = ${budget})`,
        count: deleteCandidates.length,
      };
    }
  }

  return {
    kind: "ok",
    fetch: [...fetchSet].sort(),
    fetchFullPassOnly: [...fullPassOnlySet].sort(),
    delete: del,
    deleteStalled,
    isFullPass,
  };
}
