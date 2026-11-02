// [LDB-SH9] no nondeterministic SQL in src/ or migrations/: replicas replay
// statements, so random(), randomblob(), CURRENT_TIMESTAMP/DATE/TIME and
// 'now' in date/time functions are forbidden (timestamps and ids are JS
// parameters). Scans the SQL string literals of src/**/*.ts and migrations/*.sql.
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { looksLikeSql, scanLiterals, walkFiles } from "./literals";
import { nondeterminism, stripSqlComments, usesJsonFunctions } from "./lint";
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

// SQLite's JSON functions changed behaviour between the SQLite D1 runs and the one node:sqlite embeds (a JSON subtype no
// longer survives a scalar subquery: migration 0017 double-encodes on node:sqlite 3.54). Runtime SQL has none; migrations
// 0016, 0017 and 0020 do. A migration newer than 0037 that uses one must be listed here with a reason, so the differential
// (miniflare D1 vs the shim) cannot silently hide a subtype difference behind data it never runs the migration over.
const JSON_MIGRATION_ALLOWLIST: [file: string, reason: string][] = [];
const LAST_CHECKED_MIGRATION = 37;

describe("JSON functions in new migrations", () => {
  it("[LDB-SH9] the JSON-function detector catches json(), json_*() calls and ignores words that merely contain json", () => {
    for (const sql of ["SELECT json('{}')", "SELECT json_extract(x, '$.a') FROM t", "UPDATE t SET p = json_set(p, '$.a', 1)", "SELECT JSON_GROUP_ARRAY(a) FROM t", "SELECT x FROM json_each(p)"]) expect(usesJsonFunctions(sql), sql).toBe(true);
    for (const sql of ["SELECT payload_json FROM t", "SELECT has_json FROM t", "CREATE INDEX layout_json ON t(a)", "SELECT 'json' AS k"]) expect(usesJsonFunctions(sql), sql).toBe(false);
  });

  it("[LDB-SH9] a migration newer than 0037 uses no json_* function unless it is allowlisted with a reason", () => {
    const dir = path.join(ROOT, "migrations");
    const allowed = new Map(JSON_MIGRATION_ALLOWLIST);
    const hits: string[] = [];
    for (const f of fs.readdirSync(dir).filter((x) => x.endsWith(".sql")).sort()) {
      const n = Number(/^(\d+)_/.exec(f)?.[1]);
      if (!(n > LAST_CHECKED_MIGRATION)) continue;
      if (usesJsonFunctions(stripSqlComments(fs.readFileSync(path.join(dir, f), "utf8"))) && !allowed.has(f)) hits.push(f);
    }
    expect(hits, "list the migration in JSON_MIGRATION_ALLOWLIST (tests/shim/lint-sql.test.ts) with a reason").toEqual([]);
    for (const [f, reason] of JSON_MIGRATION_ALLOWLIST) {
      expect(fs.existsSync(path.join(dir, f)), f).toBe(true);
      expect(reason.length, `${f} needs a reason`).toBeGreaterThan(10);
    }
    // The three existing JSON migrations are older than the cut and are known: if this list changes, so must the cut.
    const old = fs.readdirSync(dir).filter((f) => Number(/^(\d+)_/.exec(f)?.[1]) <= LAST_CHECKED_MIGRATION && usesJsonFunctions(stripSqlComments(fs.readFileSync(path.join(dir, f), "utf8"))));
    expect(old.map((f) => f.slice(0, 4))).toEqual(["0016", "0017", "0020"]);
  });
});
