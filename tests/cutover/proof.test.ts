// [LDB-CV14] The table proof and the SQL dump (scripts/cutover/checksum.mjs, sqlfile.mjs): canonical across SQLite and D1's JSON
// shapes, deterministic, sensitive to a single changed value, and a dump loads back to an identical proof.
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
// @ts-expect-error -- plain scripts, no .d.ts
import { canon, compareProofs, feedPosition, localSelect, orderOf, proveAll, proveAllBatched, proveTable } from "../../scripts/cutover/checksum.mjs";
// @ts-expect-error -- plain scripts, no .d.ts
import { dumpToSql, dumpToStatements, literal, loadExportSql, sanityChecks, splitStatements } from "../../scripts/cutover/sqlfile.mjs";

function sample(): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  db.exec(`
    CREATE TABLE t (id INTEGER PRIMARY KEY AUTOINCREMENT, a TEXT, r REAL, b BLOB, n INTEGER);
    CREATE TABLE loose (name TEXT PRIMARY KEY, v);
    CREATE TABLE log (x INTEGER, note TEXT);
    CREATE TABLE kv (k TEXT NOT NULL, j INTEGER NOT NULL, PRIMARY KEY (k, j)) WITHOUT ROWID;
    CREATE TRIGGER t_ins AFTER INSERT ON t BEGIN INSERT INTO log (x, note) VALUES (NEW.id, 'trigger'); END;
    CREATE INDEX t_a ON t(a);
  `);
  const ins = db.prepare("INSERT INTO t (a, r, b, n) VALUES (?, ?, ?, ?)");
  ins.run("it's \"quoted\"\nnew line é中", 1.5, new Uint8Array([0, 1, 255]), 9007199254740993n);
  ins.run(null, 3.0, null, -1);
  ins.run("x".repeat(500), 0.1 + 0.2, new Uint8Array(0), 0);
  db.exec("DELETE FROM t WHERE id = 3"); // sqlite_sequence stays at 3
  db.exec("DELETE FROM log");
  db.exec("INSERT INTO log (x, note) VALUES (7, 'kept'), (8, NULL)");
  db.exec("INSERT INTO loose VALUES ('b', 1), ('a', x'00ff'), ('c', 2.5)");
  db.exec("INSERT INTO kv VALUES ('k', 2), ('k', 1), ('j', 9)");
  return db;
}

/** D1 answers JSON: integers as numbers, blobs as arrays. */
const asD1 = (db: DatabaseSync) => (sql: string) =>
  localSelect(db)(sql).map((r: Record<string, unknown>) => Object.fromEntries(Object.entries(r).map(([k, v]) => [k, typeof v === "bigint" ? Number(v) : v instanceof Uint8Array ? Array.from(v) : v])));

