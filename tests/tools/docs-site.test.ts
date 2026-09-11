// [LDB-G9] The layoutdb docs hub (design/layout-db/20-spark.md §1 decision
// 15, §3 S8) is generated fresh on every real build (scripts/
// assemble_dist.mjs's buildLayoutdbHub(), straight into dist/layoutdb/) --
// it is NEVER checked in (see .gitignore's /web/layoutdb/ entry). Several
// sessions append to design/layout-db/*.md all day (13-ledger.md
// especially), so gating on "checked-in output equals a fresh render"
// would go red on nearly every one of those edits with nobody having
// touched this hub at all. This suite instead asserts properties of a
// fresh build -- against itself, and against a temp dir writeSite() just
// wrote, never against anything committed:
//   - every design/layout-db/*.md + db/docs/*.md source is in the hub,
//     and nothing else is
//   - every page's navigation lists every doc exactly once, in reader order
//   - every internal link and "Markdown for agents" link resolves
//   - all.md equals every doc's markdown copy concatenated in nav order
//   - each page's .md copy equals the builder's own render of its source
//   - the builder is deterministic: two runs produce byte-identical output
//
// This is db/'s only test that reaches outside db/ by design: the hub is
// built from design/layout-db/ and (once npm run build has run) lives
// under dist/layoutdb/, both siblings of db/ in the monorepo. That's
// allowed -- LDB-G5's import-boundary scan (tests/tools/boundary.test.ts)
// walks db/src, db/formats and db/scripts, never db/tests. Once db/ splits
// into its own repo (00-plan.md §7) design/layout-db/ does not exist any
// more, so this whole suite skips itself -- the same repoLayout() signal
// LDB-G5/G6 use, checked once per test rather than by conditionally
// registering tests, so `split-db.sh --dry-run` (LDB-G6) still finds every
// test here green with no edits.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { repoLayout } from "./repo.ts";
// LDB-G10's own imports (below): unlike LDB-G9 above, this doesn't reach
// outside db/ and isn't skipped once db/ splits out -- the guide, the
// router, the error factories and the registry all live inside db/.
import { app } from "../../src/index";
import { chainViolations, registerForTest } from "../../formats/registry.ts";
import { T1, T2, T2_MISSING_UP, T2_MISSING_DOWN, T2_MISSING_EDITS } from "../formats/stub-lineage.ts";
// gen-error-table.mjs is a plain script (no .d.ts) -- typed locally, same
// posture db/tests/tools/error-table.test.ts's own import already takes.
// @ts-expect-error -- see above
import * as genErrorTable from "../../scripts/gen-error-table.mjs";

const { hasSiteTree, repoRoot: REPO_ROOT } = repoLayout();
// db/'s own root, independent of repoLayout()'s monorepo/split distinction
// (REPO_ROOT above is db/'s PARENT in the monorepo, db/ itself once split;
// LDB-G10 only ever reads files inside db/, so it needs db/ itself, always).
const DB_ROOT = path.resolve(import.meta.dirname, "..", "..");
const ADOPTION_GUIDE_PATH = path.join(DB_ROOT, "docs", "adoption.md");
const BUILD_SITE_PATH = path.join(REPO_ROOT, "design", "layout-db", "build_site.mjs");

// Minimal shape of design/layout-db/build_site.mjs's exports this file
// needs -- typed locally rather than adding a .d.ts for a script outside
// db/ (same call as codeowners.test.ts makes for db/scripts/codeowners.mjs).
interface Doc {
  key: string;
  slug: string;
  title: string;
  srcPath: string;
  srcRel: string;
}
interface BuildSiteModule {
  discoverDocs(): { mainDocs: Doc[]; recordDocs: Doc[]; all: Doc[] };
  buildSite(): { files: Map<string, string>; mainDocs: Doc[]; recordDocs: Doc[]; all: Doc[] };
  writeSite(files: Map<string, string>, outDir: string): void;
  mdCopyFromSource(md: string): string;
}

// Dynamic, and only ever awaited from inside a test body after the
// hasSiteTree guard below -- a static top-level import would try to
// resolve design/layout-db/build_site.mjs even in the split repo, where it
// does not exist, and fail the whole file before any test's skip logic
// could run.
async function loadBuilder(): Promise<BuildSiteModule> {
  return (await import(pathToFileURL(BUILD_SITE_PATH).href)) as unknown as BuildSiteModule;
}

