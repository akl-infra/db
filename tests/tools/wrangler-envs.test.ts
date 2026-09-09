// [LDB-C3] `[env.preview]` in wrangler.toml redeclares every top-level
// binding and var with the preview resource names -- Wrangler environments
// do NOT inherit d1_databases/r2_buckets/vars/triggers (09-implementation-
// phase2.md §3 T7), so a binding present at the top level and silently
// missing under `[env.preview]` would deploy a preview Worker with a
// binding undefined at runtime, not a Worker pointed at the wrong resource.
// Parsed with a real TOML parser (smol-toml) rather than regexes, since this
// test's whole job is structural (bindings/keys present, values differ),
// not textual.
import fs from "node:fs";
import path from "node:path";
import { parse } from "smol-toml";
import { describe, expect, it } from "vitest";

const DB_ROOT = path.resolve(import.meta.dirname, "..", "..");
const WRANGLER_PATH = path.join(DB_ROOT, "wrangler.toml");

interface D1Binding {
  binding: string;
  database_name: string;
  database_id: string;
}
interface R2Binding {
  binding: string;
  bucket_name: string;
}
interface EnvBlock {
  name?: string;
  d1_databases?: D1Binding[];
  r2_buckets?: R2Binding[];
  triggers?: { crons?: string[] };
  vars?: Record<string, string>;
}
interface WranglerToml extends EnvBlock {
  env?: Record<string, EnvBlock>;
}

function loadToml(): WranglerToml {
  return parse(fs.readFileSync(WRANGLER_PATH, "utf8")) as unknown as WranglerToml;
}

describe("wrangler.toml [env.preview] mirrors the top level", () => {
  it("[LDB-C3] declares a preview environment named akl-db-preview", () => {
    const toml = loadToml();
    const preview = toml.env?.preview;
    expect(preview, "no [env.preview] block in wrangler.toml").toBeDefined();
    expect(preview!.name).toBe("akl-db-preview");
  });

  it("[LDB-C3] redeclares every top-level D1 binding, with a different database (name and id)", () => {
    const toml = loadToml();
    const top = toml.d1_databases ?? [];
    const preview = toml.env?.preview?.d1_databases ?? [];
    expect(top.length).toBeGreaterThan(0);
    expect(preview.length).toBe(top.length);

    const topByBinding = new Map(top.map((d) => [d.binding, d]));
    const previewByBinding = new Map(preview.map((d) => [d.binding, d]));
    expect([...previewByBinding.keys()].sort()).toEqual([...topByBinding.keys()].sort());

    for (const [binding, topDb] of topByBinding) {
      const previewDb = previewByBinding.get(binding)!;
      expect(previewDb, `no preview D1 for binding '${binding}'`).toBeDefined();
      // Same binding name, but a genuinely different resource -- a preview
      // that silently pointed at the production database_id would make
      // "the preview DB is the only DB the site's phase-2 work writes to"
      // (09 §3 T7) false.
      expect(previewDb.database_name, `preview D1 for '${binding}' reuses the production database_name`).not.toBe(
        topDb.database_name,
      );
      expect(previewDb.database_id, `preview D1 for '${binding}' reuses the production database_id`).not.toBe(
        topDb.database_id,
      );
    }
  });

  it("[LDB-C3] redeclares every top-level R2 binding, with a different bucket", () => {
    const toml = loadToml();
    const top = toml.r2_buckets ?? [];
    const preview = toml.env?.preview?.r2_buckets ?? [];
    expect(top.length).toBeGreaterThan(0);
    expect(preview.length).toBe(top.length);

    const topByBinding = new Map(top.map((r) => [r.binding, r]));
    const previewByBinding = new Map(preview.map((r) => [r.binding, r]));
    expect([...previewByBinding.keys()].sort()).toEqual([...topByBinding.keys()].sort());

    for (const [binding, topBucket] of topByBinding) {
      const previewBucket = previewByBinding.get(binding)!;
      expect(previewBucket, `no preview R2 for binding '${binding}'`).toBeDefined();
      expect(previewBucket.bucket_name, `preview R2 for '${binding}' reuses the production bucket_name`).not.toBe(
        topBucket.bucket_name,
      );
    }
  });

  it("[LDB-C3] redeclares every top-level var key with the same value", () => {
    const toml = loadToml();
    const top = toml.vars ?? {};
    const preview = toml.env?.preview?.vars ?? {};
    expect(Object.keys(top).length).toBeGreaterThan(0);
    // "the same vars" (09 §3 T7) -- these are config the Worker's code
    // reads identically regardless of environment (import tuning, the
    // Discord API origin); only the bound resources differ per environment.
    expect(preview).toEqual(top);
  });

  it("[LDB-C3] redeclares the same crons", () => {
    const toml = loadToml();
    expect(toml.env?.preview?.triggers?.crons).toEqual(toml.triggers?.crons);
  });

  it("[LDB-C3] no top-level binding, var key or cron is missing from [env.preview]", () => {
    const toml = loadToml();
    const preview = toml.env?.preview ?? {};

    const topBindings = new Set([
      ...(toml.d1_databases ?? []).map((d) => d.binding),
      ...(toml.r2_buckets ?? []).map((r) => r.binding),
    ]);
    const previewBindings = new Set([
      ...(preview.d1_databases ?? []).map((d) => d.binding),
      ...(preview.r2_buckets ?? []).map((r) => r.binding),
    ]);
    const missingBindings = [...topBindings].filter((b) => !previewBindings.has(b));
    expect(missingBindings, `[env.preview] is missing binding(s): ${missingBindings.join(", ")}`).toEqual([]);

    const topVarKeys = new Set(Object.keys(toml.vars ?? {}));
    const previewVarKeys = new Set(Object.keys(preview.vars ?? {}));
    const missingVars = [...topVarKeys].filter((k) => !previewVarKeys.has(k));
    expect(missingVars, `[env.preview.vars] is missing key(s): ${missingVars.join(", ")}`).toEqual([]);

    expect(preview.triggers?.crons, "[env.preview.triggers] has no crons").toBeDefined();
  });
});
