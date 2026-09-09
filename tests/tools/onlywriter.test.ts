// [LDB-P1] `appendWrite`/`appendLike` in `src/core/events.ts` are the only
// code that writes the `layouts` table (07 §6 S4's DoD clause);
// `records.ts` and everything else only reads it.
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const DB_ROOT = path.resolve(import.meta.dirname, "..", "..");
const SRC = path.join(DB_ROOT, "src");
const WRITE_PATTERN = /INSERT INTO layouts|UPDATE layouts|REPLACE INTO layouts/;

function walk(dir: string): string[] {
  if (!fs.existsSync(dir)) return [];
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(full));
    else if (entry.name.endsWith(".ts")) out.push(full);
  }
  return out;
}

describe("layouts table write boundary", () => {
  it("[LDB-P1] only src/core/events.ts writes the layouts table", () => {
    const files = walk(SRC);
    expect(files.length).toBeGreaterThan(0);

    const hits = files
      .filter((f) => WRITE_PATTERN.test(fs.readFileSync(f, "utf8")))
      .map((f) => path.relative(DB_ROOT, f));

    expect(hits).toEqual([path.relative(DB_ROOT, path.join(SRC, "core", "events.ts"))]);
  });
});
