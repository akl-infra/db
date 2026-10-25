// An observed D1 handle (design/aws-port.md §5.2): the same database, plus a note of every event row a statement
// committed. It issues no extra query and changes no result. `createD1Store` receives this handle in place of `env.DB`.
import { noteSeq } from "./recorder";
import { TEE_TAG, type TeeTag } from "./tag";

const EVENT_INSERT = /^\s*INSERT\s+(?:OR\s+\w+\s+)?INTO\s+events\b/i;

function note(isEvent: boolean, result: { meta?: { changes?: number; last_row_id?: number } } | undefined): void {
  if (!isEvent || result?.meta === undefined) return;
  if (result.meta.changes === 1 && typeof result.meta.last_row_id === "number") noteSeq(result.meta.last_row_id);
}

class ObservedStatement implements D1PreparedStatement {
  constructor(
    readonly inner: D1PreparedStatement,
    readonly isEvent: boolean,
  ) {}
  bind(...values: unknown[]): D1PreparedStatement {
    return new ObservedStatement(this.inner.bind(...values), this.isEvent);
  }
  async run<T = Record<string, unknown>>(): Promise<D1Result<T>> {
    const r = await this.inner.run<T>();
    note(this.isEvent, r);
    return r;
  }
  async all<T = Record<string, unknown>>(): Promise<D1Result<T>> {
    const r = await this.inner.all<T>();
    note(this.isEvent, r);
    return r;
  }
  first<T = unknown>(colName: string): Promise<T | null>;
  first<T = Record<string, unknown>>(): Promise<T | null>;
  first(colName?: string): Promise<unknown> {
    return colName === undefined ? this.inner.first() : this.inner.first(colName);
  }
  raw<T = unknown[]>(options: { columnNames: true }): Promise<[string[], ...T[]]>;
  raw<T = unknown[]>(options?: { columnNames?: false }): Promise<T[]>;
  raw(options?: { columnNames?: boolean }): Promise<unknown> {
    return (this.inner.raw as (o?: unknown) => Promise<unknown>)(options);
  }
}

export function observeD1(db: D1Database, tag?: TeeTag): D1Database {
  const observed = {
    prepare(query: string): D1PreparedStatement {
      return new ObservedStatement(db.prepare(query), EVENT_INSERT.test(query));
    },
    async batch<T = unknown>(statements: D1PreparedStatement[]): Promise<D1Result<T>[]> {
      const results = await db.batch<T>(statements.map((s) => (s instanceof ObservedStatement ? s.inner : s)));
      statements.forEach((s, i) => note(s instanceof ObservedStatement && s.isEvent, results[i]));
      return results;
    },
    exec: (query: string) => db.exec(query),
    withSession: (constraintOrBookmark?: string) => db.withSession(constraintOrBookmark),
    dump: () => db.dump(),
  } as D1Database;
  if (tag !== undefined) Object.defineProperty(observed, TEE_TAG, { value: tag });
  return observed;
}