// True (and logs) when this suite should skip itself because db/ has
// split out and the hub's sources are simply not here any more.
function skipIfSplit(): boolean {
  if (hasSiteTree) return false;
  console.log("[LDB-G9] SKIP: no sibling web/ -- the docs hub is built from design/layout-db/, which does not exist once db/ is the repo root");
  return true;
}

const tempDirs: string[] = [];
function mkTempOutDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "layoutdb-hub-"));
  tempDirs.push(dir);
  return dir;
}
afterEach(() => {
  while (tempDirs.length) {
    fs.rmSync(tempDirs.pop()!, { recursive: true, force: true });
  }
});

function walkFiles(dir: string): string[] {
  if (!fs.existsSync(dir)) return [];
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walkFiles(full));
    else out.push(full);
  }
  return out;
}

describe("[LDB-G9] layoutdb docs hub", () => {
  it("[LDB-G9] every design/layout-db/*.md and db/docs/*.md source is in the hub, and only those", async () => {
    if (skipIfSplit()) {
      expect(hasSiteTree).toBe(false);
      return;
    }
    const { discoverDocs } = await loadBuilder();
    const { all } = discoverDocs();
    const inHub = new Set(all.map((d) => d.srcPath));

    const sources: string[] = [];
    const layoutDbDir = path.join(REPO_ROOT, "design", "layout-db");
    for (const name of fs.readdirSync(layoutDbDir)) {
      if (name.endsWith(".md")) sources.push(path.join(layoutDbDir, name));
    }
    const dbDocsDir = path.join(REPO_ROOT, "db", "docs");
    if (fs.existsSync(dbDocsDir)) {
      for (const name of fs.readdirSync(dbDocsDir)) {
        if (name.endsWith(".md")) sources.push(path.join(dbDocsDir, name));
      }
    }
    expect(sources.length).toBeGreaterThan(0);

    const missing = sources.filter((s) => !inHub.has(s));
    expect(missing).toEqual([]);
    // The reverse: nothing in the hub claims a source outside the two globs
    // above (guards against a stray future source directory).
    const extra = all.map((d) => d.srcPath).filter((s) => !sources.includes(s));
    expect(extra).toEqual([]);
  });

  it("[LDB-G9] every page's navigation lists every doc exactly once, in reader order", async () => {
    if (skipIfSplit()) {
      expect(hasSiteTree).toBe(false);
      return;
    }
    const { buildSite } = await loadBuilder();
    const { files, mainDocs, recordDocs, all } = buildSite();

    // Reader order (decision 15 / S8): architecture, the adoption guide
    // (once present), 01 formats, 03 API, 02 auth, 04 governance, spark,
    // upcast, then the design-record group.
    const expectedMainKeys = ["architecture", "adoption", "01-format", "03-api", "02-auth", "04-governance", "20-spark", "19-upcast"].filter(
      (k) => mainDocs.some((d) => d.key === k),
    );
    expect(mainDocs.map((d) => d.key)).toEqual(expectedMainKeys);
    // The design-record group is exactly everything else, sorted by its own
    // filename (00, then 05-18 -- a plain string sort already gets this
    // right for that shared two-digit-prefix shape).
    const sortedRecordKeys = [...recordDocs.map((d) => d.key)].sort((a, b) => a.localeCompare(b));
    expect(recordDocs.map((d) => d.key)).toEqual(sortedRecordKeys);

    const expectedHrefs = new Set(all.map((d) => `/layoutdb/${d.slug}/`));
    expect(expectedHrefs.size).toEqual(all.length); // no two docs share a slug

    const pages = ["index.html", ...all.map((d) => `${d.slug}/index.html`)];
    const problems: string[] = [];
    for (const rel of pages) {
      const html = files.get(rel);
      expect(html, `buildSite() did not produce ${rel}`).toBeDefined();
      const navMatch = /<nav class="hubnav"[^]*?<\/nav>/.exec(html!);
      if (!navMatch) {
        problems.push(`${rel}: no <nav class="hubnav"> found`);
        continue;
      }
      const hrefs = [...navMatch[0].matchAll(/href="([^"]+)"/g)].map((m) => m[1]!).filter((h) => h !== "/layoutdb/");
      const counts = new Map<string, number>();
      for (const h of hrefs) counts.set(h, (counts.get(h) ?? 0) + 1);
      for (const href of expectedHrefs) {
        const n = counts.get(href) ?? 0;
        if (n !== 1) problems.push(`${rel}: nav has ${n} link(s) to ${href}, expected exactly 1`);
      }
      for (const href of counts.keys()) {
        if (!expectedHrefs.has(href)) problems.push(`${rel}: nav links to ${href}, which names no known doc`);
      }
    }
    expect(problems).toEqual([]);
  });

  it("[LDB-G9] every internal link and every Markdown-for-agents link resolves", async () => {
    if (skipIfSplit()) {
      expect(hasSiteTree).toBe(false);
      return;
    }
    const { buildSite } = await loadBuilder();
    const { files } = buildSite();

    // Map an href straight onto the relPath key buildSite() itself uses --
    // resolved against the in-memory file map, never against a
    // filesystem, so this holds regardless of where (or whether) the hub
    // has been written to disk.
    const hrefToRelPath = (href: string): string => {
      const rel = href.replace(/^\/layoutdb\/?/, "");
      if (rel === "") return "index.html";
      if (rel.endsWith(".md")) return rel;
      return `${rel.replace(/\/$/, "")}/index.html`;
    };

    const broken: string[] = [];
    for (const [relPath, html] of files) {
      if (!relPath.endsWith(".html")) continue;
      for (const m of html.matchAll(/href="(\/layoutdb\/[^"]*)"/g)) {
        const href = m[1]!;
        const target = hrefToRelPath(href);
        if (!files.has(target)) {
          broken.push(`${relPath}: href="${href}" -> no such page (${target})`);
        }
      }
    }
    expect(broken).toEqual([]);
  });

  it("[LDB-G9] all.md equals every doc's markdown copy concatenated in nav order", async () => {
    if (skipIfSplit()) {
      expect(hasSiteTree).toBe(false);
      return;
    }
    const { buildSite, mdCopyFromSource } = await loadBuilder();
    const { files, all } = buildSite();
    expect(all.length).toBeGreaterThan(0);
    const expected = all.map((d) => mdCopyFromSource(fs.readFileSync(d.srcPath, "utf8"))).join("\n\n---\n\n");
    expect(files.get("all.md")).toEqual(expected);
  });

  it("[LDB-G9] every page's .md copy equals the builder's own markdown render of its source", async () => {
    if (skipIfSplit()) {
      expect(hasSiteTree).toBe(false);
      return;
    }
    const { buildSite, mdCopyFromSource } = await loadBuilder();
    const { files, all } = buildSite();
    for (const d of all) {
      const expected = mdCopyFromSource(fs.readFileSync(d.srcPath, "utf8"));
      expect(files.get(`${d.slug}/${d.slug}.md`), `missing ${d.slug}/${d.slug}.md`).toEqual(expected);
    }
  });

  it("[LDB-G9] the builder is deterministic: two runs produce byte-identical output", async () => {
    if (skipIfSplit()) {
      expect(hasSiteTree).toBe(false);
      return;
    }
    const { buildSite } = await loadBuilder();
    const a = buildSite().files;
    const b = buildSite().files;
    expect([...b.keys()].sort()).toEqual([...a.keys()].sort());
    for (const [relPath, content] of a) {
      expect(b.get(relPath), `${relPath} differs between two builds`).toEqual(content);
    }
  });

  it("[LDB-G9] writeSite(files, outDir) writes exactly the fresh build's files to a temp dir, nothing more", async () => {
    if (skipIfSplit()) {
      expect(hasSiteTree).toBe(false);
      return;
    }
    const { buildSite, writeSite } = await loadBuilder();
    const { files } = buildSite();
    const outDir = mkTempOutDir();
    writeSite(files, outDir);

    const onDisk = walkFiles(outDir).map((f) => path.relative(outDir, f).split(path.sep).join("/"));
    expect(new Set(onDisk)).toEqual(new Set(files.keys()));
    for (const [relPath, content] of files) {
      expect(fs.readFileSync(path.join(outDir, relPath), "utf8")).toEqual(content);
    }
  });
});

