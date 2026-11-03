// SQL <-> SQLite for the cutover and its rollback (node:sqlite only).
//  - loadExportSql: a `wrangler d1 export` file into a fresh database, then the load step's sanity checks.
//  - dumpToSql: a database image into SQL that `wrangler d1 execute --file` accepts (no BEGIN/COMMIT, no PRAGMA foreign_keys: D1
//    refuses both), tables first, data second, indexes/triggers/views last (so no trigger fires on the load), sqlite_sequence set at
//    the very end to D1's exact values.
import fs from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { SEQUENCE_TABLE, isProvenTable, orderOf } from "./checksum.mjs";

/**
 * Split SQL text into statements (without the trailing `;`), the way SQLite's tokenizer would: `;` inside '...', "...", `...`, [...] and
 * comments does not end a statement, and a CREATE TRIGGER runs to its `END;` (its body holds `;`).
 */
export function splitStatements(sql) {
  const out = [];
  let cur = "";
  let i = 0;
  let trigger = false;
  let caseDepth = 0;
  let endSeen = false; // the last token of a trigger statement so far is the END that closes it (not one that closes a CASE)
  const startOfStatement = () => cur.trim() === "";
  const word = () => /^[A-Za-z_]+/.exec(sql.slice(i))?.[0];
  while (i < sql.length) {
    const ch = sql[i];
    const two = sql.slice(i, i + 2);
    if (ch === "'" || ch === '"' || ch === "`") {
      let j = i + 1;
      for (;;) {
        if (j >= sql.length) throw new Error(`unterminated ${ch} quote in the SQL near: ${sql.slice(i, i + 60)}`);
        if (sql[j] === ch) {
          if (sql[j + 1] === ch) j += 2;
          else break;
        } else j++;
      }
      cur += sql.slice(i, j + 1);
      i = j + 1;
    } else if (ch === "[") {
      const j = sql.indexOf("]", i);
      if (j < 0) throw new Error("unterminated [identifier]");
      cur += sql.slice(i, j + 1);
      i = j + 1;
    } else if (two === "--") {
      const j = sql.indexOf("\n", i);
      const end = j < 0 ? sql.length : j;
      if (!startOfStatement()) cur += sql.slice(i, end);
      i = end;
    } else if (two === "/*") {
      const j = sql.indexOf("*/", i + 2);
      const end = j < 0 ? sql.length : j + 2;
      if (!startOfStatement()) cur += sql.slice(i, end);
      i = end;
    } else if (ch === ";") {
      // inside a trigger body a `;` ends a body statement; the trigger ends at `END` + `;`
      if (trigger && !endSeen) {
        cur += ch;
        i++;
      } else {
        if (cur.trim() !== "") out.push(cur.trim());
        cur = "";
        trigger = false;
        caseDepth = 0;
        endSeen = false;
        i++;
      }
    } else {
      if (/[A-Za-z_]/.test(ch) && !/[A-Za-z0-9_]/.test(sql[i - 1] ?? " ")) {
        const w = word();
        const up = w.toUpperCase();
        if (startOfStatement() && up === "CREATE") trigger = /^CREATE\s+(TEMP(ORARY)?\s+)?TRIGGER\b/i.test(sql.slice(i, i + 80));
        if (trigger) {
          endSeen = false;
          if (up === "CASE") caseDepth++;
          else if (up === "END") {
            if (caseDepth > 0) caseDepth--;
            else endSeen = true;
          }
        }
        cur += w;
        i += w.length;
      } else {
        if (trigger && !/\s/.test(ch)) endSeen = false;
        cur += ch;
        i++;
      }
    }
  }
  if (cur.trim() !== "") out.push(cur.trim());
  return out;
}

const DEFERRED = /^CREATE\s+(UNIQUE\s+)?(INDEX|VIEW|TRIGGER|TEMP(ORARY)?\s+TRIGGER)\b/i;

/**
 * Build `dbPath` (or ":memory:") from an export file's SQL. Foreign keys are off while loading and checked afterwards. Triggers (and indexes
 * and views) are created AFTER every row is in, in their original order: an export that lists a trigger before the data would otherwise
 * fire it on the rows being loaded (the head counters double), and the AWS database would no longer be D1's.
 */
export function loadExportSql(sql, dbPath = ":memory:") {
  const db = new DatabaseSync(dbPath);
  db.exec("PRAGMA foreign_keys = OFF");
  const statements = splitStatements(sql);
  for (const st of statements) if (!DEFERRED.test(st)) db.exec(st);
  for (const st of statements) if (DEFERRED.test(st)) db.exec(st);
  return db;
}

/**
 * The load step's checks. `migrationNames`: the bundle's migrations/*.sql file names. Returns {ok, checks:[{name, ok, detail}]}.
 *  - PRAGMA integrity_check is "ok";
 *  - PRAGMA foreign_key_check is empty;
 *  - every table the migrations create is present (`expectedTables`, when given);
 *  - d1_migrations lists exactly the bundle's migrations (none missing, none unknown) unless `allowPending`.
 */
