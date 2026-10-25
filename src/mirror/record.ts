// The tee record (design/aws-port.md §5.2): what lane T's recorder sends and lane Z's applier reads.
// One recorded storage write (design/aws-port.md §5.2). FROZEN once T's first commit lands.
export interface TeeCall {
  v: 1;
  /** "<area>.<method>", e.g. "events.commitWrite". */
  method: string;
  /** Arguments encoded with encodeTee(); a Clock argument becomes {"$clock": [iso, ...]}, the values it returned. */
  args: unknown[];
  /** The outcome, encoded. */
  outcome: { ok: unknown } | { error: { name: string; status?: number; body?: unknown; message: string } };
  /** Event seqs this call committed, ascending ([] if none). */
  seqs: number[];
  /** Date.now() when the call returned. */
  atMs: number;
}
export interface TeeBatch {
  v: 1;
  /** Which way the mirror runs: "d1->ddb" before the cutover, "ddb->d1" after. */
  direction: "d1->ddb" | "ddb->d1";
  /** A random id; ingest dedupes on it. */
  batchId: string;
  calls: TeeCall[];
}
/** Headers: X-Akldb-Tee-Ts (epoch s, ±300 s), X-Akldb-Tee-Sig = hex HMAC-SHA256(secret, ts + "\n" + body). */
export const TEE_TS_HEADER = "X-Akldb-Tee-Ts";
export const TEE_SIG_HEADER = "X-Akldb-Tee-Sig";
/** Tagged JSON: Map -> {"$map": [[k, v], ...]}, Set -> {"$set": [...]}, Uint8Array -> {"$bytes": b64}, undefined -> {"$u": 1}. */
export declare function encodeTee(value: unknown): unknown;
export declare function decodeTee(value: unknown): unknown;
