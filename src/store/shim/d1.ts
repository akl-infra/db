// A `D1Database` over a Replica (design A, SH1/SH2/SH3/SH7). store/d1/* and
// every SQL string run unchanged on top of this: `prepare().bind()` then
// `.first()/.all()/.run()/.raw()`, `batch()`, `exec()`. Result shapes, error
// text and type coercion follow D1 (verified against miniflare's D1 by
// tests/shim/d1-parity.test.ts and the differential fuzzer):
//  - rows are plain objects, BLOBs come back as number[], `.run()` returns the
//    rows too, `.first(col)` is the value or null;
//  - `bind`: booleans -> 1/0, NaN/Infinity -> NULL, Uint8Array/ArrayBuffer ->
//    BLOB, anything else (undefined, bigint, objects, Date) -> D1_TYPE_ERROR;
//  - errors are `Error("D1_ERROR: <sqlite text>: SQLITE_X (extended: ...)")`
//    with a `cause`, so akldb's /UNIQUE constraint failed: layouts\.name/ matches;
//  - a batch (or a single statement) is one atomic commit unit.
// Per request (SH7): the first statement of a request-scoped instance awaits
// one strong catch-up; later statements do not read the head again. An
// instance that is not request-scoped catches up before every statement.
import type { BoundStatement, Replica, StatementOutcome } from "../../replica/replica";

export interface ShimOptions {
  /** One request's view: a single strong head read before the first statement. Default false: every statement catches up first. */
  requestScoped?: boolean;
}

const PRIMARY: Record<number, string> = {
  1: "ERROR", 2: "INTERNAL", 3: "PERM", 4: "ABORT", 5: "BUSY", 6: "LOCKED", 7: "NOMEM", 8: "READONLY", 9: "INTERRUPT", 10: "IOERR",
  11: "CORRUPT", 12: "NOTFOUND", 13: "FULL", 14: "CANTOPEN", 15: "PROTOCOL", 16: "EMPTY", 17: "SCHEMA", 18: "TOOBIG", 19: "CONSTRAINT",
  20: "MISMATCH", 21: "MISUSE", 22: "NOLFS", 23: "AUTH", 24: "FORMAT", 25: "RANGE", 26: "NOTADB",
};
const EXTENDED: Record<number, string> = {
  275: "SQLITE_CONSTRAINT_CHECK", 531: "SQLITE_CONSTRAINT_COMMITHOOK", 787: "SQLITE_CONSTRAINT_FOREIGNKEY", 1043: "SQLITE_CONSTRAINT_FUNCTION",
  1299: "SQLITE_CONSTRAINT_NOTNULL", 1555: "SQLITE_CONSTRAINT_PRIMARYKEY", 1811: "SQLITE_CONSTRAINT_TRIGGER", 2067: "SQLITE_CONSTRAINT_UNIQUE",
  2323: "SQLITE_CONSTRAINT_VTAB", 2579: "SQLITE_CONSTRAINT_ROWID", 2835: "SQLITE_CONSTRAINT_PINNED", 3091: "SQLITE_CONSTRAINT_DATATYPE",
};

function d1Error(message: string): Error {
  return new Error(`D1_ERROR: ${message}`, { cause: new Error(message) });
}

/** node:sqlite's error as D1 words it: `D1_ERROR: <sqlite message>: SQLITE_<PRIMARY>[ (extended: SQLITE_<X>)]`. */
export function mapSqliteError(e: unknown, sql?: string): unknown {
  if (!(e instanceof Error)) return e;
  if (e.message.startsWith("D1_")) return e;
  const code = (e as { code?: string }).code;
  const errcode = (e as { errcode?: number }).errcode;
  if (code !== "ERR_SQLITE_ERROR" || typeof errcode !== "number") return e;
  let text = e.message;
  const near = /^near "([^"]*)": syntax error$/.exec(text);
  if (near !== null && sql !== undefined) text += ` at offset ${Math.max(0, sql.indexOf(near[1]!))}`;
  const primary = `SQLITE_${PRIMARY[errcode & 0xff] ?? "ERROR"}`;
  const extended = EXTENDED[errcode];
  return d1Error(`${text}: ${primary}${extended !== undefined ? ` (extended: ${extended})` : ""}`);
}

