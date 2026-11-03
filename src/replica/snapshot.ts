// Snapshots (design A, phase B). The jobs tick writes the replica's `serialize()` image, zstd level 19, to the object
// store and then moves a pointer item; a cold container boots from it (boot.ts) instead of replaying the whole log.
//
//  - RP1: a snapshot is an image at ONE seq (taken under the replica mutex, see Replica.capture) with a sha256 and size.
//    The pointer moves only after the object was read back and verified, and only to a higher seq. The previous pointer is
//    kept as PREV, so a bad newest snapshot costs one fallback, not a replay from 0.
//  - Rolling snapshots rotate through ROLLING_SLOTS fixed keys (`snap/slot-<n>.sqlite.zst`), and daily snapshots through
//    DAILY_SLOTS keys (`snap/daily/<nn>.sqlite.zst`, one per day for 40 days). Rotation is how old images are retired: the
//    replica layer sends five AWS calls in all (RP6) and none of them deletes, and a key per seq would grow without bound.
//    The slot written next is never the one POINTER or PREV names.
//  - The pointer, PREV, the daily index and the retention mark are items of the log table (`SNAP/...`), not S3 objects:
//    one strongly consistent read finds them, and a conditional write moves them.
import { createHash } from "node:crypto";
import type { ObjectStore } from "./objects";
import { imageDigest, type Replica } from "./replica";
import { SNAPSHOT_LEVEL, zstdCompress, zstdDecompress } from "./zstd";

export type LogFn = (message: string) => void;
export const consoleLog: LogFn = (m) => console.error(m);

/** Rolling snapshot slots: POINTER, PREV and the slot being written never coincide. */
export const ROLLING_SLOTS = 4;
/** Daily snapshots kept (days). */
export const DAILY_SLOTS = 40;
/** The point-in-time window (days) every retained log entry must cover (RP3). */
export const PITR_DAYS = 35;
const DAY_MS = 86_400_000;

export interface SnapRef {
  /** The log seq the image is at. */
  seq: number;
  key: string;
  /** sha256 hex and byte size of the raw (uncompressed) image. */
  sha256: string;
  size: number;
  /** Compressed object size. */
  compressed: number;
  /** Names in d1_migrations at that seq, in order. */
  migrations: string[];
  /** ISO time the snapshot was taken. */
  at: string;
  /** Daily snapshots only: the UTC day (YYYY-MM-DD) and the slot index. */
  day?: string;
  slot?: number;
}

/** The pointer, PREV, the daily index and the retention mark. Memory (tests) and DynamoDB (log-ddb.ts). */
export interface SnapshotState {
  pointer(): Promise<SnapRef | null>;
  previous(): Promise<SnapRef | null>;
  /**
   * Make `ref` the pointer and the old pointer PREV, if `ref.seq` is higher than the pointer's. "stale": the pointer is
   * already at or past that seq (nothing changed). The pointer's seq only ever increases (RP1).
   */
  movePointer(ref: SnapRef): Promise<"moved" | "stale">;
  /** The daily index: one entry per slot in use. */
  dailies(): Promise<SnapRef[]>;
  /** Record a daily snapshot in its slot (replacing the slot's older entry); "stale" when the slot holds a higher seq. */
  putDaily(ref: SnapRef): Promise<"put" | "stale">;
  /** The highest log seq whose entries retention has already marked for expiry (0: none). */
  expiredThrough(): Promise<number>;
  setExpiredThrough(seq: number): Promise<void>;
}

export class MemorySnapshotState implements SnapshotState {
  #pointer: SnapRef | null = null;
  #prev: SnapRef | null = null;
  #daily = new Map<number, SnapRef>();
  #expired = 0;
  readonly calls = { reads: 0, writes: 0 };
  /** Make the next movePointer / putDaily throw (a DynamoDB failure). */
  failWrites = false;

