// The D1 `TestStore` (tests/harness/port.ts): plain SQL over the test
// database. Table and column names come from test code only, and are
// checked against a plain identifier pattern before interpolation.
import type { Row, TableName, TestStore, Where } from "./port";

const IDENT = /^[a-z_][a-z0-9_]*$/;
function ident(name: string): string {
  if (!IDENT.test(name)) throw new Error(`TestStore: bad identifier '${name}'`);
  return name;
}

function whereClause(where: Where | undefined): { sql: string; args: unknown[] } {
  const entries = Object.entries(where ?? {});
  if (entries.length === 0) return { sql: "", args: [] };
  const parts: string[] = [];
  const args: unknown[] = [];
  for (const [col, value] of entries) {
    if (value === null) parts.push(`${ident(col)} IS NULL`);
    else {
      parts.push(`${ident(col)} = ?`);
      args.push(typeof value === "boolean" ? (value ? 1 : 0) : value);
    }
  }
  return { sql: ` WHERE ${parts.join(" AND ")}`, args };
}

export function d1TestStore(db: D1Database): TestStore {
  return {
    async rows<T extends Row>(table: TableName, where?: Where, orderBy?: string[]) {
      const w = whereClause(where);
      const order = orderBy !== undefined && orderBy.length > 0 ? ` ORDER BY ${orderBy.map(ident).join(", ")}` : " ORDER BY rowid";
      const { results } = await db.prepare(`SELECT * FROM ${ident(table)}${w.sql}${order}`).bind(...w.args).all<T>();
      return results;
    },
    async row<T extends Row>(table: TableName, where: Where) {
      const w = whereClause(where);
      const { results } = await db.prepare(`SELECT * FROM ${ident(table)}${w.sql} LIMIT 2`).bind(...w.args).all<T>();
      if (results.length > 1) throw new Error(`TestStore.row: more than one ${table} row matches`);
      return results[0] ?? null;
    },
    async count(table: TableName, where?: Where) {
      const w = whereClause(where);
      const row = await db.prepare(`SELECT COUNT(*) AS n FROM ${ident(table)}${w.sql}`).bind(...w.args).first<{ n: number }>();
      return row?.n ?? 0;
    },
    async insert(table: TableName, ...rows: Row[]) {
      for (const r of rows) {
        const cols = Object.keys(r).map(ident);
        await db
          .prepare(`INSERT INTO ${ident(table)} (${cols.join(", ")}) VALUES (${cols.map(() => "?").join(", ")})`)
          .bind(...Object.values(r).map((v) => (typeof v === "boolean" ? (v ? 1 : 0) : v)))
          .run();
      }
    },
    async patch(table: TableName, where: Where, fields: Row) {
      const sets = Object.keys(fields).map((c) => `${ident(c)} = ?`);
      const w = whereClause(where);
      const res = await db
        .prepare(`UPDATE ${ident(table)} SET ${sets.join(", ")}${w.sql}`)
        .bind(...Object.values(fields).map((v) => (typeof v === "boolean" ? (v ? 1 : 0) : v)), ...w.args)
        .run();
      return res.meta.changes ?? 0;
    },
    async remove(table: TableName, where: Where) {
      const w = whereClause(where);
      const res = await db.prepare(`DELETE FROM ${ident(table)}${w.sql}`).bind(...w.args).run();
      return res.meta.changes ?? 0;
    },
  };
}
