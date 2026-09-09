// [LDB-F6] A format major, once merged, is immutable: its schema.json is
// never tightened and its fixtures are never edited (additions are fine --
// that's how a bug found in the wild becomes a permanent regression). Diffed
// against origin/main, not a local baseline, so the check is the same in CI
// and locally regardless of what branch you're on.
import { execSync } from "node:child_process";
import path from "node:path";
import { describe, expect, it } from "vitest";

const REPO_ROOT = path.resolve(import.meta.dirname, "..", "..", "..");

function originMainHasDbFormats(): boolean {
  try {
    execSync("git cat-file -e origin/main:db/formats", { cwd: REPO_ROOT, stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

describe("frozen format majors", () => {
  it("[LDB-F6] no schema.json or fixture is modified or deleted vs origin/main", () => {
    if (!originMainHasDbFormats()) {
      // Visible, not silent: a skip nobody reads is a pass (the
      // ci-gate-split-256 lesson). This is exactly the S2 state -- db/formats
      // hasn't merged to main yet, so there is nothing to freeze against.
      console.log("[LDB-F6] SKIP: origin/main has no db/formats yet -- nothing to freeze against");
      expect(originMainHasDbFormats()).toBe(false);
      return;
    }

    const out = execSync(
      "git diff --name-only --diff-filter=MD origin/main -- 'db/formats/*/*/schema.json' 'db/formats/*/*/fixtures/'",
      { cwd: REPO_ROOT, encoding: "utf8" },
    );
    const changed = out
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean);
    expect(changed).toEqual([]);
  });
});
