// Regression guard for a real Chrome-QA-caught bug: `<Layout ref={r.ref}/>`
// looked like a normal prop but `ref` is a reserved JSX attribute name on a
// *component* in Solid (ref-forwarding) -- it got intercepted by the
// compiler instead of arriving as `props.ref`, so the DB was asked for a
// layout named the stringified source of Solid's own internal ref-setter
// function. Fixed by renaming the prop (`layoutRef`); this test keeps it
// from silently coming back on some other component.
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const SRC_DIR = path.resolve(import.meta.dirname, "..", "..", "src");

function walkTsx(dir: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "generated") continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walkTsx(full));
    else if (entry.name.endsWith(".tsx")) out.push(full);
  }
  return out;
}

describe("no `ref` prop passed to a custom component", () => {
  it("no `<CapitalizedTag ... ref={...}` anywhere in src/**/*.tsx", () => {
    const violations: string[] = [];
    // A capitalized JSX tag (a component, never a host element) followed
    // somewhere before its closing `>` by a `ref={` attribute -- host
    // elements (lowercase tags) legitimately use `ref` for real DOM refs,
    // which this deliberately does not flag.
    const pattern = /<([A-Z]\w*)\b[^>]*?\bref=\{/gs;
    for (const file of walkTsx(SRC_DIR)) {
      const source = fs.readFileSync(file, "utf8");
      for (const m of source.matchAll(pattern)) {
        violations.push(`${path.relative(SRC_DIR, file)}: <${m[1]} ... ref={...}>`);
      }
    }
    expect(violations).toEqual([]);
  });
});