function typeError(value: unknown): Error {
  const m = `Type '${typeof value}' not supported for value '${String(value)}'`;
  return new Error(`D1_TYPE_ERROR: ${m}`, { cause: new Error(m) });
}

type SqlValue = null | number | string | Uint8Array;

export function normalizeParam(v: unknown): SqlValue {
  if (v === null) return null;
  switch (typeof v) {
    case "string":
      return v;
    case "number":
      return Number.isFinite(v) ? v : null;
    case "boolean":
      return v ? 1 : 0;
    case "object": {
      if (v instanceof ArrayBuffer) return new Uint8Array(v.slice(0));
      if (ArrayBuffer.isView(v)) return new Uint8Array(v.buffer.slice(v.byteOffset, v.byteOffset + v.byteLength));
      throw typeError(v);
    }
    default:
      throw typeError(v);
  }
}

/** The number of parameters a statement takes (SQLite's rule: the largest index; a bare `?` is the previous largest + 1). */
export function countParams(sql: string): number {
  let max = 0;
  let i = 0;
  const n = sql.length;
  while (i < n) {
    const c = sql[i]!;
    if (c === "'" || c === '"' || c === "`") {
      i++;
      while (i < n) {
        if (sql[i] === c) {
          if (sql[i + 1] === c) i += 2;
          else break;
        } else i++;
      }
      i++;
    } else if (c === "[") {
      const end = sql.indexOf("]", i);
      i = end < 0 ? n : end + 1;
    } else if (c === "-" && sql[i + 1] === "-") {
      const end = sql.indexOf("\n", i);
      i = end < 0 ? n : end + 1;
    } else if (c === "/" && sql[i + 1] === "*") {
      const end = sql.indexOf("*/", i + 2);
      i = end < 0 ? n : end + 2;
    } else if (c === "?") {
      let j = i + 1;
      while (j < n && sql[j]! >= "0" && sql[j]! <= "9") j++;
      max = j > i + 1 ? Math.max(max, Number(sql.slice(i + 1, j))) : max + 1;
      i = j;
    } else i++;
  }
  return max;
}

function plainValue(v: unknown): unknown {
  return v instanceof Uint8Array ? Array.from(v) : v;
}

function plainRow(r: Record<string, unknown>): Record<string, unknown> {
  for (const k of Object.keys(r)) if (r[k] instanceof Uint8Array) r[k] = Array.from(r[k] as Uint8Array);
  return r;
}

function metaOf(o: StatementOutcome): D1Meta & Record<string, unknown> {
  return {
    duration: 0,
    size_after: 0,
    rows_read: o.rows.length + (o.arrays?.length ?? 0),
    rows_written: o.changes,
    last_row_id: o.lastRowId,
    changed_db: o.changedDb,
    changes: o.changes,
    served_by: "shim",
  };
}

function resultOf<T>(o: StatementOutcome, raw: boolean): D1Result<T> {
  const results = raw ? (o.arrays ?? []).map((row) => row.map(plainValue)) : o.rows.map(plainRow);
  return { success: true, meta: metaOf(o), results } as unknown as D1Result<T>;
}

class ShimStatement {
  constructor(
    private readonly owner: ShimDatabase,
    readonly sql: string,
    readonly params: SqlValue[] | undefined,
  ) {}

  bind(...values: unknown[]): D1PreparedStatement {
    return new ShimStatement(this.owner, this.sql, values.map(normalizeParam)) as unknown as D1PreparedStatement;
  }

