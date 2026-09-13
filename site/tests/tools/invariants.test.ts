// Every id in INVARIANTS.md has >=1 tagged test; every `[SITE-*]` tag used
// in a test title names an id actually in the registry; no id is listed
// twice. Same mechanism as db/tests/tools/invariants.test.ts's `LDB-T1`,
// scoped to this package's own `SITE-*` registry and `tests/` tree.
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const SITE_ROOT = path.resolve(import.meta.dirname, "..", "..");
const TESTS_DIR = path.join(SITE_ROOT, "tests");
const REGISTRY_PATH = path.join(SITE_ROOT, "INVARIANTS.md");

const ID_PATTERN = /^\|\s*(SITE-\d+)\s*\|/;
const TAG_PATTERN = /\[SITE-\d+\]/g;
const TEST_CALL = /\b(?:it|test|describe)\(\s*(['"`])((?:(?!\1)[\s\S])*?)\1/g;

function registryIds(): string[] {
  const lines = fs.readFileSync(REGISTRY_PATH, "utf8").split("\n");
  const ids: string[] = [];
  for (const line of lines) {
    const m = ID_PATTERN.exec(line);
    if (m?.[1] !== undefined) ids.push(m[1]);
  }
  return ids;
}

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(full));
    else if (entry.name.endsWith(".test.ts")) out.push(full);
  }
  return out;
}

// Every `[SITE-*]` tag appearing inside an `it(`/`test(`/`describe(` title,
// across every *.test.ts file under db/site/tests/. describe() is included
// (unlike the db/ version) because several of this package's suites tag
// the id once on the describe block and let individual `it()`s stay
// descriptive prose -- both styles are valid coverage.
function taggedIds(): Map<string, string[]> {
  const byId = new Map<string, string[]>();
  for (const file of walk(TESTS_DIR)) {
    const source = fs.readFileSync(file, "utf8");
    for (const call of source.matchAll(TEST_CALL)) {
      const title = call[2] ?? "";
      for (const tag of title.matchAll(TAG_PATTERN)) {
        const id = tag[0].slice(1, -1);
        const rel = path.relative(SITE_ROOT, file);
        if (!byId.has(id)) byId.set(id, []);
        byId.get(id)!.push(rel);
      }
    }
  }
  return byId;
}

describe("db/site/INVARIANTS.md coverage", () => {
  it("has no id listed twice", () => {
    const ids = registryIds();
    const seen = new Set<string>();
    const dupes: string[] = [];
    for (const id of ids) {
      if (seen.has(id)) dupes.push(id);
      seen.add(id);
    }
    expect(dupes).toEqual([]);
  });

  it("every registry id has >=1 tagged test", () => {
    const ids = registryIds();
    const tagged = taggedIds();
    const missing = ids.filter((id) => !tagged.has(id));
    expect(missing, `no tagged test found for: ${missing.join(", ")}`).toEqual([]);
  });

  it("every tag used in a test title names a real registry id", () => {
    const ids = new Set(registryIds());
    const tagged = taggedIds();
    const orphans = [...tagged.keys()].filter((id) => !ids.has(id));
    expect(orphans, `tag(s) with no registry row: ${orphans.join(", ")}`).toEqual([]);
  });
});
