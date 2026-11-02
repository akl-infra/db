// The in-memory commit log: tests, the fuzzer's candidate and local runs
// without AWS. Entries are stored as the JSON text DynamoDB would hold, so
// anything the replica logs must survive the codec. Seeded fault injection
// models the four ways a DynamoDB append goes wrong: a conflict, a throttle,
// a timeout before the commit and a timeout AFTER the commit (the last two
// raise AmbiguousAppendError, as the real backend does).
import { AmbiguousAppendError, LogThrottledError, checkedBody, decodeBody, type CommitLog, type LogEntry, type NewLogEntry } from "./log";

export interface MemoryLogFaults {
  /** Probability that an append whose head matched still reports "conflict" without writing (a DynamoDB TransactionConflict). */
  conflict?: number;
  /** Probability that any call throws LogThrottledError before doing anything. */
  throttle?: number;
  /** Probability that an append throws AmbiguousAppendError without writing. */
  timeoutBefore?: number;
  /** Probability that an append writes and then throws AmbiguousAppendError. */
  timeoutAfter?: number;
  /** Seed for the fault dice (and the interleaving yields). Default 1. */
  seed?: number;
  /** Each call awaits up to this many macrotask yields first, so concurrent writers interleave. Default 0. */
  maxYields?: number;
  /** Reject a body over this many bytes like the DynamoDB log does (MAX_BODY_BYTES). Default: no limit (phase B stores big bodies in S3). */
  maxBodyBytes?: number;
}

export interface MemoryLogCounts {
  appends: number;
  ok: number;
  conflicts: number;
  injectedConflicts: number;
  throttles: number;
  timeoutsBefore: number;
  timeoutsAfter: number;
  heads: number;
  reads: number;
  gets: number;
}

/** mulberry32: a small seeded PRNG in [0, 1). */
export function seededRandom(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

type Op = "none" | "conflict" | "throttle" | "timeoutBefore" | "timeoutAfter";

export class MemoryLog implements CommitLog {
  readonly counts: MemoryLogCounts = { appends: 0, ok: 0, conflicts: 0, injectedConflicts: 0, throttles: 0, timeoutsBefore: 0, timeoutsAfter: 0, heads: 0, reads: 0, gets: 0 };
  #items: { unitId: string; kind: LogEntry["kind"]; body: string }[] = [];
  #faults: MemoryLogFaults;
  #rng: () => number;
  /** Forced outcomes for the next appends (consumed in order), for deterministic tests. */
  #forced: Op[] = [];

  constructor(faults: MemoryLogFaults = {}) {
    this.#faults = faults;
    this.#rng = seededRandom(faults.seed ?? 1);
  }

  /** Change the fault rates from now on (the rng stream continues). */
  setFaults(faults: MemoryLogFaults): void {
    this.#faults = { ...faults, seed: undefined };
    if (faults.seed !== undefined) this.#rng = seededRandom(faults.seed);
  }

  /** The next append(s) take these outcomes in order, ahead of the random dice. */
  forceNext(...ops: Exclude<Op, "none">[]): void {
    this.#forced.push(...ops);
  }

  /** Every entry, decoded (for assertions and for building a fresh replica from the log). */
  entries(): LogEntry[] {
    return this.#items.map((it, i) => ({ seq: i + 1, unitId: it.unitId, kind: it.kind, ...decodeBody(it.body) }));
  }

  /** A new log holding the same entries (no faults unless given), to start fresh replicas from. */
  clone(faults: MemoryLogFaults = {}): MemoryLog {
    const copy = new MemoryLog(faults);
    copy.#items = this.#items.map((it) => ({ ...it }));
    return copy;
  }

  get length(): number {
    return this.#items.length;
  }

  async #pause(): Promise<void> {
    const n = this.#faults.maxYields ?? 0;
    if (n <= 0) return;
    const k = Math.floor(this.#rng() * (n + 1));
    for (let i = 0; i < k; i++) await new Promise<void>((r) => setImmediate(r));
  }

  #throttleMaybe(): void {
    if ((this.#faults.throttle ?? 0) > 0 && this.#rng() < (this.#faults.throttle ?? 0)) {
      this.counts.throttles++;
      throw new LogThrottledError("memory log: injected throttle");
    }
  }

  async head(): Promise<number> {
    await this.#pause();
    this.#throttleMaybe();
    this.counts.heads++;
    return this.#items.length;
  }

  async read(afterSeq: number, upTo: number): Promise<LogEntry[]> {
    await this.#pause();
    this.#throttleMaybe();
    this.counts.reads++;
    const out: LogEntry[] = [];
    for (let seq = afterSeq + 1; seq <= Math.min(upTo, this.#items.length); seq++) {
      const it = this.#items[seq - 1]!;
      out.push({ seq, unitId: it.unitId, kind: it.kind, ...decodeBody(it.body) });
    }
    return out;
  }

  async get(seq: number): Promise<LogEntry | null> {
    await this.#pause();
    this.#throttleMaybe();
    this.counts.gets++;
    const it = this.#items[seq - 1];
    return it === undefined || seq < 1 ? null : { seq, unitId: it.unitId, kind: it.kind, ...decodeBody(it.body) };
  }

  #roll(): Op {
    const forced = this.#forced.shift();
    if (forced !== undefined) return forced;
    const f = this.#faults;
    const r = this.#rng();
    let edge = f.throttle ?? 0;
    if (r < edge) return "throttle";
    edge += f.conflict ?? 0;
    if (r < edge) return "conflict";
    edge += f.timeoutBefore ?? 0;
    if (r < edge) return "timeoutBefore";
    edge += f.timeoutAfter ?? 0;
    if (r < edge) return "timeoutAfter";
    return "none";
  }

  async append(expectedHead: number, entry: NewLogEntry): Promise<"ok" | "conflict"> {
    await this.#pause();
    this.counts.appends++;
    const body = checkedBody(entry, this.#faults.maxBodyBytes ?? Number.POSITIVE_INFINITY);
    const op = this.#roll();
    if (op === "throttle") {
      this.counts.throttles++;
      throw new LogThrottledError("memory log: injected throttle");
    }
    if (op === "timeoutBefore") {
      this.counts.timeoutsBefore++;
      throw new AmbiguousAppendError("memory log: injected timeout before the commit");
    }
    if (op === "conflict") {
      this.counts.injectedConflicts++;
      this.counts.conflicts++;
      return "conflict";
    }
    if (this.#items.length !== expectedHead) {
      this.counts.conflicts++;
      return "conflict";
    }
    this.#items.push({ unitId: entry.unitId, kind: entry.kind, body });
    this.counts.ok++;
    if (op === "timeoutAfter") {
      this.counts.timeoutsAfter++;
      throw new AmbiguousAppendError("memory log: injected timeout after the commit");
    }
    return "ok";
  }
}
