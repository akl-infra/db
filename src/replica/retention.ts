// Daily snapshots and log retention (RP3). Point-in-time restore to any commit within the last 35 days needs, for each
// seq k, a verified snapshot at or below k and the log from there to k. So:
//  - once a day the jobs tick writes a daily snapshot into one of 40 rotating slots (snapshot.ts), keeping 40 days;
//  - log entries are marked for expiry (DynamoDB TTL) only up to the seq of the OLDEST retained daily snapshot that
//    reads back and verifies, and only once that snapshot is itself at least 35 days old, so the whole 35-day window
//    still has a snapshot at or below its start. An entry that no verified snapshot covers is never marked.
//  - Expiry is the end of the road for "replay from 0": after it the log no longer starts at seq 1 (boot.ts then boots from
//    the newest daily snapshot instead).
//  - Spilled log bodies (`log/*`) whose entries are long gone, and orphans of lost appends, are deleted (cleanSpills).
import { decodeTime } from "ulidx";
import { raise } from "./alarm";
import type { CommitLog, ExpirableLog } from "./log";
import { SPILL_PREFIX } from "./objects";
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

export interface AnchorResult {
  /** The oldest daily snapshot that reads back and verifies, or null. */
  anchor: SnapRef | null;
  /** The dailies older than the anchor that did not verify (each already raised one alarm line). */
  unverified: string[];
}

/**
 * The oldest verified daily snapshot: the proof's base and retention's boundary. Each daily slot found unverified on the way
 * raises exactly one `akldb-alarm: retention: ...` line; the nightly job calls this once and hands the result to both.
 */
export async function findAnchor(deps: SnapshotDeps): Promise<AnchorResult> {
  const logLine = deps.logLine ?? consoleLog;
  const unverified: string[] = [];
  for (const d of await deps.state.dailies()) {
    // ascending seq
    try {
      await readSnapshot(d, deps.objects);
      return { anchor: d, unverified };
    } catch (e) {
      const why = e instanceof Error ? e.message : String(e);
      unverified.push(`${d.key} (seq ${d.seq}): ${why}`);
      raise(logLine, "retention", `daily snapshot ${d.key} (seq ${d.seq}) is unverified, not an anchor: ${why}`);
    }
  }
  return { anchor: null, unverified };
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
  /** Spilled bodies deleted this run. */
  spillsDeleted: number;
}

/**
 * Mark log entries for expiry up to the oldest verified daily snapshot, when that snapshot is old enough to anchor the
 * 35-day window, then delete the spilled bodies the log no longer needs. Idempotent: it resumes from the stored mark.
 */
export async function runRetention(commitLog: CommitLog & ExpirableLog, deps: SnapshotDeps, found?: AnchorResult): Promise<RetentionResult> {
  const logLine = deps.logLine ?? consoleLog;
  const nowMs = (deps.now ?? Date.now)();
  const { anchor, unverified } = found ?? (await findAnchor(deps));
  const mark = await deps.state.expiredThrough();
  if (anchor === null) return { boundary: null, reason: "no daily snapshot verifies", marked: 0, through: mark, unverified, spillsDeleted: 0 };
  if (nowMs - Date.parse(anchor.at) < PITR_DAYS * DAY_MS) {
    return { boundary: null, reason: `the oldest verified daily snapshot (seq ${anchor.seq}, ${anchor.at}) is younger than ${PITR_DAYS} days`, marked: 0, through: mark, unverified, spillsDeleted: 0 };
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
  const spillsDeleted = await cleanSpills(commitLog, deps, through);
  logLine(`akldb-retention: boundary=${anchor.seq} (${anchor.key}) marked=${marked} through=${through} spillsDeleted=${spillsDeleted}`);
  return { boundary: anchor.seq, reason: "ok", marked, through, unverified, spillsDeleted };
}

/** Spilled bodies older than the oldest kept entry by this much are deleted: DynamoDB removes an expired item up to ~48 h after its ttl. */
export const SPILL_GRACE_MS = 3 * DAY_MS;
const MAX_SPILL_DELETES = 500;

/**
 * Delete `log/*` objects whose unit is older than the log's oldest kept entry (the first one retention has NOT marked,
 * `through + 1`), less a grace for DynamoDB's lazy TTL deletion. That covers the bodies of expired entries and the orphans of
 * appends that were lost or never landed. A unit id is a ULID, so its age is in the name; a name that does not decode is left
 * alone. `log/` is the only prefix the object store will list or delete.
 */
export async function cleanSpills(commitLog: CommitLog, deps: SnapshotDeps, through: number): Promise<number> {
  if (through <= 0) return 0;
  const oldest = await commitLog.get(through + 1);
  if (oldest === null) return 0;
  let cutoff: number;
  try {
    cutoff = decodeTime(oldest.unitId) - SPILL_GRACE_MS;
  } catch {
    return 0; // not a ULID (a test's hand-made id): nothing safe to compare against
  }
  let deleted = 0;
  for (const key of await deps.objects.list(SPILL_PREFIX, 5000)) {
    if (deleted >= MAX_SPILL_DELETES) break;
    const unit = /^log\/([0-9A-Z]{26})\.json\.zst$/.exec(key)?.[1];
    if (unit === undefined) continue;
    let t: number;
    try {
      t = decodeTime(unit);
    } catch {
      continue;
    }
    if (t < cutoff) {
      await deps.objects.delete(key);
      deleted++;
    }
  }
  return deleted;
}

export { DAILY_SLOTS };