describe("the table proof (CV14)", () => {
  it("[LDB-CV14] values are canonical across the local shapes and D1's JSON shapes", () => {
    expect(canon(5n)).toBe(canon(5));
    expect(canon(new Uint8Array([1, 2]))).toBe(canon([1, 2]));
    expect(canon(3)).toBe("I3");
    expect(canon(3.5)).toBe("R3.5");
    expect(canon(null)).toBe(canon(undefined));
    expect(canon("5")).not.toBe(canon(5));
    expect(canon("")).not.toBe(canon(null));
    expect(canon(new Uint8Array(0))).not.toBe(canon(""));
    expect(canon("ab\x1f")).not.toBe(canon("ab")); // separators cannot be forged by a value
  });

  it("[LDB-CV14] the same database proves identically through SQLite's shapes and D1's JSON shapes, whatever the page size", async () => {
    const db = sample();
    const local = await proveAll({ select: localSelect(db), db, pageRows: 2 });
    const remote = await proveAll({ select: asD1(db), db, pageRows: 1, concurrency: 3 });
    const big = await proveAll({ select: localSelect(db), db, pageRows: 500 });
    expect(compareProofs(local, remote).ok).toBe(true);
    expect(compareProofs(local, big).ok).toBe(true);
    expect(Object.keys(local)).toEqual(["kv", "log", "loose", "t", "sqlite_sequence"]);
    expect(local.t.count).toBe(2);
    expect(orderOf(db, "kv")).toEqual({ kind: "pk", columns: ["k", "j"] });
    expect(orderOf(db, "t")).toEqual({ kind: "rowid" });
  });

  it("[LDB-CV14] one changed value, one extra row, one lost row and a changed counter are each caught, and named", async () => {
    const base = sample();
    const want = await proveAll({ select: localSelect(base), db: base });
    const mutate = async (sql: string) => {
      const db = sample();
      db.exec(sql);
      return compareProofs(want, await proveAll({ select: localSelect(db), db }), { left: "a", right: "b" });
    };
    expect((await mutate("UPDATE t SET a = 'it''s \"quoted\"\nnew line é丮' WHERE id = 1")).diffs).toEqual([expect.objectContaining({ table: "t", field: "checksum" })]);
    expect((await mutate("UPDATE loose SET v = 2 WHERE name = 'c'")).diffs).toEqual([expect.objectContaining({ table: "loose", field: "checksum" })]);
    expect((await mutate("UPDATE log SET note = '' WHERE x = 8")).ok).toBe(false); // NULL vs empty text
    expect((await mutate("UPDATE t SET r = 1.5000000000000002 WHERE id = 1")).ok).toBe(false);
    const extra = await mutate("INSERT INTO loose VALUES ('z', 0)");
    expect(extra.diffs.map((d: { field: string }) => d.field).sort()).toEqual(["checksum", "count"]);
    expect((await mutate("DELETE FROM kv WHERE k = 'j'")).diffs.map((d: { table: string }) => d.table)).toEqual(["kv", "kv"]);
    const seq = await mutate("UPDATE sqlite_sequence SET seq = seq + 1 WHERE name = 't'");
    expect(seq.diffs).toEqual([expect.objectContaining({ table: "sqlite_sequence", field: "checksum" })]);
    // a table on one side only
    const lonely = compareProofs(want, { ...want, extra: { count: 0, checksum: "x" } });
    expect(lonely.diffs[0]).toMatchObject({ table: "extra", field: "table" });
  });

  it("[LDB-CV14] a row count that moves while the pages are read is an error, not a proof", async () => {
    const db = sample();
    let calls = 0;
    const select = (sql: string) => {
      const rows = localSelect(db)(sql);
      if (++calls === 2) db.exec("INSERT INTO loose VALUES ('late', 1)"); // after the COUNT(*) and the first page
      return rows;
    };
    await expect(proveTable({ select, table: "loose", order: orderOf(db, "loose"), pageRows: 1 })).rejects.toThrow(/COUNT\(\*\) says 3 but 4 rows/);
  });

  it("[LDB-CV14] feedPosition reads meta.seq and the events counter", async () => {
    const db = new DatabaseSync(":memory:");
    db.exec("CREATE TABLE events (seq INTEGER PRIMARY KEY AUTOINCREMENT, k TEXT); INSERT INTO events (k) VALUES ('a'), ('b'), ('c'); DELETE FROM events WHERE seq = 3");
    expect(await feedPosition(localSelect(db))).toEqual({ metaSeq: 2, eventsCounter: 3 });
    const empty = new DatabaseSync(":memory:");
    empty.exec("CREATE TABLE events (seq INTEGER PRIMARY KEY AUTOINCREMENT, k TEXT)");
    expect(await feedPosition(localSelect(empty))).toEqual({ metaSeq: 0, eventsCounter: null });
  });
});

