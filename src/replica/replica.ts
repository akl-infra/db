// A replica (design A): one in-memory node:sqlite database that holds the
// whole of akldb, and the commit protocol that keeps every replica equal to
// the commit log (src/replica/log.ts).
//
//  - catchUp(): read the log head strongly, replay entries seq+1..head by
//    RE-EXECUTING their statements (never by applying changesets: node:sqlite's
//    applyChangeset fires triggers on the replica, so akldb's 10 triggers would
//    run twice), and check each entry's changeset hash against a session around
//    the replay. A mismatch is ReplicaDivergedError and the replica is dead.
//  - runUnit(): one D1 commit unit. BEGIN, run the statements under a session,
//    and if anything changed append it to the log expecting head = seq; "ok"
//    COMMITs, a conflict ROLLBACKs, catches up and runs the unit again against
//    the newer state (D1's own serialization; akldb's SQL guards carry CAS).
//    An ambiguous append (timeout) is resolved by reading seq+1 back and
//    comparing unit ids, so a unit is applied exactly once (SH6).
//  - One async mutex wraps every statement and every unit, reads included, so
//    no reader can ever see an open local transaction (the append awaits).
//
// Nothing here knows D1's result shapes; store/shim/d1.ts shapes them.
import { createHash } from "node:crypto";
import { DatabaseSync, type StatementSync } from "node:sqlite";
import { ulid as newUlid } from "ulidx";
import {
  AmbiguousAppendError,
  LogThrottledError,
  type CommitLog,
  type LogEntry,
  type LogStmt,
  type NewLogEntry,
} from "./log";

export class ReplicaDivergedError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "ReplicaDivergedError";
  }
}

/** One statement of a unit, as the shim binds it. `params` are null | number | string | Uint8Array. */
export interface BoundStatement {
  sql: string;
  params: unknown[];
  /** Return rows as arrays (D1 `.raw()`). */
  raw?: boolean;
  /** `D1Database.exec`: run `sql` (possibly several statements) with no parameters. */
  exec?: true;
}

export interface StatementOutcome {
  /** Column names in order (empty for a statement that returns no rows). */
  columns: string[];
  /** Rows as plain objects (BLOBs are Uint8Array; the shim turns them into number[] like D1). */
  rows: Record<string, unknown>[];
  /** Rows as arrays, only when `raw` was asked for. */
  arrays?: unknown[][];
  /** D1 `meta.changes`: rows changed by this statement, 0 for a read. */
  changes: number;
  /** D1 `meta.last_row_id`: the connection's last_insert_rowid() after the statement. */
  lastRowId: number;
  changedDb: boolean;
}

export interface ReplicaStats {
  replayed: number;
  units: number;
  appended: number;
  conflicts: number;
  ambiguous: number;
  throttled: number;
  noOps: number;
  retries: number;
}

export interface ReplicaOptions {
  ulid?: () => string;
  /** Jitter source in [0, 1). Default Math.random. */
  random?: () => number;
  sleep?: (ms: number) => Promise<void>;
  /** Commit attempts before "D1_ERROR: commit log contention". Default 25. */
  maxAttempts?: number;
  /** Backoff base in ms (grows to 8x, jittered). Default 2. */
  backoffMs?: number;
}

export interface RunOptions {
  /** The caller has just caught up (the request's first statement did): skip step (a). */
  fresh?: boolean;
}

class Mutex {
  #tail: Promise<void> = Promise.resolve();
  async run<T>(fn: () => Promise<T>): Promise<T> {
    const prev = this.#tail;
    let release!: () => void;
    this.#tail = new Promise<void>((r) => (release = r));
    await prev;
    try {
      return await fn();
    } finally {
      release();
    }
  }
}

/** D1 hands JS a (lossy) Number for every INTEGER; statements read bigints so an integer above 2^53 cannot throw. */
const fromSqlite = (v: unknown): unknown => (typeof v === "bigint" ? Number(v) : v);

const sha256 = (data: Uint8Array | string): string => createHash("sha256").update(data).digest("hex");