// -- [LDB-G10] The adoption guide (db/docs/adoption.md, 20-spark.md S8)
// covers the API exactly. Unlike LDB-G9 above, this never skips itself once
// db/ splits out -- the guide, the router, the error factories and the
// registry all live inside db/, none of it in design/layout-db/.

function readAdoptionGuide(): string {
  return fs.readFileSync(ADOPTION_GUIDE_PATH, "utf8");
}

// A plain markdown pipe table, located by its header row's cells (exact,
// case-sensitive match against `headerCells`) so the guide's several pipe
// tables (the endpoint table, the error table, and others) are never
// confused for one another -- no comment markers needed (the renderer
// this guide targets, design/federation/build_page.mjs's `render`, has no
// raw-HTML-comment passthrough, so a marker would render as visible text).
function findPipeTable(md: string, headerCells: string[]): string[][] {
  const lines = md.split("\n");
  const cells = (line: string) =>
    line.replace(/^\|/, "").replace(/\|\s*$/, "").split("|").map((c) => c.trim());
  for (let i = 0; i < lines.length - 1; i++) {
    const line = lines[i]!;
    if (!line.startsWith("|") || !/^\|[\s:|-]+\|$/.test(lines[i + 1]!)) continue; // header, then a `---` separator row (internal `|`s included in the class)
    if (JSON.stringify(cells(line)) !== JSON.stringify(headerCells)) continue;
    const rows: string[][] = [];
    for (let j = i + 2; j < lines.length && lines[j]!.startsWith("|"); j++) rows.push(cells(lines[j]!));
    return rows;
  }
  throw new Error(`findPipeTable: no table with header ${JSON.stringify(headerCells)} in ${ADOPTION_GUIDE_PATH}`);
}

