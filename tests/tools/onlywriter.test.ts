// [LDB-P1] `appendWrite`/`appendLike` in `src/core/events.ts` are the only
// code that writes the `layouts` table through the fold (07 §6 S4's DoD
// clause); `records.ts` and everything else only reads it. `src/dump/
// restore.ts` (S7) is the one explicit exception: a restore reconstructs
// rows verbatim from a dump that already carries `rev`/`created_at`/etc.,
// so routing it through `appendWrite`'s fold would mean re-deriving values
// the dump already has -- pure overhead with a chance to disagree with what
// was actually dumped. It is allow-listed here by name, not by pattern.
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const DB_ROOT = path.resolve(import.meta.dirname, "..", "..");
const SRC = path.join(DB_ROOT, "src");
const WRITE_PATTERN = /INSERT INTO layouts|UPDATE layouts|REPLACE INTO layouts/;
const ALLOWED = [path.join(SRC, "core", "events.ts"), path.join(SRC, "dump", "restore.ts")];

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
  it("[LDB-P1] only src/core/events.ts and src/dump/restore.ts write the layouts table", () => {
    const files = walk(SRC);
    expect(files.length).toBeGreaterThan(0);

    const hits = files
      .filter((f) => WRITE_PATTERN.test(fs.readFileSync(f, "utf8")))
      .map((f) => path.relative(DB_ROOT, f))
      .sort();

    expect(hits).toEqual(ALLOWED.map((f) => path.relative(DB_ROOT, f)).sort());
  });
});
