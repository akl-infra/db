// Shared helpers for suites that assert through `testStore` (tests/harness).
// `testStore.row` returns every column where the SQL it replaced selected a
// few (`pick`), and its rows are `Record<string, unknown>` where the suites
// type them as the `*DbRow` interfaces (`rowsAs`/`rowAs`).
import { testStore, type Row, type TableName, type Where } from "../harness";

export function pick<T = Row>(row: Row | null, ...columns: string[]): T | null {
  if (row === null) return null;
  return Object.fromEntries(columns.map((c) => [c, row[c]])) as T;
}

export async function rowsAs<T>(table: TableName, where?: Where, orderBy?: string[]): Promise<T[]> {
  return (await testStore.rows(table, where, orderBy)) as unknown as T[];
}

export async function rowAs<T>(table: TableName, where: Where): Promise<T | null> {
  return (await testStore.row(table, where)) as unknown as T | null;
}
