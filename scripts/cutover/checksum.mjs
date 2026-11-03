// The cutover's table proof (LDB-CV16/CV17): per table a row COUNT and a CHECKSUM over every row, computed the same way on the local
// SQLite (node:sqlite) and on D1 (read-only SELECTs through `wrangler d1 execute --remote --json`), so the two can be compared.
//
//  - Rows are read in a deterministic order (`rowid` keyset pages; a WITHOUT ROWID table pages by OFFSET over its primary key).
//  - Every value is canonicalised the same way on both sides. D1 answers JSON, so an INTEGER and a REAL with an integral value
//    both arrive as a JS number; the local side therefore converts to a JS Number first (bigint included) and both sides call the
//    same `canon`. A BLOB is a Uint8Array locally and an array of byte numbers in D1's JSON.
//  - Nothing here knows Cloudflare or AWS: `select(sql)` is injected (sync or async), so the same code proves the export against the
//    local database, the fresh D1 of a rollback, and the stored image reference.
import { createHash } from "node:crypto";

/** Tables never proven: SQLite's own, Cloudflare's internal `_cf_*`. `sqlite_sequence` is proven as its own pseudo-table. */
export const isProvenTable = (name) => !name.startsWith("sqlite_") && !name.startsWith("_cf_");
export const SEQUENCE_TABLE = "sqlite_sequence";

const HEX = "0123456789abcdef";
function hex(bytes) {
  let s = "";
  for (const b of bytes) s += HEX[(b >> 4) & 15] + HEX[b & 15];
  return s;
}

/** One value, canonical text. The first character is the type: N(ull) I(nteger) R(eal) T(ext) B(lob). */
export function canon(v) {
  if (v === null || v === undefined) return "N";
  if (typeof v === "bigint") return `I${Number(v)}`;
  if (typeof v === "number") return Number.isInteger(v) ? `I${v}` : `R${Object.is(v, -0) ? "0" : String(v)}`;
  if (typeof v === "string") return `T${v.length}:${v}`;
  if (v instanceof Uint8Array || Array.isArray(v)) return `B${hex(v)}`;
  if (v instanceof ArrayBuffer) return `B${hex(new Uint8Array(v))}`;
  throw new Error(`cannot canonicalise a ${typeof v} value`);
}

const rowText = (values) => values.map(canon).join("\x1f");

/** The SQL that reads one page of a table. `after` is the last rowid of the previous page (keyset) or the OFFSET (no rowid). */
export function pageSql(table, order, pageRows, after) {
  const q = `"${table.replaceAll('"', '""')}"`;
  if (order.kind === "rowid") return `SELECT rowid AS "__rid", * FROM ${q} WHERE rowid > ${Number(after)} ORDER BY rowid LIMIT ${pageRows}`;
  if (order.kind === "name") return `SELECT * FROM ${q} ORDER BY name LIMIT ${pageRows} OFFSET ${Number(after)}`;
  const by = order.columns.map((c) => `"${c.replaceAll('"', '""')}"`).join(", ");
  return `SELECT * FROM ${q} ORDER BY ${by} LIMIT ${pageRows} OFFSET ${Number(after)}`;
}

/** How a table is ordered, decided from the LOCAL database (the loaded schema is D1's): rowid, or the primary key of a WITHOUT ROWID table. */
export function orderOf(db, table) {
  if (table === SEQUENCE_TABLE) return { kind: "name" };
  try {
    db.prepare(`SELECT rowid FROM "${table.replaceAll('"', '""')}" LIMIT 0`).all();
    return { kind: "rowid" };
  } catch {
    const cols = db.prepare(`PRAGMA table_info("${table.replaceAll('"', '""')}")`).all().filter((c) => c.pk > 0).sort((a, b) => a.pk - b.pk).map((c) => c.name);
    if (cols.length === 0) throw new Error(`table ${table} has neither a rowid nor a primary key to order by`);
    return { kind: "pk", columns: cols };
  }
}

/** The tables to prove, from the local schema, in name order, plus the sequence pseudo-table when it exists. */
export function provenTables(db) {
  const names = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all().map((r) => r.name);
  const out = names.filter(isProvenTable);
  if (names.includes(SEQUENCE_TABLE)) out.push(SEQUENCE_TABLE);
  return out;
}

