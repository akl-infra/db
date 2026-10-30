// [LDB-W2] Every D1 statement goes through the storage port (design/aws-port.md
// §4.1, the P1 gate in design/p1-briefs.md). Outside src/store/d1/, nothing
// calls `.prepare(` or `.batch(`, in source or in tests -- except the D1 test
// inspector and the tests that exist to test D1 itself: migrations, query
// plans, round-trip counts, and atomic rollbacks proven with D1 trigger fault
// injection. The list is exact both ways, so a new raw-SQL test fails, and so
// does an entry left behind after a test stops needing D1 (design/
// p1-briefs.md "Carried to P2": several of these get DynamoDB equivalents).
// Comment lines are ignored.
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const DB_ROOT = path.resolve(import.meta.dirname, "..", "..");
const SQL_CALL = /\.prepare\(|\.batch\(/;

const D1_ONLY = [
  "tests/api/authors-count.test.ts",
  "tests/api/authors-validator-d1.test.ts",
  "tests/api/changes-longpoll-d1.test.ts",
  "tests/api/l8-roundtrips.test.ts",
  "tests/api/list-plan.test.ts",
  "tests/api/me-d1.test.ts",
  "tests/api/mf-l2-unlike-race.test.ts",
  "tests/api/migration-0016.test.ts",
  "tests/api/migration-0017.test.ts",
  "tests/api/moderation-reopen-d1.test.ts",
  "tests/api/p1-a-equivalence.test.ts",
  "tests/auth/modqueue-migration-d1.test.ts",
  "tests/auth/rejection-dm-d1.test.ts",
  "tests/harness/d1.ts",
  // Lane T: the mirror's observed D1 handle wraps prepare/batch itself, and its test drives D1 directly.
  "src/mirror/observe-d1.ts",
  "tests/mirror/recorder.test.ts",
  // Lane Z: the reverse mirror's D1 queue table (migrations/0037) and its D1-side test.
  "src/mirror/kv-d1.ts",
  "tests/mirror/reverse.test.ts",
];

// Tests that check DynamoDB code against real SQLite semantics through `node:sqlite` (an oracle, not D1): they call
// `.prepare(` on their own in-memory database, run on the ddb project, and are NOT in D1_ONLY (vitest.config.ts excludes
// D1_ONLY from the ddb project). Exact both ways too, and each must import node:sqlite and never the D1 harness.
const SQLITE_ORACLE = [
  "tests/ddb/catalog-order.test.ts",
];

function walk(dir: string): string[] {
  if (!fs.existsSync(dir)) return [];
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(full));
    else if (/\.(ts|mjs)$/.test(entry.name)) out.push(full);
  }
  return out;
}

function callsSql(file: string): boolean {
  return fs
    .readFileSync(file, "utf8")
    .split("\n")
    .some((line) => {
      const code = line.trimStart();
      if (code.startsWith("//") || code.startsWith("*") || code.startsWith("/*")) return false;
      return SQL_CALL.test(code.replace(/\/\/.*$/, ""));
    });
}

describe("storage port boundary", () => {
  it("[LDB-W2] no .prepare(/.batch( outside src/store/d1/, except the exact D1-only list", () => {
    const files = [...walk(path.join(DB_ROOT, "src")), ...walk(path.join(DB_ROOT, "tests"))].map((f) => path.relative(DB_ROOT, f));
    expect(files.length).toBeGreaterThan(0);
    const hits = files
      .filter((f) => !f.startsWith(`src${path.sep}store${path.sep}d1${path.sep}`))
      .filter((f) => f !== path.join("tests", "tools", "sql-boundary.test.ts"))
      .filter((f) => callsSql(path.join(DB_ROOT, f)))
      .sort();
    expect(hits).toEqual([...D1_ONLY, ...SQLITE_ORACLE].sort());
    for (const f of SQLITE_ORACLE) {
      const src = fs.readFileSync(path.join(DB_ROOT, f), "utf8");
      expect(src, `${f} is a SQLite oracle`).toMatch(/["']node:sqlite["']/);
      expect(src, `${f} must not use the D1 harness`).not.toMatch(/harness\/d1/);
    }
  });
});
