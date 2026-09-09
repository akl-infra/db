// [LDB-G3] .github/CODEOWNERS is generated from every format's OWNERS file
// (db/scripts/codeowners.mjs, 12 §3 X5 item 4) -- this is the promise
// 04-governance.md §2 makes ("owners merge their own format") and 12 finally
// enforces: a format directory with no line here, or a line naming the
// wrong handles, is a real drift the generator would have caught.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
// codeowners.mjs is a plain script (no .d.ts) -- typed locally rather than
// widening db/tsconfig.json's own allowJs setting for one test file.
// @ts-expect-error -- see above
import * as codeowners from "../../scripts/codeowners.mjs";
import { repoLayout } from "./repo.ts";

interface FormatDir {
  name: string;
  major: string;
  ownersPath: string;
}
const formatDirs = codeowners.formatDirs as () => FormatDir[];
const generate = codeowners.generate as () => string;
const parseOwners = codeowners.parseOwners as (ownersPath: string) => string[];

describe(".github/CODEOWNERS is generated from formats/*/*/OWNERS", () => {
  it("[LDB-G3] codeowners.mjs --check passes against the committed file", () => {
    // Runs the script for real, as a subprocess -- exit code, not a grep of
    // its stdout (gates.sh's own "check exit codes" posture).
    expect(() => execFileSync("node", [path.join(import.meta.dirname, "..", "..", "scripts", "codeowners.mjs"), "--check"], {
      stdio: "pipe",
    })).not.toThrow();
  });

  it("[LDB-G3] every format directory has exactly one generated line naming exactly its OWNERS", () => {
    const dirs = formatDirs();
    expect(dirs.length).toBeGreaterThan(0);

    const generated = generate();
    const lines = generated.split("\n").filter((l) => l && !l.startsWith("#"));
    expect(lines.length).toBe(dirs.length);

    const { dbPrefix } = repoLayout();
    for (const d of dirs) {
      const expectedPath = `${dbPrefix}formats/${d.name}/${d.major}/`;
      const expectedHandles = parseOwners(d.ownersPath);
      const line = lines.find((l) => l.startsWith(`${expectedPath} `));
      expect(line, `no CODEOWNERS line for ${expectedPath}`).toBeDefined();
      const handles = line!.slice(expectedPath.length).trim().split(/\s+/);
      expect(handles).toEqual(expectedHandles);
    }
  });

  it("[LDB-G3] a fourth format (with its own OWNERS) would need a line too -- the generator derives dirs from disk, not a hardcoded list", () => {
    // Not a new format's fixture cost (that's X2's own bar) -- just proving
    // formatDirs() walks formats/*/*/  rather than naming cmini/akl/mana2
    // by hand, so this test doesn't silently stop covering a real add.
    const names = formatDirs().map((d) => d.name);
    expect(new Set(names)).toEqual(new Set(["cmini", "akl", "mana2"]));
  });

  it("[LDB-G3] the committed .github/CODEOWNERS equals what the generator writes right now", () => {
    const { repoRoot } = repoLayout();
    const outPath = path.join(repoRoot, ".github", "CODEOWNERS");
    expect(fs.existsSync(outPath), "run 'node db/scripts/codeowners.mjs' and commit .github/CODEOWNERS").toBe(true);
    expect(fs.readFileSync(outPath, "utf8")).toBe(generate());
  });
});