describe("the SQL dump (CV14)", () => {
  it("[LDB-CV14] a dump is what D1's import accepts: no transaction statements, tables then rows then indexes and triggers, sequences last", () => {
    const db = sample();
    const sql = dumpToStatements(db) as string[];
    expect(sql.some((s) => /^(BEGIN|COMMIT|ROLLBACK|SAVEPOINT)\b/i.test(s))).toBe(false);
    expect(sql.some((s) => /^PRAGMA foreign_keys/i.test(s))).toBe(false);
    const at = (re: RegExp) => sql.findIndex((s) => re.test(s));
    expect(at(/^CREATE TABLE "?t"? /)).toBeLessThan(at(/^INSERT INTO "t"/));
    expect(at(/^INSERT INTO "t"/)).toBeLessThan(at(/^CREATE TRIGGER/)); // a trigger created before the rows would fire on them
    expect(at(/^INSERT INTO "log"/)).toBeLessThan(at(/^CREATE TRIGGER/));
    expect(at(/^CREATE INDEX/)).toBeGreaterThan(at(/^INSERT INTO "kv"/));
    expect(sql[sql.length - 2]).toBe("DELETE FROM sqlite_sequence");
    expect(sql[sql.length - 1]).toMatch(/^INSERT INTO sqlite_sequence \(name, seq\) VALUES\('t', 3\)$/);
    expect(sql.every((s) => !s.endsWith(";"))).toBe(true);
  });

  it("[LDB-CV14] loading a dump gives a database with an identical proof: rowids of rowid-less-alias tables, REAL vs INTEGER, blobs, quotes, unicode, big integers, the AUTOINCREMENT counter", async () => {
    const db = sample();
    const copy = loadExportSql(dumpToSql(db));
    const a = await proveAll({ select: localSelect(db), db });
    const b = await proveAll({ select: localSelect(copy), db: copy });
    expect(compareProofs(a, b).ok).toBe(true);
    // the REAL 3.0 stayed a REAL (typeof), the big integer stayed exact, the trigger did not fire a second time
    expect(copy.prepare("SELECT typeof(r) AS t FROM t WHERE id = 2").get()).toEqual({ t: "real" });
    const big = copy.prepare("SELECT n FROM t WHERE id = 1");
    big.setReadBigInts(true);
    expect(big.get()).toEqual({ n: 9007199254740993n });
    expect(copy.prepare("SELECT count(*) AS c FROM log").get()).toEqual({ c: 2 });
    expect(copy.prepare("SELECT seq FROM sqlite_sequence WHERE name = 't'").get()).toEqual({ seq: 3 });
    // rowids kept even for tables with no INTEGER PRIMARY KEY: 'log' was emptied and refilled, its rowids are 4 and 5
    expect(copy.prepare("SELECT rowid AS r FROM log ORDER BY rowid").all()).toEqual(db.prepare("SELECT rowid AS r FROM log ORDER BY rowid").all());
    expect(copy.prepare("PRAGMA integrity_check").get()).toEqual({ integrity_check: "ok" });
  });

  it("[LDB-CV14] a row too big for D1's 100 KB statement limit fails in the dump, by table, not half-way through an import", () => {
    const db = new DatabaseSync(":memory:");
    db.exec("CREATE TABLE big (id INTEGER PRIMARY KEY, v TEXT)");
    db.prepare("INSERT INTO big VALUES (1, ?)").run("x".repeat(120_000));
    expect(() => dumpToSql(db)).toThrow(/row of big is \d+ bytes/);
  });

  it("[LDB-CV14] literals: exact integers, reals stay reals, text quotes double, blobs are hex, NaN is refused", () => {
    expect(literal(12345678901234567890n)).toBe("12345678901234567890");
    expect(literal(2)).toBe("2.0");
    expect(literal(0.5)).toBe("0.5");
    expect(literal("a'b")).toBe("'a''b'");
    expect(literal(new Uint8Array([0, 171]))).toBe("X'00ab'");
    expect(literal(null)).toBe("NULL");
    expect(() => literal(Number.NaN)).toThrow();
  });

  it("[LDB-CV14] the sanity checks name an incomplete d1_migrations, an unknown migration and a missing table", () => {
    const db = new DatabaseSync(":memory:");
    db.exec("CREATE TABLE d1_migrations (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT UNIQUE, applied_at TIMESTAMP NOT NULL); INSERT INTO d1_migrations (name, applied_at) VALUES ('0001_a.sql', 'x'), ('0099_zzz.sql', 'x')");
    const r = sanityChecks(db, { migrationNames: ["0001_a.sql", "0002_b.sql"], expectedTables: ["d1_migrations", "layouts"] });
    expect(r.ok).toBe(false);
    const by = Object.fromEntries(r.checks.map((c: { name: string; ok: boolean; detail: string }) => [c.name, c]));
    expect(by.integrity_check.ok).toBe(true);
    expect(by.tables_present.detail).toContain("layouts");
    expect(by.d1_migrations_complete.detail).toMatch(/pending \[0002_b\.sql\].*unknown to this bundle \[0099_zzz\.sql\]/);
    expect(sanityChecks(db, { migrationNames: ["0001_a.sql", "0099_zzz.sql"], expectedTables: ["d1_migrations"] }).ok).toBe(true);
    expect(sanityChecks(db, { migrationNames: ["0001_a.sql", "0002_b.sql", "0099_zzz.sql"], allowPending: true }).ok).toBe(true);
  });
});

