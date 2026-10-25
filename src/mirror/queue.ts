// The mirror's durable queue and applier state (design/aws-port.md §5.2 item 2; lane Z). One queue per direction, over a
// tiny key-value adapter so the same ordering and dedupe logic runs on DynamoDB (the ephemeral table, pk `MQ#<direction>`),
// on D1 (the reverse direction's receiver) and in memory (tests).
//
// Sort keys inside one queue:
//   B#<batchId>                         dedupe marker, written in the same atomic write as the batch's calls
//   E#<firstSeq, 12 digits>             a call that committed events, by its first seq (ascending = prod's commit order)
//   N#<atMs, 15 digits>#<batchId>#<i>   every other call, by the time it returned
//   S                                   the applier's state (one item, compare-and-set)
//   H                                   the kept divergent record
import type { Direction } from "./apply";
import type { TeeCall } from "./record";

export interface QueuedCall {
  /** The call's sort key; unique in the queue. */
  key: string;
  atMs: number;
  /** First and last event seq the call committed; null for a call that committed none. */
  firstSeq: number | null;
  lastSeq: number | null;
  batchId: string;
  index: number;
  call: TeeCall;
}

export interface Halt {
  code: "MIRROR_DIVERGED" | "MIRROR_GAP" | "MIRROR_UNREPLAYABLE" | "MIRROR_BAD_RECORD" | "MIRROR_TARGET_ERROR" | "MIRROR_AMBIGUOUS" | "RESEEDING";
  reason: string;
  atMs: number;
  callKey: string | null;
}

export interface MirrorState {
  /** Compare-and-set version. */
  v: number;
  /** Highest event seq applied (equal to the target's head seq). */
  appliedSeq: number;
  appliedCalls: number;
  /** Calls skipped because prod's outcome was an infrastructure error or a concurrency artifact (nothing was committed there). */
  skippedCalls: number;
  /** Event calls found already applied after a crash and accepted without a re-check (the daily proof covers them). */
  unverifiedCalls: number;
  /** Calls whose Clock was read a different number of times than in prod (D1 and DynamoDB differ legitimately; informational). */
  clockDrift: number;
  halted: Halt | null;
  /** When the next event call in line was first seen missing (a gap), or null. */
  gapSinceMs: number | null;
  gapSeq: number | null;
  /** The applier stops at this point: events with lastSeq <= seq, other calls with atMs <= atMs (daily proof, cutover). */
  pause: { seq: number; atMs: number } | null;
  /** Reseed overlap: queued event calls with firstSeq <= seedSeq and other calls with atMs <= seedAtMs are already in the seed. */
  seedSeq: number;
  seedAtMs: number;
  lease: { token: string; untilMs: number } | null;
  /** The call being applied when the state was last written (a crash leaves it set). */
  inflight: string | null;
  /** The last call fully applied; a re-run after a crash between "state written" and "call removed" is dropped by this. */
  lastApplied: string | null;
  lastAppliedAtMs: number | null;
}

export function initialState(): MirrorState {
  return {
    v: 0, appliedSeq: 0, appliedCalls: 0, skippedCalls: 0, unverifiedCalls: 0, clockDrift: 0, halted: null, gapSinceMs: null, gapSeq: null, pause: null,
    seedSeq: 0, seedAtMs: 0, lease: null, inflight: null, lastApplied: null, lastAppliedAtMs: null,
  };
}

/** The adapter a backend implements. Bodies are opaque strings. */
export interface Kv {
  /** Write every item and the marker atomically, only if the marker is absent and no `E#` item exists. "duplicate" = the marker was there. Throws QueueConflict on a taken `E#` key. */
  putBatch(items: { sk: string; body: string }[], markerSk: string, markerTtlSec: number): Promise<"ok" | "duplicate">;
  /** The lowest sort key starting with `prefix`, strongly consistent. */
  first(prefix: string): Promise<{ sk: string; body: string } | null>;
  list(prefix: string, limit: number): Promise<{ sk: string; body: string }[]>;
  get(sk: string): Promise<string | null>;
  put(sk: string, body: string): Promise<void>;
  delete(sk: string): Promise<void>;
  /** Replace `sk` with `next` only if it currently holds `expected` (null = absent). */
  cas(sk: string, expected: string | null, next: string): Promise<boolean>;
}

/** Two different batches claimed one event seq. Never happens with a correct recorder. */
export class QueueConflict extends Error {
  constructor(readonly sk: string) {
    super(`queue key ${sk} is already taken by another record`);
    this.name = "QueueConflict";
  }
}

const pad = (n: number, w: number): string => String(n).padStart(w, "0");
export const eventKey = (firstSeq: number): string => `E#${pad(firstSeq, 12)}`;
export const otherKey = (atMs: number, batchId: string, index: number): string => `N#${pad(atMs, 15)}#${batchId}#${pad(index, 5)}`;
const STATE = "S";
const HALT = "H";

export function callKeyOf(batchId: string, index: number, call: TeeCall): string {
  return call.seqs.length > 0 ? eventKey(call.seqs[0]!) : otherKey(call.atMs, batchId, index);
}

function toQueued(sk: string, body: string): QueuedCall {
  const o = JSON.parse(body) as { batchId: string; index: number; call: TeeCall };
  const seqs = o.call.seqs;
  return { key: sk, atMs: o.call.atMs, firstSeq: seqs[0] ?? null, lastSeq: seqs.length > 0 ? seqs[seqs.length - 1]! : null, batchId: o.batchId, index: o.index, call: o.call };
}