// "`/v1/layouts/:ref`" -> "/v1/layouts/:ref"; a cell with no backticks is
// returned trimmed, unchanged.
function unbacktick(cell: string): string {
  const m = /^`([^`]*)`$/.exec(cell.trim());
  return m ? m[1]! : cell.trim();
}

// The lines strictly between `startHeading` and either `endHeading` (if
// given) or the next heading (`#`, `##` or `###`) after it -- what one
// section's own body reads as, for the bullet-name extraction below.
function extractSection(md: string, startHeading: string, endHeading: string | null): string {
  const lines = md.split("\n");
  const startIdx = lines.findIndex((l) => l.trim() === startHeading);
  if (startIdx === -1) throw new Error(`extractSection: heading '${startHeading}' not found in ${ADOPTION_GUIDE_PATH}`);
  let endIdx = lines.length;
  if (endHeading !== null) {
    const idx = lines.findIndex((l, i) => i > startIdx && l.trim() === endHeading);
    if (idx !== -1) endIdx = idx;
  } else {
    for (let i = startIdx + 1; i < lines.length; i++) {
      if (/^#{1,3}\s/.test(lines[i]!)) {
        endIdx = i;
        break;
      }
    }
  }
  return lines.slice(startIdx + 1, endIdx).join("\n");
}

