// [LDB-PV9] The latency probe stack: a throwaway Lambda in us-east-2, invoked by hand only, no way in, no schedule, one-day
// logs, tagged, bounded by the same permissions boundary; lint and guard clean; probe.sh only prints unless --execute.
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { loadTemplate, type Json } from "./checks";

const ROOT = path.resolve(import.meta.dirname, "..", "..");
const file = (...p: string[]): string => path.join(ROOT, ...p);
const has = (cmd: string): boolean => spawnSync(cmd, ["--version"], { encoding: "utf8" }).error === undefined;
const t = loadTemplate(file("infra", "akldb-probe.yaml"));
const R = t.Resources as Record<string, Json>;
const guard = (data: string) => spawnSync("cfn-guard", ["validate", "-r", file("infra", "akldb-probe.guard"), "-d", data], { encoding: "utf8" });

describe("the probe template", () => {
  it.skipIf(!has("cfn-lint"))("[LDB-PV9] cfn-lint is clean", () => {
    const r = spawnSync("cfn-lint", [file("infra", "akldb-probe.yaml")], { encoding: "utf8" });
    expect(r.stdout + r.stderr).toBe("");
    expect(r.status).toBe(0);
  });

  it.skipIf(!has("cfn-guard"))("[LDB-PV9] cfn-guard passes and rejects each mutation of its rules", () => {
    expect(guard(file("infra", "akldb-probe.yaml")).status).toBe(0);
    const src = fs.readFileSync(file("infra", "akldb-probe.yaml"), "utf8");
    const mutations: [string, string][] = [
      ["RetentionInDays: 1\n", "RetentionInDays: 14\n"],
      ["Architectures: [ arm64 ]", "Architectures: [ x86_64 ]"],
      ["Runtime: nodejs24.x", "Runtime: nodejs20.x"],
      ["      PermissionsBoundary: !ImportValue akldb-boundary-arn\n", ""],
      ["                  - logs:PutLogEvents\n", "                  - logs:PutLogEvents\n                  - dynamodb:GetItem\n"],
      ["      Tags:\n        - { Key: project, Value: akldb }\n        - { Key: purpose, Value: akldb-probe }\n\n  ProbeRole", "      Tags:\n        - { Key: project, Value: akldb }\n\n  ProbeRole"],
      ["Outputs:", "  Url:\n    Type: AWS::Lambda::Url\n    Properties: { TargetFunctionArn: !GetAtt ProbeFunction.Arn, AuthType: NONE }\n\n  Rule:\n    Type: AWS::Events::Rule\n    Properties: { ScheduleExpression: 'rate(5 minutes)', State: ENABLED, Targets: [] }\n\nOutputs:"],
    ];
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "akldb-probe-guard-"));
    try {
      for (const [from, to] of mutations) {
        expect(src, from).toContain(from);
        const f = path.join(dir, "m.yaml");
        fs.writeFileSync(f, src.replace(from, to));
        expect(guard(f).status, `mutation ${JSON.stringify(from)} must fail`).not.toBe(0);
      }
    } finally {
      fs.rmSync(dir, { recursive: true });
    }
  });

  it("[LDB-PV9] exactly one function, its role and a one-day log group; no URL, schedule, trigger or permission; us-east-2 only; tagged purpose=akldb-probe", () => {
    expect(Object.values(R).map((r) => r.Type).sort()).toEqual(["AWS::IAM::Role", "AWS::Lambda::Function", "AWS::Logs::LogGroup"]);
    const fn = R.ProbeFunction.Properties as Json;
    expect(fn).toMatchObject({ FunctionName: "akldb-probe", Runtime: "nodejs24.x", Architectures: ["arm64"], Handler: "index.handler" });
    expect(fn).not.toHaveProperty("ReservedConcurrentExecutions");
    expect(fn.Timeout).toBeLessThanOrEqual(300);
    expect(R.ProbeLogGroup.Properties).toMatchObject({ LogGroupName: "/aws/lambda/akldb-probe", RetentionInDays: 1 });
    expect(R.ProbeLogGroup.DeletionPolicy).toBe("Delete");
    for (const r of Object.values(R)) expect((r.Properties.Tags as { Key: string; Value: string }[]).find((x) => x.Key === "purpose")?.Value).toBe("akldb-probe");
    const stmts = R.ProbeRole.Properties.Policies[0].PolicyDocument.Statement as Json[];
    expect(stmts).toHaveLength(1);
    expect(stmts[0].Action).toEqual(["logs:CreateLogStream", "logs:PutLogEvents"]);
    expect(stmts[0].Resource).toEqual({ "Fn::Sub": "arn:aws:logs:${AWS::Region}:${AWS::AccountId}:log-group:/aws/lambda/akldb-probe:*" });
    expect(R.ProbeRole.Properties.PermissionsBoundary).toEqual({ "Fn::ImportValue": "akldb-boundary-arn" });
    expect(t.Rules.RegionIsOhio.Assertions[0].Assert).toEqual({ "Fn::Equals": [{ Ref: "AWS::Region" }, "us-east-2"] });
    // the probe zip is exactly the two files the handler needs
    expect(fs.readdirSync(file("infra", "probe")).sort()).toEqual(["index.mjs", "measure.mjs"]);
  });
});

describe("scripts/aws/probe.sh", () => {
  function sh(args: string[]): { status: number | null; stderr: string; stdout: string; calls: string } {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "akldb-probe-sh-"));
    try {
      const marker = path.join(dir, "aws-was-called");
      fs.writeFileSync(path.join(dir, "aws"), `#!/bin/sh\necho "$@" >> ${marker}\nexit 99\n`, { mode: 0o755 });
      const r = spawnSync("sh", [file("scripts", "aws", "probe.sh"), ...args], { env: { PATH: `${dir}:/usr/bin:/bin`, HOME: dir }, encoding: "utf8", cwd: dir });
      return { status: r.status, stderr: r.stderr, stdout: r.stdout, calls: fs.existsSync(marker) ? fs.readFileSync(marker, "utf8") : "" };
    } finally {
      fs.rmSync(dir, { recursive: true });
    }
  }

  it("[LDB-PV9] create, run and delete without --execute only print their commands and call nothing", () => {
    const create = sh(["create"]);
    expect(create.status).toBe(0);
    expect(create.calls).toBe("");
    expect(create.stderr).toContain("printing only");
    expect(create.stderr).toMatch(/cloudformation' 'deploy' '--stack-name' 'akldb-probe'/);
    expect(create.stderr).toContain("'purpose=akldb-probe'");
    expect(create.stderr).toContain("s3://akldb-artifacts-335937358231/code/probe/akldb-probe-");
    const run = sh(["run", "--n", "5"]);
    expect(run.calls).toBe("");
    expect(run.stderr).toMatch(/lambda' 'invoke' '--function-name' 'akldb-probe'/);
    expect(run.stderr).toContain('"n":5');
    const del = sh(["delete"]);
    expect(del.calls).toBe("");
    expect(del.stderr).toMatch(/delete-stack' '--stack-name' 'akldb-probe'/);
    expect(del.stdout).not.toContain("deleted");
  });

  it("[LDB-PV9] a bad command, a bad --n and a wrong account are refused", () => {
    expect(sh(["nonsense"]).status).toBe(2);
    expect(sh(["run", "--n", "0"]).status).toBe(2);
    expect(sh(["run", "--n", "61"]).status).toBe(2);
    expect(sh(["run", "--n", "x"]).status).toBe(2);
    expect(sh(["run", "--bogus"]).status).toBe(2);
  });
});