/** The select function over a local DatabaseSync (rows as plain objects, integers as bigint so nothing throws above 2^53). */
export function localSelect(db) {
  return (sql) => {
    const stmt = db.prepare(sql);
    stmt.setReadBigInts(true);
    return stmt.all();
  };
}

const feedRows = (h, rows) => {
  for (const row of rows) {
    const keys = Object.keys(row);
    h.update(rowText(keys.filter((k) => k !== "__rid").map((k) => row[k]))).update("\x1e");
  }
};
const clamp = (n, lo, hi) => Math.max(lo, Math.min(hi, n));

/**
 * Count and checksum one table. `select(sql)` returns an array of row objects (a Promise of one is fine). The checksum is the
 * sha256 over every row's canonical text, in order. The keyset column `__rid` is not part of the row (so two tables that differ
 * only in how their rowids were assigned are caught by the ORDER, not hidden: the rows come out in rowid order and a renumbered
 * rowid with the same relative order is equal, which is also what D1 and SQLite guarantee about a rowid-less table's identity).
 * `targetPageBytes` makes the page size follow the row width (about that many bytes of JSON per page, between 50 and 50,000 rows), so a
 * table of 5 KB rows and one of 100-byte rows both take few round trips to a remote database.
 */
export async function proveTable({ select, table, order, pageRows = 500, targetPageBytes }) {
  const q = `"${table.replaceAll('"', '""')}"`;
  const countRows = await select(`SELECT count(*) AS n FROM ${q}`);
  const count = Number(countRows[0].n);
  return proveTableRows({ select, table, order, pageRows, targetPageBytes, count });
}

async function proveTableRows({ select, table, order, pageRows, targetPageBytes, count }) {
  const h = createHash("sha256");
  let after = 0;
  let seen = 0;
  for (;;) {
    const rows = await select(pageSql(table, order, pageRows, after));
    feedRows(h, rows);
    seen += rows.length;
    if (rows.length < pageRows) break;
    after = order.kind === "rowid" ? Number(rows[rows.length - 1].__rid) : seen;
    if (targetPageBytes !== undefined) pageRows = clamp(Math.floor(targetPageBytes / Math.max(1, JSON.stringify(rows).length / rows.length)), 50, 50_000);
  }
  if (seen !== count) throw new Error(`table ${table}: COUNT(*) says ${count} but ${seen} rows were read (a write raced the proof, or the read lied)`);
  return { count, checksum: h.digest("hex") };
}

/** Prove every table. `onTable(table, proof)` is called as each finishes (progress). */
export async function proveAll({ select, db, tables, pageRows, concurrency = 1, onTable }) {
  const list = tables ?? provenTables(db);
  const out = {};
  let next = 0;
  async function worker() {
    while (next < list.length) {
      const table = list[next++];
      out[table] = await proveTable({ select, table, order: orderOf(db, table), pageRows });
      onTable?.(table, out[table]);
    }
  }
  await Promise.all(Array.from({ length: Math.max(1, Math.min(concurrency, list.length)) }, worker));
  return Object.fromEntries(list.map((t) => [t, out[t]]));
}

/**
 * proveAll for a database a round trip away (the D1 REST API), with few calls: ONE query counts every table; every small table is read whole,
 * all of them in ONE multi-statement call (`selectMany(sqls) -> rows[][]`); the big tables are paged by row width, `concurrency` at a time.
 * The result is exactly what proveAll gives for the same data (the checksum does not depend on how the rows were fetched).
 * `stats` (optional) counts what was asked of the remote.
 */
