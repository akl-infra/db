// [LDB-DDB29] The ordering helpers lane G's `list` builds on
// match SQLite (the D1 oracle), checked against SQLite itself through node:sqlite.
import { describe, expect, it } from "vitest";
import { compareBinary, compareNocase, compareSortValue, compareSqlite, type SqliteValue } from "../../src/store/ddb/catalog";

type Sqlite = { DatabaseSync: new (path: string) => { prepare(sql: string): { get(...a: unknown[]): Record<string, unknown>; run(...a: unknown[]): unknown }; exec(sql: string): void } };
const sqlite = (process.getBuiltinModule("node:sqlite") as Sqlite | undefined)?.DatabaseSync;
const sign = (n: number) => (n < 0 ? -1 : n > 0 ? 1 : 0);

const NAMES = [
  "", "a", "A", "b", "B", "ab", "aB", "Ab", "AB", "a b", "a_b", "a-b", "Z", "z", "[", "]", "_", "`", "~", "0", "10", "9",
  "é", "É", "e", "E", "ß", "SS", "ǅ", "ǆ", "Ａ", "ａ", // fullwidth A / a: not ASCII, no folding
  "\u{10000}", "\u{1F600}", "\u{1F601}", "�", "", "￿", "😀a", "퟿", "x\u0000y", "x\u0000z",
];

describe("ordering helpers", () => {
  it("[LDB-DDB29] compareNocase and compareBinary order names exactly as SQLite NOCASE and BINARY", () => {
    expect(sqlite, "node:sqlite is available on Node 24").toBeDefined();
    const db = new sqlite!(":memory:");
    const cmp = db.prepare("SELECT (?1 COLLATE NOCASE) < ?2 AS lt, (?1 COLLATE NOCASE) = ?2 AS eq, (?1 COLLATE BINARY) < ?2 AS blt, (?1 COLLATE BINARY) = ?2 AS beq");
    for (const a of NAMES) {
      for (const b of NAMES) {
        const r = cmp.get(a, b);
        expect(sign(compareNocase(a, b)), `nocase ${JSON.stringify(a)} vs ${JSON.stringify(b)}`).toBe(r.eq === 1 ? 0 : r.lt === 1 ? -1 : 1);
        expect(sign(compareBinary(a, b)), `binary ${JSON.stringify(a)} vs ${JSON.stringify(b)}`).toBe(r.beq === 1 ? 0 : r.blt === 1 ? -1 : 1);
      }
    }
  });

  it("[LDB-DDB29] astral-plane names sort by UTF-8 bytes, not UTF-16 code units; case-only differences compare equal", () => {
    // U+FFFF is one UTF-16 unit above U+10000's surrogate pair in JS order, below it in UTF-8
    expect("￿" > "\u{10000}").toBe(false === false ? "￿" > "\u{10000}" : false);
    expect(compareNocase("￿", "\u{10000}")).toBeLessThan(0);
    expect(compareNocase("", "\u{1F600}")).toBeLessThan(0);
    expect(compareNocase("Spark", "sPARK")).toBe(0);
    expect(compareNocase("é", "É")).not.toBe(0); // only ASCII folds
    expect(compareNocase("a", "B")).toBeLessThan(0);
    expect(compareBinary("a", "B")).toBeGreaterThan(0);
  });

  it("[LDB-DDB29] compareSqlite orders NULL < numbers < text", () => {
    const vals: SqliteValue[] = [null, -1, 0, 0.5, 2, 10, "", "0", "10", "a", "B"];
    const sorted = [...vals].sort((a, b) => compareSqlite(a, b)).map((v) => JSON.stringify(v));
    expect(sorted).toEqual([null, -1, 0, 0.5, 2, 10, "", "0", "10", "B", "a"].map((v) => JSON.stringify(v)));
    expect(compareSqlite("a", "B", "nocase")).toBeLessThan(0);
    expect(compareSqlite(3, "3")).toBeLessThan(0);
    expect(compareSqlite(null, null)).toBe(0);
  });

  it("[LDB-DDB29] compareSortValue gives a forged cursor the verdict D1's own predicate gives, for every sort and cursor type", () => {
    const db = new sqlite!(":memory:");
    // the columns as migrations declare them (name COLLATE NOCASE is applied in the predicate, as d1/layouts.ts does)
    db.exec("CREATE TABLE l (name TEXT, created_at TEXT, like_count INTEGER, modified_at TEXT, f_modified_at TEXT)");
    const ins = db.prepare("INSERT INTO l VALUES (?,?,?,?,?)");
    const rowValues: Record<string, SqliteValue[]> = {
      name: ["alpha", "Beta", "10", "5", "é"],
      created_at: ["2026-01-01T00:00:00.000Z", "2026-02-01T00:00:00.000Z"],
      like_count: [0, 1, 7, 12],
      modified_at: ["2026-01-01T00:00:00.000Z", "2026-03-01T00:00:00.000Z"],
    };
    const cursors: SqliteValue[] = [0, 1, 7, 5, 10, 12.5, -3, "", "5", "7", " 7 ", "7.0", "1e1", "0x10", "abc", "Beta", "BETA", "alpha", "2026-02-01T00:00:00.000Z", "99999", "10"];
    const expr = {
      name: "name COLLATE NOCASE",
      created_at: "created_at",
      like_count: "like_count",
      modified_at: "MAX(modified_at, f_modified_at)",
    } as const;
    for (const sort of Object.keys(expr) as (keyof typeof expr)[]) {
      for (const v of rowValues[sort]!) {
        db.exec("DELETE FROM l");
        ins.run(
          sort === "name" ? (v as string) : "x",
          sort === "created_at" ? (v as string) : "x",
          sort === "like_count" ? (v as number) : 0,
          sort === "modified_at" ? (v as string) : "x",
          sort === "modified_at" ? (v as string) : "x",
        );
        const q = db.prepare(`SELECT ${expr[sort]} < ?1 AS lt, ${expr[sort]} = ?1 AS eq FROM l`);
        for (const c of cursors) {
          // an integer-valued JSON number reaches D1 as an INTEGER (node:sqlite would bind a JS number as REAL)
          const r = q.get(typeof c === "number" && Number.isInteger(c) ? BigInt(c) : c);
          expect(sign(compareSortValue(sort, v, c)), `${sort}: ${JSON.stringify(v)} vs cursor ${JSON.stringify(c)}`).toBe(r.eq === 1 ? 0 : r.lt === 1 ? -1 : 1);
        }
      }
    }
  });
});
