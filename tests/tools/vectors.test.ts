// [LDB-B4] (db-side half) tests/vectors/client-signing.json is frozen:
// `scripts/gen-vectors.mjs --check` recomputes every vector deterministically
// and diffs against the committed file, exiting 1 on any difference. This
// test runs that flag -- the freeze IS the diff, not a re-derivation of it.
import { execFileSync } from "node:child_process";
import path from "node:path";
import { describe, expect, it } from "vitest";

const DB_ROOT = path.resolve(import.meta.dirname, "..", "..");

describe("client-signing vectors are frozen", () => {
  it("[LDB-A4] `gen-vectors.mjs --check` reproduces tests/vectors/client-signing.json exactly", () => {
    expect(() =>
      execFileSync("node", ["scripts/gen-vectors.mjs", "--check"], { cwd: DB_ROOT, stdio: "pipe" }),
    ).not.toThrow();
  });
});
