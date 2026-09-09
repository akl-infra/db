// [LDB-C1] db.yml's shape is asserted from the parsed YAML, not grepped
// text -- the whole point of "check exit codes, not grep" (gates.sh's own
// header) applied to CI wiring: a passing job whose steps quietly don't do
// what the invariant claims is worse than an obviously-red one.
//
// S1 checks the `test` job + triggers + action pinning only. S7 extends
// this file to check the `deploy` job and the daily job (07 §7).
import fs from "node:fs";
import path from "node:path";
import { parse } from "yaml";
import { describe, expect, it } from "vitest";

const DB_ROOT = path.resolve(import.meta.dirname, "..", "..");
const REPO_ROOT = path.resolve(DB_ROOT, "..");
const WORKFLOW_PATH = path.join(REPO_ROOT, ".github", "workflows", "db.yml");

interface Step {
  uses?: string;
  run?: string;
  with?: Record<string, unknown>;
  [k: string]: unknown;
}
interface Job {
  "runs-on"?: string;
  needs?: string | string[];
  if?: string;
  defaults?: { run?: { "working-directory"?: string } };
  steps?: Step[];
  [k: string]: unknown;
}
interface Workflow {
  on?: Record<string, { paths?: string[] } | null>;
  jobs: Record<string, Job>;
}

function loadWorkflow(): Workflow {
  const text = fs.readFileSync(WORKFLOW_PATH, "utf8");
  return parse(text) as Workflow;
}

// Every `uses:` anywhere in the document -- walk it generically so a step
// added inside any job is covered without updating this test.
function collectUses(doc: unknown, out: string[] = []): string[] {
  if (Array.isArray(doc)) {
    for (const item of doc) collectUses(item, out);
  } else if (doc !== null && typeof doc === "object") {
    for (const [k, v] of Object.entries(doc)) {
      if (k === "uses" && typeof v === "string") out.push(v);
      else collectUses(v, out);
    }
  }
  return out;
}

describe("db.yml wiring", () => {
  it("[LDB-C1] triggers on pull_request and push, scoped to db/** and the workflow file", () => {
    const wf = loadWorkflow();
    for (const trigger of ["pull_request", "push"] as const) {
      const paths = wf.on?.[trigger]?.paths ?? [];
      expect(paths).toContain("db/**");
      expect(paths).toContain(".github/workflows/db.yml");
    }
  });

  it("[LDB-C1] the test job installs deps, typechecks and tests, working from db/", () => {
    const wf = loadWorkflow();
    const test = wf.jobs.test;
    expect(test, "no `test` job in db.yml").toBeDefined();
    if (!test) throw new Error("unreachable: assertion above failed");

    const workingDir =
      test.defaults?.run?.["working-directory"] ??
      test.steps?.find((s) => typeof s.run === "string")?.["working-directory"];
    expect(workingDir).toBe("db");

    const runs = (test.steps ?? []).map((s) => s.run).filter((r): r is string => typeof r === "string");
    expect(runs.some((r) => /\bnpm ci\b/.test(r))).toBe(true);
    expect(runs.some((r) => /\bnpm test\b/.test(r))).toBe(true);
    expect(runs.some((r) => /\bnpm run typecheck\b/.test(r))).toBe(true);

    const checkout = test.steps?.find((s) => s.uses?.startsWith("actions/checkout@"));
    expect(checkout, "no actions/checkout step").toBeDefined();
    expect(checkout?.with?.["fetch-depth"]).toBe(0);
  });

  it("[LDB-C1] every `uses:` is pinned to a major version only (no float, no SHA)", () => {
    const wf = loadWorkflow();
    const uses = collectUses(wf.jobs);
    expect(uses.length).toBeGreaterThan(0);
    for (const u of uses) {
      expect(u, `'${u}' is not pinned to a bare major (name@vN)`).toMatch(/^[^@]+@v\d+$/);
    }
  });
});
