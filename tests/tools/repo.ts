// repoLayout() (12 §3 X5 item 5): the one place that answers "am I sitting
// inside the cmini-web monorepo, or have I been split out to my own repo?"
// -- so tests/tools/{ciwiring,boundary,frozen}.test.ts and tests/api/
// fixture-export.test.ts (plus scripts/codeowners.mjs) run unchanged
// whether `db/` is a subdirectory of a bigger tree or the repo root itself
// (`scripts/split/split-db.sh --dry-run`'s own proof, LDB-G6, runs these
// same test files -- unedited -- inside the filter-repo'd clone). Probing
// for a sibling `web/` is the same signal `12 §0.7` names as this repo's
// own tell: the split moves `db/` out but never creates a `web/` next to
// wherever it lands.
import fs from "node:fs";
import path from "node:path";

export interface RepoLayout {
  // "db/" inside this monorepo (paths/globs that name db/'s own files from
  // repo root need the prefix); "" once db/ IS the repo root.
  dbPrefix: "db/" | "";
  // The git repo's own root: one level above db/ in the monorepo, db/
  // itself once split. Every caller that used to compute this as
  // `path.resolve(DB_ROOT, "..")` unconditionally had the same latent bug
  // repoLayout() exists to fix -- that climbs OUTSIDE the repo entirely
  // once db/ is the root.
  repoRoot: string;
  // .github/workflows/db.yml here; .github/workflows/ci.yml in the split
  // repo (the split script's own --path-rename, item 6).
  workflowPath: string;
  // true iff a `web/` directory sits next to this one -- the monorepo
  // signal.
  hasSiteTree: boolean;
}

// `dbRootOverride` is test-only (repoLayout(dir) against a scratch temp
// dir, rather than this file's own real location) -- every real caller
// calls repoLayout() with no argument.
export function repoLayout(dbRootOverride?: string): RepoLayout {
  const dbRoot = dbRootOverride ?? path.resolve(import.meta.dirname, "..", "..");
  const hasSiteTree = fs.existsSync(path.join(dbRoot, "..", "web"));
  const repoRoot = hasSiteTree ? path.resolve(dbRoot, "..") : dbRoot;
  const dbPrefix: RepoLayout["dbPrefix"] = hasSiteTree ? "db/" : "";
  const workflowName = hasSiteTree ? "db.yml" : "ci.yml";
  const workflowPath = path.join(repoRoot, ".github", "workflows", workflowName);
  return { dbPrefix, repoRoot, workflowPath, hasSiteTree };
}
