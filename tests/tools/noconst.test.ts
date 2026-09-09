// [LDB-G2] No admin id is a constant in code. Discord snowflakes are
// 17-19 digit numbers; a bare numeric literal that size in db/src is
// either a hardcoded id (the bug this guards against) or a silent
// precision-loss bug (snowflakes exceed Number.MAX_SAFE_INTEGER). Ids
// belong in the `admins` table (migrations/, exempt -- it's data, not
// code) or in test fixtures (tests/fixtures/, exempt).
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const DB_ROOT = path.resolve(import.meta.dirname, "..", "..");
const SRC = path.join(DB_ROOT, "src");

function walk(dir: string): string[] {
  if (!fs.existsSync(dir)) return [];
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(full));
    else out.push(full);
  }
  return out;
}

// A 17-19 digit run not immediately wrapped in quotes -- a bare numeric
// literal, not a quoted id string (those are fine: ids are TEXT columns).
const SNOWFLAKE_LITERAL = /(?<!['"`])\b\d{17,19}\b(?!['"`])/g;

describe("no hardcoded Discord ids in db/src", () => {
  it("[LDB-G2] has no 17-19-digit numeric literal", () => {
    const files = walk(SRC);
    expect(files.length).toBeGreaterThan(0);

    const violations: string[] = [];
    for (const file of files) {
      const source = fs.readFileSync(file, "utf8");
      for (const m of source.matchAll(SNOWFLAKE_LITERAL)) {
        const line = source.slice(0, m.index).split("\n").length;
        violations.push(`${path.relative(DB_ROOT, file)}:${line}: ${m[0]}`);
      }
    }
    expect(violations).toEqual([]);
  });
});
