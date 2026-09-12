// [LDB-G4] Every binding/var the Worker actually reads is documented in
// README.md's secrets/bindings table, with a "how to regenerate" cell --
// derived from wrangler.toml and a grep over src/ (not hand-copied), so a
// new binding or var can't merge without a matching row. LEDGER.md L4
// retired the `[env.preview]`-mirroring half of this row (LDB-C3) along
// with the block itself -- there is one layoutdb, production, and no
// `[env.*]` section left to check.
import fs from "node:fs";
import path from "node:path";
import { parse } from "smol-toml";
import { describe, expect, it } from "vitest";

const DB_ROOT = path.resolve(import.meta.dirname, "..", "..");
const SRC = path.join(DB_ROOT, "src");
const WRANGLER_PATH = path.join(DB_ROOT, "wrangler.toml");
const README_PATH = path.join(DB_ROOT, "README.md");

interface D1Binding {
  binding: string;
  database_name: string;
}
interface R2Binding {
  binding: string;
  bucket_name: string;
}
interface EnvBlock {
  d1_databases?: D1Binding[];
  r2_buckets?: R2Binding[];
  vars?: Record<string, string>;
}
interface WranglerToml extends EnvBlock {
  env?: Record<string, EnvBlock>;
}

function loadToml(): WranglerToml {
  return parse(fs.readFileSync(WRANGLER_PATH, "utf8")) as unknown as WranglerToml;
}

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(full));
    else if (entry.name.endsWith(".ts")) out.push(full);
  }
  return out;
}

function bindingsAndVars(block: EnvBlock): string[] {
  return [
    ...(block.d1_databases ?? []).map((d) => d.binding),
    ...(block.r2_buckets ?? []).map((r) => r.binding),
    ...Object.keys(block.vars ?? {}),
  ];
}

function wranglerBindingsAndVars(): string[] {
  return [...new Set(bindingsAndVars(loadToml()))];
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

  // LEDGER.md L4: there is one layoutdb, production -- wrangler.toml has no
  // `[env.*]` section any more, so this asserts its absence rather than
  // its shape (a re-added `[env.preview]` should fail loudly here, same
  // spirit as the deleted LDB-C3 suite it replaces).
  it("[LDB-G4] wrangler.toml declares no [env.*] section (one layoutdb, production)", () => {
    const toml = loadToml();
    expect(Object.keys(toml.env ?? {})).toEqual([]);
  });
});