/** True for a statement that can only read: it skips the transaction and the session. */
export function isSelectLeading(sql: string): boolean {
  let i = 0;
  for (;;) {
    while (i < sql.length && /\s/.test(sql[i]!)) i++;
    if (sql.startsWith("--", i)) {
      const nl = sql.indexOf("\n", i);
      if (nl < 0) return false;
      i = nl + 1;
    } else if (sql.startsWith("/*", i)) {
      const end = sql.indexOf("*/", i + 2);
      if (end < 0) return false;
      i = end + 2;
    } else break;
  }
  return /^(select|values)\b/i.test(sql.slice(i, i + 7));
}

interface Prepared {
  stmt: StatementSync;
  returnsRows: boolean;
  select: boolean;
}

interface Attempt<T> {
  result: T;
  /** null: nothing to log (the local transaction is already committed). Otherwise the transaction is still open. */
  entry: Omit<NewLogEntry, "unitId"> | null;
}

const toLogStmt = (s: BoundStatement): LogStmt => ({ sql: s.sql, params: s.params, ...(s.exec === true ? { exec: true as const } : {}) });

export class Replica {
  readonly db: DatabaseSync;
  readonly stats: ReplicaStats = { replayed: 0, units: 0, appended: 0, conflicts: 0, ambiguous: 0, throttled: 0, noOps: 0, retries: 0 };
  #seq = 0;
  #dead: Error | null = null;
  #mu = new Mutex();
  #cache = new Map<string, Prepared>();
  #ulid: () => string;
  #random: () => number;
  #sleep: (ms: number) => Promise<void>;
  #maxAttempts: number;
  #backoffMs: number;
  #inTxn = false;
  #metaStmt: StatementSync | undefined;
  #changesStmt: StatementSync | undefined;

  constructor(readonly log: CommitLog, opts: ReplicaOptions = {}) {
    this.db = new DatabaseSync(":memory:", { enableForeignKeyConstraints: true });
    this.#ulid = opts.ulid ?? newUlid;
    this.#random = opts.random ?? Math.random;
    this.#sleep = opts.sleep ?? ((ms) => new Promise<void>((r) => setTimeout(r, ms)));
    this.#maxAttempts = opts.maxAttempts ?? 25;
    this.#backoffMs = opts.backoffMs ?? 2;
  }

  /** The log seq this replica has applied. */
  get seq(): number {
    return this.#seq;
  }

  /** Non-null once a replay diverged from the log: every call throws it. */
  get dead(): Error | null {
    return this.#dead;
  }

  #assertAlive(): void {
    if (this.#dead !== null) throw this.#dead;
  }

