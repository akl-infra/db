// [LDB-X1] The cmini importer is gone for good (2026-09-26, `CHANGELOG-API.md`
// 1.15) -- pine's own upstream (`https://clemenpine.com/layoutapi/v3`) has
// been permanently dead since 2026-09-15 (LDB-I27). This pins the removal:
// nothing under `db/src/`, `db/scripts/`, `db/site/src/` ever names that
// upstream again, and nothing there imports from a `src/import/` path (the
// directory itself is deleted -- an import of it would 404 at build time
// anyway, but this catches the same mistake in `.md`/`.json`-adjacent
// tooling that a bundler wouldn't). `formats/adapters/cmini/` (the kept,
// published format adapter) and `tests/` (the kept `upstream-100` fixtures,
// this file itself, and this repo's own decision docs/CHANGELOG, which
// legitimately narrate history) are OUT of scope on purpose -- see each
// check's own comment.
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const DB_ROOT = path.resolve(import.meta.dirname, "..", "..");
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

// The three trees a client, a script, or the site's own Worker could ever
// actually EXECUTE code from -- deliberately narrower than `db/` as a
// whole: `formats/adapters/cmini/` (the published adapter) legitimately
// imports nothing import-pipeline-specific (it never did -- 20-spark.md S1
// moved it out of the registry specifically because "cmini is an import
// source, not a format"), and `tests/` legitimately still fixtures/mentions
// cmini (the adapter's own tests, `upstream-100`, this file).
const SCOPES = ["src", "scripts", path.join("site", "src")];
// `site/src/generated/` is build OUTPUT (`site/scripts/build-docs.mjs`
// renders `docs/adoption.md` -- itself a historical doc, out of this
// check's scope on purpose -- into HTML) -- quoting history in generated
// documentation content is not the live-code reintegration this check
// exists to catch.
const EXCLUDE_DIRS = [path.join("site", "src", "generated")];

function inExcludedDir(file: string): boolean {
  const rel = path.relative(DB_ROOT, file);
  return EXCLUDE_DIRS.some((dir) => rel.startsWith(dir + path.sep));
}

describe("[LDB-X1] the cmini importer stays deleted", () => {
  it("[LDB-X1] nothing under src/, scripts/, or site/src/ imports from a 'src/import/' (or '../import/') path", () => {
    // Any specifier whose path component is literally `import` (a
    // directory segment, not e.g. `./important.ts` or a package named
    // `import-x`) -- matches the deleted `src/import/*` tree regardless of
    // how many `../` lead into it.
    const SPEC_PATTERN = /\bfrom\s*["']((?:\.\.?\/)*(?:[\w.-]+\/)*import\/[^"']+)["']/g;
    const offenders: string[] = [];
    for (const scope of SCOPES) {
      for (const file of walk(path.join(DB_ROOT, scope))) {
        if (inExcludedDir(file)) continue;
        const source = fs.readFileSync(file, "utf8");
        for (const m of source.matchAll(SPEC_PATTERN)) {
          offenders.push(`${path.relative(DB_ROOT, file)}: imports '${m[1]}'`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it("[LDB-X1] nothing under src/, scripts/, or site/src/ mentions clemenpine.com", () => {
    const offenders: string[] = [];
    for (const scope of SCOPES) {
      for (const file of walk(path.join(DB_ROOT, scope))) {
        if (inExcludedDir(file)) continue;
        const source = fs.readFileSync(file, "utf8");
        if (source.includes("clemenpine.com")) offenders.push(path.relative(DB_ROOT, file));
      }
    }
    expect(offenders).toEqual([]);
  });

  it("[LDB-X1] the deleted src/import/ directory does not exist", () => {
    expect(fs.existsSync(path.join(DB_ROOT, "src", "import"))).toBe(false);
  });
});
