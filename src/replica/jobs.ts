// The snapshot jobs, in two groups.
//
//  runRollingJob   every `{"akldb":"tick"}` (5 minutes): a rolling snapshot when 50 units or an hour have passed since the
//                  pointer's. Level-12 compression of a 45 MB image is about 3 s, so it fits the tick's 35 s.
//  runNightlyJobs  once per UTC day, from 03:00, in its OWN invocation (`{"akldb":"nightly"}` on the jobs function, 600 s):
//                  today's daily snapshot, log retention (ttl marks and spill cleanup), and the nightly proof. The tick only
//                  decides that it is due (nightlyDue) and starts it, claiming the day so a 5-minute tick cannot start it twice.
//
// Each step is isolated (a failed upload must not skip the proof) and each failure raises exactly one
// `akldb-alarm: <component>: ...` line; any failure is also thrown at the end so the Lambda Errors alarm sees it, and the work
// that did succeed stays done.
import { raise } from "./alarm";
import type { CommitLog, ExpirableLog } from "./log";
import { ProofMismatchError, nightlyProof } from "./proof";
import { ReplicaDivergedError, type Replica, type ReplicaOptions } from "./replica";
import { dailyDue, findAnchor, runRetention, writeDaily, type AnchorResult, type RetentionResult } from "./retention";
import { consoleLog, dayOf, snapshotDue, writeSnapshot, type SnapshotDeps, type SnapshotOutcome, type SnapshotPolicy } from "./snapshot";

export interface SnapshotJobDeps extends SnapshotDeps {
  log: CommitLog & Partial<ExpirableLog>;
  policy?: SnapshotPolicy;
  /** Options for the proof's rebuilt replica (tests: no real sleeping). */
  replica?: ReplicaOptions;
  /** Test switch: skip the nightly proof. Default on. */
  proof?: boolean;
}

/** How long one claim of the nightly job blocks another (the jobs function times out at 600 s). */
export const NIGHTLY_LEASE_MS = 11 * 60 * 1000;

export async function runRollingJob(replica: Replica, deps: SnapshotJobDeps): Promise<SnapshotOutcome | "not due"> {
  const logLine = deps.logLine ?? consoleLog;
  const nowMs = (deps.now ?? Date.now)();
  try {
    const [head, pointer] = await Promise.all([deps.log.head(), deps.state.pointer()]);
    return snapshotDue(head, pointer, nowMs, deps.policy) ? await writeSnapshot(replica, deps) : "not due";
  } catch (e) {
    raise(logLine, "snapshot", `rolling snapshot failed: ${e instanceof Error ? e.message : String(e)}`);
    throw e;
  }
}

/** True from 03:00 UTC while no daily snapshot carries today's date: the tick should start the nightly job. */
export async function nightlyDue(deps: SnapshotDeps): Promise<boolean> {
  const nowMs = (deps.now ?? Date.now)();
  if (new Date(nowMs).getUTCHours() < 3) return false; // before the daily hour: no index read
  return dailyDue(await deps.state.dailies(), nowMs);
}

export interface NightlyReport {
  /** "busy": another run holds today's claim. */
  status: "ran" | "busy";
  daily: SnapshotOutcome | "exists" | null;
  retention: RetentionResult | null;
  proof: { seq: number; digest: string } | null;
  errors: string[];
}

/**
 * The nightly job: claim the day, write today's daily snapshot if it is missing, find the oldest verified daily once (one
 * alarm line per unverified slot), run retention and the proof on it. Run by hand, or again the same day after the lease,
 * it skips the daily snapshot that exists and redoes retention and the proof.
 */
export async function runNightlyJobs(replica: Replica, deps: SnapshotJobDeps): Promise<NightlyReport> {
  const logLine = deps.logLine ?? consoleLog;
  const nowMs = (deps.now ?? Date.now)();
  const report: NightlyReport = { status: "ran", daily: null, retention: null, proof: null, errors: [] };
  if (!(await deps.state.claimNightly(dayOf(nowMs), nowMs, NIGHTLY_LEASE_MS))) return { ...report, status: "busy" };

  const failures: unknown[] = [];
  const attempt = async <T>(component: string, what: string, fn: () => Promise<T>): Promise<T | undefined> => {
    try {
      return await fn();
    } catch (e) {
      failures.push(e);
      const why = e instanceof Error ? e.message : String(e);
      report.errors.push(`${what}: ${why}`);
      // a divergence raised its own line where the replica halted; one event, one line
      if (!(e instanceof ReplicaDivergedError)) raise(logLine, component, `${what} failed: ${why}`);
      return undefined;
    }
  };

  const dailies = await attempt("snapshot", "daily index read", () => deps.state.dailies());
  if (dailies !== undefined) {
    if (dailies.some((d) => d.day === dayOf(nowMs))) report.daily = "exists";
    else report.daily = (await attempt("snapshot", "daily snapshot", () => writeDaily(replica, deps))) ?? null;
  }

  const found: AnchorResult | undefined = await attempt("retention", "daily snapshot verification", () => findAnchor(deps));
  if (found !== undefined) {
    if (deps.log.expire !== undefined) report.retention = (await attempt("retention", "log retention", () => runRetention(deps.log as CommitLog & ExpirableLog, deps, found))) ?? null;
    if (deps.proof !== false) {
      const r = await attempt("proof", "nightly proof", () => nightlyProof(replica, { log: deps.log, state: deps.state, objects: deps.objects, replica: deps.replica, logLine }, "oldest", found));
      if (r !== undefined) report.proof = { seq: r.seq, digest: r.digest };
    }
  }

  if (failures.length > 0) {
    // A proof mismatch (or a rebuild that cannot replay the log) is the page; surface it as itself.
    const mismatch = failures.find((f) => f instanceof ProofMismatchError || f instanceof ReplicaDivergedError);
    if (mismatch !== undefined) throw mismatch;
    throw new Error(`nightly jobs failed: ${report.errors.join("; ")}`, { cause: failures[0] });
  }
  return report;
}
