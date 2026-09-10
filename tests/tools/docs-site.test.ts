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

const { hasSiteTree, repoRoot: REPO_ROOT } = repoLayout();
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
