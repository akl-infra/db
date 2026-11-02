// [LDB-SH2] error text, meta and result-shape parity with D1. The expected
// values are what miniflare's D1 (the workers project) answers for the same
// statements, measured 2026-11-02 with a throwaway probe test, and what
// D1's documentation describes; each case says which.
import { beforeAll, describe, expect, it } from "vitest";
import { countParams, mapSqliteError, normalizeParam } from "../../src/store/shim/d1";
import { freshReplica, shimOf } from "./support";

let db: D1Database;

async function failure(p: Promise<unknown>): Promise<Error> {
  try {
    await p;
  } catch (e) {
    return e as Error;
  }
  throw new Error("expected a rejection");
}

beforeAll(async () => {
  db = shimOf((await freshReplica()).replica);
  await db.exec("CREATE TABLE zz (id INTEGER PRIMARY KEY AUTOINCREMENT, a)");
});

describe("D1 result shapes", () => {
  it("[LDB-SH2] a SELECT answers { success, meta, results } with D1's meta fields and zero changes", async () => {
    const r = await db.prepare("SELECT 1 AS x").all();
    expect(r.success).toBe(true);
    expect(r.results).toEqual([{ x: 1 }]);
    expect(Object.keys(r.meta).sort()).toEqual(["changed_db", "changes", "duration", "last_row_id", "rows_read", "rows_written", "served_by", "size_after"]);
    expect(r.meta).toMatchObject({ changes: 0, changed_db: false, duration: 0, served_by: "shim" });
    expect(Object.getPrototypeOf(r.results[0])).toBe(Object.prototype); // a plain object, not node:sqlite's null-prototype row
  });

  it("[LDB-SH2] run() of an INSERT: results [], changes 1, last_row_id = the new rowid, changed_db true; a SELECT after it reports changes 0", async () => {
    const ins = await db.prepare("INSERT INTO zz (a) VALUES (?)").bind(1).run();
    expect(ins.results).toEqual([]);
    expect(ins.meta).toMatchObject({ changes: 1, last_row_id: 1, changed_db: true });
    const sel = await db.prepare("SELECT * FROM zz").run();
    expect(sel.results).toEqual([{ id: 1, a: 1 }]); // D1's run() returns the rows of a SELECT too
    expect(sel.meta).toMatchObject({ changes: 0, changed_db: false });
    expect(sel.meta.last_row_id).toBe(1); // D1 reports the connection's last_insert_rowid() for reads as well
  });

  it("[LDB-SH2] an UPDATE that matches nothing: changes 0, changed_db false", async () => {
    const r = await db.prepare("UPDATE zz SET a = 2 WHERE id = 99").run();
    expect(r.meta).toMatchObject({ changes: 0, changed_db: false });
  });

  it("[LDB-SH2] INSERT ... RETURNING through all() and first() returns its rows and counts as a write", async () => {
    const all = await db.prepare("INSERT INTO zz (a) VALUES (7) RETURNING id").all<{ id: number }>();
    expect(all.results).toEqual([{ id: 2 }]);
    expect(all.meta).toMatchObject({ changes: 1, last_row_id: 2, changed_db: true });
    expect(await db.prepare("INSERT INTO zz (a) VALUES (7) RETURNING id").first()).toEqual({ id: 3 });
  });

  it("[LDB-SH2] first() is the first row or null; first(col) is the value, null for no row, and an unknown column throws", async () => {
    expect(await db.prepare("SELECT a, id FROM zz ORDER BY id").first("id")).toBe(1);
    expect(await db.prepare("SELECT a FROM zz WHERE id = 999").first("a")).toBeNull();
    expect(await db.prepare("SELECT a FROM zz WHERE id = 999").first()).toBeNull();
    expect((await failure(db.prepare("SELECT a FROM zz").first("nope"))).message).toMatch(/^D1_ERROR: Column not found/);
  });

  it("[LDB-SH2] raw() answers arrays, with column names first when asked", async () => {
    expect(await db.prepare("SELECT id, a FROM zz WHERE id = 1").raw()).toEqual([[1, 1]]);
    expect(await db.prepare("SELECT id, a FROM zz WHERE id = 1").raw({ columnNames: true })).toEqual([["id", "a"], [1, 1]]);
  });

  it("[LDB-SH2] BLOBs come back as number[]; Uint8Array and ArrayBuffer bind as BLOBs", async () => {
    const r = await db.prepare("SELECT x'01ff' AS b, ? AS c, typeof(?) AS t").bind(new Uint8Array([9, 8]), new Uint8Array([1]).buffer).all();
    expect(r.results).toEqual([{ b: [1, 255], c: [9, 8], t: "blob" }]);
  });

  it("[LDB-SH2] batch() answers one D1Result per statement, in order, and exec() answers { count, duration }", async () => {
    const out = await db.batch([db.prepare("INSERT INTO zz (a) VALUES (1)"), db.prepare("SELECT COUNT(*) AS n FROM zz"), db.prepare("SELECT ? AS v").bind(5)]);
    expect(out.map((r) => r.success)).toEqual([true, true, true]);
    expect(out[0]!.meta.changes).toBe(1);
    expect(out[1]!.results).toEqual([{ n: 4 }]);
    expect(out[2]!.results).toEqual([{ v: 5 }]);
    expect(await db.exec("CREATE TABLE zz2 (a);\nINSERT INTO zz2 VALUES (1);\n")).toEqual({ count: 2, duration: 0 }); // miniflare: { count: 2, duration: 0 }
  });
});

