// [LDB-F24] db/tests/formats/spec-example.test.ts -- design/layout-db/
// 22-spark-spec.md's worked examples (§11) are REAL, schema-valid,
// validate()-passing spark/1 payloads, extracted straight from the
// markdown -- never retyped here -- so the doc can never silently drift
// from what the code actually accepts. F1's own doc requirement
// (design/layout-db/21-formats.md): "a worked example validated by a test
// extracting example from markdown".
//
// Rewritten for the 24-spark-wire-review.md skeleton's §11 "Worked
// examples" (plural): the doc now carries three complete payloads (plain
// + duplicate + tagged magic; iso + free position + thumb; colstag + six
// thumb keys), each pulled from its own fenced ```json block in reading
// order, each validated independently.
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

// Every fenced ```json block strictly after the literal heading "## 11.
// Worked examples", in reading order -- exact, not fuzzy, so a future doc
// edit that moves, removes or truncates the examples fails loudly here
// rather than silently checking nothing (or checking fewer than intended).
function extractWorkedExamples(md: string): unknown[] {
  const headingIdx = md.indexOf("## 11. Worked examples");
  if (headingIdx === -1) throw new Error(`extractWorkedExamples: heading '## 11. Worked examples' not found in ${SPEC_PATH}`);
  const after = md.slice(headingIdx);
  const fenceRe = /```json\n([^]*?)\n```/g;
  const examples: unknown[] = [];
  let m: RegExpExecArray | null;
  while ((m = fenceRe.exec(after)) !== null) {
    examples.push(JSON.parse(m[1]!));
  }
  if (examples.length === 0) throw new Error(`extractWorkedExamples: no \`\`\`json fenced blocks found after the heading in ${SPEC_PATH}`);
  return examples;
}

describe("[LDB-F24] 22-spark-spec.md's worked examples (§11)", () => {
  it("[LDB-F24] carries exactly three examples, each parsing as JSON and validate()ing as a valid spark/1 payload", () => {
    if (skipIfSplit()) {
      expect(hasSiteTree).toBe(false);
      return;
    }
    const md = fs.readFileSync(SPEC_PATH, "utf8");
    const examples = extractWorkedExamples(md);
    expect(examples).toHaveLength(3);
    for (const example of examples) {
      expect(validate(example)).toEqual({ ok: true });
    }
  });

  it("[LDB-F24] example 1 matches the doc's own prose (the '@' key, the board, the duplicate 'e', the free position)", () => {
    if (skipIfSplit()) {
      expect(hasSiteTree).toBe(false);
      return;
    }
    const md = fs.readFileSync(SPEC_PATH, "utf8");
    const example = extractWorkedExamples(md)[0] as Payload;

    // "@ sits at row 0, left ring finger"
    expect(example.keys.find((k) => k.char === "@")).toEqual({ char: "@", row: 0, col: 1, finger: "LR" });
    expect(example.board).toBe("ansi");
    // "typing n then @ lowers to a rule emitting nl"
    expect(example.magic?.magic_keys?.[0]).toMatchObject({ key: "@", rules: [{ after: "n", output: "nl" }] });
    // "'e' has two entries ... a duplicate character"
    expect(example.keys.filter((k) => k.char === "e")).toHaveLength(2);
    // "The entry with no char ... is a free position"
    expect(example.keys.filter((k) => k.char === undefined)).toHaveLength(1);
  });

  it("[LDB-F24] example 2 is iso with a free position and a thumb key", () => {
    if (skipIfSplit()) {
      expect(hasSiteTree).toBe(false);
      return;
    }
    const md = fs.readFileSync(SPEC_PATH, "utf8");
    const example = extractWorkedExamples(md)[1] as Payload;

    expect(example.board).toBe("iso");
    expect(example.keys.some((k) => k.char === undefined)).toBe(true);
    expect(example.keys.some((k) => k.finger === "LT")).toBe(true);
  });

  it("[LDB-F24] example 3 is colstag with six thumb keys, three per side", () => {
    if (skipIfSplit()) {
      expect(hasSiteTree).toBe(false);
      return;
    }
    const md = fs.readFileSync(SPEC_PATH, "utf8");
    const example = extractWorkedExamples(md)[2] as Payload;

    expect(example.board).toBe("colstag");
    expect(example.keys.filter((k) => k.finger === "LT")).toHaveLength(3);
    expect(example.keys.filter((k) => k.finger === "RT")).toHaveLength(3);
  });
});
