// Boot a replica (design A, phase B). The fast path:
//
//   GetItem SNAP/POINTER ──► S3 GET the snapshot ─┐
//                       └──► log HEAD, tail read ─┴─► unzstd, verify sha256 ─► deserialize ─► replay the tail ─► catchUp ─► serve
//
// The pointer read starts the S3 GET; the head read and the tail read run beside the GET, so the tail is usually in hand
// when the image is ready. RP2: nothing is served before the image is verified, the prefetched tail is replayed and a final
// strong head read (catchUp) finds nothing left. Any failure on the snapshot path falls back, loudly, in this order:
//
//   POINTER ──► PREV ──► the newest verified DAILY snapshot (+ its tail) ──► replay the whole log from seq 0
//
// Every fallback taken logs exactly one `akldb-alarm: boot: ...` line (alarm.ts); the `akldb-boot:` line says which path
// finally ran. Replay from 0 works only while the log still starts at seq 1 (retention.ts expires old entries past the daily
// snapshots), which is exactly why the daily step sits before it: after retention it is the last path that still works.
// Only when all four fail does the boot throw (with one more alarm line), and the Lambda handler retries once.
import { raise } from "./alarm";
import type { LogEntry, CommitLog } from "./log";
import type { ObjectStore } from "./objects";
import { Replica, ReplicaDivergedError, type ReplicaOptions } from "./replica";
import { consoleLog, readSnapshot, type LogFn, type SnapRef, type SnapshotState } from "./snapshot";

export interface BootOptions extends ReplicaOptions {
  /** Where snapshots live. Without it the replica replays the log from seq 0 (phase C's behaviour). */
  snapshots?: { state: SnapshotState; objects: ObjectStore };
  /** Where the boot lines and alarm lines go. Default console.error. */
  logLine?: LogFn;
}

export type BootPath = "pointer" | "prev" | "daily" | "replay";

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
  const fallback = (what: string, why: string): void => {
    fallbacks.push(`${what}: ${why}`);
    raise(logLine, "boot", `fallback: ${what} unusable: ${why}`);
  };
  if (snapshots !== undefined) {
    // The head and the tail are read once, beside whichever snapshot GET runs first; a later candidate reuses them if it can.
    const tail = prefetchTail(log);
    tail.promise.catch(() => {});
    const candidates = async function* (): AsyncGenerator<{ which: "pointer" | "prev" | "daily"; label: string; ref: SnapRef | null }> {
      yield { which: "pointer", label: "pointer", ref: await snapshots.state.pointer() };
      yield { which: "prev", label: "prev", ref: await snapshots.state.previous() };
      // Read lazily: a healthy boot never queries the daily index.
      for (const d of (await snapshots.state.dailies()).sort((a, b) => b.seq - a.seq)) yield { which: "daily", label: `daily ${d.key}`, ref: d };
    };
    for await (const { which, label, ref } of candidates()) {
      if (ref === null) {
        // an absent POINTER/PREV is the normal state of a young stack, not a failure: note it, no alarm
        fallbacks.push(`${label}: none recorded`);
        continue;
      }
      const gate = { quiet: true };
      try {
        const replica = await fromRef(log, ref, snapshots.objects, tail, { ...replicaOpts, alarm: (l) => (gate.quiet ? undefined : (replicaOpts.alarm ?? logLine)(l)) });
        gate.quiet = false;
        reports.set(replica, { path: which, snapshot: ref, fromSeq: ref.seq, seq: replica.seq, fallbacks });
        logLine(`akldb-boot: path=${which} snapshot=${ref.key} snapshotSeq=${ref.seq} seq=${replica.seq} replayed=${replica.stats.replayed}${fallbacks.length > 0 ? ` fallbacks=[${fallbacks.join("; ")}]` : ""}`);
        return replica;
      } catch (e) {
        if (!(e instanceof BootFallback)) throw e; // a log or network failure the next snapshot would hit too: fail the boot, the handler retries
        fallback(label, e.message);
      }
    }
  }
  const replica = new Replica(log, { ...replicaOpts, alarm: replicaOpts.alarm ?? logLine });
  try {
    await replica.catchUp();
  } catch (e) {
    replica.close();
    // a divergence already raised the replica's own alarm line; anything else (the log no longer starts at 1, a read failure) is raised here
    if (snapshots !== undefined && !(e instanceof ReplicaDivergedError)) raise(logLine, "boot", `no usable path: every snapshot failed and the log cannot be replayed from seq 0: ${msg(e)}`);
    throw e;
  }
  reports.set(replica, { path: "replay", snapshot: null, fromSeq: 0, seq: replica.seq, fallbacks });
  logLine(`akldb-boot: path=replay seq=${replica.seq} replayed=${replica.stats.replayed}${fallbacks.length > 0 ? ` fallbacks=[${fallbacks.join("; ")}]` : snapshots === undefined ? " (no snapshot store)" : ""}`);
  return replica;
}

/** A snapshot that cannot be used (missing, damaged, wrong, or its tail does not replay on it): try the next path. */
class BootFallback extends Error {}

interface Tail {
  /** The head and the entries after the first snapshot's seq, read while it downloads. `from` = the seq it started after. */
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
    // The prefetched tail only helps if it starts at this snapshot's seq; a later candidate starts elsewhere and reads on its own.
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
