// [LDB-G4] Every binding/var the Worker actually reads is documented in
// README.md's secrets/bindings table, with a "how to regenerate" cell --
// derived from wrangler.toml and a grep over src/ (not hand-copied), so a
// new binding or var can't merge without a matching row.
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const DB_ROOT = path.resolve(import.meta.dirname, "..", "..");
const SRC = path.join(DB_ROOT, "src");
const WRANGLER_PATH = path.join(DB_ROOT, "wrangler.toml");
const README_PATH = path.join(DB_ROOT, "README.md");

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(full));
    else if (entry.name.endsWith(".ts")) out.push(full);
  }
  return out;
}

// wrangler.toml is small and flat here -- a couple of targeted regexes over
// it are simpler and less fragile than pulling in a TOML parser dependency
// for one test.
function wranglerBindingsAndVars(): string[] {
  const toml = fs.readFileSync(WRANGLER_PATH, "utf8");
  const bindings = [...toml.matchAll(/^\s*binding\s*=\s*"([^"]+)"/gm)].map((m) => m[1]!);
  const varsBlock = /\[vars\]\n([\s\S]*?)(?:\n\[|$)/.exec(toml)?.[1] ?? "";
  const vars = [...varsBlock.matchAll(/^([A-Za-z_][A-Za-z0-9_]*)\s*=/gm)].map((m) => m[1]!);
  return [...new Set([...bindings, ...vars])];
}

// Every `env.<UPPER_NAME>` read anywhere under src/ -- covers both `c.env.X`
// (route handlers) and the plain `env.X` the `scheduled()` parameter uses.
// Test-only wiring (TEST_ROUTES, TEST_MIGRATIONS, TEST_REHOST_DUMP_URL) is
// never read this way from `src/` (it's cast through an inline type or read
// only from `tests/`), so it's documented in the README by hand instead of
// being required here -- exactly 07 §6 S7's own distinction.
function envReadsInSrc(): string[] {
  const names = new Set<string>();
  for (const file of walk(SRC)) {
    const source = fs.readFileSync(file, "utf8");
    for (const m of source.matchAll(/\benv\.([A-Z][A-Z0-9_]*)\b/g)) names.add(m[1]!);
  }
  return [...names];
}

describe("README secrets/bindings table", () => {
  it("[LDB-G4] documents every wrangler.toml binding/var and every env.X read in src/, each with a regeneration line", () => {
    const readme = fs.readFileSync(README_PATH, "utf8");
    const required = new Set([...wranglerBindingsAndVars(), ...envReadsInSrc()]);
    expect(required.size).toBeGreaterThan(0);

    const missing: string[] = [];
    for (const name of required) {
      // A table row naming it, with a non-empty fourth ("how to
      // regenerate") column: `| \`NAME\` | kind | where | how |`.
      const rowRe = new RegExp(`^\\|\\s*\`${name}\`\\s*\\|[^|]+\\|[^|]+\\|\\s*([^|]+?)\\s*\\|\\s*$`, "m");
      const match = rowRe.exec(readme);
      if (!match || match[1]!.trim().length === 0) missing.push(name);
    }
    expect(
      missing,
      `README.md's bindings table is missing (or has no regeneration line for): ${missing.join(", ")}`,
    ).toEqual([]);
  });
});