// A section's own `- \`name\`: ...` bullets -- the format-author checklist's
// one bullet-per-member shape (adoption.md's "Every stored format exports"
// / "Additionally, for a major > 1" lists).
function extractBacktickBulletNames(section: string): string[] {
  const out: string[] = [];
  for (const line of section.split("\n")) {
    const m = /^-\s+`([A-Za-z]+)/.exec(line);
    if (m) out.push(m[1]!);
  }
  return out;
}

// Every non-ALL entry in the live Hono router (`app.routes`, exported by
// src/index.ts for exactly this kind of black-box enumeration -- the same
// export tests/auth/routes.test.ts's [LDB-A1] already walks). "ALL" is
// `app.use()`'s own registration (the actor/rate-limit/nudge middleware),
// never a route a client calls.
function routerRoutes(): Set<string> {
  const out = new Set<string>();
  for (const route of app.routes) {
    if (route.method === "ALL") continue;
    out.add(`${route.method} ${route.path}`);
  }
  return out;
}

describe("[LDB-G10] the adoption guide covers the API exactly", () => {
  it("[LDB-G10] the guide's endpoint table (method + path) equals the router's own registered routes", () => {
    const rows = findPipeTable(readAdoptionGuide(), ["METHOD", "PATH", "auth", "body", "success", "errors"]);
    expect(rows.length).toBeGreaterThan(0);
    const guideRoutes = new Set(rows.map((r) => `${unbacktick(r[0]!)} ${unbacktick(r[1]!)}`));
    const liveRoutes = routerRoutes();
    expect(liveRoutes.size).toBeGreaterThan(0);
    expect([...guideRoutes].sort()).toEqual([...liveRoutes].sort());
  });

  it("[LDB-G10] every error code the guide's error table lists is one the error factories can produce, and every factory code is in the guide", () => {
    const rows = findPipeTable(readAdoptionGuide(), ["status", "error", "message", "thrown by"]);
    expect(rows.length).toBeGreaterThan(0);
    const guideCodes = new Set(rows.map((r) => unbacktick(r[1]!)));

    const parseErrors = genErrorTable.parseErrors as () => { code: string }[];
    const factoryCodes = new Set(parseErrors().map((r) => r.code));
    expect(factoryCodes.size).toBeGreaterThan(0);

    expect([...guideCodes].sort()).toEqual([...factoryCodes].sort());
  });

  it("[LDB-G10] the format-author checklist names every member the registry requires, for a stored format and for a major > 1 -- enumerated from LDB-F18's own required-member fixtures, not hard-coded", () => {
    // Baseline: T1 (db/tests/formats/stub-lineage.ts) is LDB-F18's own
    // conforming major-1 fixture -- zero chainViolations, same assertion
    // chain.test.ts's "every REAL registered module is chain-clean" makes.
    // Every key it carries is exactly what a major-1 FormatModule needs.
    expect(chainViolations(T1)).toEqual([]);
    const requiredStored = Object.keys(T1);
    expect(requiredStored.length).toBeGreaterThan(0);

    // Additionally for major > 1: derived from the SAME three "missing
    // piece" mutants LDB-F18's own test proves chainViolations catches
    // (chain.test.ts's "chainViolations catches each missing piece" block).
    // For each mutant, the one key it lacks that T2 (the conforming major-2
    // fixture) has is the required member -- confirmed here by running
    // chainViolations and checking it actually flags THAT key missing, so
    // this list is behaviorally derived, never a hard-coded ["up","down",
    // "edits"] literal.
    const requiredMajorGt1: string[] = [];
    for (const mutant of [T2_MISSING_UP, T2_MISSING_DOWN, T2_MISSING_EDITS]) {
      const t2Keys = Object.keys(T2) as (keyof typeof T2)[];
      const missingKey = t2Keys.find((k) => T2[k] !== undefined && (mutant as typeof T2)[k] === undefined);
      expect(missingKey, "each mutant must lack exactly one key T2 has").toBeDefined();

      const unT1 = registerForTest(T1);
      const unMutant = registerForTest(mutant);
      let errs: string[];
      try {
        errs = chainViolations(mutant);
      } finally {
        unMutant();
        unT1();
      }
      expect(errs.some((e) => e.includes(`missing '${missingKey}'`)), `chainViolations should flag '${missingKey}' missing: ${JSON.stringify(errs)}`).toBe(
        true,
      );
      requiredMajorGt1.push(missingKey as string);
    }
    expect(requiredMajorGt1.length).toBe(3);

    const guide = readAdoptionGuide();
    const storedSection = extractSection(guide, "### Every stored format exports", "### Additionally, for a major > 1 of an existing lineage");
    const majorSection = extractSection(guide, "### Additionally, for a major > 1 of an existing lineage", null);

    expect(new Set(extractBacktickBulletNames(storedSection))).toEqual(new Set(requiredStored));
    expect(new Set(extractBacktickBulletNames(majorSection))).toEqual(new Set(requiredMajorGt1));
  });
});

// [LDB-G9] CI can build the whole hub: every workflow job whose sparse
// checkout carries the hub's design sources also carries every other
// directory the builder reads (found 2026-09-11: db/docs was missing, so
// CI-built hubs had no adoption guide).
const cone = repoLayout();
(cone.hasSiteTree ? describe : describe.skip)("[LDB-G9] CI sparse checkouts carry every hub source", () => {
  it("[LDB-G9] a sparse-checkout block that lists design/layout-db also lists db/docs and design/federation", () => {
    const wfDir = path.join(cone.repoRoot, ".github", "workflows");
    const problems: string[] = [];
    let blocks = 0;
    for (const file of fs.readdirSync(wfDir).filter((f) => f.endsWith(".yml"))) {
      const lines = fs.readFileSync(path.join(wfDir, file), "utf8").split("\n");
      for (let i = 0; i < lines.length; i++) {
        if (!/sparse-checkout:\s*\|\s*$/.test(lines[i]!)) continue;
        const entries: string[] = [];
        const indent = (lines[i + 1]?.match(/^(\s+)/)?.[1] ?? "").length;
        for (let j = i + 1; j < lines.length; j++) {
          const l = lines[j]!;
          if (l.trim() === "" || (l.match(/^(\s*)/)?.[1] ?? "").length < indent || l.trim().startsWith("#")) {
            if (l.trim().startsWith("#")) continue;
            break;
          }
          entries.push(l.trim());
        }
        if (!entries.includes("design/layout-db")) continue;
        blocks++;
        for (const need of ["db/docs", "design/federation"]) {
          if (!entries.includes(need)) problems.push(`${file}:${i + 1} lacks ${need}`);
        }
      }
    }
    expect(blocks).toBeGreaterThan(0);
    expect(problems).toEqual([]);
  });
});
