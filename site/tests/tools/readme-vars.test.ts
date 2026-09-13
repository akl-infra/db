// [SITE-8] every var/secret the site Worker reads has a README row, and
// every README row names something actually read somewhere (the
// db/tests/tools/runbook.test.ts pattern, applied to this Worker's own
// wrangler.toml + server/**).
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const SITE_ROOT = path.resolve(import.meta.dirname, "..", "..");
const README = fs.readFileSync(path.join(SITE_ROOT, "README.md"), "utf8");
const WRANGLER_TOML = fs.readFileSync(path.join(SITE_ROOT, "wrangler.toml"), "utf8");

function walkServerSource(): string {
  const dir = path.join(SITE_ROOT, "server");
  let combined = "";
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.isFile() && entry.name.endsWith(".ts")) combined += fs.readFileSync(path.join(dir, entry.name), "utf8");
  }
  return combined;
}

const SERVER_SOURCE = walkServerSource();

// Every `[vars]` key in wrangler.toml, plus the secrets this Worker is
// documented to need (not present in wrangler.toml by design -- secrets are
// never committed).
const VARS_KEYS = [...WRANGLER_TOML.matchAll(/^(\w+)\s*=/gm)]
  .map((m) => m[1]!)
  .filter((k) => !["name", "main", "compatibility_date", "compatibility_flags", "directory", "not_found_handling", "run_worker_first", "enabled", "pattern", "custom_domain", "workers_dev"].includes(k));
const SECRET_KEYS = ["DISCORD_CLIENT_ID", "DISCORD_CLIENT_SECRET", "SESSION_SECRET"];

describe("[SITE-8] README documents every var/secret", () => {
  it("every [vars] key in wrangler.toml is read somewhere in server/ and has a README row", () => {
    for (const key of VARS_KEYS) {
      expect(README, `README.md missing a row for var '${key}'`).toContain(`\`${key}\``);
    }
  });

  it("every documented secret is actually read in server/ and has a README row", () => {
    for (const key of SECRET_KEYS) {
      expect(SERVER_SOURCE, `server/ never reads env.${key}`).toContain(`env.${key}`);
      expect(README, `README.md missing a row for secret '${key}'`).toContain(`\`${key}\``);
    }
  });

  it("the README documents no var/secret name that isn't real", () => {
    const documented = [...README.matchAll(/`([A-Z_]+)`/g)].map((m) => m[1]!);
    const known = new Set([...VARS_KEYS, ...SECRET_KEYS]);
    // Only check names that look like the var/secret table's own column
    // (all-caps, underscored) and appear in the vars/secrets table section.
    const tableSection = README.slice(README.indexOf("## Vars and secrets"), README.indexOf("## Local dev"));
    const tableNames = [...tableSection.matchAll(/`([A-Z_]+)`/g)].map((m) => m[1]!);
    for (const name of tableNames) {
      if (!documented.includes(name)) continue;
      expect(known.has(name), `README documents '${name}' which isn't a real var or secret`).toBe(true);
    }
  });
});