  /** @internal */
  toBound(raw = false): BoundStatement {
    if (this.sql.trim() === "") throw d1Error("No SQL statements detected.");
    const params = this.params ?? [];
    if (countParams(this.sql) !== params.length) throw d1Error("Wrong number of parameter bindings for SQL query.");
    return { sql: this.sql, params, ...(raw ? { raw: true } : {}) };
  }

  async first<T = Record<string, unknown>>(column?: string): Promise<T | null> {
    const [o] = await this.owner.unit([this.toBound()]);
    const row = o!.rows[0];
    if (row === undefined) return null;
    const r = plainRow(row);
    if (column === undefined) return r as T;
    if (!(column in r)) throw d1Error(`Column not found: ${column}`);
    return r[column] as T;
  }

  async all<T = Record<string, unknown>>(): Promise<D1Result<T>> {
    const [o] = await this.owner.unit([this.toBound()]);
    return resultOf<T>(o!, false);
  }

  // D1's run() answers with the rows too (a SELECT through run() returns them).
  async run<T = Record<string, unknown>>(): Promise<D1Result<T>> {
    return this.all<T>();
  }

  async raw<T = unknown[]>(options?: { columnNames?: boolean }): Promise<T[]> {
    const [o] = await this.owner.unit([this.toBound(true)]);
    const rows = (o!.arrays ?? []).map((row) => row.map(plainValue));
    return (options?.columnNames === true ? [o!.columns, ...rows] : rows) as T[];
  }
}

class ShimDatabase {
  #synced: Promise<unknown> | undefined;

  constructor(
    private readonly replica: Replica,
    private readonly scoped: boolean,
  ) {}

  /** Run one commit unit: the SH7 sync rule, then Replica.runUnit with D1 error words. */
  async unit(stmts: BoundStatement[]): Promise<StatementOutcome[]> {
    try {
      if (this.scoped) {
        // One strong head read per request, shared by statements that start before it finishes.
        this.#synced ??= this.replica.catchUp().catch((e: unknown) => {
          this.#synced = undefined;
          throw e;
        });
        await this.#synced;
        return await this.replica.runUnit(stmts, { fresh: true });
      }
      return await this.replica.runUnit(stmts, { fresh: false });
    } catch (e) {
      throw mapSqliteError(e, stmts.length === 1 ? stmts[0]!.sql : undefined);
    }
  }

  prepare(sql: string): D1PreparedStatement {
    return new ShimStatement(this, sql, undefined) as unknown as D1PreparedStatement;
  }

  async batch<T = unknown>(statements: D1PreparedStatement[]): Promise<D1Result<T>[]> {
    if (statements.length === 0) return [];
    const bound = statements.map((s) => (s as unknown as ShimStatement).toBound());
    const outcomes = await this.unit(bound);
    return outcomes.map((o) => resultOf<T>(o, false));
  }

  async exec(query: string): Promise<D1ExecResult> {
    if (query.trim() === "") throw d1Error("No SQL statements detected.");
    const outcomes = await this.unit([{ sql: query, params: [], exec: true }]);
    void outcomes;
    return { count: Math.max(1, query.split(";").filter((p) => p.trim() !== "").length), duration: 0 };
  }

  async dump(): Promise<ArrayBuffer> {
    throw d1Error("dump() is not supported by the shim; akldb builds its dump from the store (src/dump)");
  }

  withSession(): D1DatabaseSession {
    const self = this;
    return {
      prepare: (sql: string) => self.prepare(sql),
      batch: <T>(s: D1PreparedStatement[]) => self.batch<T>(s),
      getBookmark: () => null,
    } as unknown as D1DatabaseSession;
  }
}

/** A D1Database over `replica`. Request-scoped instances read the log head once (SH7). */
export function createShimD1(replica: Replica, opts: ShimOptions = {}): D1Database {
  return new ShimDatabase(replica, opts.requestScoped === true) as unknown as D1Database;
}
