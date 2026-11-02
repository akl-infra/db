// [LDB-SH9] no nondeterministic SQL in src/ or migrations/: replicas replay
// statements, so random(), randomblob(), CURRENT_TIMESTAMP/DATE/TIME and
// 'now' in date/time functions are forbidden (timestamps and ids are JS
// parameters). Scans the SQL string literals of src/**/*.ts and migrations/*.sql.
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { looksLikeSql, scanLiterals, walkFiles } from "./literals";
import { nondeterminism, stripSqlComments } from "./lint";
import { ROOT } from "./support";

describe("deterministic SQL", () => {
  it("[LDB-SH9] the lint catches each forbidden construct (and leaves the deterministic ones alone)", () => {
    const bad = [
      "SELECT random()",
      "SELECT 1 ORDER BY RANDOM ()",
      "SELECT randomblob(16)",
      "INSERT INTO t (at) VALUES (CURRENT_TIMESTAMP)",
      "SELECT current_date",
      "SELECT CURRENT_TIME",
      "SELECT datetime('now')",
      "SELECT strftime('%s', 'now')",
      "SELECT julianday( 'now' , 'localtime')",
      "SELECT unixepoch('now')",
      "SELECT date('now', '-1 day')",
      "SELECT time('now')",
      "SELECT sqlite_version()",
    ];
    for (const sql of bad) expect(nondeterminism(sql), sql).not.toEqual([]);
    const good = [
      "SELECT datetime(?, '+1 day')",
      "SELECT strftime('%s', at) FROM events",
      "SELECT last_insert_rowid(), changes()",
      "SELECT substr(name, 1, 3) FROM layouts WHERE at < ?",
      "SELECT 'now' AS word",
      "SELECT date(at) FROM events",
      "SELECT * FROM operand WHERE x = 1", // the identifier `operand` contains no random()
    ];
    for (const sql of good) expect(nondeterminism(sql), sql).toEqual([]);
    expect(stripSqlComments("SELECT 1 -- datetime('now')\n/* random() */ , 2")).not.toMatch(/now|random/);
    expect(stripSqlComments("SELECT '-- not a comment', \"x\"")).toContain("'-- not a comment'");
  });

  it("[LDB-SH9] no SQL string literal in src/ is nondeterministic", () => {
    const hits: string[] = [];
    let scanned = 0;
    for (const f of walkFiles(path.join(ROOT, "src"), /\.ts$/)) {
      for (const lit of scanLiterals(fs.readFileSync(f, "utf8"))) {
        if (!looksLikeSql(lit.text)) continue;
        scanned++;
        for (const name of nondeterminism(lit.text)) hits.push(`${path.relative(ROOT, f)}:${lit.line}: ${name}`);
      }
    }
    expect(scanned).toBeGreaterThan(200); // the scan sees the store's SQL
    expect(hits).toEqual([]);
  });

  it("[LDB-SH9] no migrations/*.sql statement is nondeterministic", () => {
    const hits: string[] = [];
    const dir = path.join(ROOT, "migrations");
    const files = fs.readdirSync(dir).filter((f) => f.endsWith(".sql"));
    expect(files.length).toBeGreaterThanOrEqual(37);
    for (const f of files) {
      for (const name of nondeterminism(stripSqlComments(fs.readFileSync(path.join(dir, f), "utf8")))) hits.push(`${f}: ${name}`);
    }
    expect(hits).toEqual([]);
  });
});
