// [SITE-35] The site names the product "akldb" -- saltorbit, 2026-09-13
// ("akldb everywhere"). "layoutdb"/"layout-db"/"the layout database" (the
// internal/historical name) must never reach a viewer: not `copy.ts` (the
// ONE place SITE-5 lets a 3+-word string live) and not the built client
// bundle, in ANY chunk -- unlike SITE-7/SITE-12's docs-content exception,
// this one has none: db/docs/adoption.md (rendered verbatim into that
// chunk) was itself renamed (LDB-G14) to say "akldb" throughout, so a
// clean build has zero occurrences anywhere, and a stray one flags either
// a copy regression here or a re-introduced occurrence in adoption.md.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { copy } from "../../src/copy.ts";

const SITE_ROOT = path.resolve(import.meta.dirname, "..", "..");
const DIST_DIR = path.join(SITE_ROOT, "dist");
const BANNED = /layout[- ]?db|layout database/i;

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(full));
    else out.push(full);
  }
  return out;
}

// Every string leaf in copy.ts, including inside functions' own template
// literals (probed with representative arguments) -- not just the plain
// string leaves an object walk finds on its own.
function copyStrings(): string[] {
  const out: string[] = [];
  const visit = (v: unknown): void => {
    if (typeof v === "string") out.push(v);
    else if (typeof v === "function") {
      try {
        out.push(String((v as (...args: unknown[]) => unknown)("x", "x", 1, 1)));
      } catch {
        // A function whose probe args don't type-check at runtime (none do
        // here -- every copy.ts function just interpolates) is skipped
        // rather than failing this unrelated test.
      }
    } else if (v && typeof v === "object") {
      for (const child of Object.values(v)) visit(child);
    }
  };
  visit(copy);
  return out;
}

describe("[SITE-35] akldb.org never says \"layoutdb\"/\"layout database\"", () => {
  it("[SITE-35] every copy.ts string (including the kinds/rename/link function outputs) is clear of the banned pattern", () => {
    const offenders = copyStrings().filter((s) => BANNED.test(s));
    expect(offenders).toEqual([]);
  });

  it("[SITE-35] the built bundle -- EVERY chunk, docs-content included -- has no occurrence of the banned pattern", () => {
    execFileSync("npx", ["vite", "build"], { cwd: SITE_ROOT, stdio: "pipe" });
    expect(fs.existsSync(DIST_DIR)).toBe(true);

    const files = walk(DIST_DIR).filter((f) => /\.(js|css|html)$/.test(f));
    expect(files.length).toBeGreaterThan(0);

    const offenders = files.filter((f) => BANNED.test(fs.readFileSync(f, "utf8")));
    expect(offenders.map((f) => path.relative(DIST_DIR, f))).toEqual([]);
  });
});
