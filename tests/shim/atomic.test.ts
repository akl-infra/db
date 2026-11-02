// [LDB-SH3] a commit unit is atomic and is the replication unit: a failing
// batch (or statement) leaves no trace, locally or in the log; a successful
// one is exactly one log entry; reads and no-op writes never append.
import { beforeEach, describe, expect, it } from "vitest";
import type { MemoryLog } from "../../src/replica/log-memory";
import type { Replica } from "../../src/replica/replica";
import { createCounter, freshReplica, replicaOf, shimOf } from "./support";

let log: MemoryLog;
let replica: Replica;
let db: D1Database;

beforeEach(async () => {
  ({ log, replica } = await freshReplica());
  db = shimOf(replica);
  await db.exec("CREATE TABLE t (id INTEGER PRIMARY KEY AUTOINCREMENT, a TEXT UNIQUE)");
});

const count = async (d: D1Database = db) => (await d.prepare("SELECT COUNT(*) AS n FROM t").first<{ n: number }>())!.n;

describe("commit units", () => {
  it("[LDB-SH3] a failing batch leaves no trace locally, in the log, or on another replica", async () => {
    const before = log.length;
    const seq = replica.seq;
    await expect(db.batch([db.prepare("INSERT INTO t (a) VALUES ('x')"), db.prepare("INSERT INTO t (a) VALUES ('y')"), db.prepare("INSERT INTO t (a) VALUES ('x')")])).rejects.toThrow(/UNIQUE constraint failed: t\.a/);
    expect(await count()).toBe(0);
    expect(log.length).toBe(before);
    expect(replica.seq).toBe(seq);
    const other = await replicaOf(log);
    expect(await count(shimOf(other))).toBe(0);
    // AUTOINCREMENT did not advance either: the rolled-back inserts never happened.
    await db.prepare("INSERT INTO t (a) VALUES ('z')").run();
    expect((await db.prepare("SELECT id FROM t").first<{ id: number }>())!.id).toBe(1);
  });

  it("[LDB-SH3] a single statement that fails half way (a multi-row INSERT) changes nothing", async () => {
    await db.prepare("INSERT INTO t (a) VALUES ('x')").run();
    const before = log.length;
    await expect(db.prepare("INSERT INTO t (a) VALUES ('p'), ('x')").run()).rejects.toThrow(/UNIQUE/);
    expect(await count()).toBe(1);
    expect(log.length).toBe(before);
  });

  it("[LDB-SH3] a trigger's RAISE(ABORT) in the third statement rolls the whole batch back", async () => {
    await db.exec("CREATE TRIGGER t_stop BEFORE INSERT ON t WHEN NEW.a = 'stop' BEGIN SELECT RAISE(ABORT, 'stopped'); END;");
    const before = log.length;
    await expect(db.batch([db.prepare("INSERT INTO t (a) VALUES ('1')"), db.prepare("INSERT INTO t (a) VALUES ('2')"), db.prepare("INSERT INTO t (a) VALUES ('stop')")])).rejects.toThrow(/stopped/);
    expect(await count()).toBe(0);
    expect(log.length).toBe(before);
  });

  it("[LDB-SH3] a successful batch is exactly one log entry carrying its statements and parameters in order", async () => {
    const before = log.length;
    await db.batch([db.prepare("INSERT INTO t (a) VALUES (?)").bind("one"), db.prepare("INSERT INTO t (a) VALUES (?)").bind("two"), db.prepare("DELETE FROM t WHERE a = ?").bind("one")]);
    expect(log.length).toBe(before + 1);
    const entry = log.entries().at(-1)!;
    expect(entry.kind).toBe("unit");
    expect(entry.stmts).toEqual([
      { sql: "INSERT INTO t (a) VALUES (?)", params: ["one"] },
      { sql: "INSERT INTO t (a) VALUES (?)", params: ["two"] },
      { sql: "DELETE FROM t WHERE a = ?", params: ["one"] },
    ]);
    expect(entry.hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("[LDB-SH3] a `changes() = 1` guard chain inside a batch behaves as on D1 and replicates", async () => {
    await createCounter(db);
    const run = (rev: number) =>
      db.batch([
        db.prepare("UPDATE ctr SET n = n + 10, rev = rev + 1 WHERE id = 1 AND rev = ?").bind(rev),
        db.prepare("INSERT INTO t (a) SELECT ? WHERE changes() = 1").bind(`after-rev-${rev}`),
      ]);
    const won = await run(0);
    expect(won.map((r) => r.meta.changes)).toEqual([1, 1]);
    const lost = await run(0); // stale rev: the guard fails, the second statement inserts nothing
    expect(lost.map((r) => r.meta.changes)).toEqual([0, 0]);
    expect(await count()).toBe(1);
    const other = await replicaOf(log);
    expect(Buffer.from(other.serialize()).equals(Buffer.from(replica.serialize()))).toBe(true);
  });

  it("[LDB-SH3] reads and writes that match nothing never append: SELECT, an UPDATE or DELETE matching no row", async () => {
    await db.prepare("INSERT INTO t (a) VALUES ('x')").run();
    const before = log.length;
    await db.prepare("SELECT * FROM t").all();
    await db.prepare("UPDATE t SET a = 'nope' WHERE id = 99").run();
    await db.batch([db.prepare("SELECT 1"), db.prepare("DELETE FROM t WHERE id = 99")]);
    expect(log.length).toBe(before);
    expect(replica.stats.noOps).toBeGreaterThanOrEqual(2);
  });

  it("[LDB-SH3] change detection is total_changes(), not the session: a table WITHOUT a primary key (invisible to sessions) is logged and replicates", async () => {
    await db.exec("CREATE TABLE nopk (a TEXT, b INTEGER)");
    const before = log.length;
    await db.prepare("INSERT INTO nopk (a, b) VALUES ('x', 1)").run();
    await db.prepare("UPDATE nopk SET b = 2 WHERE a = 'x'").run();
    await db.prepare("UPDATE nopk SET b = 2 WHERE a = 'x'").run(); // same value: a counted change, an empty changeset -- still logged
    expect(log.length).toBe(before + 3);
    const other = shimOf(await replicaOf(log));
    expect(await other.prepare("SELECT a, b FROM nopk").all().then((r) => r.results)).toEqual([{ a: "x", b: 2 }]);
  });

  it("[LDB-SH3] a unit that nets to no row change but advances AUTOINCREMENT is still logged, so every replica's next id matches", async () => {
    await db.batch([db.prepare("INSERT INTO t (a) VALUES ('gone')"), db.prepare("DELETE FROM t WHERE a = 'gone'")]);
    expect(log.entries().at(-1)!.stmts).toHaveLength(2); // logged although the changeset is empty
    const other = shimOf(await replicaOf(log));
    expect((await other.prepare("SELECT seq FROM sqlite_sequence WHERE name = 't'").first<{ seq: number }>())!.seq).toBe(1); // the replica's counter advanced with the writer's
    expect((await db.prepare("INSERT INTO t (a) VALUES ('next') RETURNING id").first<{ id: number }>())!.id).toBe(2);
    expect((await other.prepare("INSERT INTO t (a) VALUES ('later') RETURNING id").first<{ id: number }>())!.id).toBe(3);
  });

  it("[LDB-SH3] schema changes made through prepare().run() are logged too (the changeset sees rows, not DDL)", async () => {
    const before = log.length;
    await db.prepare("CREATE TABLE ddl (a)").run();
    expect(log.length).toBe(before + 1);
    expect((await shimOf(await replicaOf(log)).prepare("SELECT name FROM sqlite_master WHERE name = 'ddl'").first())).toEqual({ name: "ddl" });
  });

  it("[LDB-SH3] two statements of one request-scoped batch never interleave with another request's reads", async () => {
    // The mutex: a reader started while a unit awaits its append must see the state before or after the unit, never inside it.
    const other = shimOf(replica, true);
    const seen: number[] = [];
    const writer = db.batch([db.prepare("INSERT INTO t (a) VALUES ('a')"), db.prepare("INSERT INTO t (a) VALUES ('b')")]);
    const readers = Array.from({ length: 5 }, async () => seen.push((await other.prepare("SELECT COUNT(*) AS n FROM t").first<{ n: number }>())!.n));
    await Promise.all([writer, ...readers]);
    expect(seen.every((n) => n === 0 || n === 2)).toBe(true);
  });
});
