// Boot a replica (design A). Phase C: replay the whole log from seq 0. This is the one function phase B replaces
// with the snapshot boot (S3 GET of the newest verified snapshot and the log HEAD read started together,
// deserialize, replay the tail); its callers (platform/lambda.ts) keep the same signature, so the swap changes
// this file only.
import type { CommitLog } from "./log";
import { Replica, type ReplicaOptions } from "./replica";

/** A replica caught up to the log's head. Nothing is served before this resolves (RP2 in phase B). */
export async function bootReplica(log: CommitLog, opts: ReplicaOptions = {}): Promise<Replica> {
  const replica = new Replica(log, opts);
  try {
    await replica.catchUp();
  } catch (e) {
    replica.close();
    throw e;
  }
  return replica;
}
