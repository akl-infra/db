// [LDB-G15] docs/decisions/21-formats.md D8, amended 2026-09-14 (saltorbit:
// "we can't lose data anymore - people may start making edits"): the
// standing "layoutdb is disposable" rule is retired. Every migration under
// `migrations/` from here on is additive -- no `DROP TABLE`, no `DELETE
// FROM`, no `TRUNCATE`, no `DROP COLUMN`, and never a `CREATE TABLE events`
// recreating the log. Rewriting a stored row's own payload in place (an
// `UPDATE ... SET payload_json = ...`, as `0016_no_board.sql` and
// `0017_magic_emit.sql` did) is unaffected -- it changes what a row holds,
// never whether a table or a row exists.
//
// `0001_init.sql`, `0009_formats.sql` and `0010_v2_cleanup.sql` predate the
// 2026-09-14 rule and legitimately contain one of the retired statements
// (the schema's first `CREATE TABLE events`, the D8 wipe-and-rebuild that
// dropped and recreated `events`/`layout_revs`/`layouts` and emptied three
// more tables, and the webhook subsystem's `DROP TABLE webhooks` --
// LEDGER.md L4) -- they are the one, closed allowlist this test exempts.
// The allowlist is checked from both directions: every OTHER file must be
// clean, and every allowlisted file must still exist AND still actually
// trip one of the patterns below, so a future edit can't quietly widen the
// exemption or leave a stale entry once a file is rewritten clean.
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const DB_ROOT = path.resolve(import.meta.dirname, "..", "..");
const MIGRATIONS_DIR = path.join(DB_ROOT, "migrations");

const ALLOWLIST = new Set(["0001_init.sql", "0009_formats.sql", "0010_v2_cleanup.sql"]);

// Case-insensitive; `-- ...` line comments are stripped first so a
// migration's own prose (this file's header above quotes several) can
// mention "DROP TABLE" without tripping the scan.
const FORBIDDEN: { name: string; pattern: RegExp }[] = [
  { name: "DROP TABLE", pattern: /\bDROP\s+TABLE\b/i },
  { name: "DELETE FROM", pattern: /\bDELETE\s+FROM\b/i },
  { name: "TRUNCATE", pattern: /\bTRUNCATE\b/i },
  { name: "DROP COLUMN", pattern: /\bDROP\s+COLUMN\b/i },
  { name: "CREATE TABLE events", pattern: /\bCREATE\s+TABLE\s+events\b/i },
];

function stripSqlComments(sql: string): string {
  return sql
    .split("\n")
    .map((line) => line.replace(/--.*$/, ""))
    .join("\n");
}

function migrationFiles(): string[] {
  return fs
    .readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith(".sql"))
    .sort();
}

function violationsIn(file: string): string[] {
  const sql = stripSqlComments(fs.readFileSync(path.join(MIGRATIONS_DIR, file), "utf8"));
  return FORBIDDEN.filter((f) => f.pattern.test(sql)).map((f) => f.name);
}

describe("[LDB-G15] migrations are additive from here on (docs/decisions/21-formats.md D8, 2026-09-14)", () => {
  it("[LDB-G15] no migration outside the closed allowlist drops a table, deletes/truncates rows, drops a column, or recreates `events`", () => {
    const files = migrationFiles();
    expect(files.length).toBeGreaterThan(0);

    const offenders: string[] = [];
    for (const file of files) {
      if (ALLOWLIST.has(file)) continue;
      const violations = violationsIn(file);
      if (violations.length > 0) offenders.push(`${file}: ${violations.join(", ")}`);
    }
    expect(offenders, "a migration outside the allowlist contains a retired, non-additive statement").toEqual([]);
  });

  it("[LDB-G15] every allowlisted file still exists (the allowlist can't rot into naming a deleted file)", () => {
    const files = new Set(migrationFiles());
    const missing = [...ALLOWLIST].filter((f) => !files.has(f));
    expect(missing, "allowlisted migration file(s) no longer exist -- shrink the allowlist").toEqual([]);
  });

  it("[LDB-G15] every allowlisted file is a genuine offender (no stale exemption for a file that's since gone clean)", () => {
    const files = new Set(migrationFiles());
    const stale: string[] = [];
    for (const file of ALLOWLIST) {
      if (!files.has(file)) continue; // reported by the previous case
      if (violationsIn(file).length === 0) stale.push(file);
    }
    expect(stale, "allowlisted migration file(s) no longer trip any forbidden pattern -- remove them from the allowlist").toEqual([]);
  });
});
