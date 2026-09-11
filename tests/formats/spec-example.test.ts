// [LDB-F24] db/tests/formats/spec-example.test.ts -- design/layout-db/
// 22-spark-spec.md's worked example (§7) is a REAL, schema-valid,
// validate()-passing spark/1 payload, extracted straight from the
// markdown -- never retyped here -- so the doc can never silently drift
// from what the code actually accepts. F1's own doc requirement
// (design/layout-db/21-formats.md): "a worked example validated by a test
// extracting example from markdown".
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { validate, type Payload } from "../../formats/spark/1/index.ts";
import { repoLayout } from "../tools/repo.ts";

const { hasSiteTree, repoRoot } = repoLayout();
const SPEC_PATH = path.join(repoRoot, "design", "layout-db", "22-spark-spec.md");

// Once db/ splits out of the monorepo (00-plan.md §7), design/layout-db/
// does not exist any more -- same skip signal db/tests/tools/
// docs-site.test.ts's LDB-G9 suite uses for the same reason.
function skipIfSplit(): boolean {
  if (hasSiteTree) return false;
  console.log("[LDB-F24] SKIP: no sibling web/ -- 22-spark-spec.md lives outside db/, which does not exist once db/ is the repo root");
  return true;
}

// The FIRST fenced ```json block strictly after the literal heading "## 7.
// Worked example" -- exact, not fuzzy, so a future doc edit that moves or
// removes the example fails loudly here rather than silently checking
// nothing.
function extractWorkedExample(md: string): unknown {
  const headingIdx = md.indexOf("## 7. Worked example");
  if (headingIdx === -1) throw new Error(`extractWorkedExample: heading '## 7. Worked example' not found in ${SPEC_PATH}`);
  const after = md.slice(headingIdx);
  const fenceMatch = /```json\n([^]*?)\n```/.exec(after);
  if (!fenceMatch) throw new Error(`extractWorkedExample: no \`\`\`json fenced block found after the heading in ${SPEC_PATH}`);
  return JSON.parse(fenceMatch[1]!);
}

describe("[LDB-F24] 22-spark-spec.md's worked example", () => {
  it("[LDB-F24] parses as JSON and validate()s as a valid spark/1 payload", () => {
    if (skipIfSplit()) {
      expect(hasSiteTree).toBe(false);
      return;
    }
    const md = fs.readFileSync(SPEC_PATH, "utf8");
    const example = extractWorkedExample(md);
    expect(validate(example)).toEqual({ ok: true });
  });

  it("[LDB-F24] matches the doc's own prose about it (the '@' key, the board, the free position)", () => {
    if (skipIfSplit()) {
      expect(hasSiteTree).toBe(false);
      return;
    }
    const md = fs.readFileSync(SPEC_PATH, "utf8");
    const example = extractWorkedExample(md) as Payload;

    // "@ sits at the top-left key, row 0, left ring finger"
    expect(example.keys["@"]).toEqual({ row: 0, col: 1, finger: "LR" });
    // "The board is ANSI-staggered ... and renders as cmini's "angle" word"
    expect(example.board).toEqual({ kind: "rowstag", stagger: [0, 0.25, 0.75], cmini: "angle" });
    // "typing n then @ lowers ... to a rule emitting nl"
    expect(example.magic?.magic_keys?.[0]).toMatchObject({ key: "@", rules: [{ after: "n", output: "nl" }] });
    // "The one free position is a hole in the layout"
    expect(example.free).toHaveLength(1);
  });
});
