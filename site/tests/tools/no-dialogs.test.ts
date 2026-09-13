// [SITE-15] no browser dialog (`window.confirm`/`alert`/`prompt`, or the
// bare global form `confirm(...)`/`alert(...)`/`prompt(...)`) anywhere
// under `src/**` -- every destructive action confirms IN PLACE (an inline
// confirm row, e.g. `ui/OwnerActions.tsx`'s per-action `open` signal),
// design/akldb-site/01-plan.md's W1b deliverable 1.
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const SRC_DIR = path.resolve(import.meta.dirname, "..", "..", "src");

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "generated") continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(full));
    else if (/\.(ts|tsx)$/.test(entry.name)) out.push(full);
  }
  return out;
}

const DIALOG_RE = /\b(?:window\.)?(?:confirm|alert|prompt)\s*\(/;

describe("[SITE-15] no window.confirm/alert/prompt anywhere in src/**", () => {
  it("no source file under src/ calls a browser dialog", () => {
    const violations: string[] = [];
    for (const file of walk(SRC_DIR)) {
      const source = fs.readFileSync(file, "utf8");
      for (const line of source.split("\n")) {
        if (DIALOG_RE.test(line)) violations.push(`${path.relative(SRC_DIR, file)}: ${line.trim()}`);
      }
    }
    expect(violations).toEqual([]);
  });
});