describe("the loader (CV21)", () => {
  it("[LDB-CV21] the statement splitter respects quotes, comments, identifiers and trigger bodies (CASE ... END included)", () => {
    const sql = `-- header; with a semicolon
PRAGMA defer_foreign_keys=TRUE;
CREATE TABLE "a;b" (x TEXT, "y;z" INTEGER); /* block; comment */
INSERT INTO "a;b" VALUES('it''s; here -- not a comment', 1);
INSERT INTO "a;b" VALUES('line
break;', 2);
CREATE TRIGGER t1 AFTER INSERT ON "a;b"
BEGIN
  UPDATE "a;b" SET x = CASE WHEN NEW.y > 1 THEN 'big;' ELSE 'small' END WHERE y = NEW.y;
  INSERT INTO log VALUES (1);
END;
CREATE INDEX i ON "a;b"(x);
DELETE FROM sqlite_sequence;`;
    const parts = splitStatements(sql);
    expect(parts.map((p: string) => p.split(/\s/)[0])).toEqual(["PRAGMA", "CREATE", "INSERT", "INSERT", "CREATE", "CREATE", "DELETE"]);
    expect(parts[3]).toBe("INSERT INTO \"a;b\" VALUES('line\nbreak;', 2)");
    expect(parts[4]).toMatch(/^CREATE TRIGGER t1[\s\S]*THEN 'big;' ELSE 'small' END WHERE y = NEW\.y;\s+INSERT INTO log VALUES \(1\);\s+END$/);
    // every real migration, split and re-run statement by statement, builds the same schema as running it whole
    const fs = require("node:fs");
    const path = require("node:path");
    const dir = path.resolve(__dirname, "..", "..", "migrations");
    const a = new DatabaseSync(":memory:");
    const b = new DatabaseSync(":memory:");
    for (const f of fs.readdirSync(dir).filter((n: string) => n.endsWith(".sql")).sort()) {
      const text = fs.readFileSync(path.join(dir, f), "utf8");
      a.exec(text);
      for (const st of splitStatements(text)) b.exec(st);
    }
    const dump = (db: DatabaseSync) => db.prepare("SELECT type, name, sql FROM sqlite_master ORDER BY type, name").all().map((r: any) => `${r.type}|${r.name}|${String(r.sql).replace(/\s+/g, " ")}`);
    expect(dump(b)).toEqual(dump(a));
    expect(dump(a).some((l: string) => l.startsWith("trigger|"))).toBe(true);
  });

  it("[LDB-CV21] triggers are created after the data: an export that lists them first would double the head counters in the naive order, and does not in the loader", async () => {
    // D1's export emits CREATE TRIGGER in schema order, i.e. BEFORE the INSERTs of a table created earlier.
    const exportSql = `PRAGMA defer_foreign_keys=TRUE;
CREATE TABLE authors_head (id INTEGER PRIMARY KEY, version INTEGER NOT NULL);
CREATE TABLE authors (user_id TEXT PRIMARY KEY, name TEXT NOT NULL);
CREATE TRIGGER authors_head_on_insert AFTER INSERT ON authors
BEGIN
  UPDATE authors_head SET version = version + 1 WHERE id = 1;
END;
INSERT INTO authors_head VALUES(1,3);
INSERT INTO authors VALUES('u1','ada');
INSERT INTO authors VALUES('u2','grace');
INSERT INTO authors VALUES('u3','linus');
`;
    const naive = new DatabaseSync(":memory:");
    naive.exec(exportSql);
    expect(naive.prepare("SELECT version FROM authors_head").get()).toEqual({ version: 6 }); // the trigger fired on the load: 3 + 3
    const loaded = loadExportSql(exportSql);
    expect(loaded.prepare("SELECT version FROM authors_head").get()).toEqual({ version: 3 }); // D1's value
    expect(loaded.prepare("SELECT count(*) AS n FROM sqlite_master WHERE type = 'trigger'").get()).toEqual({ n: 1 });
    // ... and the proof sees exactly the difference the naive order makes
    const want = await proveAll({ select: localSelect(loaded), db: loaded });
    const got = await proveAll({ select: localSelect(naive), db: naive });
    expect(compareProofs(want, got, { left: "d1", right: "naive" }).diffs).toEqual([expect.objectContaining({ table: "authors_head", field: "checksum" })]);
    // the trigger works after the load
    loaded.exec("INSERT INTO authors VALUES('u4','x')");
    expect(loaded.prepare("SELECT version FROM authors_head").get()).toEqual({ version: 4 });
  });
});

