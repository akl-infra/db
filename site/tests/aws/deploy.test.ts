// site/scripts/deploy-aws.mjs: it refuses any profile but akldb, and its dry run
// names the steps in the order that keeps a page from naming a missing asset.
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
// @ts-expect-error plain .mjs without types
import { AKLDB_ACCOUNT, profileOk, REGION } from "../../scripts/deploy-aws.mjs";

const SCRIPT = resolve(import.meta.dirname, "..", "..", "scripts", "deploy-aws.mjs");

/** A PATH whose `aws` (and `npm`, `npx`, `zip`) record that they were called and fail. */
function trapPath(): { dir: string; marker: string } {
  const dir = mkdtempSync(join(tmpdir(), "trap-"));
  const marker = join(dir, "CALLED");
  for (const bin of ["aws", "npm", "npx", "zip"]) {
    const f = join(dir, bin);
    writeFileSync(f, `#!/bin/sh\necho "${bin} $@" >> ${marker}\nexit 99\n`);
    chmodSync(f, 0o755);
  }
  return { dir, marker };
}

function run(args: string[], env: Record<string, string>) {
  const trap = trapPath();
  const r = spawnSync(process.execPath, [SCRIPT, ...args], {
    encoding: "utf8",
    env: { PATH: `${trap.dir}:/usr/bin:/bin`, HOME: process.env.HOME ?? "", ...env },
  });
  return { ...r, called: existsSync(trap.marker) };
}

describe("[LDB-SITE7] deploy-aws.mjs", () => {
  it("accepts only the akldb profile", () => {
    expect(profileOk({ AWS_PROFILE: "akldb" })).toBe(true);
    expect(profileOk({ AWS_VAULT: "akldb" })).toBe(true);
    expect(profileOk({})).toBe(false);
    expect(profileOk({ AWS_PROFILE: "akl" })).toBe(false);
    expect(profileOk({ AWS_PROFILE: "akl", AWS_VAULT: "akl" })).toBe(false);
  });

  it("refuses to run without it, and runs nothing", () => {
    for (const env of [{}, { AWS_PROFILE: "akl" }, { AWS_PROFILE: "default" }] as Record<string, string>[]) {
      const r = run(["lab", "--dry-run"], env);
      expect(r.status).toBe(1);
      expect(r.stderr).toContain("akldb");
      expect(r.called).toBe(false);
    }
  });

  it("names the account and region it is for", () => {
    expect(AKLDB_ACCOUNT).toBe("335937358231");
    expect(REGION).toBe("us-east-2");
  });

  it("needs a certificate on staging and prod", () => {
    const r = run(["prod", "--dry-run"], { AWS_PROFILE: "akldb" });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("CERTIFICATE_ARN");
  });

  it("dry run calls nothing and orders: stack, hashed assets, index.html, invalidation", () => {
    const r = run(["staging", "--dry-run"], { AWS_PROFILE: "akldb", CERTIFICATE_ARN: "arn:aws:acm:us-east-1:335937358231:certificate/abc" });
    expect(r.status).toBe(0);
    expect(r.called).toBe(false);
    const lines = r.stdout.trim().split("\n");
    const at = (needle: string) => lines.findIndex((l) => l.includes(needle));
    expect(at("cloudformation deploy")).toBeGreaterThan(-1);
    expect(at("s3 sync")).toBeGreaterThan(at("cloudformation deploy"));
    expect(at("index.html s3://")).toBeGreaterThan(at("s3 sync"));
    expect(at("create-invalidation")).toBeGreaterThan(at("index.html s3://"));
    expect(lines[at("s3 sync")]).toContain("--exclude index.html");
    expect(r.stdout).toContain("DbBaseUrl=https://staging-api.akldb.org");
    expect(r.stdout).not.toMatch(/OriginVerifyValue=(?!\*\*\*)/);
  });
});
