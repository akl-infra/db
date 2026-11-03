// Daily snapshots and log retention (RP3). Point-in-time restore to any commit within the last 35 days needs, for each
// seq k, a verified snapshot at or below k and the log from there to k. So:
//  - once a day the jobs tick writes a daily snapshot into one of 40 rotating slots (snapshot.ts), keeping 40 days;
//  - log entries are marked for expiry (DynamoDB TTL) only up to the seq of the OLDEST retained daily snapshot that
//    reads back and verifies, and only once that snapshot is itself at least 35 days old, so the whole 35-day window
//    still has a snapshot at or below its start. An entry that no verified snapshot covers is never marked.
//  - Expiry is the end of the road for "replay from 0": after it the log no longer starts at seq 1 (boot.ts says so).
import type { CommitLog, ExpirableLog } from "./log";
import type { Replica } from "./replica";
import { DAILY_SLOTS, PITR_DAYS, consoleLog, dailySlot, dayOf, readSnapshot, writeSnapshot, type SnapRef, type SnapshotDeps, type SnapshotOutcome } from "./snapshot";

const DAY_MS = 86_400_000;
/** Expiry is set this long after the marking, so an operator who spots a mistake the next morning can still clear it. */
export const EXPIRY_GRACE_S = 86_400;
/** Entries marked per expire() call, and per job run (the daily job must fit one Lambda invocation). */
const BATCH = 1000;
const MAX_PER_RUN = 20_000;

/** UTC hour from which the daily job runs (03:00, where the worker's nightly prune already runs). */
export const DAILY_HOUR_UTC = 3;

/** A daily snapshot is due from 03:00 UTC if none carries today's date. */
export function dailyDue(dailies: SnapRef[], nowMs: number, hourUtc: number = DAILY_HOUR_UTC): boolean {
  return new Date(nowMs).getUTCHours() >= hourUtc && !dailies.some((d) => d.day === dayOf(nowMs));
}

/** Write today's daily snapshot into its slot (the slot's previous occupant is 40 days old). */
export function writeDaily(replica: Replica, deps: SnapshotDeps): Promise<SnapshotOutcome> {
  const now = (deps.now ?? Date.now)();
  return writeSnapshot(replica, deps, { type: "daily", slot: dailySlot(now), day: dayOf(now) });
}

export interface RetentionResult {
  /** The seq up to which entries may expire (the oldest verified daily snapshot's), or null when none may. */
  boundary: number | null;
  reason: string;
  /** Entries newly marked this run. */
  marked: number;
  /** Retention mark after the run: every entry at or below it has an expiry time. */
  through: number;
  /** Daily snapshots that did not verify (loud, but they only narrow what may expire). */
  unverified: string[];
}

/**
 * Mark log entries for expiry up to the oldest verified daily snapshot, when that snapshot is old enough to anchor the
 * 35-day window. Idempotent: it resumes from the stored mark.
 */
export async function runRetention(commitLog: CommitLog & ExpirableLog, deps: SnapshotDeps): Promise<RetentionResult> {
  const logLine = deps.logLine ?? consoleLog;
  const nowMs = (deps.now ?? Date.now)();
  const dailies = await deps.state.dailies(); // ascending seq
  const unverified: string[] = [];
  let anchor: SnapRef | null = null;
  for (const d of dailies) {
    try {
      await readSnapshot(d, deps.objects);
      anchor = d;
      break;
    } catch (e) {
      unverified.push(`${d.key} (seq ${d.seq}): ${e instanceof Error ? e.message : String(e)}`);
      logLine(`akldb-retention: daily snapshot ${d.key} (seq ${d.seq}) does not verify, not an anchor: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  const mark = await deps.state.expiredThrough();
  if (anchor === null) return { boundary: null, reason: "no daily snapshot verifies", marked: 0, through: mark, unverified };
  if (nowMs - Date.parse(anchor.at) < PITR_DAYS * DAY_MS) {
    return { boundary: null, reason: `the oldest verified daily snapshot (seq ${anchor.seq}, ${anchor.at}) is younger than ${PITR_DAYS} days`, marked: 0, through: mark, unverified };
  }
  const atSec = Math.floor(nowMs / 1000) + EXPIRY_GRACE_S;
  let through = mark;
  let marked = 0;
  while (through < anchor.seq && marked < MAX_PER_RUN) {
    const r = await commitLog.expire(through, anchor.seq, atSec, BATCH);
    marked += r.marked;
    if (r.through <= through) break;
    through = r.through;
    await deps.state.setExpiredThrough(through);
  }
  logLine(`akldb-retention: boundary=${anchor.seq} (${anchor.key}) marked=${marked} through=${through}`);
  return { boundary: anchor.seq, reason: "ok", marked, through, unverified };
}

export { DAILY_SLOTS };