/** Dedupe markers outlive any retry window several times over. */
const MARKER_TTL_SEC = 7 * 24 * 3600;

export interface MirrorQueue {
  readonly direction: Direction;
  /** Enqueue one atomic unit of calls under `batchId` (at most MAX_UNIT calls; ingest splits larger batches). */
  enqueue(batchId: string, calls: TeeCall[]): Promise<{ duplicate: boolean }>;
  nextEvent(): Promise<QueuedCall | null>;
  nextOther(): Promise<QueuedCall | null>;
  /** Up to `limit` queued calls, events first (diagnostics and tests). */
  pending(limit: number): Promise<QueuedCall[]>;
  remove(c: QueuedCall): Promise<void>;
  readState(): Promise<MirrorState>;
  /** Compare-and-set: writes `next` (with `next.v = prev.v + 1`) only if the stored state is still `prev`. */
  writeState(prev: MirrorState, next: MirrorState): Promise<boolean>;
  keepDivergent(info: unknown): Promise<void>;
  readDivergent(): Promise<unknown | null>;
  clearDivergent(): Promise<void>;
}

/** Calls per atomic unit (a DynamoDB transaction holds 100 items, one of them the marker). */
export const MAX_UNIT = 90;

export function createKvQueue(kv: Kv, direction: Direction): MirrorQueue {
  const stateBody = new WeakMap<MirrorState, string>();
  const remember = (s: MirrorState, body: string | null): MirrorState => {
    if (body !== null) stateBody.set(s, body);
    return s;
  };
  return {
    direction,
    async enqueue(batchId, calls) {
      if (calls.length > MAX_UNIT) throw new Error(`enqueue: ${calls.length} calls in one unit (max ${MAX_UNIT})`);
      const items = calls.map((call, index) => ({ sk: callKeyOf(batchId, index, call), body: JSON.stringify({ batchId, index, call }) }));
      const r = await kv.putBatch(items, `B#${batchId}`, MARKER_TTL_SEC);
      return { duplicate: r === "duplicate" };
    },
    async nextEvent() {
      const r = await kv.first("E#");
      return r === null ? null : toQueued(r.sk, r.body);
    },
    async nextOther() {
      const r = await kv.first("N#");
      return r === null ? null : toQueued(r.sk, r.body);
    },
    async pending(limit) {
      const ev = await kv.list("E#", limit);
      const ot = ev.length >= limit ? [] : await kv.list("N#", limit - ev.length);
      return [...ev, ...ot].map((r) => toQueued(r.sk, r.body));
    },
    async remove(c) {
      await kv.delete(c.key);
    },
    async readState() {
      const body = await kv.get(STATE);
      if (body === null) return remember(initialState(), null);
      return remember({ ...initialState(), ...(JSON.parse(body) as Partial<MirrorState>) }, body);
    },
    async writeState(prev, next) {
      if (next.v !== prev.v + 1) throw new Error("writeState: next.v must be prev.v + 1");
      const expected = stateBody.get(prev) ?? null;
      const body = JSON.stringify(next);
      if (!(await kv.cas(STATE, expected, body))) return false;
      stateBody.set(next, body);
      return true;
    },
    async keepDivergent(info) {
      await kv.put(HALT, JSON.stringify(info));
    },
    async readDivergent() {
      const b = await kv.get(HALT);
      return b === null ? null : JSON.parse(b);
    },
    async clearDivergent() {
      await kv.delete(HALT);
    },
  };
}

/** Read-modify-write of the state with compare-and-set retries. `fn` mutates a copy and returns false to skip the write. */
export async function updateState(queue: MirrorQueue, fn: (s: MirrorState) => boolean | void): Promise<MirrorState> {
  for (let attempt = 0; attempt < 12; attempt++) {
    const prev = await queue.readState();
    const next: MirrorState = { ...prev, v: prev.v + 1 };
    if (fn(next) === false) return prev;
    if (await queue.writeState(prev, next)) return next;
  }
  throw new Error("mirror state: compare-and-set kept losing");
}

// ---------------------------------------------------------------------------
// In-memory adapter (tests)
// ---------------------------------------------------------------------------

export function memoryKv(): Kv & { readonly items: ReadonlyMap<string, string> } {
  const m = new Map<string, string>();
  const sorted = (prefix: string): string[] => [...m.keys()].filter((k) => k.startsWith(prefix)).sort();
  return {
    items: m,
    async putBatch(items, markerSk) {
      if (m.has(markerSk)) return "duplicate";
      for (const i of items) if (i.sk.startsWith("E#") && m.has(i.sk)) throw new QueueConflict(i.sk);
      for (const i of items) m.set(i.sk, i.body);
      m.set(markerSk, "1");
      return "ok";
    },
    async first(prefix) {
      const k = sorted(prefix)[0];
      return k === undefined ? null : { sk: k, body: m.get(k)! };
    },
    async list(prefix, limit) {
      return sorted(prefix).slice(0, limit).map((k) => ({ sk: k, body: m.get(k)! }));
    },
    async get(sk) {
      return m.get(sk) ?? null;
    },
    async put(sk, body) {
      m.set(sk, body);
    },
    async delete(sk) {
      m.delete(sk);
    },
    async cas(sk, expected, next) {
      if ((m.get(sk) ?? null) !== expected) return false;
      m.set(sk, next);
      return true;
    },
  };
}
