// [SITE-9] nothing under db/site/src|server imports db/src/** or
// db/formats/** (design/akldb-site/01-plan.md S9: the site is a client of
// the public wire only). Same static-regex-scan spirit as db/tests/tools/
// boundary.test.ts's LDB-G5 (which this file's sibling test extends per
// plan §4.7 item 16 to also scan db/site/src and db/site/server), resolving
// relative specifiers to a real path rather than string-matching.
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const SITE_ROOT = path.resolve(import.meta.dirname, "..", "..");
const DB_ROOT = path.resolve(SITE_ROOT, ".."); // db/
const FORBIDDEN = [path.join(DB_ROOT, "src"), path.join(DB_ROOT, "formats"), path.resolve(DB_ROOT, "..", "web", "src")];

const CODE_EXT = new Set([".ts", ".tsx", ".mjs", ".js"]);
const SKIP_DIRS = new Set(["node_modules", "dist", ".wrangler", "generated"]);

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

function extractSpecifiers(source: string): string[] {
  const specs: string[] = [];
  const patterns = [/\bfrom\s*["']([^"']+)["']/g, /\brequire\(\s*["']([^"']+)["']\s*\)/g, /\bimport\(\s*["']([^"']+)["']\s*\)/g];
  for (const re of patterns) {
    for (const m of source.matchAll(re)) specs.push(m[1]!);
  }
  return specs;
}

describe("[SITE-9] db/site is a client only", () => {
  it("nothing under src/ or server/ resolves an import into db/src, db/formats, or web/src", () => {
    const files = [...walk(path.join(SITE_ROOT, "src")), ...walk(path.join(SITE_ROOT, "server"))];
    expect(files.length).toBeGreaterThan(0);
    const violations: string[] = [];
    for (const file of files) {
      const source = fs.readFileSync(file, "utf8");
      for (const spec of extractSpecifiers(source)) {
        if (spec === "@akl/core" || spec.startsWith("@akl/core/")) {
          violations.push(`${path.relative(SITE_ROOT, file)}: imports '${spec}'`);
          continue;
        }
        if (!spec.startsWith(".")) continue; // bare specifier -- an npm package, not a boundary crossing
        const resolved = path.resolve(path.dirname(file), spec);
        for (const forbidden of FORBIDDEN) {
          if (resolved === forbidden || resolved.startsWith(forbidden + path.sep)) {
            violations.push(`${path.relative(SITE_ROOT, file)}: imports '${spec}' -> ${path.relative(DB_ROOT, resolved)}`);
          }
        }
      }
    }
    expect(violations).toEqual([]);
  });

  it("package.json declares no relative file: dependency out of db/site", () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(SITE_ROOT, "package.json"), "utf8")) as {
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };
    const all = { ...pkg.dependencies, ...pkg.devDependencies };
    for (const [name, version] of Object.entries(all)) {
      expect(version.includes("../"), `${name}: '${version}' looks like a relative file: link out of db/site`).toBe(false);
    }
  });
});
