// [LDB-P1] the event commit (`commitWrite`/`appendLike`, whose D1 statements
// are in `src/store/d1/events.ts`) is the only code that writes the
// `layouts` table through the fold (07 §6 S4's DoD clause); everything else
// only reads it. The bulk restore (`src/store/d1/dump.ts`, S7) is the one
// explicit exception: a restore reconstructs
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
// Since P1 (design/aws-port.md §4.1) the statements live behind the storage
// port: the event commit in store/d1/events.ts and the bulk restore in
// store/d1/dump.ts.
const ALLOWED = [path.join(SRC, "store", "d1", "events.ts"), path.join(SRC, "store", "d1", "dump.ts")];

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
  it("[LDB-P1] only src/store/d1/events.ts and src/store/d1/dump.ts write the layouts table", () => {
    const files = walk(SRC);
    expect(files.length).toBeGreaterThan(0);

    const hits = files
      .filter((f) => WRITE_PATTERN.test(fs.readFileSync(f, "utf8")))
      .map((f) => path.relative(DB_ROOT, f))
      .sort();

    expect(hits).toEqual(ALLOWED.map((f) => path.relative(DB_ROOT, f)).sort());
  });
});
