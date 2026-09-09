// [LDB-G4] Every binding/var the Worker actually reads is documented in
// README.md's secrets/bindings table, with a "how to regenerate" cell --
// derived from wrangler.toml and a grep over src/ (not hand-copied), so a
// new binding or var can't merge without a matching row. T7
// (09-implementation-phase2.md §3) extends this over `[env.preview]`: every
// `[env.*]` section must declare the same binding names and var keys as the
// top level (Wrangler environments don't inherit them -- a binding present
// at the top level and silently missing under an env block would deploy
// that env's Worker with the binding undefined at runtime), and its D1/R2
// resource names must be named in the README so a reader knows what
// `akl-db-preview`/`akl-db-dumps-preview` (etc.) actually are.
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

  it("[LDB-G4] every [env.*] section redeclares the same binding names and var keys as the top level", () => {
    const toml = loadToml();
    const topNames = new Set(bindingsAndVars(toml));
    expect(topNames.size).toBeGreaterThan(0);

    const envs = toml.env ?? {};
    expect(Object.keys(envs).length, "no [env.*] section in wrangler.toml").toBeGreaterThan(0);

    for (const [envName, block] of Object.entries(envs)) {
      const envNames = new Set(bindingsAndVars(block));
      const missing = [...topNames].filter((n) => !envNames.has(n));
      const extra = [...envNames].filter((n) => !topNames.has(n));
      expect(missing, `[env.${envName}] is missing: ${missing.join(", ")}`).toEqual([]);
      expect(extra, `[env.${envName}] declares names the top level doesn't have: ${extra.join(", ")}`).toEqual([]);
    }
  });

  it("[LDB-G4] every [env.*] D1/R2 resource name is named in the README", () => {
    const readme = fs.readFileSync(README_PATH, "utf8");
    const toml = loadToml();
    const envs = toml.env ?? {};
    expect(Object.keys(envs).length, "no [env.*] section in wrangler.toml").toBeGreaterThan(0);

    const missing: string[] = [];
    for (const block of Object.values(envs)) {
      for (const name of [
        ...(block.d1_databases ?? []).map((d) => d.database_name),
        ...(block.r2_buckets ?? []).map((r) => r.bucket_name),
      ]) {
        if (!readme.includes(name)) missing.push(name);
      }
    }
    expect(missing, `README.md never names: ${missing.join(", ")}`).toEqual([]);
  });
});