export async function proveAllBatched({ select, selectMany, db, tables, pageRows = 2000, targetPageBytes = 3_000_000, smallRows = 300, concurrency = 4, onTable, stats }) {
  const list = tables ?? provenTables(db);
  const q = (t) => `"${t.replaceAll('"', '""')}"`;
  const many = selectMany ?? (async (sqls) => Promise.all(sqls.map((s) => select(s))));
  const note = (calls, label) => {
    if (stats) stats.calls = (stats.calls ?? 0) + calls, (stats.log ??= []).push(`${label}: ${calls}`);
  };
  const countSql = list.map((t) => `SELECT '${t.replaceAll("'", "''")}' AS t, count(*) AS n FROM ${q(t)}`).join(" UNION ALL ");
  const counts = Object.fromEntries((await select(countSql)).map((r) => [r.t, Number(r.n)]));
  note(1, "counts");
  const small = list.filter((t) => counts[t] <= smallRows);
  const large = list.filter((t) => counts[t] > smallRows);
  const out = {};
  if (small.length > 0) {
    const results = await many(small.map((t) => pageSql(t, orderOf(db, t), smallRows + 1, 0)));
    note(1, `${small.length} small tables`);
    small.forEach((t, i) => {
      const rows = results[i];
      if (rows.length !== counts[t]) throw new Error(`table ${t}: COUNT(*) says ${counts[t]} but ${rows.length} rows were read (a write raced the proof, or the read lied)`);
      const h = createHash("sha256");
      feedRows(h, rows);
      out[t] = { count: rows.length, checksum: h.digest("hex") };
      onTable?.(t, out[t]);
    });
  }
  let next = 0;
  async function worker() {
    while (next < large.length) {
      const t = large[next++];
      let calls = 0;
      out[t] = await proveTableRows({ select: async (sql) => (calls++, select(sql)), table: t, order: orderOf(db, t), pageRows, targetPageBytes, count: counts[t] });
      note(calls, t);
      onTable?.(t, out[t]);
    }
  }
  await Promise.all(Array.from({ length: Math.max(1, Math.min(concurrency, large.length)) }, worker));
  return Object.fromEntries(list.map((t) => [t, out[t]]));
}

/** Every row of a table (objects, `__rid` dropped), paged the way the proof pages. For the few small drift tables whose rows are compared one by one. */
export async function readAllRows({ select, table, order, pageRows = 2000, targetPageBytes = 3_000_000 }) {
  const out = [];
  let after = 0;
  for (;;) {
    const rows = await select(pageSql(table, order, pageRows, after));
    for (const r of rows) out.push(Object.fromEntries(Object.entries(r).filter(([k]) => k !== "__rid")));
    if (rows.length < pageRows) return out;
    after = order.kind === "rowid" ? Number(rows[rows.length - 1].__rid) : out.length;
    pageRows = clamp(Math.floor(targetPageBytes / Math.max(1, JSON.stringify(rows).length / rows.length)), 50, 50_000);
  }
}

/** Compare two proofs (`{table: {count, checksum}}`). Every difference is named; the result is ok only if there is none. */
export function compareProofs(left, right, names = { left: "local", right: "D1" }) {
  const diffs = [];
  for (const t of [...new Set([...Object.keys(left), ...Object.keys(right)])].sort()) {
    const l = left[t];
    const r = right[t];
    if (l === undefined) diffs.push({ table: t, field: "table", [names.left]: "absent", [names.right]: "present" });
    else if (r === undefined) diffs.push({ table: t, field: "table", [names.left]: "present", [names.right]: "absent" });
    else {
      if (l.count !== r.count) diffs.push({ table: t, field: "count", [names.left]: l.count, [names.right]: r.count });
      if (l.checksum !== r.checksum) diffs.push({ table: t, field: "checksum", [names.left]: l.checksum, [names.right]: r.checksum });
    }
  }
  return { ok: diffs.length === 0, tables: Object.keys(left).length, rows: Object.values(left).reduce((n, p) => n + p.count, 0), diffs };
}

/** `meta.seq` (MAX(seq) of events; 0 when empty) and the events counter (sqlite_sequence), through any select. */
export async function feedPosition(select) {
  const m = await select("SELECT COALESCE(MAX(seq), 0) AS seq FROM events");
  let counter = null;
  try {
    const s = await select("SELECT seq FROM sqlite_sequence WHERE name = 'events'");
    counter = s.length === 0 ? null : Number(s[0].seq);
  } catch (e) {
    // a database that never had an AUTOINCREMENT column has no sqlite_sequence; any other failure is a failure, not "no counter"
    if (!/no such table/i.test(String(e?.message ?? e))) throw e;
    counter = null;
  }
  return { metaSeq: Number(m[0].seq), eventsCounter: counter };
}
