// Point-in-time restore and the nightly proof (RP3, RP4).
//
// restoreAt(k): the newest verified snapshot at or below k, then the log up to exactly k. It is what a restore after a
// bad write does, and the proof below is the same machinery pointed at the live replica's seq.
//
// nightlyProof(): rebuild a fresh replica from the OLDEST retained verified daily snapshot plus the log to the live
// replica's seq, and compare database images. A difference means the log no longer reproduces the live database (a
// replay bug, a lost or altered entry, a snapshot that is not what it says): it throws, and the Errors alarm pages.
import type { CommitLog } from "./log";
import type { ObjectStore } from "./objects";
import { Replica, imageDigest, type ReplicaOptions } from "./replica";
import { consoleLog, readSnapshot, type LogFn, type SnapRef, type SnapshotState } from "./snapshot";

export interface RestoreDeps {
  log: CommitLog;
  state: SnapshotState;
  objects: ObjectStore;
  replica?: ReplicaOptions;
  logLine?: LogFn;
}

/** Every snapshot the state knows (rolling pointer, PREV, dailies), newest first. */
async function allRefs(state: SnapshotState): Promise<SnapRef[]> {
  const [p, v, d] = await Promise.all([state.pointer(), state.previous(), state.dailies()]);
  const seen = new Set<string>();
  const out: SnapRef[] = [];
  for (const r of [p, v, ...d]) {
    if (r === null) continue;
    const id = `${r.key}@${r.seq}:${r.sha256}`;
    if (!seen.has(id)) (seen.add(id), out.push(r));
  }
  return out.sort((a, b) => b.seq - a.seq);
}

/** A replica at exactly log seq `k`: the newest snapshot at or below k that verifies, else a replay from 0. */
export async function restoreAt(k: number, deps: RestoreDeps): Promise<{ replica: Replica; base: SnapRef | null }> {
  const logLine = deps.logLine ?? consoleLog;
  for (const ref of (await allRefs(deps.state)).filter((r) => r.seq <= k)) {
    try {
      const bytes = await readSnapshot(ref, deps.objects);
      const replica = Replica.fromSnapshot(deps.log, bytes, ref.seq, deps.replica);
      try {
        await replica.catchUp(k);
      } catch (e) {
        replica.close();
        throw e;
      }
      return { replica, base: ref };
    } catch (e) {
      logLine(`akldb-restore: snapshot ${ref.key} (seq ${ref.seq}) unusable for seq ${k}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  const replica = new Replica(deps.log, deps.replica);
  try {
    await replica.catchUp(k);
  } catch (e) {
    replica.close();
    throw new Error(`cannot restore seq ${k}: no verified snapshot at or below it, and the log cannot be replayed from 0: ${e instanceof Error ? e.message : String(e)}`, { cause: e });
  }
  return { replica, base: null };
}

export class ProofMismatchError extends Error {
  constructor(readonly seq: number, readonly live: string, readonly rebuilt: string, readonly base: SnapRef | null) {
    super(`nightly proof FAILED at seq ${seq}: the live replica's image digest ${live} != ${rebuilt}, rebuilt from ${base === null ? "the log from seq 0" : `snapshot ${base.key} (seq ${base.seq})`} plus the log`);
    this.name = "ProofMismatchError";
  }
}

export interface ProofResult {
  seq: number;
  digest: string;
  base: SnapRef | null;
}

/**
 * Compare the live replica with a rebuild at the same seq. The live image is taken at one consistent seq under the replica's
 * mutex (Replica.capture); the rebuild runs outside it. `from`: which snapshot anchors the rebuild: the oldest retained
 * verified daily (default, the longest replay, which also proves the whole retained log) or the newest at/below the live seq.
 */
export async function nightlyProof(live: Replica, deps: RestoreDeps, from: "oldest" | "newest" = "oldest"): Promise<ProofResult> {
  const logLine = deps.logLine ?? consoleLog;
  const cap = await live.capture();
  const liveDigest = imageDigest(cap.bytes);
  let rebuilt: Replica;
  let base: SnapRef | null = null;
  if (from === "newest") {
    ({ replica: rebuilt, base } = await restoreAt(cap.seq, deps));
  } else {
    const dailies = (await deps.state.dailies()).filter((d) => d.seq <= cap.seq);
    let found: Replica | undefined;
    for (const ref of dailies) {
      try {
        const bytes = await readSnapshot(ref, deps.objects);
        found = Replica.fromSnapshot(deps.log, bytes, ref.seq, deps.replica);
        base = ref;
        break;
      } catch (e) {
        logLine(`akldb-proof: daily snapshot ${ref.key} (seq ${ref.seq}) does not verify, trying the next: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
    if (found === undefined) ({ replica: found, base } = await restoreAt(cap.seq, deps));
    else await found.catchUp(cap.seq);
    rebuilt = found;
  }
  try {
    const got = imageDigest(rebuilt.serialize());
    if (got !== liveDigest) throw new ProofMismatchError(cap.seq, liveDigest, got, base);
    logLine(`akldb-proof: ok seq=${cap.seq} digest=${got} base=${base === null ? "log" : `${base.key}@${base.seq}`}`);
    return { seq: cap.seq, digest: got, base };
  } finally {
    rebuilt.close();
  }
}
