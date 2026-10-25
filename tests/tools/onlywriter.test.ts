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
// design/p1-briefs.md: during P1 the commit SQL moves from core/events.ts to
// store/d1/events.ts (agent A) and the restore SQL from dump/restore.ts to
// store/d1/dump.ts (agent D). Either location of each counts; at P1's end
// the main session drops the two legacy entries.
const ALLOWED = [
  path.join(SRC, "core", "events.ts"),
  path.join(SRC, "dump", "restore.ts"),
  path.join(SRC, "store", "d1", "events.ts"),
  path.join(SRC, "store", "d1", "dump.ts"),
];
const REQUIRED_ONE_OF = [ALLOWED.slice(0, 1).concat(ALLOWED.slice(2, 3)), ALLOWED.slice(1, 2).concat(ALLOWED.slice(3, 4))];

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
  it("[LDB-P1] only the event commit (core/events.ts or store/d1/events.ts) and the restore (dump/restore.ts or store/d1/dump.ts) write the layouts table", () => {
    const files = walk(SRC);
    expect(files.length).toBeGreaterThan(0);

    const hits = files
      .filter((f) => WRITE_PATTERN.test(fs.readFileSync(f, "utf8")))
      .map((f) => path.relative(DB_ROOT, f))
      .sort();

    const allowed = ALLOWED.map((f) => path.relative(DB_ROOT, f));
    for (const hit of hits) expect(allowed).toContain(hit);
    for (const group of REQUIRED_ONE_OF) {
      expect(group.map((f) => path.relative(DB_ROOT, f)).some((f) => hits.includes(f))).toBe(true);
    }
  });
});