describe("D1 parameter binding", () => {
  it("[LDB-SH2] booleans bind as 1/0; NaN and Infinity bind as NULL", async () => {
    expect(await db.prepare("SELECT ? AS t, ? AS f").bind(true, false).first()).toEqual({ t: 1, f: 0 });
    expect(await db.prepare("SELECT typeof(?) AS a, typeof(?) AS b").bind(NaN, Infinity).first()).toEqual({ a: "null", b: "null" });
  });

  it("[LDB-SH2] every JS number binds as a REAL, like D1 (json_object('x', 3) is {\"x\":3.0})", async () => {
    expect(await db.prepare("SELECT typeof(?) AS a, typeof(?) AS b, json_object('x', ?) AS j").bind(1, 1.5, 3).first()).toEqual({ a: "real", b: "real", j: '{"x":3.0}' });
  });

  it("[LDB-SH2] undefined, bigint, objects and Dates are D1_TYPE_ERROR with D1's words, thrown at bind()", () => {
    const stmt = db.prepare("SELECT ?");
    expect(() => stmt.bind(undefined)).toThrow("D1_TYPE_ERROR: Type 'undefined' not supported for value 'undefined'");
    expect(() => stmt.bind(10n)).toThrow("D1_TYPE_ERROR: Type 'bigint' not supported for value '10'");
    expect(() => stmt.bind({})).toThrow("D1_TYPE_ERROR: Type 'object' not supported for value '[object Object]'");
    expect(() => stmt.bind(new Date(0))).toThrow(new RegExp(`^D1_TYPE_ERROR: Type 'object' not supported for value '${String(new Date(0)).replace(/[()+]/g, "\\$&")}'$`));
    expect(normalizeParam("s")).toBe("s");
  });

  it("[LDB-SH2] the wrong number of bindings is D1_ERROR: Wrong number of parameter bindings for SQL query.", async () => {
    expect((await failure(db.prepare("SELECT ?").run())).message).toBe("D1_ERROR: Wrong number of parameter bindings for SQL query.");
    expect((await failure(db.prepare("SELECT 1").bind(1).run())).message).toBe("D1_ERROR: Wrong number of parameter bindings for SQL query.");
    expect(countParams("SELECT '?', \"?\", `?`, [?] -- ?\n, /* ? */ ?, ?3, ?")).toBe(4); // ? (1), ?3 -> 3, ? -> 4
  });
});

