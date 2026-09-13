// [SITE-30] [SITE-31] [SITE-32] [SITE-34] the W1c Docs page overhaul.
// build-docs.mjs (pretest hook) always regenerates src/generated/docs.html.ts
// and public/adoption.md fresh from db/docs/adoption.md before this suite
// runs -- these tests read what's already on disk, same posture as
// tests/tools/copy-scan.test.ts's static source scans.
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { copyMarkdownToClipboard } from "../../src/pages/Docs.tsx";
import { adoptionMarkdown, docsHtml, endpoints } from "../../src/generated/docs.html.ts";

const SITE_ROOT = path.resolve(import.meta.dirname, "..", "..");
const DB_ROOT = path.resolve(SITE_ROOT, "..");
const ADOPTION_SOURCE = path.join(DB_ROOT, "docs", "adoption.md");
const PUBLIC_COPY = path.join(SITE_ROOT, "public", "adoption.md");
const DOCS_TSX = path.join(SITE_ROOT, "src", "pages", "Docs.tsx");

function readSource(): string {
  return fs.readFileSync(ADOPTION_SOURCE, "utf8");
}

// Same minimal pipe-table locator build-docs.mjs and db/tests/tools/
// docs-site.test.ts's LDB-G10 both use -- independent of this package's
// own generated output, so SITE-31 is a real cross-check, not a tautology.
function findPipeTable(md: string, headerCells: string[]): string[][] {
  const lines = md.split("\n");
  const cells = (line: string) =>
    line
      .replace(/^\|/, "")
      .replace(/\|\s*$/, "")
      .split("|")
      .map((c) => c.trim());
  for (let i = 0; i < lines.length - 1; i++) {
    const line = lines[i]!;
    if (!line.startsWith("|") || !/^\|[\s:|-]+\|$/.test(lines[i + 1]!)) continue;
    if (JSON.stringify(cells(line)) !== JSON.stringify(headerCells)) continue;
    const rows: string[][] = [];
    for (let j = i + 2; j < lines.length && lines[j]!.startsWith("|"); j++) rows.push(cells(lines[j]!));
    return rows;
  }
  throw new Error(`findPipeTable: no table with header ${JSON.stringify(headerCells)}`);
}

function unbacktick(cell: string): string {
  const m = /^`([^`]*)`$/.exec(cell.trim());
  return m ? m[1]! : cell.trim();
}

describe("[SITE-30] /adoption.md is served byte-identical to db/docs/adoption.md", () => {
  it("[SITE-30] public/adoption.md (what Vite copies verbatim into dist/) equals db/docs/adoption.md exactly", () => {
    expect(fs.existsSync(PUBLIC_COPY), "public/adoption.md is missing -- run `node scripts/build-docs.mjs` (or npm test's pretest hook) first").toBe(true);
    const source = readSource();
    const served = fs.readFileSync(PUBLIC_COPY, "utf8");
    expect(served).toEqual(source);
  });

  it("[SITE-30] the generated module's own adoptionMarkdown equals db/docs/adoption.md exactly", () => {
    expect(adoptionMarkdown).toEqual(readSource());
  });
});

describe("[SITE-31] the on-page endpoint brief lists exactly adoption.md's §9 routes", () => {
  it("[SITE-31] every (method, path) in the generated endpoints array is in §9's table, and vice versa", () => {
    const rows = findPipeTable(readSource(), ["METHOD", "PATH", "auth", "body", "success", "errors"]);
    expect(rows.length).toBeGreaterThan(0);
    const guideRoutes = new Set(rows.map((r) => `${unbacktick(r[0]!)} ${unbacktick(r[1]!)}`));
    const briefRoutes = new Set(endpoints.map((e) => `${e.method} ${e.path}`));
    expect(briefRoutes.size).toEqual(endpoints.length); // no duplicate route in the brief
    expect([...briefRoutes].sort()).toEqual([...guideRoutes].sort());
  });

  it("[SITE-31] every endpoint is classified into exactly one of the five named groups", () => {
    const allowed = new Set(["read", "write", "likes", "link", "admin"]);
    for (const e of endpoints) {
      expect(allowed.has(e.group), `${e.method} ${e.path} has an unrecognized group '${e.group}'`).toBe(true);
    }
  });

  it("[SITE-31] every endpoint has a non-empty one-line purpose", () => {
    const missing = endpoints.filter((e) => e.purpose.trim() === "").map((e) => `${e.method} ${e.path}`);
    expect(missing).toEqual([]);
  });
});

describe("[SITE-32] the copy-as-markdown payload equals the served guide", () => {
  it("[SITE-32] copyMarkdownToClipboard sends exactly adoptionMarkdown to the clipboard", async () => {
    const calls: string[] = [];
    const fakeClipboard = { writeText: async (text: string) => void calls.push(text) };
    const outcome = await copyMarkdownToClipboard(adoptionMarkdown, fakeClipboard);
    expect(outcome).toEqual("copied");
    expect(calls).toEqual([adoptionMarkdown]);
    // ...and that payload is exactly what /adoption.md serves (SITE-30 ties
    // the two together: same source, same bytes, everywhere).
    expect(calls[0]).toEqual(fs.readFileSync(PUBLIC_COPY, "utf8"));
  });

  it("[SITE-32] with no clipboard API available, it reports 'unsupported' rather than throwing", async () => {
    await expect(copyMarkdownToClipboard(adoptionMarkdown, undefined)).resolves.toEqual("unsupported");
    await expect(copyMarkdownToClipboard(adoptionMarkdown, null)).resolves.toEqual("unsupported");
  });

  it("[SITE-32] a rejected clipboard write propagates (Docs.tsx's own catch is what falls back to the textarea)", async () => {
    const failing = { writeText: async () => Promise.reject(new Error("denied")) };
    await expect(copyMarkdownToClipboard(adoptionMarkdown, failing)).rejects.toThrow("denied");
  });
});

describe("[SITE-34] the Docs page has exactly one H1 and every TOC anchor resolves", () => {
  const docsSource = fs.readFileSync(DOCS_TSX, "utf8");

  it("[SITE-34] exactly one <h1> in src/pages/Docs.tsx", () => {
    const h1Count = (docsSource.match(/<h1[\s>]/g) ?? []).length;
    expect(h1Count).toEqual(1);
  });

  it("[SITE-34] every #anchor the table of contents links to has a matching id= on the page", () => {
    const navMatch = /<nav class="akl-docs-toc">[\s\S]*?<\/nav>/.exec(docsSource);
    expect(navMatch, "no <nav class=\"akl-docs-toc\"> found in Docs.tsx").not.toBeNull();
    const hrefs = [...navMatch![0].matchAll(/href="#([^"]+)"/g)].map((m) => m[1]!);
    expect(hrefs.length).toBeGreaterThan(0);

    const allIds = [...docsSource.matchAll(/\bid="([^"]+)"/g)].map((m) => m[1]!);
    const ids = new Set(allIds);
    expect(ids.size).toEqual(allIds.length); // no id defined twice

    const broken = hrefs.filter((h) => !ids.has(h));
    expect(broken, `TOC links to #${broken.join(", #")}, which no element on the page defines`).toEqual([]);
  });

  it("[SITE-34] the guide's own leading heading is demoted to <h2> before it's embedded (never a second <h1>, collapsed or not)", () => {
    expect(docsHtml.includes("<h1>")).toBe(false);
    expect(docsHtml.startsWith("<h2>Adopting the akldb API</h2>")).toBe(true);
  });
});
