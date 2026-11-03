// The snapshot jobs the `{"akldb":"tick"}` event runs after the Worker's scheduled() jobs (never on a request path):
//   every tick   a rolling snapshot when 50 units or an hour have passed since the pointer's
//   daily        from 03:00 UTC, once per UTC day: the daily snapshot, then log retention, then the nightly proof
// Each step is isolated (a failed upload must not skip the proof), and any failure is thrown at the end so the Lambda
// Errors alarm sees it; the work that did succeed stays done.
import type { CommitLog, ExpirableLog } from "./log";
import { ProofMismatchError, nightlyProof } from "./proof";
import { ReplicaDivergedError, type Replica, type ReplicaOptions } from "./replica";
import { dailyDue, runRetention, writeDaily, type RetentionResult } from "./retention";
import { consoleLog, snapshotDue, writeSnapshot, type SnapshotDeps, type SnapshotOutcome, type SnapshotPolicy } from "./snapshot";

export interface SnapshotJobDeps extends SnapshotDeps {
  log: CommitLog & Partial<ExpirableLog>;
  policy?: SnapshotPolicy;
  /** Options for the proof's rebuilt replica (tests: no real sleeping). */
  replica?: ReplicaOptions;
  /** Test switch: skip the daily block's proof. Default on. */
  proof?: boolean;
}

export interface SnapshotJobReport {
  rolling: SnapshotOutcome | "not due";
  daily: SnapshotOutcome | "not due" | null;
  retention: RetentionResult | null;
  proof: { seq: number; digest: string } | null;
  errors: string[];
}

export async function runSnapshotJobs(replica: Replica, deps: SnapshotJobDeps): Promise<SnapshotJobReport> {
  const logLine = deps.logLine ?? consoleLog;
  const nowMs = (deps.now ?? Date.now)();
  const report: SnapshotJobReport = { rolling: "not due", daily: null, retention: null, proof: null, errors: [] };
  const failures: unknown[] = [];
  const attempt = async <T>(what: string, fn: () => Promise<T>): Promise<T | undefined> => {
    try {
      return await fn();
    } catch (e) {
      failures.push(e);
      report.errors.push(`${what}: ${e instanceof Error ? e.message : String(e)}`);
      logLine(`akldb-snapshot: ${what} FAILED: ${e instanceof Error ? e.message : String(e)}`);
      return undefined;
    }
  };

  // 1. rolling
  await attempt("rolling snapshot", async () => {
    const [head, pointer] = await Promise.all([deps.log.head(), deps.state.pointer()]);
    if (snapshotDue(head, pointer, nowMs, deps.policy)) report.rolling = await writeSnapshot(replica, deps);
  });

  // 2. daily, retention, proof
  const dailies = await attempt("daily index", () => deps.state.dailies());
  if (dailies !== undefined && dailyDue(dailies, nowMs)) {
    report.daily = "not due";
    const wrote = await attempt("daily snapshot", () => writeDaily(replica, deps));
    if (wrote !== undefined) report.daily = wrote;
    if (deps.log.expire !== undefined) {
      const expirable = deps.log as CommitLog & ExpirableLog;
      report.retention = (await attempt("log retention", () => runRetention(expirable, deps))) ?? null;
    }
    if (deps.proof !== false) {
      const r = await attempt("nightly proof", () => nightlyProof(replica, { log: deps.log, state: deps.state, objects: deps.objects, replica: deps.replica, logLine }));
      if (r !== undefined) report.proof = { seq: r.seq, digest: r.digest };
    }
  }

  if (failures.length > 0) {
    // A proof mismatch (or a rebuild that cannot replay the log) is the page; surface it as itself.
    const mismatch = failures.find((f) => f instanceof ProofMismatchError || f instanceof ReplicaDivergedError);
    if (mismatch !== undefined) throw mismatch;
    throw new Error(`snapshot jobs failed: ${report.errors.join("; ")}`, { cause: failures[0] });
  }
  return report;
}
