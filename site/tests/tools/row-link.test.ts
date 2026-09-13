// [SITE-20] the Home list's whole-row click target is a real <a> (class
// `akl-row-link`) wired to the same guarded `onLinkClick` every other link
// on the site uses, stretched over the row by styles.css -- not a separate
// ad-hoc row click handler that could swallow a modified click or skip
// keyboard access. Static source checks; the actual click-vs-modified-click
// behavior is `onLinkClick`'s own, covered by tests/src/router.test.ts.
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const SITE_ROOT = path.resolve(import.meta.dirname, "..", "..");

describe("[SITE-20] Home row is a stretched real link", () => {
  it("Home.tsx's name cell renders a real <a class=\"akl-row-link\"> wired to onLinkClick", () => {
    const source = fs.readFileSync(path.join(SITE_ROOT, "src", "pages", "Home.tsx"), "utf8");
    expect(source).toMatch(/<a\s+href=\{layoutHref\}\s+class="akl-row-link"\s+onClick=\{\(e\) => onLinkClick\(e, layoutHref\)\}/);
  });

  it("styles.css stretches akl-row-link over its row with a positioned ::after overlay", () => {
    const css = fs.readFileSync(path.join(SITE_ROOT, "src", "styles.css"), "utf8");
    expect(css).toMatch(/\.akl-table tbody tr\s*\{[^}]*position:\s*relative/);
    expect(css).toMatch(/\.akl-row-link::after\s*\{[^}]*position:\s*absolute/);
    expect(css).toMatch(/\.akl-row-link::after\s*\{[^}]*inset:\s*0/);
  });

  it("any non-row-link anchor inside the table stacks above the overlay (stays independently clickable)", () => {
    const css = fs.readFileSync(path.join(SITE_ROOT, "src", "styles.css"), "utf8");
    expect(css).toMatch(/\.akl-table td a:not\(\.akl-row-link\)\s*\{[^}]*z-index:\s*1/);
  });
});
