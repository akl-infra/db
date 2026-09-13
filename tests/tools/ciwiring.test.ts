// [LDB-C1] db.yml's shape is asserted from the parsed YAML, not grepped
// text -- the whole point of "check exit codes, not grep" (gates.sh's own
// header) applied to CI wiring: a passing job whose steps quietly don't do
// what the invariant claims is worse than an obviously-red one.
//
// S1 checked the `test` job + triggers + action pinning only. S7 extends
// this file to check the `deploy` job and the daily job (07 §7).
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { parse } from "yaml";
import { describe, expect, it } from "vitest";
import { repoLayout } from "./repo.ts";

const WORKFLOW_PATH = repoLayout().workflowPath;

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

  it("[LDB-C1] push runs only on main and the ldb-arch-review integration branch (other PR branches run once, on pull_request -- 2026-09-10, doubled runs and failure emails)", () => {
    const wf = loadWorkflow();
    const push = (wf.on as Record<string, { branches?: string[] }>).push;
    expect(push?.branches).toEqual(["main", "ldb-arch-review"]);
  });

  it("[LDB-C1] the deploy job needs test, runs only on a push to main, and applies migrations before deploying", () => {
    const wf = loadWorkflow();
    const deploy = wf.jobs.deploy;
    expect(deploy, "no `deploy` job in db.yml").toBeDefined();
    if (!deploy) throw new Error("unreachable: assertion above failed");

    expect(deploy.needs).toEqual(expect.stringContaining("test"));
    expect(deploy.if, "deploy job has no `if:` guard").toContain("refs/heads/main");
    expect(deploy.if).toContain("github.event_name == 'push'");

    const steps = deploy.steps ?? [];
    const runSteps = steps.filter((s): s is Step & { run: string } => typeof s.run === "string");
    const migrationsIdx = runSteps.findIndex((s) => /d1 migrations apply akl-db.*--remote/.test(s.run));
    const deployIdx = runSteps.findIndex((s) => /wrangler deploy/.test(s.run));
    expect(migrationsIdx, "no 'd1 migrations apply akl-db --remote' step").toBeGreaterThanOrEqual(0);
    expect(deployIdx, "no 'wrangler deploy' step").toBeGreaterThanOrEqual(0);
    expect(migrationsIdx, "migrations must run before deploy").toBeLessThan(deployIdx);

    // Both secrets referenced somewhere in the job (migrations and/or deploy
    // steps' `env:`) -- a deploy running with neither would just fail
    // remotely with no auth, silently past this check otherwise.
    const jobText = JSON.stringify(deploy);
    expect(jobText).toContain("CLOUDFLARE_DB_TOKEN");
    expect(jobText).toContain("CLOUDFLARE_DB_ACCOUNT_ID");
  });

  it("[LDB-C1] the pr-deploy job needs test, runs only on a push to the ldb-arch-review integration branch, and bookmarks, migrates and deploys the ONE layoutdb (prod akl-db) in that order", () => {
    // saltorbit 2026-09-11: "deploy to prod layoutdb" -- the preview layoutdb is
    // retired; 2026-09-12: the integration branch is ldb-arch-review and a push
    // there deploys production, never akl-db-preview.
    const wf = loadWorkflow();
    expect(wf.jobs.preview, "the retired preview job is back in db.yml").toBeUndefined();
    const job = wf.jobs["pr-deploy"];
    expect(job, "no `pr-deploy` job in db.yml").toBeDefined();
    if (!job) throw new Error("unreachable: assertion above failed");

    expect(job.needs).toEqual(expect.stringContaining("test"));
    expect(job.if, "pr-deploy job has no `if:` guard").toBeTruthy();
    expect(job.if).toContain("github.event_name == 'push'");
    expect(job.if).toContain("github.ref == 'refs/heads/ldb-arch-review'");
    expect((wf.on as Record<string, { branches?: string[] }>).push?.branches, "the integration branch must trigger the push run").toContain("ldb-arch-review");

    const steps = job.steps ?? [];
    const runSteps = steps.filter((s): s is Step & { run: string } => typeof s.run === "string");
    const bookmarkIdx = runSteps.findIndex((s) => /d1 time-travel info akl-db\b/.test(s.run));
    const migrationsIdx = runSteps.findIndex((s) => /d1 migrations apply akl-db --remote/.test(s.run));
    const deployIdx = runSteps.findIndex((s) => /wrangler deploy/.test(s.run));
    expect(bookmarkIdx, "no 'd1 time-travel info akl-db' (rollback bookmark) step").toBeGreaterThanOrEqual(0);
    expect(migrationsIdx, "no 'd1 migrations apply akl-db --remote' step").toBeGreaterThanOrEqual(0);
    expect(deployIdx, "no 'wrangler deploy' step").toBeGreaterThanOrEqual(0);
    expect(bookmarkIdx, "the bookmark must be taken before migrations").toBeLessThan(migrationsIdx);
    expect(migrationsIdx, "migrations must run before deploy").toBeLessThan(deployIdx);

    const jobText = JSON.stringify(job);
    expect(jobText).not.toContain("akl-db-preview");
    expect(jobText).not.toContain("--env preview");
    expect(jobText).toContain("CLOUDFLARE_DB_TOKEN");
    expect(jobText).toContain("CLOUDFLARE_DB_ACCOUNT_ID");
  });

  it("[LDB-C1] pr-deploy and deploy share one non-cancelling concurrency group (two prod deploys never interleave)", () => {
    const wf = loadWorkflow();
    for (const name of ["deploy", "pr-deploy"]) {
      const c = (wf.jobs[name] as { concurrency?: { group?: string; "cancel-in-progress"?: boolean } } | undefined)?.concurrency;
      expect(c?.group, name).toBe("db-prod-deploy");
      expect(c?.["cancel-in-progress"], name).toBe(false);
    }
  });

  it("[LDB-C1] the deploy job's `if:` is unchanged by the pr-deploy job (main-push only)", () => {
    const wf = loadWorkflow();
    const deploy = wf.jobs.deploy;
    expect(deploy?.if).toContain("refs/heads/main");
    expect(deploy?.if).toContain("github.event_name == 'push'");
    expect(deploy?.if).not.toContain("worktree-layout-db");
  });

  it("[LDB-C1] triggers on schedule and workflow_dispatch (for the daily job)", () => {
    const wf = loadWorkflow();
    expect(wf.on?.schedule, "no `schedule` trigger").toBeDefined();
    expect(wf.on?.workflow_dispatch !== undefined || "workflow_dispatch" in (wf.on ?? {})).toBe(true);
  });

  it("[LDB-C1] the daily job runs the rehost drill and the upstream diff, unguarded (S8 landed the file)", () => {
    const wf = loadWorkflow();
    const daily = wf.jobs.daily;
    expect(daily, "no `daily` job in db.yml").toBeDefined();
    if (!daily) throw new Error("unreachable: assertion above failed");

    // Never runs on a plain PR/push -- only schedule/workflow_dispatch.
    expect(daily.if, "daily job has no `if:` guard").toBeDefined();
    expect(daily.if).toContain("schedule");
    expect(daily.if).toContain("workflow_dispatch");

    const runs = (daily.steps ?? []).map((s) => s.run).filter((r): r is string => typeof r === "string");
    expect(runs.some((r) => /vitest run tests\/rehost\.test\.ts/.test(r)), "no rehost.test.ts step").toBe(true);
    expect(runs.some((r) => /vitest run tests\/upstream-diff\.test\.ts/.test(r)), "no upstream-diff.test.ts step").toBe(
      true,
    );

    // S8 landed `tests/upstream-diff.test.ts` for real -- the step must run
    // it directly now, no `[ -f ... ]`/"SKIP" guard (07 §6 S8: "no skip
    // semantics -- a skip nobody reads is a pass"; that guard was S7's
    // placeholder for a file S8 hadn't landed yet).
    const diffStep = runs.find((r) => /vitest run tests\/upstream-diff\.test\.ts/.test(r))!;
    expect(diffStep).not.toMatch(/-f tests\/upstream-diff\.test\.ts/);
    expect(diffStep.toUpperCase()).not.toContain("SKIP");
  });

  it("[LDB-C6] the daily job uploads the fetched dump as a 30-day-retention artifact, before the rehost drill runs", () => {
    const wf = loadWorkflow();
    const daily = wf.jobs.daily;
    expect(daily, "no `daily` job in db.yml").toBeDefined();
    if (!daily) throw new Error("unreachable: assertion above failed");

    const steps = daily.steps ?? [];
    const uploadIdx = steps.findIndex((s) => s.uses?.startsWith("actions/upload-artifact@"));
    expect(uploadIdx, "no actions/upload-artifact step in the daily job").toBeGreaterThanOrEqual(0);
    expect((steps[uploadIdx] as Step).with?.["retention-days"]).toBe(30);

    const rehostIdx = steps.findIndex((s) => typeof s.run === "string" && /vitest run tests\/rehost\.test\.ts/.test(s.run));
    expect(rehostIdx, "no rehost.test.ts step").toBeGreaterThanOrEqual(0);
    expect(uploadIdx, "the dump must be uploaded before the rehost drill can mutate/consume it").toBeLessThan(rehostIdx);

    // The uploaded path(s) actually name the fetched dump, not some
    // unrelated artifact -- a passing upload step that uploads nothing
    // useful would be worse than an obviously-missing one.
    const uploadWith = (steps[uploadIdx] as Step).with ?? {};
    const uploadPath = String(uploadWith.path ?? "");
    expect(uploadPath).toMatch(/dump.*\.gz/);
  });

  it("[LDB-C1] the site job does NOT wait on the db suite (own gate; LDB-G5 keeps it code-independent), runs from db/site, and builds+tests unconditionally", () => {
    const wf = loadWorkflow();
    const site = wf.jobs.site;
    expect(site, "no `site` job in db.yml").toBeDefined();
    if (!site) throw new Error("unreachable: assertion above failed");

    // 2026-09-13: deliberately independent of `test` -- see db.yml's comment.
    expect(site.needs).toBeUndefined();

    const workingDir =
      site.defaults?.run?.["working-directory"] ??
      site.steps?.find((s) => typeof s.run === "string")?.["working-directory"];
    expect(workingDir).toBe("db/site");

    const runSteps = (site.steps ?? []).filter((s): s is Step & { run: string } => typeof s.run === "string");
    const runs = runSteps.map((s) => s.run);
    expect(runs.some((r) => /\bnpm ci\b/.test(r))).toBe(true);
    expect(runs.some((r) => /\bnpm run typecheck\b/.test(r))).toBe(true);
    expect(runs.some((r) => /\bnpm test\b/.test(r))).toBe(true);
    expect(runs.some((r) => /\bnpm run build\b/.test(r))).toBe(true);

    // The build/test steps have no `if:` guard -- they run on every PR/push
    // this job triggers on, unlike the deploy step below.
    for (const step of runSteps) {
      if (/wrangler deploy/.test(step.run)) continue;
      expect(step.if, `step '${step.name ?? step.run}' should run unconditionally`).toBeUndefined();
    }
  });

  it("[LDB-C1] the site job's deploy step runs only on a push to ldb-arch-review, references both secrets, and shares no concurrency group with db-prod-deploy", () => {
    const wf = loadWorkflow();
    const site = wf.jobs.site;
    expect(site, "no `site` job in db.yml").toBeDefined();
    if (!site) throw new Error("unreachable: assertion above failed");

    const deployStep = (site.steps ?? []).find((s) => typeof s.run === "string" && /wrangler deploy/.test(s.run));
    expect(deployStep, "no 'wrangler deploy' step in the site job").toBeDefined();
    if (!deployStep) throw new Error("unreachable: assertion above failed");

    expect(deployStep.if, "the site job's deploy step has no `if:` guard").toBeTruthy();
    expect(deployStep.if).toContain("github.event_name == 'push'");
    expect(deployStep.if).toContain("github.ref == 'refs/heads/ldb-arch-review'");

    const stepText = JSON.stringify(deployStep);
    expect(stepText).toContain("CLOUDFLARE_DB_TOKEN");
    expect(stepText).toContain("CLOUDFLARE_DB_ACCOUNT_ID");

    const c = (site as { concurrency?: { group?: string; "cancel-in-progress"?: boolean } }).concurrency;
    expect(c?.group, "site job concurrency group").toBe("akldb-site-deploy");
    expect(c?.["cancel-in-progress"], "site job concurrency cancel-in-progress").toBe(false);
    expect(c?.group).not.toBe("db-prod-deploy");
  });

  it("[LDB-G6] the split-dry-run job needs test, runs weekly + on workflow_dispatch, and runs scripts/split/split-db.sh --dry-run", () => {
    const wf = loadWorkflow();
    const job = wf.jobs["split-dry-run"];
    expect(job, "no `split-dry-run` job in db.yml").toBeDefined();
    if (!job) throw new Error("unreachable: assertion above failed");

    const needs = Array.isArray(job.needs) ? job.needs : [job.needs];
    expect(needs).toContain("test");

    expect(job.if, "split-dry-run job has no `if:` guard").toBeDefined();
    expect(job.if).toContain("schedule");
    expect(job.if).toContain("workflow_dispatch");
    // Its own cron, not daily's -- a weekly job firing every day would be
    // a silent behavior change nothing here would ever catch otherwise.
    const schedules = (wf.on?.schedule as unknown as { cron: string }[] | undefined) ?? [];
    expect(schedules.length, "no `schedule` triggers at all").toBeGreaterThanOrEqual(2);
    const dailyCron = wf.jobs.daily?.if ?? "";
    const ownCron = schedules.map((s) => s.cron).find((cron) => !dailyCron.includes(cron));
    expect(ownCron, "no schedule distinct from daily's own cron").toBeDefined();
    expect(job.if).toContain(ownCron);

    const runs = (job.steps ?? []).map((s) => s.run).filter((r): r is string => typeof r === "string");
    expect(runs.some((r) => /sh scripts\/split\/split-db\.sh --dry-run/.test(r)), "no split-db.sh --dry-run step").toBe(
      true,
    );

    const checkout = job.steps?.find((s) => s.uses?.startsWith("actions/checkout@"));
    expect(checkout, "no actions/checkout step").toBeDefined();
    expect(checkout?.with?.["fetch-depth"], "needs full history to filter-repo").toBe(0);
  });

  // [LDB-G6] repoLayout()'s prefix logic (tests/tools/repo.ts, 12 §3 X5
  // item 5), unit-tested on both branches against a scratch temp dir --
  // the real proof that db/tests/tools/{ciwiring,boundary,frozen}.test.ts
  // and tests/api/fixture-export.test.ts run unchanged inside a split repo
  // is `scripts/split/split-db.sh --dry-run`'s own `split-dry-run` CI job,
  // which runs this file (and the other three) for real against a
  // filter-repo'd clone; this is the fast, offline half.
  it("[LDB-G6] repoLayout() reads db/'s prefix from a sibling web/, with and without one", () => {
    const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "ldb-repolayout-"));
    try {
      // With a sibling `web/` -- the monorepo shape this file's own DB_ROOT
      // sits in right now.
      const monorepoDb = path.join(scratch, "monorepo", "db");
      fs.mkdirSync(path.join(scratch, "monorepo", "web"), { recursive: true });
      fs.mkdirSync(monorepoDb, { recursive: true });
      const monorepo = repoLayout(monorepoDb);
      expect(monorepo.hasSiteTree).toBe(true);
      expect(monorepo.dbPrefix).toBe("db/");
      expect(monorepo.workflowPath).toBe(path.join(scratch, "monorepo", ".github", "workflows", "db.yml"));

      // No sibling `web/` -- what `db/` becomes once `git filter-repo`
      // renames it to the split repo's own root (item 6).
      const splitDb = path.join(scratch, "akl-db");
      fs.mkdirSync(splitDb, { recursive: true });
      const split = repoLayout(splitDb);
      expect(split.hasSiteTree).toBe(false);
      expect(split.dbPrefix).toBe("");
      expect(split.workflowPath).toBe(path.join(splitDb, ".github", "workflows", "ci.yml"));
    } finally {
      fs.rmSync(scratch, { recursive: true, force: true });
    }
  });
});