describe("proof over a remote database with few calls (CV22)", () => {
  function big(): DatabaseSync {
    const db = new DatabaseSync(":memory:");
    db.exec("CREATE TABLE events (seq INTEGER PRIMARY KEY AUTOINCREMENT, kind TEXT, body TEXT); CREATE TABLE small (a TEXT PRIMARY KEY, b); CREATE TABLE empty (x); CREATE TABLE rev (id INTEGER PRIMARY KEY, p TEXT)");
    const ev = db.prepare("INSERT INTO events (kind, body) VALUES (?, ?)");
    for (let i = 0; i < 2500; i++) ev.run(i % 3 === 0 ? "created" : "updated", `row ${i} ${"x".repeat(i % 40)}`);
    const rv = db.prepare("INSERT INTO rev (p) VALUES (?)");
    for (let i = 0; i < 700; i++) rv.run("p".repeat(2000 + (i % 7)));
    db.exec("INSERT INTO small VALUES ('a', 1), ('b', x'00'), ('c', 2.5)");
    return db;
  }

  it("[LDB-CV22] one count query, one call for all the small tables, the big ones paged by row width, and the same proof as the plain walk", async () => {
    const db = big();
    const want = await proveAll({ select: localSelect(db), db });
    const stats: { calls?: number; log?: string[] } = {};
    const sent: string[] = [];
    const select = async (sql: string) => (sent.push(sql), asD1(db)(sql));
    const selectMany = async (sqls: string[]) => (sent.push(...sqls.map((s) => `MANY ${s}`)), sqls.map((s) => asD1(db)(s)));
    const got = await proveAllBatched({ select, selectMany, db, pageRows: 100, targetPageBytes: 100_000, smallRows: 50, concurrency: 3, stats });
    expect(compareProofs(want, got).ok).toBe(true);
    // 1 count + 1 batch of the 3 small tables (small, empty, sqlite_sequence) + pages of events and rev (rev: ~2 KB rows, so ~50 rows a page)
    expect(sent.filter((s) => s.includes("count(*) AS n FROM") && s.includes("UNION ALL"))).toHaveLength(1); // the count query names every table
    expect(sent.filter((s) => s.startsWith("MANY"))).toHaveLength(3);
    expect(stats.log![0]).toBe("counts: 1");
    expect(stats.log![1]).toBe("3 small tables: 1");
    expect(stats.calls).toBe(1 + 1 + stats.log!.slice(2).reduce((n, l) => n + Number(l.split(": ")[1]), 0));
    // far fewer calls than one per 100 rows: the page size followed the row width (events rows ~50 B, rev rows ~2 KB)
    expect(stats.calls!).toBeLessThan(2 + Math.ceil(2500 / 100) + Math.ceil(700 / 50));
  });

  it("[LDB-CV22] a write that races the proof (rows appear between the count and the read) is an error", async () => {
    const db = big();
    let first = true;
    const select = async (sql: string) => {
      const r = asD1(db)(sql);
      if (first && sql.includes("UNION ALL")) {
        first = false;
        db.exec("INSERT INTO events (kind, body) VALUES ('late', 'x')");
      }
      return r;
    };
    await expect(proveAllBatched({ select, db, pageRows: 100, smallRows: 50 })).rejects.toThrow(/COUNT\(\*\) says 2500 but 2501 rows/);
  });
});
