// [LDB-F6] A format major, once merged, is immutable: its schema.json is
// never tightened and its fixtures are never edited (additions are fine --
// that's how a bug found in the wild becomes a permanent regression).
//
// SUSPENDED by design/layout-db/21-formats.md D11 until layoutdb's first
// outside adopter: `spark/1` is edited in place (D5, D10, 23-geometry.md,
// 26-no-board.md) rather than frozen, so this test reads an explicit
// FROZEN list -- empty today -- instead of diffing every format against
// `origin/main`. The day a major is published to an outside client, its
// id goes into `FROZEN` and this test starts refusing edits to it. Diffed
// against origin/main, not a local baseline, so the check is the same in
// CI and locally regardless of what branch you're on.
import { execSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { repoLayout } from "../tools/repo.ts";

// Format majors whose schema.json and fixtures/ may never change again --
// `<name>/<major>` directory names under formats/ (e.g. "spark/1"). Empty
// until the first outside adopter (D11).
export const FROZEN: readonly string[] = [];

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
  it("[LDB-F6] no FROZEN major's schema.json or fixture is modified or deleted vs origin/main (the list is empty until the first outside adopter, D11)", () => {
    if (!originMainHasDbFormats()) {
      // Visible, not silent: a skip nobody reads is a pass (the
      // ci-gate-split-256 lesson).
      console.log(`[LDB-F6] SKIP: origin/main has no ${FORMATS_REF} yet -- nothing to freeze against`);
      expect(originMainHasDbFormats()).toBe(false);
      return;
    }
    if (FROZEN.length === 0) {
      console.log("[LDB-F6] no frozen majors yet (21-formats.md D11) -- every format is still edited in place");
    }

    const changed: string[] = [];
    for (const major of FROZEN) {
      const out = execSync(
        `git diff --name-only --diff-filter=MD origin/main -- '${FORMATS_REF}/${major}/schema.json' '${FORMATS_REF}/${major}/fixtures/'`,
        { cwd: REPO_ROOT, encoding: "utf8" },
      );
      changed.push(...out.split("\n").map((line) => line.trim()).filter(Boolean));
    }
    expect(changed).toEqual([]);
  });
});