  async pointer() {
    this.calls.reads++;
    return this.#pointer === null ? null : { ...this.#pointer };
  }
  async previous() {
    this.calls.reads++;
    return this.#prev === null ? null : { ...this.#prev };
  }
  async movePointer(ref: SnapRef) {
    if (this.failWrites) throw new Error("MemorySnapshotState: injected write failure");
    this.calls.writes++;
    if (this.#pointer !== null && this.#pointer.seq >= ref.seq) return "stale" as const;
    this.#prev = this.#pointer;
    this.#pointer = { ...ref };
    return "moved" as const;
  }
  async dailies() {
    this.calls.reads++;
    return [...this.#daily.values()].map((r) => ({ ...r })).sort((a, b) => a.seq - b.seq);
  }
  async putDaily(ref: SnapRef) {
    if (this.failWrites) throw new Error("MemorySnapshotState: injected write failure");
    this.calls.writes++;
    const slot = ref.slot ?? 0;
    const cur = this.#daily.get(slot);
    if (cur !== undefined && cur.seq > ref.seq) return "stale" as const;
    this.#daily.set(slot, { ...ref });
    return "put" as const;
  }
  async expiredThrough() {
    return this.#expired;
  }
  async setExpiredThrough(seq: number) {
    this.#expired = Math.max(this.#expired, seq);
  }
  /** Overwrite items directly, for tests that damage the state. */
  set(which: "pointer" | "prev", ref: SnapRef | null): void {
    if (which === "pointer") this.#pointer = ref;
    else this.#prev = ref;
  }
}

export interface SnapshotDeps {
  objects: ObjectStore;
  state: SnapshotState;
  /** Where the job report goes. Default console.error. */
  logLine?: LogFn;
  now?: () => number;
  /** zstd level for the snapshot image. Default 19 (SNAPSHOT_LEVEL); the jobs tick pays for it (boot-bench.mjs prints the cost per level). */
  zstdLevel?: number;
}

export class SnapshotError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "SnapshotError";
  }
}

const sha256 = (b: Uint8Array): string => createHash("sha256").update(b).digest("hex");

export const rollingKey = (slot: number): string => `snap/slot-${slot}.sqlite.zst`;
export const dailyKey = (slot: number): string => `snap/daily/${String(slot).padStart(2, "0")}.sqlite.zst`;
export const dayOf = (ms: number): string => new Date(ms).toISOString().slice(0, 10);
export const dailySlot = (ms: number): number => Math.floor(ms / DAY_MS) % DAILY_SLOTS;

/** The rolling slot to write next: the one after the pointer's, which is neither POINTER nor PREV. */
export function nextRollingSlot(pointer: SnapRef | null): number {
  const m = pointer === null ? null : /^snap\/slot-(\d+)\.sqlite\.zst$/.exec(pointer.key);
  return m === null || m === undefined ? 0 : (Number(m[1]) + 1) % ROLLING_SLOTS;
}

export interface SnapshotPolicy {
  /** Snapshot when the head is this many units past the last snapshot. Default 50. */
  minUnits?: number;
  /** Or when the last snapshot is this old (ms) and the head moved. Default one hour. */
  maxAgeMs?: number;
}

/** Whether the rolling snapshot is due: nothing without a newer head, then the unit count or the age. */
export function snapshotDue(head: number, pointer: SnapRef | null, nowMs: number, policy: SnapshotPolicy = {}): boolean {
  if (head <= 0) return false;
  if (pointer === null) return true;
  if (head <= pointer.seq) return false;
  return head - pointer.seq >= (policy.minUnits ?? 50) || nowMs - Date.parse(pointer.at) >= (policy.maxAgeMs ?? 3_600_000);
}

/**
 * Fetch a snapshot and prove it: the object exists, decompresses, has the recorded size and sha256 (and, when S3 returned
 * them, metadata that agrees, so a slot overwritten by a newer image is caught). Returns the raw image.
 */
export async function readSnapshot(ref: SnapRef, objects: ObjectStore): Promise<Uint8Array> {
  const obj = await objects.get(ref.key);
  if (obj === null) throw new SnapshotError(`snapshot ${ref.key} (seq ${ref.seq}) is missing from the object store`);
  return verifySnapshot(ref, obj.bytes, obj.meta);
}

