// [LDB-F6] A format major, once merged, is immutable: its schema.json is
// never tightened and its fixtures are never edited (additions are fine --
// that's how a bug found in the wild becomes a permanent regression). Diffed
// against origin/main, not a local baseline, so the check is the same in CI
// and locally regardless of what branch you're on.
import { execSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { repoLayout } from "../tools/repo.ts";

// "db/formats" inside this monorepo; "formats" once db/ is the repo root
// itself (12 §3 X5 item 5 -- the split's own `--path-rename db/:` drops the
// prefix, so this file's `git diff` glob has to drop it too).
const { dbPrefix, repoRoot: REPO_ROOT } = repoLayout();
const FORMATS_REF = `${dbPrefix}formats`;

function originMainHasDbFormats(): boolean {
  try {
    execSync(`git cat-file -e origin/main:${FORMATS_REF}`, { cwd: REPO_ROOT, stdio: "ignore" });
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
      console.log(`[LDB-F6] SKIP: origin/main has no ${FORMATS_REF} yet -- nothing to freeze against`);
      expect(originMainHasDbFormats()).toBe(false);
      return;
    }

    const out = execSync(
      `git diff --name-only --diff-filter=MD origin/main -- '${FORMATS_REF}/*/*/schema.json' '${FORMATS_REF}/*/*/fixtures/'`,
      { cwd: REPO_ROOT, encoding: "utf8" },
    );
    const changed = out
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean);
    expect(changed).toEqual([]);
  });
});
