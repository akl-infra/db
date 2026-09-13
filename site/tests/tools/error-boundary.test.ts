// [SITE-22] A page error never kills the shell: every routed page in
// App.tsx renders inside one `Errored` boundary (Solid 2's ErrorBoundary) that sits INSIDE <main>, below
// <Header />, so the header/nav keep working and the user can navigate
// away (production 2026-09-13: an uncaught memo error disposed the root).
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const APP = path.resolve(import.meta.dirname, "..", "..", "src", "App.tsx");

describe("[SITE-22] page error boundary", () => {
  it("[SITE-22] App.tsx wraps every routed page in an ErrorBoundary placed after the Header", () => {
    const src = fs.readFileSync(APP, "utf8");
    expect(src).toMatch(/import \{[^}]*Errored[^}]*\} from "solid-js"/);
    const header = src.indexOf("<Header />");
    const open = src.indexOf("<Errored");
    const close = src.indexOf("</Errored>");
    expect(header).toBeGreaterThan(-1);
    expect(open).toBeGreaterThan(header);
    expect(close).toBeGreaterThan(open);
    // every page component is mounted between the boundary's open and close
    for (const page of ["<Home />", "<Layout ", "<Author ", "<Changes />", "<Docs />", "<Admin />", "<NotFound />"]) {
      const at = src.indexOf(page);
      expect(at, `${page} outside the boundary`).toBeGreaterThan(open);
      expect(at, `${page} outside the boundary`).toBeLessThan(close);
    }
  });
});