export function verifySnapshot(ref: SnapRef, compressed: Uint8Array, meta: Record<string, string> = {}): Uint8Array {
  if (meta.sha256 !== undefined && meta.sha256 !== ref.sha256) throw new SnapshotError(`snapshot ${ref.key}: the object's sha256 metadata ${meta.sha256} is not the recorded ${ref.sha256} (the slot was overwritten)`);
  let raw: Uint8Array;
  try {
    raw = zstdDecompress(compressed);
  } catch (e) {
    throw new SnapshotError(`snapshot ${ref.key} (seq ${ref.seq}) does not decompress: ${e instanceof Error ? e.message : String(e)}`, { cause: e });
  }
  if (raw.byteLength !== ref.size) throw new SnapshotError(`snapshot ${ref.key} (seq ${ref.seq}) is ${raw.byteLength} bytes, expected ${ref.size}`);
  const got = sha256(raw);
  if (got !== ref.sha256) throw new SnapshotError(`snapshot ${ref.key} (seq ${ref.seq}) has sha256 ${got}, expected ${ref.sha256}`);
  return raw;
}

/** S3 user metadata is capped at 2 KB in all: the full migration list lives in the pointer item, the object carries a compact form. */
function objectMeta(ref: SnapRef): Record<string, string> {
  const list = ref.migrations.join(",");
  return {
    sha256: ref.sha256,
    size: String(ref.size),
    seq: String(ref.seq),
    at: ref.at,
    "migration-count": String(ref.migrations.length),
    "migration-last": ref.migrations[ref.migrations.length - 1] ?? "",
    ...(list.length <= 1200 ? { migrations: list } : {}),
  };
}

export type SnapshotKind = { type: "rolling" } | { type: "daily"; slot: number; day: string };

export type SnapshotOutcome = { status: "written"; ref: SnapRef; moved: "moved" | "stale" | "put" } | { status: "current"; pointer: SnapRef };

/**
 * Write one snapshot of `replica` and publish it. The mutex is held only inside capture(); compression (level 19) and the
 * upload run outside it. Publication order is the invariant (RP1): upload, read back and verify, THEN move the pointer.
 */
export async function writeSnapshot(replica: Replica, deps: SnapshotDeps, kind: SnapshotKind = { type: "rolling" }): Promise<SnapshotOutcome> {
  const now = deps.now ?? Date.now;
  const logLine = deps.logLine ?? consoleLog;
  const pointer = await deps.state.pointer();
  const cap = await replica.capture();
  if (kind.type === "rolling" && pointer !== null && cap.seq <= pointer.seq) return { status: "current", pointer };
  const level = deps.zstdLevel ?? SNAPSHOT_LEVEL;
  const t0 = performance.now();
  const compressed = zstdCompress(cap.bytes, level);
  const compressMs = Math.round(performance.now() - t0);
  const ref: SnapRef = {
    seq: cap.seq,
    key: kind.type === "rolling" ? rollingKey(nextRollingSlot(pointer)) : dailyKey(kind.slot),
    sha256: sha256(cap.bytes),
    size: cap.bytes.byteLength,
    compressed: compressed.byteLength,
    migrations: cap.migrations,
    at: new Date(now()).toISOString(),
    ...(kind.type === "daily" ? { day: kind.day, slot: kind.slot } : {}),
  };
  await deps.objects.put(ref.key, compressed, objectMeta(ref));
  // Read it back: this is what a cold container will do, so it is what has to work.
  await readSnapshot(ref, deps.objects);
  const moved = kind.type === "rolling" ? await deps.state.movePointer(ref) : await deps.state.putDaily(ref);
  logLine(`akldb-snapshot: ${kind.type} seq=${ref.seq} key=${ref.key} raw=${ref.size} compressed=${ref.compressed} zstd=${level} compressMs=${compressMs} pointer=${moved}`);
  return { status: "written", ref, moved };
}

/** Hex digest of an image for the nightly proof (see imageDigest: header counters aside, every byte). */
export const digestOf = imageDigest;
