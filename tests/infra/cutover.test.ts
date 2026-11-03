// [LDB-CV12] The template side of "prod awaits its image": AKLDB_AWAIT_IMAGE is on for prod (auto) on both functions,
// off for the other stages, and forceable either way.
import path from "node:path";
import { describe, expect, it } from "vitest";
import { loadTemplate, resolveStage } from "./checks";

const t = loadTemplate(path.resolve(import.meta.dirname, "..", "..", "infra", "akldb.yaml"));
const flag = (stage: string, extra: Record<string, string> = {}) => {
  const { resources } = resolveStage(t, stage, extra);
  return [resources.ApiFunction.Properties.Environment.Variables.AKLDB_AWAIT_IMAGE, resources.JobsFunction.Properties.Environment.Variables.AKLDB_AWAIT_IMAGE];
};

describe("AwaitImage (CV12)", () => {
  it("[LDB-CV12] auto means prod awaits its image on both functions and staging and shadow do not", () => {
    expect(t.Parameters.AwaitImage.Default).toBe("auto");
    expect(flag("prod")).toEqual(["1", "1"]);
    expect(flag("staging")).toEqual(["0", "0"]);
    expect(flag("shadow")).toEqual(["0", "0"]);
  });
  it("[LDB-CV12] 1 and 0 force it for any stage (the rehearsal turns it on for staging)", () => {
    expect(flag("staging", { AwaitImage: "1" })).toEqual(["1", "1"]);
    expect(flag("prod", { AwaitImage: "0" })).toEqual(["0", "0"]);
  });
});

describe("deploy-aws.sh passes AwaitImage (CV12)", () => {
  it("[LDB-CV12] the change set carries AwaitImage: auto by default, AWAIT_IMAGE overrides it, a bad value is refused", async () => {
    const { spawnSync } = await import("node:child_process");
    const fs = await import("node:fs");
    const os = await import("node:os");
    const ROOT = path.resolve(import.meta.dirname, "..", "..");
    const run = (env: Record<string, string>) => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), "akldb-await-"));
      try {
        fs.writeFileSync(path.join(dir, "aws"), "#!/bin/sh\nexit 99\n", { mode: 0o755 });
        return spawnSync("sh", [path.join(ROOT, "scripts", "deploy-aws.sh"), "--stage", "staging", "--dry-run"], { env: { PATH: `${dir}:${path.dirname(process.execPath)}:/usr/bin:/bin`, HOME: dir, ...env }, encoding: "utf8", cwd: dir });
      } finally {
        fs.rmSync(dir, { recursive: true });
      }
    };
    expect(run({}).stderr).toContain("ParameterKey=AwaitImage,ParameterValue=auto");
    expect(run({ AWAIT_IMAGE: "1" }).stderr).toContain("ParameterKey=AwaitImage,ParameterValue=1");
    const bad = run({ AWAIT_IMAGE: "yes" });
    expect(bad.status).toBe(2);
    expect(bad.stderr).toContain("AWAIT_IMAGE must be");
  });
});

describe("prod serves aws-api.akldb.org until the DNS step (CV15)", () => {
  it("[LDB-CV15] only prod may take aws-api.akldb.org as its DomainName, and the stack still serves exactly one hostname", () => {
    expect(t.Parameters.DomainName.AllowedValues).toContain("aws-api.akldb.org");
    const rule = JSON.stringify(t.Rules.HostMatchesStage.Assertions[0].Assert);
    expect(rule).toContain("aws-api.akldb.org");
    const pairs = t.Rules.HostMatchesStage.Assertions[0].Assert["Fn::Or"].map((a: any) => a["Fn::And"].map((e: any) => e["Fn::Equals"][1]));
    expect(pairs).toEqual([["staging", "staging-api.akldb.org"], ["shadow", "shadow-api.akldb.org"], ["prod", "api.akldb.org"], ["prod", "aws-api.akldb.org"]]);
    expect(Object.values(t.Resources).filter((r: any) => r.Type === "AWS::ApiGatewayV2::DomainName")).toHaveLength(1);
  });

  it("[LDB-CV15] deploy-aws.sh: DOMAIN_NAME=aws-api.akldb.org on prod uses the akldb-cert-aws-api stack; any other value, or another stage, keeps its own host", async () => {
    const { spawnSync } = await import("node:child_process");
    const fs = await import("node:fs");
    const os = await import("node:os");
    const ROOT = path.resolve(import.meta.dirname, "..", "..");
    const run = (stage: string, env: Record<string, string>) => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), "akldb-domain-"));
      try {
        fs.writeFileSync(path.join(dir, "aws"), "#!/bin/sh\nexit 99\n", { mode: 0o755 });
        return spawnSync("sh", [path.join(ROOT, "scripts", "deploy-aws.sh"), "--stage", stage, "--dry-run"], { env: { PATH: `${dir}:${path.dirname(process.execPath)}:/usr/bin:/bin`, HOME: dir, ...env }, encoding: "utf8", cwd: dir });
      } finally {
        fs.rmSync(dir, { recursive: true });
      }
    };
    const aws = run("prod", { DOMAIN_NAME: "aws-api.akldb.org" });
    expect(aws.status).toBe(0);
    expect(aws.stderr).toContain("ParameterKey=DomainName,ParameterValue=aws-api.akldb.org");
    expect(aws.stderr).toContain("'--stack-name' 'akldb-cert-aws-api'");
    const plain = run("prod", {});
    expect(plain.stderr).toContain("ParameterKey=DomainName,ParameterValue=api.akldb.org");
    expect(plain.stderr).toContain("'--stack-name' 'akldb-cert-prod'");
    const bad = run("prod", { DOMAIN_NAME: "evil.akldb.org" });
    expect(bad.status).toBe(2);
    expect(bad.stderr).toContain("DOMAIN_NAME must be api.akldb.org or aws-api.akldb.org");
    expect(run("staging", { DOMAIN_NAME: "aws-api.akldb.org" }).stderr).toContain("ParameterKey=DomainName,ParameterValue=staging-api.akldb.org");
  });
});