  #die(err: Error): never {
    this.#dead = err;
    throw err;
  }

  async #backoff(n: number): Promise<void> {
    const ms = Math.floor(this.#backoffMs * Math.min(2 ** (n - 1), 8) * (0.5 + this.#random()));
    if (ms > 0) await this.#sleep(ms);
    else await new Promise<void>((r) => setImmediate(r));
  }

  /** A log read with bounded retries of throttling. */
  async #logCall<T>(fn: () => Promise<T>): Promise<T> {
    for (let n = 1; ; n++) {
      try {
        return await fn();
      } catch (e) {
        if (!(e instanceof LogThrottledError) || n >= this.#maxAttempts) throw e;
        this.stats.throttled++;
        await this.#backoff(n);
      }
    }
  }

  // ---- catch-up ----

  /** Read the head strongly and replay everything this replica has not applied. Resolves to the seq reached. */
  catchUp(): Promise<number> {
    return this.#mu.run(() => this.#catchUpLocked());
  }

  async #catchUpLocked(): Promise<number> {
    this.#assertAlive();
    const head = await this.#logCall(() => this.log.head());
    if (head < this.#seq) this.#die(new ReplicaDivergedError(`the log head ${head} is behind this replica (${this.#seq}): the log lost entries`));
    if (head === this.#seq) return head;
    const entries = await this.#logCall(() => this.log.read(this.#seq, head));
    for (const [i, e] of entries.entries()) {
      if (e.seq !== this.#seq + 1 + i) throw new Error(`commit log read is not contiguous: expected seq ${this.#seq + 1 + i}, got ${e.seq}`);
    }
    if (entries.length !== head - this.#seq) throw new Error(`commit log read returned ${entries.length} entries for seq ${this.#seq + 1}..${head}`);
    for (const e of entries) this.#apply(e);
    return head;
  }

  /** Re-execute one entry and verify its hash. */
  #apply(entry: LogEntry): void {
    if (entry.seq !== this.#seq + 1) throw new Error(`replay out of order: at ${this.#seq}, got ${entry.seq}`);
    this.db.exec("BEGIN");
    this.#inTxn = true;
    try {
      if (entry.kind === "migration") {
        const sql = entry.stmts[0]?.sql ?? "";
        if (sha256(sql) !== entry.hash) throw new ReplicaDivergedError(`migration ${entry.name ?? "?"} at seq ${entry.seq}: sql hash mismatch`);
        this.#migrate(entry.name ?? "", sql, entry.at ?? "");
      } else {
        const session = this.db.createSession();
        let changeset: Uint8Array;
        try {
          for (const s of entry.stmts) this.#replayStmt(s);
          changeset = session.changeset();
        } finally {
          session.close();
        }
        const got = sha256(changeset);
        if (got !== entry.hash) throw new ReplicaDivergedError(`seq ${entry.seq} (unit ${entry.unitId}): changeset hash ${got} != logged ${entry.hash}`);
      }
      this.db.exec("COMMIT");
      this.#inTxn = false;
    } catch (e) {
      this.#rollback();
      this.#die(e instanceof ReplicaDivergedError ? e : new ReplicaDivergedError(`replay of seq ${entry.seq} (unit ${entry.unitId}) failed: ${e instanceof Error ? e.message : String(e)}`, { cause: e }));
    }
    this.#seq = entry.seq;
    this.stats.replayed++;
  }

  #replayStmt(s: LogStmt): void {
    if (s.exec === true) {
      this.db.exec(s.sql);
      return;
    }
    const p = this.#prep(s.sql);
    if (p.returnsRows) p.stmt.all(...(s.params as never[]));
    else p.stmt.run(...(s.params as never[]));
  }

  /** The migration, recorded in d1_migrations the way wrangler does (id AUTOINCREMENT, name, applied_at), with the entry's own timestamp. */
  #migrate(name: string, sql: string, at: string): void {
    // wrangler's table, minus the CURRENT_TIMESTAMP default: applied_at always comes from the log entry.
    this.db.exec("CREATE TABLE IF NOT EXISTS d1_migrations(id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT UNIQUE, applied_at TIMESTAMP NOT NULL)");
    this.db.exec(sql);
    this.db.prepare("INSERT INTO d1_migrations (name, applied_at) VALUES (?, ?)").run(name, at);
  }

  // ---- statements ----

  #prep(sql: string, raw = false): Prepared {
    if (!raw) {
      const hit = this.#cache.get(sql);
      if (hit !== undefined) return hit;
    }
    const stmt = this.db.prepare(sql);
    stmt.setReadBigInts(true); // node:sqlite throws on an integer above 2^53; D1 answers a lossy Number (see fromSqlite)
    if (raw) stmt.setReturnArrays(true);
    const p: Prepared = { stmt, returnsRows: stmt.columns().length > 0, select: isSelectLeading(sql) };
    if (!raw) {
      if (this.#cache.size >= 512) this.#cache.delete(this.#cache.keys().next().value as string);
      this.#cache.set(sql, p);
    }
    return p;
  }

  #meta(): { total: number; changes: number; lastRowId: number } {
    this.#metaStmt ??= this.db.prepare("SELECT total_changes() AS t, changes() AS c, last_insert_rowid() AS r");
    const r = this.#metaStmt.get() as { t: number; c: number; r: number };
    return { total: r.t, changes: r.c, lastRowId: r.r };
  }

  #totalChanges(): number {
    this.#changesStmt ??= this.db.prepare("SELECT total_changes() AS t");
    return (this.#changesStmt.get() as { t: number }).t;
  }

  #execOne(s: BoundStatement): StatementOutcome {
    if (s.exec === true) {
      const before = this.#totalChanges();
      this.db.exec(s.sql);
      const m = this.#meta();
      return { columns: [], rows: [], changes: 0, lastRowId: m.lastRowId, changedDb: m.total !== before };
    }
    const p = this.#prep(s.sql, s.raw === true);
    const before = p.select ? 0 : this.#totalChanges();
    let rows: Record<string, unknown>[] = [];
    let arrays: unknown[][] | undefined;
    let columns: string[] = [];
    if (p.returnsRows) {
      columns = p.stmt.columns().map((c) => c.name);
      if (s.raw === true) arrays = (p.stmt.all(...(s.params as never[])) as unknown as unknown[][]).map((row) => row.map(fromSqlite));
      else rows = (p.stmt.all(...(s.params as never[])) as Record<string, unknown>[]).map((r) => Object.fromEntries(Object.entries(r).map(([k, v]) => [k, fromSqlite(v)])));
    } else {
      p.stmt.run(...(s.params as never[]));
    }
    const m = this.#meta();
    const changed = !p.select && m.total !== before;
    return { columns, rows, ...(arrays !== undefined ? { arrays } : {}), changes: changed ? m.changes : 0, lastRowId: m.lastRowId, changedDb: changed };
  }

  #rollback(): void {
    try {
      this.db.exec("ROLLBACK");
    } catch {
      // the transaction was already rolled back by SQLite
    }
    this.#inTxn = false;
  }

  /** sqlite_sequence is not tracked by sessions (it has no primary key): AUTOINCREMENT counters are compared by value. */
  #sequenceDigest(): string {
    try {
      return JSON.stringify(this.db.prepare("SELECT name, seq FROM sqlite_sequence ORDER BY name").all());
    } catch {
      return "";
    }
  }

  #schemaVersion(): number {
    return (this.db.prepare("PRAGMA schema_version").get() as { schema_version: number }).schema_version;
  }

  // ---- units ----

  /**
   * One D1 commit unit: the statements of one `.run()`/`.first()`/`.all()` or one `.batch()`, atomic (an error
   * rolls the whole unit back and propagates), logged if it changed anything, results in statement order.
   */
  runUnit(stmts: BoundStatement[], opts: RunOptions = {}): Promise<StatementOutcome[]> {
    return this.#mu.run(async () => {
      this.#assertAlive();
      if (stmts.length > 0 && stmts.every((s) => s.exec !== true && isSelectLeading(s.sql))) {
        // Reads: no transaction, no session, no log. The mutex means no unit is open.
        this.stats.units++;
        if (opts.fresh !== true) await this.#catchUpLocked();
        return stmts.map((s) => this.#execOne(s));
      }
      this.stats.units++;
      const forceLog = stmts.some((s) => s.exec === true);
      return this.#commit(() => this.#attemptUnit(stmts, forceLog), opts.fresh === true);
    });
  }

  #attemptUnit(stmts: BoundStatement[], forceLog: boolean): Attempt<StatementOutcome[]> {
    this.db.exec("BEGIN");
    this.#inTxn = true;
    let session: ReturnType<DatabaseSync["createSession"]> | undefined;
    try {
      const seqBefore = this.#sequenceDigest();
      const schemaBefore = this.#schemaVersion();
      const rowsBefore = this.#totalChanges();
      session = this.db.createSession();
      const result = stmts.map((s) => this.#execOne(s));
      const changeset = session.changeset();
      session.close();
      session = undefined;
      // total_changes() is the signal, NOT the session: sessions record nothing for a table without a declared PRIMARY KEY,
      // and a unit touching only such a table would otherwise never be logged. The changeset is only the replay hash.
      const changed = forceLog || this.#totalChanges() !== rowsBefore || changeset.byteLength > 0 || this.#sequenceDigest() !== seqBefore || this.#schemaVersion() !== schemaBefore;
      if (!changed) {
        this.db.exec("COMMIT");
        this.#inTxn = false;
        this.stats.noOps++;
        return { result, entry: null };
      }
      return { result, entry: { kind: "unit", stmts: stmts.map(toLogStmt), hash: sha256(changeset) } };
    } catch (e) {
      try {
        session?.close();
      } catch {
        // already closed
      }
      this.#rollback();
      throw e;
    }
  }

  /**
   * Apply one migration through the log (SH10): run it locally in a transaction, append it, and COMMIT on "ok".
   * Resolves "skipped" when d1_migrations already has `name` (another replica applied it first).
   */
  applyMigration(m: { name: string; sql: string; at: string }): Promise<"applied" | "skipped"> {
    return this.#mu.run(async () => {
      this.#assertAlive();
      return this.#commit<"applied" | "skipped">(() => {
        this.db.exec("BEGIN");
        this.#inTxn = true;
        try {
          const done = this.db.prepare("SELECT 1 AS x FROM sqlite_master WHERE type = 'table' AND name = 'd1_migrations'").get() !== undefined && this.db.prepare("SELECT 1 AS x FROM d1_migrations WHERE name = ?").get(m.name) !== undefined;
          if (done) {
            this.db.exec("COMMIT");
            this.#inTxn = false;
            return { result: "skipped", entry: null };
          }
          this.#migrate(m.name, m.sql, m.at);
          return { result: "applied", entry: { kind: "migration", stmts: [{ sql: m.sql, params: [] }], hash: sha256(m.sql), name: m.name, at: m.at } };
        } catch (e) {
          this.#rollback();
          throw e;
        }
      }, false);
    });
  }

  /** Names recorded in d1_migrations (after a catch-up), in application order. */
  appliedMigrations(): Promise<string[]> {
    return this.#mu.run(async () => {
      await this.#catchUpLocked();
      if (this.db.prepare("SELECT 1 AS x FROM sqlite_master WHERE type = 'table' AND name = 'd1_migrations'").get() === undefined) return [];
      return (this.db.prepare("SELECT name FROM d1_migrations ORDER BY id").all() as { name: string }[]).map((r) => r.name);
    });
  }

  /** The commit protocol: (a) catch up unless fresh, (b) attempt, (c) append, then COMMIT / roll back and retry. */
  async #commit<T>(attemptFn: () => Attempt<T>, fresh: boolean): Promise<T> {
    if (!fresh) await this.#catchUpLocked();
    for (let n = 1; n <= this.#maxAttempts; n++) {
      const a = attemptFn();
      if (a.entry === null) return a.result;
      const entry: NewLogEntry = { unitId: this.#ulid(), ...a.entry };
      let landed: boolean;
      try {
        landed = await this.#append(entry);
      } catch (e) {
        this.#rollback();
        throw e;
      }
      if (landed) {
        try {
          this.db.exec("COMMIT");
          this.#inTxn = false;
        } catch (e) {
          this.#die(new ReplicaDivergedError(`COMMIT failed after seq ${this.#seq + 1} was logged: ${e instanceof Error ? e.message : String(e)}`, { cause: e }));
        }
        this.#seq++;
        this.stats.appended++;
        return a.result;
      }
      this.#rollback();
      this.stats.retries++;
      await this.#catchUpLocked();
      await this.#backoff(n);
    }
    throw new Error(`D1_ERROR: commit log contention: no commit after ${this.#maxAttempts} attempts`);
  }

  /** Append `entry` as seq+1. true: it is in the log at seq+1 (exactly once). false: someone else holds seq+1 (or nothing was written). */
  async #append(entry: NewLogEntry): Promise<boolean> {
    for (let tries = 1; ; tries++) {
      try {
        const r = await this.log.append(this.#seq, entry);
        if (r === "ok") return true;
        this.stats.conflicts++;
        // A conflict normally means another unit holds seq+1. After an earlier ambiguous try of this very attempt, the
        // late-landing copy of OUR entry may be what holds it: ask, so the unit is never run twice.
        return (await this.#holder(entry.unitId)) === "mine";
      } catch (e) {
        if (e instanceof AmbiguousAppendError) {
          this.stats.ambiguous++;
          const who = await this.#holder(entry.unitId);
          if (who === "mine") return true;
          if (who === "other") return false;
          // absent: not (yet) in the log; try again with the SAME unit id
        } else if (e instanceof LogThrottledError) {
          this.stats.throttled++;
        } else throw e;
        if (tries >= this.#maxAttempts) throw new Error(`D1_ERROR: commit log contention: append unresolved after ${tries} tries`);
        await this.#backoff(tries);
      }
    }
  }

  async #holder(unitId: string): Promise<"mine" | "other" | "absent"> {
    const got = await this.#logCall(() => this.log.get(this.#seq + 1));
    if (got === null) return "absent";
    return got.unitId === unitId ? "mine" : "other";
  }

  // ---- inspection ----

  /** The whole database as bytes (byte-identical across replicas at the same seq). Throws inside a unit. */
  serialize(): Uint8Array {
    if (this.#inTxn) throw new Error("serialize() while a unit is open");
    return this.db.serialize();
  }

  close(): void {
    this.#cache.clear();
    this.#metaStmt = undefined;
    this.#changesStmt = undefined;
    this.db.close();
  }
}
