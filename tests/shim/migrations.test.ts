// [LDB-SH10] migrations travel as log entries (one per migrations/*.sql, in
// filename order), are recorded in d1_migrations with the entry's own
// timestamp, and the files stay plain D1 SQL.
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { MemoryLog } from "../../src/replica/log-memory";
import { applyMigrations, readMigrationFiles, sqlTimestamp } from "../../src/replica/migrations";
import { Replica } from "../../src/replica/replica";
import { stripSqlComments } from "./lint";
import { FAST, MIGRATIONS_DIR, replicaOf, shimOf } from "./support";

const T0 = new Date("2026-11-02T10:11:12.999Z");

describe("migrations as log entries", () => {
  it("[LDB-SH10] applying migrations appends one 'migration' entry per file, in filename order, carrying the file's SQL byte for byte", async () => {
    const log = new MemoryLog();
    const applied = await applyMigrations(new Replica(log, FAST), MIGRATIONS_DIR, () => T0);
    const files = readMigrationFiles(MIGRATIONS_DIR);
    expect(files.length).toBeGreaterThanOrEqual(37);
    expect(files.map((f) => f.name)).toEqual([...files.map((f) => f.name)].sort());
    expect(applied).toEqual(files.map((f) => f.name));
    const entries = log.entries();
    expect(entries.map((e) => e.kind)).toEqual(files.map(() => "migration"));
    expect(entries.map((e) => e.name)).toEqual(files.map((f) => f.name));
    entries.forEach((e, i) => {
      expect(e.stmts).toEqual([{ sql: files[i]!.sql, params: [] }]);
      expect(e.stmts[0]!.sql).toBe(fs.readFileSync(path.join(MIGRATIONS_DIR, files[i]!.name), "utf8"));
      expect(e.hash).toBe(createHash("sha256").update(files[i]!.sql).digest("hex"));
      expect(e.at).toBe("2026-11-02 10:11:12");
    });
  });

  it("[LDB-SH10] d1_migrations has wrangler's columns and rows, and applied_at is the entry's timestamp on every replica, never the replica's clock", async () => {
    const log = new MemoryLog();
    await applyMigrations(new Replica(log, FAST), MIGRATIONS_DIR, () => T0);
    const files = readMigrationFiles(MIGRATIONS_DIR);
    // A replica built a "day later" still carries the entry's time.
    const later = await replicaOf(log);
    const rows = await shimOf(later).prepare("SELECT id, name, applied_at FROM d1_migrations ORDER BY id").all<{ id: number; name: string; applied_at: string }>();
    expect(rows.results.map((r) => r.name)).toEqual(files.map((f) => f.name));
    expect(rows.results.map((r) => r.id)).toEqual(files.map((_, i) => i + 1));
    expect(new Set(rows.results.map((r) => r.applied_at))).toEqual(new Set(["2026-11-02 10:11:12"]));
    expect(sqlTimestamp(T0)).toBe("2026-11-02 10:11:12");
    expect(await later.appliedMigrations()).toEqual(files.map((f) => f.name));
  });

  it("[LDB-SH10] two replicas replaying the same entries are byte-identical, d1_migrations included", async () => {
    const log = new MemoryLog();
    const writer = new Replica(log, FAST);
    await applyMigrations(writer, MIGRATIONS_DIR, () => T0);
    const replay = await replicaOf(log);
    expect(Buffer.from(replay.serialize()).equals(Buffer.from(writer.serialize()))).toBe(true);
  });

  it("[LDB-SH10] applying twice, or from two replicas racing, appends each file exactly once", async () => {
    const log = new MemoryLog({ maxYields: 3, seed: 3 });
    const a = new Replica(log, FAST);
    const b = new Replica(log, FAST);
    const [ra, rb] = await Promise.all([applyMigrations(a, MIGRATIONS_DIR, () => T0), applyMigrations(b, MIGRATIONS_DIR, () => T0)]);
    const files = readMigrationFiles(MIGRATIONS_DIR);
    expect(ra.length + rb.length).toBe(files.length); // each file applied by exactly one of them
    expect(log.length).toBe(files.length);
    expect(await applyMigrations(a, MIGRATIONS_DIR, () => T0)).toEqual([]);
    await a.catchUp();
    await b.catchUp();
    expect(Buffer.from(a.serialize()).equals(Buffer.from(b.serialize()))).toBe(true);
  });

  it("[LDB-SH10] a migration that fails is rolled back and never reaches the log", async () => {
    const log = new MemoryLog();
    const r = new Replica(log, FAST);
    await r.applyMigration({ name: "0001_ok.sql", sql: "CREATE TABLE ok (a);", at: "2026-11-02 00:00:00" });
    await expect(r.applyMigration({ name: "0002_bad.sql", sql: "CREATE TABLE half (a); CREATE TABLE ok (a);", at: "2026-11-02 00:00:00" })).rejects.toThrow(/already exists/);
    expect(log.length).toBe(1);
    expect(r.db.prepare("SELECT name FROM sqlite_master WHERE name = 'half'").get()).toBeUndefined();
    expect(await r.appliedMigrations()).toEqual(["0001_ok.sql"]);
  });

  it("[LDB-SH10] every table after all migrations has a declared PRIMARY KEY (a future migration without one fails here, and then needs sessions-independent review)", async () => {
    const log = new MemoryLog();
    const r = new Replica(log, FAST);
    await applyMigrations(r, MIGRATIONS_DIR, () => T0);
    const rows = r.db
      .prepare("SELECT m.name FROM sqlite_master m WHERE m.type = 'table' AND m.name NOT LIKE 'sqlite_%' AND (SELECT COUNT(*) FROM pragma_table_info(m.name) WHERE pk > 0) = 0")
      .all();
    expect(rows).toEqual([]);
  });

  it("[LDB-SH10] the migration files stay plain D1 SQL: no transaction control, no PRAGMA, no ATTACH, none edited for the shim", () => {
    for (const f of readMigrationFiles(MIGRATIONS_DIR)) {
      const sql = stripSqlComments(f.sql);
      // A trigger body's BEGIN is followed by a statement; transaction control is BEGIN/COMMIT/END as a statement of its own.
      expect(sql, f.name).not.toMatch(/(?:^|;)\s*(?:BEGIN\s*(?:DEFERRED|IMMEDIATE|EXCLUSIVE)?\s*(?:TRANSACTION)?\s*;|COMMIT\b|ROLLBACK\b|SAVEPOINT\b|RELEASE\b|PRAGMA\b|ATTACH\b|DETACH\b|VACUUM\b)/i);
    }
    // The workers project hands the same files to wrangler's migration reader: the names are the files' names.
    expect(readMigrationFiles(MIGRATIONS_DIR).map((f) => f.name)).toEqual(fs.readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith(".sql")).sort());
  });
});
