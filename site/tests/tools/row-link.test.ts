// [SITE-20] Whole-row click on Home, WITHOUT a positioned overlay.
// 2026-09-13: the first implementation stretched the name link over the row
// with `position: relative` on the <tr> + `inset: 0` on `::after`; Safari
// does not honour a positioned <tr> as a containing block, so the overlay
// anchored to the document and the last row's link swallowed every click
// (production: "clicking graphite takes me to /l/zxcvb", nav dead). The
// row now delegates plain clicks to `onLinkClick`; this test pins both the
// wiring and the absence of any overlay.
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { landedOnLink } from "../../src/lib/rowclick.ts";

const SITE_ROOT = path.resolve(import.meta.dirname, "..", "..");

describe("[SITE-20] Home row click is delegation, never an overlay", () => {
  it("Home.tsx wires rowClick on the <tr> and keeps a real <a class=\"akl-row-link\"> for the name", () => {
    const source = fs.readFileSync(path.join(SITE_ROOT, "src", "pages", "Home.tsx"), "utf8");
    expect(source).toMatch(/<tr onClick=\{\(e\) => rowClick\(e, layoutHref\)\}>/);
    expect(source).toMatch(/<a\s+href=\{layoutHref\}\s+class="akl-row-link"\s+onClick=\{\(e\) => onLinkClick\(e, layoutHref\)\}/);
  });

  it("styles.css has no absolutely-positioned overlay on the row link and no positioned <tr>", () => {
    const css = fs.readFileSync(path.join(SITE_ROOT, "src", "styles.css"), "utf8");
    expect(css).not.toMatch(/\.akl-row-link::after/);
    expect(css).not.toMatch(/\.akl-table tbody tr\s*\{[^}]*position:\s*(relative|absolute)/);
  });

  it("a click that lands on a link (or inside one) is left to that link", () => {
    const anchor = { closest: (s: string) => (s === "a" ? anchor : null) };
    const insideAnchor = { closest: (s: string) => (s === "a" ? anchor : null) };
    const cell = { closest: () => null };
    expect(landedOnLink(insideAnchor as unknown as EventTarget)).toBe(true);
    expect(landedOnLink(anchor as unknown as EventTarget)).toBe(true);
    expect(landedOnLink(cell as unknown as EventTarget)).toBe(false);
    expect(landedOnLink(null)).toBe(false);
  });
});
