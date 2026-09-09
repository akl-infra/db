// [LDB-G5] Nothing under db/ resolves an import outside db/, and nothing
// outside db/ resolves an import inside it. Static regex scan, not a type
// checker -- deliberately simple so it stays fast and has no deps of its
// own. Reading files outside db/ here is test-time verification, not a
// runtime import, so it doesn't itself violate the boundary it checks.
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const DB_ROOT = path.resolve(import.meta.dirname, "..", "..");
const REPO_ROOT = path.resolve(DB_ROOT, "..");

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

  it("[LDB-G5] nothing under web/src, scripts, functions, workers, tools imports a db/ path", () => {
    const dirs = ["web/src", "scripts", "functions", "workers", "tools"].map((d) =>
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
});
