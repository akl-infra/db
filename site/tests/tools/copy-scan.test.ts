// [SITE-5] every user-facing string of 3+ words lives in src/copy.ts, which
// carries the `// COPY: sign-off pending` marker. Static regex scan over
// JSX text nodes and string-literal attribute values in src/**/*.tsx --
// deliberately simple (no TSX parser dependency), same spirit as db/tests/
// tools/boundary.test.ts's import scan.
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const SRC_DIR = path.resolve(import.meta.dirname, "..", "..", "src");
const COPY_FILE = path.join(SRC_DIR, "copy.ts");

function walkTsx(dir: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "generated") continue; // build-time output, not authored copy
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walkTsx(full));
    else if (entry.name.endsWith(".tsx")) out.push(full);
  }
  return out;
}

function wordCount(s: string): number {
  return s.trim().split(/\s+/).filter(Boolean).length;
}

// JSX text nodes: text directly between `>` and `<` that isn't just
// whitespace/an expression. String-literal attribute values (title="...",
// placeholder="...", aria-label="...") are also user-facing.
function findLongLiterals(source: string): string[] {
  const found: string[] = [];

  // Text between tags: >TEXT< where TEXT has no braces/tags.
  for (const m of source.matchAll(/>([^<>{}\n]+)</g)) {
    const text = m[1]!.trim();
    if (text && wordCount(text) >= 3) found.push(text);
  }

  // String-literal JSX attribute values: attr="..." or attr='...'.
  for (const m of source.matchAll(/\b(?:title|placeholder|aria-label|alt)=["']([^"']+)["']/g)) {
    const text = m[1]!.trim();
    if (wordCount(text) >= 3) found.push(text);
  }

  return found;
}

describe("[SITE-5] copy scan", () => {
  it("copy.ts carries the sign-off-pending marker", () => {
    const header = fs.readFileSync(COPY_FILE, "utf8").split("\n").slice(0, 5).join("\n");
    expect(header).toContain("// COPY: sign-off pending");
  });

  it("no .tsx file outside copy.ts hardcodes a 3+ word user-facing string", () => {
    const files = walkTsx(SRC_DIR);
    expect(files.length).toBeGreaterThan(0);
    const violations: string[] = [];
    for (const file of files) {
      const source = fs.readFileSync(file, "utf8");
      for (const literal of findLongLiterals(source)) {
        violations.push(`${path.relative(SRC_DIR, file)}: "${literal}"`);
      }
    }
    expect(violations).toEqual([]);
  });
});
