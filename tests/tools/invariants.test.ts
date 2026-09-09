// [LDB-T1] Every id in INVARIANTS.md has >=1 tagged test; every `[LDB-*]`
// tag used in a test title names an id actually in the registry; no id is
// listed twice. This is the covenant's own enforcement mechanism (CLAUDE.md:
// "which invariant did this add, and where is it enforced?") -- a registry
// row with no test is exactly the failure mode it exists to catch.
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const DB_ROOT = path.resolve(import.meta.dirname, "..", "..");
const TESTS_DIR = path.join(DB_ROOT, "tests");
const REGISTRY_PATH = path.join(DB_ROOT, "INVARIANTS.md");

const ID_PATTERN = /^\|\s*(LDB-[A-Za-z0-9]+)\s*\|/;
const TAG_PATTERN = /\[LDB-[A-Za-z0-9]+\]/g;
const TEST_CALL = /\b(?:it|test)\(\s*(['"`])((?:(?!\1)[\s\S])*?)\1/g;
// A `*.test.ts` path inside backticks in the registry's own "enforced by"
// column -- the convention every row in INVARIANTS.md already follows.
const FILE_IN_CELL = /`([^`]+\.test\.ts)`/g;

function registryIds(): string[] {
  const lines = fs.readFileSync(REGISTRY_PATH, "utf8").split("\n");
  const ids: string[] = [];
  for (const line of lines) {
    const m = ID_PATTERN.exec(line);
    if (m?.[1] !== undefined) ids.push(m[1]);
  }
  return ids;
}

// Every row's (id, enforced-by files) pair -- the registry's own table is
// `| id | invariant | enforced by |`, so the LAST real cell (before the
// line's trailing empty split piece) is always "enforced by" regardless of
// how long the middle "invariant" cell's prose runs.
function registryRows(): { id: string; files: string[] }[] {
  const lines = fs.readFileSync(REGISTRY_PATH, "utf8").split("\n");
  const rows: { id: string; files: string[] }[] = [];
  for (const line of lines) {
    const m = ID_PATTERN.exec(line);
    if (m?.[1] === undefined) continue;
    const cells = line.split("|");
    const enforcedByCell = cells[cells.length - 2] ?? "";
    const files = [...enforcedByCell.matchAll(FILE_IN_CELL)].map((f) => f[1]!);
    rows.push({ id: m[1], files });
  }
  return rows;
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

// Every `[LDB-*]` tag appearing inside an `it(`/`test(` title, across every
// *.test.ts file under db/tests/.
function taggedIds(): Map<string, string[]> {
  const byId = new Map<string, string[]>();
  for (const file of walk(TESTS_DIR)) {
    const source = fs.readFileSync(file, "utf8");
    for (const call of source.matchAll(TEST_CALL)) {
      const title = call[2] ?? "";
      for (const tag of title.matchAll(TAG_PATTERN)) {
        const id = tag[0].slice(1, -1);
        const rel = path.relative(DB_ROOT, file);
        if (!byId.has(id)) byId.set(id, []);
        byId.get(id)!.push(rel);
      }
    }
  }
  return byId;
}

describe("db/INVARIANTS.md coverage", () => {
  it("[LDB-T1] has no id listed twice", () => {
    const ids = registryIds();
    const seen = new Set<string>();
    const dupes: string[] = [];
    for (const id of ids) {
      if (seen.has(id)) dupes.push(id);
      seen.add(id);
    }
    expect(dupes).toEqual([]);
  });

  it("[LDB-T1] every registry id has >=1 tagged test", () => {
    const ids = registryIds();
    const tagged = taggedIds();
    const missing = ids.filter((id) => !tagged.has(id));
    expect(missing).toEqual([]);
  });

  it("[LDB-T1] every tag used in a test title names a registered id", () => {
    const ids = new Set(registryIds());
    const tagged = taggedIds();
    const orphans = [...tagged.keys()].filter((id) => !ids.has(id));
    expect(orphans).toEqual([]);
  });

  // The reverse of "every registry id has >=1 tagged test" above: that test
  // only proves the tag exists SOMEWHERE under tests/, not in the specific
  // file(s) the row's own "enforced by" column names -- a row can drift
  // (the file gets renamed, or was never actually tagged) while the tag
  // survives untouched in some other file and the looser check keeps
  // passing. This one reads each row's own file list and requires the tag
  // inside THAT file.
  it("[LDB-T1] every file a registry row names actually carries that row's tag", () => {
    const rows = registryRows();
    const tagged = taggedIds();
    const drift: string[] = [];
    for (const { id, files } of rows) {
      const taggedFiles = new Set(tagged.get(id) ?? []);
      for (const file of files) {
        if (!taggedFiles.has(file)) drift.push(`${id}: '${file}' names it but carries no [${id}] tag`);
      }
    }
    expect(drift).toEqual([]);
  });
});