export function sanityChecks(db, { migrationNames = [], expectedTables = [], allowPending = false } = {}) {
  const checks = [];
  const add = (name, ok, detail) => checks.push({ name, ok, detail });
  const integrity = db.prepare("PRAGMA integrity_check").all().map((r) => Object.values(r)[0]);
  add("integrity_check", integrity.length === 1 && integrity[0] === "ok", integrity.join("; "));
  const fk = db.prepare("PRAGMA foreign_key_check").all();
  add("foreign_key_check", fk.length === 0, fk.length === 0 ? "no violations" : `${fk.length} violation(s), first: ${JSON.stringify(fk[0])}`);
  const tables = new Set(db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map((r) => r.name));
  const missing = expectedTables.filter((t) => !tables.has(t));
  add("tables_present", missing.length === 0, missing.length === 0 ? `${[...tables].filter(isProvenTable).length} tables` : `missing: ${missing.join(", ")}`);
  let applied = [];
  if (tables.has("d1_migrations")) applied = db.prepare("SELECT name FROM d1_migrations ORDER BY id").all().map((r) => r.name);
  const pending = migrationNames.filter((n) => !applied.includes(n));
  const unknown = applied.filter((n) => !migrationNames.includes(n));
  add("d1_migrations_complete", tables.has("d1_migrations") && unknown.length === 0 && (allowPending || pending.length === 0), `${applied.length} applied; pending [${pending.join(", ")}]; unknown to this bundle [${unknown.join(", ")}]`);
  return { ok: checks.every((c) => c.ok), checks, applied, pending, unknown };
}

/** The tables a set of migration files create, read from a database built by running them (the load step passes them in). */
export function tablesCreatedBy(migrationSqls) {
  const db = new DatabaseSync(":memory:");
  try {
    for (const sql of migrationSqls) db.exec(sql);
    return db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map((r) => r.name).filter(isProvenTable);
  } finally {
    db.close();
  }
}

const qid = (s) => `"${s.replaceAll('"', '""')}"`;

/** One value as a SQL literal. Integers are exact (bigint), a REAL is its shortest round-trip form, text doubles its quotes, a blob is X'..'. */
export function literal(v) {
  if (v === null || v === undefined) return "NULL";
  if (typeof v === "bigint") return v.toString();
  if (typeof v === "number") {
    if (!Number.isFinite(v)) throw new Error(`cannot write ${v} as SQL`);
    return Number.isInteger(v) ? `${v}.0` : String(v); // a REAL stays a REAL
  }
  if (typeof v === "string") return `'${v.replaceAll("'", "''")}'`;
  if (v instanceof Uint8Array) return `X'${Buffer.from(v).toString("hex")}'`;
  throw new Error(`cannot write a ${typeof v} as SQL`);
}

/** True when the table has an INTEGER PRIMARY KEY alias of rowid (then the rowid travels in that column). */
function hasRowidAlias(db, table) {
  const pk = db.prepare(`PRAGMA table_info(${qid(table)})`).all().filter((c) => c.pk > 0);
  return pk.length === 1 && /^integer$/i.test(pk[0].type);
}

/**
 * The whole database as SQL statements, one per array element. `maxStatementBytes`: D1 refuses a statement over 100 KB, so a row
 * bigger than that fails HERE, by name, instead of half-way through an import.
 */
export function dumpToStatements(db, { maxStatementBytes = 100_000 } = {}) {
  const out = ["PRAGMA defer_foreign_keys = TRUE"];
  const master = db.prepare("SELECT type, name, tbl_name, sql FROM sqlite_master WHERE sql IS NOT NULL ORDER BY rowid").all();
  const tables = master.filter((m) => m.type === "table" && isProvenTable(m.name));
  for (const t of tables) out.push(t.sql);
  for (const t of tables) {
    const info = db.prepare(`PRAGMA table_info(${qid(t.name)})`).all();
    const order = orderOf(db, t.name);
    const explicitRowid = order.kind === "rowid" && !hasRowidAlias(db, t.name); // a WITHOUT ROWID table has none; an INTEGER PRIMARY KEY carries it
    const cols = info.map((c) => qid(c.name));
    const orderBy = order.kind === "rowid" ? "rowid" : order.columns.map(qid).join(", ");
    const select = db.prepare(`SELECT ${explicitRowid ? 'rowid AS "__rid", ' : ""}* FROM ${qid(t.name)} ORDER BY ${orderBy}`);
    select.setReadBigInts(true);
    const head = `INSERT INTO ${qid(t.name)} (${explicitRowid ? `"rowid", ` : ""}${cols.join(", ")}) VALUES`;
    for (const row of select.iterate()) {
      const values = (explicitRowid ? [row.__rid] : []).concat(info.map((c) => row[c.name]));
      const stmt = `${head}(${values.map(literal).join(", ")})`;
      if (stmt.length > maxStatementBytes) throw new Error(`a row of ${t.name} is ${stmt.length} bytes as an INSERT, over the ${maxStatementBytes}-byte statement limit of D1`);
      out.push(stmt);
    }
  }
  for (const kind of ["index", "view", "trigger"]) for (const m of master.filter((x) => x.type === kind && isProvenTable(x.tbl_name) && !x.name.startsWith("sqlite_autoindex"))) out.push(m.sql);
  if (db.prepare("SELECT 1 FROM sqlite_master WHERE name = ?").get(SEQUENCE_TABLE) !== undefined) {
    out.push(`DELETE FROM ${SEQUENCE_TABLE}`);
    const seqs = db.prepare(`SELECT name, seq FROM ${SEQUENCE_TABLE} ORDER BY name`);
    seqs.setReadBigInts(true); // exact integers: a plain number would be written as a REAL ("3.0")
    for (const r of seqs.all()) out.push(`INSERT INTO ${SEQUENCE_TABLE} (name, seq) VALUES(${literal(r.name)}, ${literal(r.seq)})`);
  }
  return out;
}

export function dumpToSql(db, opts) {
  return dumpToStatements(db, opts).map((s) => `${s};`).join("\n") + "\n";
}

export function writeDump(db, file, opts) {
  fs.writeFileSync(file, dumpToSql(db, opts));
}
