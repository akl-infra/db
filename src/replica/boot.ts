// Boot a replica (design A, phase B). The fast path:
//
//   GetItem SNAP/POINTER ──► S3 GET the snapshot ─┐
//                       └──► log HEAD, tail read ─┴─► unzstd, verify sha256 ─► deserialize ─► replay the tail ─► catchUp ─► serve
//
// The pointer read starts the S3 GET; the head read and the tail read run beside the GET, so the tail is usually in hand
// when the image is ready. RP2: nothing is served before the image is verified, the prefetched tail is replayed and a final
// strong head read (catchUp) finds nothing left. Any failure on the snapshot path falls back, loudly, in this order:
//
//   POINTER ──► PREV ──► replay the whole log from seq 0
//
// A fallback is never silent: every step logs one `akldb-boot:` line saying which path ran and why the earlier one did not.
// Replay from 0 works only while the log still starts at seq 1 (retention.ts expires old entries past the daily snapshots);
// when it does not, the error says so and the container fails to boot (the Lambda handler retries once, the Errors alarm fires).
import type { LogEntry, CommitLog } from "./log";
import type { ObjectStore } from "./objects";
import { Replica, ReplicaDivergedError, type ReplicaOptions } from "./replica";
import { consoleLog, readSnapshot, type LogFn, type SnapRef, type SnapshotState } from "./snapshot";

export interface BootOptions extends ReplicaOptions {
  /** Where snapshots live. Without it the replica replays the log from seq 0 (phase C's behaviour). */
  snapshots?: { state: SnapshotState; objects: ObjectStore };
  /** Where the boot report goes. Default console.error. */
  logLine?: LogFn;
}

export type BootPath = "pointer" | "prev" | "replay";

/** What a boot did, kept on the replica for the warm/tick answers and for tests. */
export interface BootReport {
  path: BootPath;
  /** The snapshot used (null for replay). */
  snapshot: SnapRef | null;
  /** Seq the replica started its replay from. */
  fromSeq: number;
  /** Seq it reached (the head it was served at). */
  seq: number;
  /** Why each earlier path was not used. */
  fallbacks: string[];
}

const reports = new WeakMap<Replica, BootReport>();
export const bootReportOf = (r: Replica): BootReport | undefined => reports.get(r);

const msg = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/** A replica caught up to the log's head. Nothing is served before this resolves (RP2). */
export async function bootReplica(log: CommitLog, opts: BootOptions = {}): Promise<Replica> {
  const { snapshots, logLine = consoleLog, ...replicaOpts } = opts;
  const fallbacks: string[] = [];
  if (snapshots !== undefined) {
    // The head and the tail are read once, beside whichever snapshot GET runs; a fallback reuses them.
    const tail = prefetchTail(log);
    tail.promise.catch(() => {});
    for (const which of ["pointer", "prev"] as const) {
      try {
        const ref = await (which === "pointer" ? snapshots.state.pointer() : snapshots.state.previous());
        if (ref === null) {
          fallbacks.push(`${which}: none recorded`);
          continue;
        }
        const replica = await fromRef(log, ref, snapshots.objects, tail, replicaOpts);
        const report: BootReport = { path: which, snapshot: ref, fromSeq: ref.seq, seq: replica.seq, fallbacks };
        reports.set(replica, report);
        logLine(`akldb-boot: path=${which} snapshot=${ref.key} snapshotSeq=${ref.seq} seq=${replica.seq} replayed=${replica.stats.replayed}${fallbacks.length > 0 ? ` fallbacks=[${fallbacks.join("; ")}]` : ""}`);
        return replica;
      } catch (e) {
        if (!(e instanceof BootFallback)) throw e; // a log or network failure the next snapshot would hit too: fail the boot, the handler retries
        fallbacks.push(`${which}: ${e.message}`);
        logLine(`akldb-boot: FALLBACK ${which} unusable: ${e.message}`);
      }
    }
  }
  const replica = new Replica(log, replicaOpts);
  try {
    await replica.catchUp();
  } catch (e) {
    replica.close();
    throw e;
  }
  reports.set(replica, { path: "replay", snapshot: null, fromSeq: 0, seq: replica.seq, fallbacks });
  logLine(`akldb-boot: path=replay seq=${replica.seq} replayed=${replica.stats.replayed}${fallbacks.length > 0 ? ` fallbacks=[${fallbacks.join("; ")}]` : snapshots === undefined ? " (no snapshot store)" : ""}`);
  return replica;
}

/** A snapshot that cannot be used (missing, damaged, wrong, or its tail does not replay on it): try the next path. */
class BootFallback extends Error {}

interface Tail {
  /** The head and the entries after the pointer's seq, read while the snapshot downloads. Resolves with `from` = the seq it started after. */
  promise: Promise<{ head: number; from: number; entries: LogEntry[] }>;
  start(from: number): void;
}

function prefetchTail(log: CommitLog): Tail {
  let resolveFrom!: (n: number) => void;
  const from = new Promise<number>((r) => (resolveFrom = r));
  const headP = log.head();
  headP.catch(() => {});
  const promise = (async () => {
    const [head, after] = await Promise.all([headP, from]);
    return { head, from: after, entries: head > after ? await log.read(after, head) : [] };
  })();
  return { promise, start: resolveFrom };
}

async function fromRef(log: CommitLog, ref: SnapRef, objects: ObjectStore, tail: Tail, opts: ReplicaOptions): Promise<Replica> {
  tail.start(ref.seq);
  // The S3 GET and the tail read are in flight together.
  const [bytes, pre] = await Promise.all([readSnapshotOrFallback(ref, objects), tail.promise.catch(() => null)]);
  let replica: Replica;
  try {
    replica = Replica.fromSnapshot(log, bytes, ref.seq, opts);
  } catch (e) {
    throw new BootFallback(msg(e));
  }
  try {
    // The prefetched tail only helps if it starts at this snapshot's seq; a fallback to PREV starts earlier and reads on its own.
    if (pre !== null && pre.from === ref.seq) await replica.applyPrefetched(pre.entries);
    await replica.catchUp(); // the strong head read: whatever landed since the prefetch
  } catch (e) {
    replica.close();
    if (e instanceof ReplicaDivergedError) throw new BootFallback(`the log tail does not replay on this snapshot: ${e.message}`);
    throw e;
  }
  return replica;
}

async function readSnapshotOrFallback(ref: SnapRef, objects: ObjectStore): Promise<Uint8Array> {
  try {
    return await readSnapshot(ref, objects);
  } catch (e) {
    throw new BootFallback(msg(e));
  }
}