describe("D1 error text", () => {
  it("[LDB-SH2] errors are Error('D1_ERROR: <sqlite text>: SQLITE_<CODE> (extended: ...)') with a cause, as miniflare words them", async () => {
    const syntax = await failure(db.prepare("selec 1").run());
    expect(syntax.message).toBe('D1_ERROR: near "selec": syntax error at offset 0: SQLITE_ERROR');
    expect((syntax.cause as Error).message).toBe('near "selec": syntax error at offset 0: SQLITE_ERROR');
    expect((await failure(db.prepare("SELECT * FROM nonex").all())).message).toBe("D1_ERROR: no such table: nonex: SQLITE_ERROR");
    expect((await failure(db.prepare("INSERT INTO zz (id, a) VALUES (1, 1)").run())).message).toBe(
      "D1_ERROR: UNIQUE constraint failed: zz.id: SQLITE_CONSTRAINT (extended: SQLITE_CONSTRAINT_PRIMARYKEY)",
    );
    expect((await failure(db.prepare("   ").run())).message).toBe("D1_ERROR: No SQL statements detected.");
  });

  it("[LDB-SH2] the messages akldb matches on appear for the real constraints (layouts.name, layout_revs, likes, nonces, discord interactions)", async () => {
    const t = "2026-11-02T00:00:00Z";
    const layout = (id: string, name: string) =>
      db.prepare("INSERT INTO layouts (id, name, owner, n, layout_rev, created_at, modified_at) VALUES (?, ?, 'o', 1, 1, ?, ?)").bind(id, name, t, t).run();
    await layout("L1", "Alpha");
    expect((await failure(layout("L2", "alpha"))).message).toMatch(/UNIQUE constraint failed: layouts\.name/); // COLLATE NOCASE, live-unique
    await db.prepare("INSERT INTO likes (layout_id, user_id, at, via) VALUES ('L1', 'u', ?, 'x')").bind(t).run();
    expect((await failure(db.prepare("INSERT INTO likes (layout_id, user_id, at, via) VALUES ('L1', 'u', ?, 'x')").bind(t).run())).message).toMatch(/UNIQUE constraint failed: likes\./);
    await db.prepare("INSERT INTO nonces (client_id, nonce, at) VALUES ('c', 'n', ?)").bind(t).run();
    expect((await failure(db.prepare("INSERT INTO nonces (client_id, nonce, at) VALUES ('c', 'n', ?)").bind(t).run())).message).toMatch(/UNIQUE constraint failed: nonces/);
    await db.prepare("INSERT INTO layout_revs (layout_id, n, lineage, rev, event_seq, format, payload_json) VALUES ('L1', 1, 'spark', 1, 1, NULL, NULL)").run();
    expect((await failure(db.prepare("INSERT INTO layout_revs (layout_id, n, lineage, rev, event_seq, format, payload_json) VALUES ('L1', 1, 'spark', 1, 2, NULL, NULL)").run())).message).toMatch(/UNIQUE constraint failed: layout_revs\./);
  });

  it("[LDB-SH2] a trigger's RAISE(ABORT, text) keeps its text with the TRIGGER extended code; other errors pass through untouched", async () => {
    await db.exec("CREATE TRIGGER zz_fail BEFORE INSERT ON zz2 WHEN NEW.a = 'boom' BEGIN SELECT RAISE(ABORT, 'test failure'); END;");
    expect((await failure(db.prepare("INSERT INTO zz2 VALUES ('boom')").run())).message).toBe("D1_ERROR: test failure: SQLITE_CONSTRAINT (extended: SQLITE_CONSTRAINT_TRIGGER)");
    const other = new RangeError("not sqlite");
    expect(mapSqliteError(other)).toBe(other);
  });
});
