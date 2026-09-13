// [LDB-G5] Nothing under db/ resolves an import outside db/, and nothing
// outside db/ resolves an import inside it. Static regex scan, not a type
// checker -- deliberately simple so it stays fast and has no deps of its
// own. Reading files outside db/ here is test-time verification, not a
// runtime import, so it doesn't itself violate the boundary it checks.
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { repoLayout } from "./repo.ts";

const DB_ROOT = path.resolve(import.meta.dirname, "..", "..");
const { hasSiteTree, repoRoot: REPO_ROOT } = repoLayout();

const CODE_EXT = new Set([".ts", ".tsx", ".mjs", ".js", ".cjs"]);
const SKIP_DIRS = new Set(["node_modules", ".git", "dist", "test-results"]);

function walk(dir: string): string[] {
  if (!fs.existsSync(dir)) return [];
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (SKIP_DIRS.has(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(full));
    else if (CODE_EXT.has(path.extname(entry.name))) out.push(full);
  }
  return out;
}

// Every `import ... from "spec"`, bare `import "spec"`, dynamic
// `import("spec")` and `require("spec")` specifier in a source string.
function extractSpecifiers(source: string): string[] {
  const specs: string[] = [];
  const patterns = [
    /\bfrom\s*["']([^"']+)["']/g,
    /\brequire\(\s*["']([^"']+)["']\s*\)/g,
    /\bimport\(\s*["']([^"']+)["']\s*\)/g,
    /^\s*import\s*["']([^"']+)["']/gm,
  ];
  for (const re of patterns) {
    for (const m of source.matchAll(re)) {
      const spec = m[1];
      if (spec !== undefined) specs.push(spec);
    }
  }
  return specs;
}

describe("db/ import boundary", () => {
  it("[LDB-G5] nothing under db/src, db/formats, db/scripts resolves outside db/", () => {
    const files = [
      ...walk(path.join(DB_ROOT, "src")),
      ...walk(path.join(DB_ROOT, "formats")),
      ...walk(path.join(DB_ROOT, "scripts")),
    ];
    expect(files.length).toBeGreaterThan(0);

    const violations: string[] = [];
    for (const file of files) {
      const source = fs.readFileSync(file, "utf8");
      for (const spec of extractSpecifiers(source)) {
        if (!spec.startsWith(".")) continue; // bare specifier -- an npm package, not a boundary crossing
        const resolvedDir = path.resolve(path.dirname(file), spec);
        if (!resolvedDir.startsWith(DB_ROOT + path.sep) && resolvedDir !== DB_ROOT) {
          violations.push(`${path.relative(REPO_ROOT, file)}: imports '${spec}' -> outside db/`);
        }
      }
    }
    expect(violations).toEqual([]);
  });

  it("[LDB-G5] nothing under web/src, scripts, functions, workers, tools, bot/src imports a db/ path", () => {
    if (!hasSiteTree) {
      // Visible, not silent (the ci-gate-split-256 lesson): once db/ is the
      // repo root there is no sibling tree left to scan -- this is exactly
      // the split repo's own shape, not a gap.
      console.log("[LDB-G5] SKIP: no sibling web/ -- db/ is the repo root, nothing outside it to scan");
      expect(hasSiteTree).toBe(false);
      return;
    }
    // `bot/src` joins the scan (12 §3 X5 item 3): it used to import
    // db/formats/** BY PATH (tsconfig `@formats/*`, LDB-B6's narrow named
    // exception) and so had to stay excluded here or this test would have
    // fought that exception; it then briefly consumed a real
    // `file:`-linked package (`@akl/layout-formats`) instead. **2026-09-13
    // (saltorbit: "the bot is a third-party client of the layout DB like any
    // other"): that package is GONE -- bot/src reaches db/ by neither path
    // nor package any more, ever (`db/` is moving to its own repo soon;
    // "no favoritism holds in code").** `bot/src/spark/format.ts` is the
    // bot's own hand-maintained reading of the public spark/1 wire format
    // instead. `bot/tests` now largely gets the SAME guarantee via bot's own
    // boundary test (LDB-B6, tightened the same day) rather than this one --
    // with ONE deliberate, gated exception that test itself carves out:
    // `bot/tests/tools/sparkFormatParity.test.ts` (LDB-B334), which compares
    // the bot's copy of a few pure geometry functions against db's own while
    // db/ still happens to be a sibling directory, skipping cleanly once it
    // isn't. `db/site/src`, `db/site/server` join too (design/akldb-site/
    // 01-plan.md §4.7 item 16): they sit INSIDE db/, but the site is meant
    // to be a client of the public wire like any outside adopter, so this
    // scan's "does anything reach into a db/ implementation path" question
    // applies to them for symmetry even though they aren't literally
    // outside the directory.
    const dirs = ["web/src", "scripts", "functions", "workers", "tools", "bot/src", "db/site/src", "db/site/server"].map((d) =>
      path.join(REPO_ROOT, d),
    );
    const files = dirs.flatMap((d) => walk(d));

    const violations: string[] = [];
    for (const file of files) {
      const source = fs.readFileSync(file, "utf8");
      for (const spec of extractSpecifiers(source)) {
        if (spec.includes("/db/") || spec.includes("db/formats") || /(^|\/)db$/.test(spec)) {
          violations.push(`${path.relative(REPO_ROOT, file)}: imports '${spec}'`);
        }
      }
    }
    expect(violations).toEqual([]);
  });

  it("[LDB-G5] nothing under db/site/src or db/site/server resolves into db/src/** or db/formats/** (the site is a client)", () => {
    // db/site/** is inside db/, so an fs READ of db/docs/adoption.md
    // (scripts/build-docs.mjs, S8) is not a crossing at all -- and isn't
    // caught by this regex scan anyway (it's a plain `fs.readFileSync`
    // call, never an `import`/`require` specifier). What this narrower
    // check catches is the site's frontend/server code reaching into the
    // DB's own IMPLEMENTATION (db/src, db/formats) by relative path instead
    // of treating it as a normal outside adopter would: the public wire
    // only. `db/site`'s own package.json declares no dependency on either.
    const files = [...walk(path.join(DB_ROOT, "site", "src")), ...walk(path.join(DB_ROOT, "site", "server"))];
    expect(files.length).toBeGreaterThan(0);

    const forbidden = [path.join(DB_ROOT, "src"), path.join(DB_ROOT, "formats")];
    const violations: string[] = [];
    for (const file of files) {
      const source = fs.readFileSync(file, "utf8");
      for (const spec of extractSpecifiers(source)) {
        if (!spec.startsWith(".")) continue; // bare specifier -- an npm package, not a boundary crossing
        const resolved = path.resolve(path.dirname(file), spec);
        for (const forbiddenDir of forbidden) {
          if (resolved === forbiddenDir || resolved.startsWith(forbiddenDir + path.sep)) {
            violations.push(`${path.relative(REPO_ROOT, file)}: imports '${spec}' -> ${path.relative(DB_ROOT, resolved)}`);
          }
        }
      }
    }
    expect(violations).toEqual([]);
  });
});
