// LDB-AX1..AX6 (design A, phase C): the CloudFormation templates, the cfn-guard rules, the deploy script's order and
// the CI file. No AWS call is made anywhere in this file. cfn-lint and cfn-guard run when they are installed
// (`pip install cfn-lint`, `brew install cloudformation-guard`); the node twin of every rule runs regardless.
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { ALARMS_EVERY_STAGE, ALARMS_PROD_ONLY, alarmsFor, expectedResources, loadTemplate, policyDocs, resolveStage, violations, type Json } from "./checks";

const ROOT = path.resolve(import.meta.dirname, "..", "..");
const file = (...p: string[]) => path.join(ROOT, ...p);
const t = loadTemplate(file("infra", "akldb.yaml"));
const cert = loadTemplate(file("infra", "akldb-cert.yaml"));
const boot = loadTemplate(file("infra", "akldb-bootstrap.yaml"));
const stages = ["staging", "shadow", "prod"];
const clone = <T>(x: T): T => structuredClone(x);
const list = (x: Json): Json[] => (Array.isArray(x) ? x : [x]);
const has = (cmd: string): boolean => spawnSync(cmd, ["--version"], { encoding: "utf8" }).error === undefined;

function guard(args: string[]) {
  return spawnSync("cfn-guard", ["validate", "-r", file("infra", "akldb.guard"), ...args], { encoding: "utf8" });
}

describe("template lint and guard (AX1)", () => {
  it.skipIf(!has("cfn-lint"))("[LDB-AX1] cfn-lint is clean on all three templates", () => {
    const r = spawnSync("cfn-lint", [file("infra", "akldb.yaml"), file("infra", "akldb-cert.yaml"), file("infra", "akldb-bootstrap.yaml")], { encoding: "utf8" });
    expect(r.stdout + r.stderr).toBe("");
    expect(r.status).toBe(0);
  });

  it.skipIf(!has("cfn-guard"))("[LDB-AX1] cfn-guard passes the stack and the certificate template, and rejects each mutation", () => {
    expect(guard(["-d", file("infra", "akldb.yaml")]).status).toBe(0);
    expect(guard(["-d", file("infra", "akldb-cert.yaml")]).status).toBe(0);
    const src = fs.readFileSync(file("infra", "akldb.yaml"), "utf8");
    const mutations: [string, string][] = [
      ["Runtime: nodejs24.x", "Runtime: nodejs20.x"],
      ["Architectures: [ arm64 ]", "Architectures: [ x86_64 ]"],
      ["- dynamodb:GetItem\n", "- dynamodb:*\n"],
      ["      RoleName: !Sub akldb-${Stage}-api\n      PermissionsBoundary: !ImportValue akldb-boundary-arn\n", "      RoleName: !Sub akldb-${Stage}-api\n"],
      ["      PermissionsBoundary: !ImportValue akldb-boundary-arn\n", "      PermissionsBoundary: arn:aws:iam::335937358231:policy/other\n"],
      ["PointInTimeRecoveryEnabled: true", "PointInTimeRecoveryEnabled: false"],
      ["DeletionProtectionEnabled: true", "DeletionProtectionEnabled: false"],
      ["DeletionProtectionEnabled: false", "DeletionProtectionEnabled: true"],
      ["    Condition: IsProd\n    DeletionPolicy: Retain\n    UpdateReplacePolicy: Retain\n    Properties:\n      TableName", "    Condition: IsProd\n    DeletionPolicy: Delete\n    UpdateReplacePolicy: Delete\n    Properties:\n      TableName"],
      ["    Condition: NotProd\n    DeletionPolicy: Delete\n    UpdateReplacePolicy: Delete\n    Properties:\n      BucketName", "    Condition: NotProd\n    DeletionPolicy: Retain\n    UpdateReplacePolicy: Retain\n    Properties:\n      BucketName"],
      ["      RetentionInDays: 14\n", "      RetentionInDays: 30\n"],
      ["DisableExecuteApiEndpoint: true", "DisableExecuteApiEndpoint: false"],
      ["LogGroupClass: STANDARD", "LogGroupClass: INFREQUENT_ACCESS"],
      ["FilterPattern: '\"akldb-alarm:\"'", "FilterPattern: '\"alarm\"'"],
      ["VersioningConfiguration: { Status: Enabled }", "VersioningConfiguration: { Status: Suspended }"],
      ["BlockPublicPolicy: true", "BlockPublicPolicy: false"],
      ["SSEAlgorithm: AES256", "SSEAlgorithm: aws:kms"],
      ["    Condition: IsProd\n    Properties:\n      Budget:", "    Properties:\n      Budget:"],
      ["        Arn: !Ref LiveAlias\n        RoleArn: !GetAtt SchedulerRole.Arn\n        Input: '{\"akldb\":\"tick\"}'", "        Arn: !GetAtt ApiFunction.Arn\n        RoleArn: !GetAtt SchedulerRole.Arn\n        Input: '{\"akldb\":\"tick\"}'"],
    ];
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "akldb-guard-"));
    try {
      for (const [from, to] of mutations) {
        expect(src, from).toContain(from);
        const f = path.join(dir, "m.yaml");
        fs.writeFileSync(f, src.replace(from, to));
        expect(guard(["-d", f]).status, `guard accepted: ${from} -> ${to}`).not.toBe(0);
      }
    } finally {
      fs.rmSync(dir, { recursive: true });
    }
  });

  it("[LDB-AX1] each stage creates exactly the listed resources, and nothing a hand could have made is outside the templates", () => {
    for (const s of stages) expect(Object.keys(resolveStage(t, s).resources).sort(), s).toEqual(expectedResources(s));
    // every resource in the three templates is a CloudFormation resource; the only things made by hand are the IAM user
    // akldb-ci, the SSM parameters and the Cloudflare records (design/aws-a-ops.md), none of which a template can hold.
    for (const tpl of [t, cert, boot]) for (const r of Object.values<Json>(tpl.Resources)) expect(r.Type).toMatch(/^AWS::/);
  });

  it("[LDB-AX1] every stage passes the structural checks, with and without a reservation", () => {
    for (const s of stages) {
      expect(violations(t, s), s).toEqual([]);
      expect(violations(t, s, { ReservedConcurrency: "3" }), s).toEqual([]);
    }
  });

  it("[LDB-AX1] the template is plain CloudFormation in the project Region, and every stage has its own hostname", () => {
    const text = fs.readFileSync(file("infra", "akldb.yaml"), "utf8");
    expect(text).not.toMatch(/^[^#\n]*\s&\w+/m);
    for (const tpl of [t, cert, boot]) expect(tpl.Rules.RegionIsOhio.Assertions[0].Assert["Fn::Equals"][1]).toBe("us-east-2");
    expect(t.Parameters.DomainName.AllowedValues).toEqual(["staging-api.akldb.org", "shadow-api.akldb.org", "api.akldb.org"]);
    expect(cert.Parameters.DomainName.AllowedValues).toEqual(t.Parameters.DomainName.AllowedValues);
    expect(cert.Resources.Certificate.Properties.ValidationMethod).toBe("DNS");
    expect(cert.Outputs.CertificateArn.Value).toEqual({ Ref: "Certificate" });
    expect(Object.keys(t.Outputs).sort()).toEqual(["AlarmTopicArn", "AliasArn", "ApiDomainHostedZoneId", "ApiDomainTarget", "DataBucket", "FunctionName", "LogTable"].sort());
    expect(t.Outputs.ApiDomainTarget.Value).toEqual({ "Fn::GetAtt": ["CustomDomain", "RegionalDomainName"] });
  });

  it("[LDB-AX1] rejected mutations: a VPC, CloudFront, a Function URL, a wildcard action, Resource *, a second table", () => {
    const m1 = clone(t);
    m1.Resources.ApiFunction.Properties.VpcConfig = { SubnetIds: ["subnet-1"], SecurityGroupIds: ["sg-1"] };
    expect(violations(m1, "prod").some((x) => /VpcConfig/.test(x))).toBe(true);
    const m2 = clone(t);
    m2.Resources.Vpc = { Type: "AWS::EC2::VPC", Properties: { CidrBlock: "10.0.0.0/16" } };
    m2.Resources.Cdn = { Type: "AWS::CloudFront::Distribution", Properties: {} };
    m2.Resources.Url = { Type: "AWS::Lambda::Url", Properties: {} };
    const v2 = violations(m2, "prod");
    expect(v2.some((x) => /EC2/.test(x)) && v2.some((x) => /CloudFront/.test(x)) && v2.some((x) => /Function URL/.test(x))).toBe(true);
    const m3 = clone(t);
    m3.Resources.ApiRole.Properties.Policies[0].PolicyDocument.Statement[1].Action = ["dynamodb:*"];
    expect(violations(m3, "prod").some((x) => /wildcard action/.test(x))).toBe(true);
    const m4 = clone(t);
    m4.Resources.ApiRole.Properties.Policies[0].PolicyDocument.Statement[1].Resource = "*";
    expect(violations(m4, "prod").some((x) => /Resource \*/.test(x))).toBe(true);
    const m5 = clone(t);
    m5.Resources.Second = clone(m5.Resources.LogTable);
    expect(violations(m5, "prod").some((x) => /DynamoDB tables/.test(x))).toBe(true);
  });

  it("[LDB-AX1] prod keeps its state (Retain, deletion protection, no expiry); staging and shadow are deletable, so their stacks delete and recreate", () => {
    const prod = resolveStage(t, "prod").resources;
    expect([prod.LogTable.DeletionPolicy, prod.LogTable.UpdateReplacePolicy, prod.LogTable.Properties.DeletionProtectionEnabled]).toEqual(["Retain", "Retain", true]);
    expect([prod.DataBucket.DeletionPolicy, prod.DataBucket.UpdateReplacePolicy, prod.LogGroup.DeletionPolicy]).toEqual(["Retain", "Retain", "Retain"]);
    for (const s of ["staging", "shadow"]) {
      const R = resolveStage(t, s).resources;
      expect([R.LogTable.DeletionPolicy, R.LogTable.UpdateReplacePolicy, R.LogTable.Properties.DeletionProtectionEnabled], s).toEqual(["Delete", "Delete", false]);
      expect([R.DataBucket.DeletionPolicy, R.DataBucket.UpdateReplacePolicy, R.LogGroup.DeletionPolicy], s).toEqual(["Delete", "Delete", "Delete"]);
      // the table keeps its name, and its PITR, so a recreate under the same name works once the old one is gone
      expect(R.LogTable.Properties.TableName).toEqual({ "Fn::Sub": "akldb-${Stage}-log" });
      expect(R.LogTable.Properties.PointInTimeRecoverySpecification.PointInTimeRecoveryEnabled).toBe(true);
    }
    // exactly one of each pair exists per stage
    for (const [stage, ids] of [["prod", ["LogTable", "DataBucket", "LogGroup"]], ["staging", ["LogTableDev", "DataBucketDev", "LogGroupDev"]], ["shadow", ["LogTableDev", "DataBucketDev", "LogGroupDev"]]] as const) {
      const live = (id: string) => !t.Resources[id].Condition || (t.Resources[id].Condition === "IsProd") === (stage === "prod");
      expect(ids.every(live), stage).toBe(true);
      expect([...ids].every((id) => id.endsWith("Dev") === (stage !== "prod")), stage).toBe(true);
    }
  });

  it("[LDB-AX1] rejected mutations: prod without PITR, protection or Retain; staging protected or retained; the bucket unversioned, public or expiring current objects", () => {
    const m = clone(t);
    m.Resources.LogTable.Properties.PointInTimeRecoverySpecification.PointInTimeRecoveryEnabled = false;
    m.Resources.LogTable.Properties.DeletionProtectionEnabled = false;
    delete m.Resources.LogTable.DeletionPolicy;
    const v = violations(m, "prod");
    expect(v.some((x) => /PITR off/.test(x)) && v.some((x) => /deletion protection/.test(x)) && v.some((x) => /not Retain/.test(x))).toBe(true);
    const d = clone(t);
    d.Resources.LogTableDev.Properties.DeletionProtectionEnabled = true;
    d.Resources.DataBucketDev.DeletionPolicy = "Retain";
    d.Resources.LogGroupDev.DeletionPolicy = "Retain";
    const vd = violations(d, "staging");
    expect(vd.some((x) => /deletion protection outside prod/.test(x)) && vd.some((x) => /not Delete/.test(x)) && vd.some((x) => /LogGroup: DeletionPolicy Retain/.test(x))).toBe(true);
    const b = clone(t);
    b.Resources.DataBucket.Properties.VersioningConfiguration.Status = "Suspended";
    b.Resources.DataBucket.Properties.PublicAccessBlockConfiguration.RestrictPublicBuckets = false;
    b.Resources.DataBucket.Properties.LifecycleConfiguration.Rules[0].ExpirationInDays = 30;
    const vb = violations(b, "prod");
    expect(vb.some((x) => /not versioned/.test(x)) && vb.some((x) => /RestrictPublicBuckets/.test(x)) && vb.some((x) => /expires current objects/.test(x))).toBe(true);
    const c = clone(t);
    c.Resources.DataBucketPolicy.Properties.PolicyDocument.Statement = [];
    expect(violations(c, "prod").some((x) => /TLS-only/.test(x))).toBe(true);
  });

  it("[LDB-AX1] rejected mutations: wrong runtime, architecture or size; an invoke grant on the function instead of the alias", () => {
    const m = clone(t);
    m.Resources.ApiFunction.Properties.Runtime = "nodejs20.x";
    m.Resources.ApiFunction.Properties.Architectures = ["x86_64"];
    m.Resources.ApiFunction.Properties.MemorySize = 1024;
    const v = violations(m, "prod");
    expect(v.some((x) => /runtime/.test(x)) && v.some((x) => /arm64/.test(x)) && v.some((x) => /memory/.test(x))).toBe(true);
    const g = clone(t);
    g.Resources.SchedulerRole.Properties.Policies[0].PolicyDocument.Statement[0].Resource = { "Fn::GetAtt": ["ApiFunction", "Arn"] };
    expect(violations(g, "prod").some((x) => /other than the live alias/.test(x))).toBe(true);
  });

  it("[LDB-AX1] the bootstrap role is assumable only by akldb-ci, acts only on akldb-* names, and cannot touch users, OIDC or stack deletion", () => {
    const role = boot.Resources.DeployRole.Properties;
    expect(role.RoleName).toBe("akldb-deploy");
    expect(role.MaxSessionDuration).toBe(3600);
    expect(role.AssumeRolePolicyDocument.Statement).toHaveLength(1);
    expect(role.AssumeRolePolicyDocument.Statement[0].Principal.AWS["Fn::Sub"]).toBe("arn:aws:iam::${AWS::AccountId}:user/akldb-ci");
    const stmts = role.Policies[0].PolicyDocument.Statement as Json[];
    const allow = stmts.filter((s) => s.Effect === "Allow");
    const actions = allow.flatMap((s) => list(s.Action));
    for (const forbidden of ["cloudformation:DeleteStack", "iam:CreateUser", "iam:CreateAccessKey", "iam:CreateOpenIDConnectProvider", "iam:AttachRolePolicy", "iam:PutUserPolicy", "iam:CreatePolicy", "iam:CreatePolicyVersion", "iam:DeleteRolePermissionsBoundary", "sts:AssumeRole"]) {
      expect(actions, forbidden).not.toContain(forbidden);
    }
    expect(actions.filter((a: string) => /^iam:/.test(a)).every((a: string) => /Role|PassRole/.test(a))).toBe(true);
    expect(actions.filter((a: string) => a.includes("*"))).toEqual(["lambda:*"]);
    // Resource "*" only for the actions AWS cannot scope.
    const star = allow.filter((s) => list(s.Resource).includes("*")).flatMap((s) => list(s.Action)).sort();
    expect(star).toEqual(["acm:AddTagsToCertificate", "acm:DescribeCertificate", "acm:ListTagsForCertificate", "acm:RequestCertificate", "cloudformation:ValidateTemplate", "cloudwatch:DescribeAlarms", "logs:DescribeLogGroups"]);
    for (const s of allow.filter((x) => !list(x.Resource).includes("*"))) {
      for (const r of list(s.Resource)) {
        const text = typeof r === "string" ? r : JSON.stringify(r);
        expect(text, s.Sid).toMatch(/akldb-|ArtifactsBucket|\/apis|\/domainnames|\/tags/);
      }
    }
    const ci = JSON.parse(fs.readFileSync(file("infra", "iam-akldb-ci.json"), "utf8"));
    expect(ci.UserName).toBe("akldb-ci");
    expect(ci.Policy.Statement).toEqual([{ Sid: "AssumeDeployRoleOnly", Effect: "Allow", Action: "sts:AssumeRole", Resource: "arn:aws:iam::335937358231:role/akldb-deploy" }]);
    const art = boot.Resources.ArtifactsBucket;
    expect(art.Properties.VersioningConfiguration.Status).toBe("Enabled");
    expect(art.Properties.BucketEncryption.ServerSideEncryptionConfiguration[0].ServerSideEncryptionByDefault.SSEAlgorithm).toBe("AES256");
    expect(Object.values(art.Properties.PublicAccessBlockConfiguration)).toEqual([true, true, true, true]);
  });

  it("[LDB-AX1] the deploy role makes a role only with akldb-boundary as its boundary, and can neither remove it nor edit the policy", () => {
    const stmts = boot.Resources.DeployRole.Properties.Policies[0].PolicyDocument.Statement as Json[];
    const byAction = (a: string) => stmts.filter((s) => list(s.Action).includes(a));
    // iam:CreateRole and iam:PutRolePermissionsBoundary appear once each, in one statement, behind the condition
    for (const a of ["iam:CreateRole", "iam:PutRolePermissionsBoundary"]) expect(byAction(a).map((s) => s.Sid), a).toEqual(["RolesWithBoundary"]);
    const cond = stmts.find((s) => s.Sid === "RolesWithBoundary")!;
    expect(cond.Effect).toBe("Allow");
    expect(cond.Action).toEqual(["iam:CreateRole", "iam:PutRolePermissionsBoundary"]);
    expect(cond.Condition).toEqual({ StringEquals: { "iam:PermissionsBoundary": { Ref: "DeployBoundary" } } });
    expect(cond.Resource).toEqual({ "Fn::Sub": "arn:aws:iam::${AWS::AccountId}:role/akldb-*" });
    expect(stmts.find((s) => s.Sid === "NeverRemoveTheBoundary")).toEqual({ Sid: "NeverRemoveTheBoundary", Effect: "Deny", Action: "iam:DeleteRolePermissionsBoundary", Resource: "*" });
    const deny = stmts.find((s) => s.Sid === "NeverChangeTheBoundaryPolicy")!;
    expect(deny.Effect).toBe("Deny");
    expect(deny.Action).toEqual(["iam:CreatePolicyVersion", "iam:SetDefaultPolicyVersion", "iam:DeletePolicyVersion", "iam:DeletePolicy"]);
    expect(deny.Resource).toEqual({ Ref: "DeployBoundary" });
    expect(boot.Outputs.BoundaryArn).toEqual({ Description: expect.any(String), Value: { Ref: "DeployBoundary" }, Export: { Name: "akldb-boundary-arn" } });
  });

  it("[LDB-AX1] the boundary allows only what the function and scheduler roles need, all on akldb-* names; every role in the stack sets it; a role without it is rejected", () => {
    const pol = boot.Resources.DeployBoundary.Properties;
    expect(pol.ManagedPolicyName).toBe("akldb-boundary");
    const bs = pol.PolicyDocument.Statement as Json[];
    expect(bs.every((s) => s.Effect === "Allow")).toBe(true);
    const allowedActions = new Set(bs.flatMap((s) => list(s.Action)));
    expect([...allowedActions].every((a) => !a.includes("*"))).toBe(true);
    for (const s of bs) for (const r of list(s.Resource)) expect(JSON.stringify(r), s.Sid).toMatch(/akldb-\*|parameter\/akldb\/\*/);
    expect([...allowedActions].sort()).toEqual([
      "dynamodb:ConditionCheckItem", "dynamodb:GetItem", "dynamodb:PutItem", "dynamodb:Query", "dynamodb:UpdateItem",
      "lambda:InvokeFunction", "logs:CreateLogStream", "logs:PutLogEvents", "s3:DeleteObject", "s3:GetObject", "s3:ListBucket", "s3:PutObject",
      "ssm:GetParameter", "ssm:GetParameters",
    ]);
    // nothing the stack's roles are granted falls outside the boundary
    for (const stage of stages) {
      for (const [name, doc] of policyDocs(resolveStage(t, stage).resources)) {
        for (const s of doc.Statement as Json[]) for (const a of list(s.Action)) expect(allowedActions.has(a), `${name}: ${a}`).toBe(true);
      }
      const roles = Object.entries(resolveStage(t, stage).resources).filter(([, r]) => r.Type === "AWS::IAM::Role");
      expect(roles.length).toBeGreaterThanOrEqual(2);
      for (const [id, r] of roles) expect(r.Properties.PermissionsBoundary, id).toEqual({ "Fn::ImportValue": "akldb-boundary-arn" });
    }
    const m = clone(t);
    delete m.Resources.ApiRole.Properties.PermissionsBoundary;
    expect(violations(m, "staging").some((x) => /ApiRole: no permissions boundary/.test(x))).toBe(true);
    const other = clone(t);
    other.Resources.SchedulerRole.Properties.PermissionsBoundary = "arn:aws:iam::335937358231:policy/other";
    expect(violations(other, "prod").some((x) => /SchedulerRole: no permissions boundary/.test(x))).toBe(true);
  });

  it("[LDB-AX1] updating the bootstrap stack in place replaces nothing: its logical ids and physical names are unchanged", () => {
    expect(Object.keys(boot.Resources).sort()).toEqual(["ArtifactsBucket", "ArtifactsBucketPolicy", "DeployBoundary", "DeployRole"]);
    expect(boot.Resources.ArtifactsBucket.Properties.BucketName).toEqual({ "Fn::Sub": "akldb-artifacts-${AWS::AccountId}" });
    expect(boot.Resources.DeployRole.Properties.RoleName).toBe("akldb-deploy");
    expect(boot.Resources.ArtifactsBucket.DeletionPolicy).toBe("Retain");
    expect(Object.keys(boot.Outputs).sort()).toEqual(["ArtifactsBucket", "BoundaryArn", "DeployRoleArn"]);
  });

  it("[LDB-AX1] the deploy script makes no AWS call outside the deploy flow (no create-*, put-*, delete-* beyond the change set)", () => {
    const lines = dryRun("staging", ["--execute"]).lines;
    const aws = lines.filter((l) => l[0] === "aws").map((l) => l.slice(3).join(" "));
    const allowed = [
      /^sts get-caller-identity /,
      /^s3 cp /,
      /^cloudformation (describe-stacks|create-change-set|describe-change-set|execute-change-set|wait) /,
      /^lambda (update-function-code|wait|publish-version|invoke) /,
    ];
    expect(aws.length).toBeGreaterThan(10);
    for (const c of aws) expect(allowed.some((a) => a.test(c)), c).toBe(true);
  });
});

/** Run `deploy-aws.sh --dry-run` with an `aws` on PATH that records any real call (none must happen). */
function dryRun(stage: string, extra: string[] = []): { lines: string[][]; status: number | null; stdout: string; stderr: string; calls: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "akldb-deploy-"));
  try {
    const marker = path.join(dir, "aws-was-called");
    fs.writeFileSync(path.join(dir, "aws"), `#!/bin/sh\necho "$@" >> ${marker}\nexit 99\n`, { mode: 0o755 });
    const r = spawnSync("sh", [file("scripts", "deploy-aws.sh"), "--stage", stage, "--dry-run", ...extra], {
      env: { PATH: `${dir}:/usr/bin:/bin`, HOME: dir },
      encoding: "utf8",
      cwd: dir,
    });
    const lines = r.stderr
      .split("\n")
      .filter((l) => l.startsWith("+ "))
      .map((l) => [...l.slice(2).matchAll(/'((?:[^']|'\\'')*)'/g)].map((m) => m[1]!.replace(/'\\''/g, "'")));
    return { lines, status: r.status, stdout: r.stdout, stderr: r.stderr, calls: fs.existsSync(marker) ? fs.readFileSync(marker, "utf8") : "" };
  } finally {
    fs.rmSync(dir, { recursive: true });
  }
}

describe("alias event config (AX1)", () => {
  it("[LDB-AX1] LiveAliasEventConfig's Qualifier is the literal alias name, not a Ref or an ARN (cfn-lint misses it; CloudFormation rejected it on the real deploy)", () => {
    const cfg = t.Resources.LiveAliasEventConfig;
    expect(cfg.Properties.Qualifier).toBe("live");
    expect(typeof cfg.Properties.Qualifier).toBe("string");
    expect(t.Resources.LiveAlias.Properties.Name).toBe("live");
    // the alias must exist before the config names it (a Ref would have carried the dependency; a literal does not)
    expect(list(cfg.DependsOn)).toContain("LiveAlias");
    for (const s of stages) expect(resolveStage(t, s).resources.LiveAliasEventConfig.Properties.Qualifier).toBe("live");
    // any other EventInvokeConfig qualifier must be a plain name or version too
    for (const [id, r] of Object.entries<Json>(t.Resources)) {
      if (r.Type === "AWS::Lambda::EventInvokeConfig") expect(typeof r.Properties.Qualifier, id).toBe("string");
    }
  });
});

describe("execute-api endpoint and origin secret (AX2)", () => {
  it("[LDB-AX2] every stage serves only through the custom domain: the HTTP API disables its default endpoint and there is no other door", () => {
    for (const s of stages) {
      const R = resolveStage(t, s).resources;
      expect(R.HttpApi.Properties.DisableExecuteApiEndpoint).toBe(true);
      expect(R.HttpApi.Properties.ProtocolType).toBe("HTTP");
      expect(Object.values(R).filter((r) => r.Type === "AWS::Lambda::Url" || r.Type.startsWith("AWS::CloudFront::"))).toEqual([]);
      // the API Gateway invoke permission is for this API only
      expect(R.ApiInvokePermission.Properties.SourceArn["Fn::Sub"]).toBe("arn:aws:execute-api:${AWS::Region}:${AWS::AccountId}:${HttpApi}/*/*");
    }
    const m = clone(t);
    m.Resources.HttpApi.Properties.DisableExecuteApiEndpoint = false;
    expect(violations(m, "prod").some((x) => /execute-api endpoint is enabled/.test(x))).toBe(true);
  });

  it("[LDB-AX2] the function may read exactly its own stage's parameters (the origin secret and the Discord settings)", () => {
    const stmts = policyDocs(resolveStage(t, "staging").resources).flatMap(([, d]) => d.Statement as Json[]);
    const ssm = stmts.find((s) => list(s.Action).includes("ssm:GetParameter"));
    expect(ssm.Action).toEqual(["ssm:GetParameter", "ssm:GetParameters"]);
    expect(ssm.Resource["Fn::Sub"]).toBe("arn:aws:ssm:${AWS::Region}:${AWS::AccountId}:parameter/akldb/${Stage}/*");
    expect(t.Resources.ApiFunction.Properties.Environment.Variables.SSM_PREFIX["Fn::Sub"]).toBe("/akldb/${Stage}/");
  });
});

describe("deploy order (AX3)", () => {
  it("[LDB-AX3] build, upload, change set, new version, migrate that version, move the alias, pre-warm the live alias with k=4, in that order", () => {
    const r = dryRun("staging", ["--execute"]);
    expect(r.status).toBe(0);
    expect(r.calls).toBe(""); // --dry-run runs nothing: the stub aws was never reached
    const cmd = r.lines.map((l) => l.join(" "));
    const at = (re: RegExp): number => {
      const i = cmd.findIndex((c) => re.test(c));
      expect(i, String(re)).toBeGreaterThanOrEqual(0);
      return i;
    };
    const steps = [
      at(/esbuild .*src\/lambda\.ts .*--target=node24 .*--format=esm .*--minify/),
      at(/aws --region us-east-2 s3 cp .*\.zip s3:\/\/akldb-artifacts-335937358231\/code\/staging\//),
      at(/create-change-set .*ParameterKey=LiveVersion,ParameterValue=\$LATEST/),
      at(/execute-change-set .*akldb-[0-9a-f]+-code/),
      at(/lambda update-function-code/),
      at(/lambda publish-version/),
      at(/lambda invoke .*--qualifier 42 .*\{"akldb":"migrate"\}/),
      at(/create-change-set .*ParameterKey=LiveVersion,ParameterValue=42/),
      at(/execute-change-set .*-live-42/),
      at(/lambda invoke .*--qualifier live .*\{"akldb":"warm","k":4\}/),
    ];
    expect(steps).toEqual([...steps].sort((a, b) => a - b));
    expect(new Set(steps).size).toBe(steps.length);
    // nothing but the final pre-warm follows the alias move
    expect(cmd.slice(steps[8]! + 1).filter((c) => /lambda invoke/.test(c))).toHaveLength(1);
  });

  it("[LDB-AX3] without --execute it prints the change set and stops before touching the function", () => {
    const r = dryRun("prod");
    expect(r.status).toBe(0);
    const cmd = r.lines.map((l) => l.join(" "));
    expect(cmd.some((c) => /create-change-set/.test(c))).toBe(true);
    expect(cmd.some((c) => /describe-change-set/.test(c))).toBe(true);
    expect(cmd.some((c) => /execute-change-set|update-function-code|publish-version|lambda invoke/.test(c))).toBe(false);
  });

  it("[LDB-AX3] --destroy-nonprod empties the versioned bucket and deletes a staging or shadow stack, asks for the stack name, and refuses prod", () => {
    for (const stage of ["staging", "shadow"]) {
      const r = dryRun(stage, ["--destroy-nonprod"]);
      expect(r.status, stage).toBe(0);
      expect(r.calls).toBe("");
      const cmd = r.lines.map((l) => l.slice(3).join(" "));
      expect(cmd.some((c) => new RegExp(`s3api list-object-versions --bucket akldb-${stage}-data-335937358231 `).test(c)), stage).toBe(true);
      expect(cmd.filter((c) => /cloudformation/.test(c))).toEqual([`cloudformation delete-stack --stack-name akldb-${stage}`, `cloudformation wait stack-delete-complete --stack-name akldb-${stage}`]);
      expect(cmd.some((c) => /lambda|s3 cp|create-change-set/.test(c))).toBe(false);
    }
    const prod = dryRun("prod", ["--destroy-nonprod"]);
    expect(prod.status).toBe(2);
    expect(prod.stderr).toMatch(/never touches prod/);
    expect(prod.lines).toEqual([]);
    // for real (no --dry-run) it will not start without the stack name
    const text = fs.readFileSync(file("scripts", "deploy-aws.sh"), "utf8");
    expect(text).toContain('[ "$CONFIRM" != "$STACK" ]');
  });

  it("[LDB-AX3] a stage must be named, and the password-free defaults hold (profile akldb, account 335937358231, us-east-2)", () => {
    const bad = spawnSync("sh", [file("scripts", "deploy-aws.sh"), "--stage", "nonsense", "--dry-run"], { encoding: "utf8", env: { PATH: "/usr/bin:/bin" } });
    expect(bad.status).not.toBe(0);
    expect(bad.stderr).toMatch(/usage/);
    const text = fs.readFileSync(file("scripts", "deploy-aws.sh"), "utf8");
    expect(text).toContain("ACCOUNT=335937358231");
    expect(text).toContain("REGION=us-east-2");
    expect(text).toContain("PROFILE=akldb");
  });
});

describe("alarms, budget, reserved concurrency (AX4)", () => {
  it("[LDB-AX4] prod has the full alarm set, staging and shadow only Errors and the akldb-alarm line; one email topic; within the free 10 per stage", () => {
    const metricsOf = (R: Record<string, Json>): string[] => {
      const metrics = new Set<string>();
      for (const [, a] of Object.entries(R).filter(([, r]) => r.Type === "AWS::CloudWatch::Alarm")) {
        for (const m of a.Properties.Metrics ?? [a.Properties]) {
          const stat = m.MetricStat?.Metric ?? m;
          if (stat.Namespace) metrics.add(`${typeof stat.Namespace === "string" ? stat.Namespace : stat.Namespace["Fn::Sub"]}/${stat.MetricName}`);
        }
      }
      return [...metrics].sort();
    };
    for (const s of stages) {
      const R = resolveStage(t, s).resources;
      const alarms = Object.entries(R).filter(([, r]) => r.Type === "AWS::CloudWatch::Alarm");
      expect(alarms.map(([id]) => id).sort(), s).toEqual([...alarmsFor(s)].sort());
      expect(alarms.length).toBeLessThanOrEqual(10);
      expect(R.AlarmTopic.Properties.Subscription).toEqual([{ Protocol: "email", Endpoint: { Ref: "AlarmEmail" } }]);
    }
    expect(ALARMS_EVERY_STAGE).toEqual(["LambdaErrorsAlarm", "AlarmPrefixAlarm"]);
    expect(metricsOf(resolveStage(t, "staging").resources)).toEqual(["AWS/Lambda/Errors", "akldb/${Stage}/Alarms"]);
    expect(metricsOf(resolveStage(t, "shadow").resources)).toEqual(["AWS/Lambda/Errors", "akldb/${Stage}/Alarms"]);
    expect(metricsOf(resolveStage(t, "prod").resources)).toEqual(["AWS/ApiGateway/5xx", "AWS/DynamoDB/SystemErrors", "AWS/DynamoDB/ThrottledRequests", "AWS/Lambda/Duration", "AWS/Lambda/Errors", "AWS/Lambda/Throttles", "akldb/${Stage}/Alarms"]);
    for (const id of ALARMS_PROD_ONLY) expect(t.Resources[id].Condition, id).toBe("IsProd");
    const stray = clone(t);
    delete stray.Resources.LambdaDurationAlarm.Condition;
    expect(violations(stray, "staging").some((x) => /LambdaDurationAlarm: outside prod/.test(x))).toBe(true);
    const p = resolveStage(t, "prod").resources;
    expect(p.LambdaErrorsAlarm.Properties).toMatchObject({ EvaluationPeriods: 2, DatapointsToAlarm: 2, Period: 300, Threshold: 0, ComparisonOperator: "GreaterThanThreshold" });
    expect(p.LambdaDurationAlarm.Properties).toMatchObject({ ExtendedStatistic: "p95", Threshold: 3000 });
    expect(p.Api5xxAlarm.Properties.Dimensions).toEqual([{ Name: "ApiId", Value: { Ref: "HttpApi" } }]);
    // Throttles (and Errors, Duration) are this function's own, never the account-wide concurrency metrics.
    for (const id of ["LambdaErrorsAlarm", "LambdaThrottlesAlarm", "LambdaDurationAlarm"]) expect(p[id].Properties.Dimensions, id).toEqual([{ Name: "FunctionName", Value: { Ref: "ApiFunction" } }]);
    const th = clone(t);
    th.Resources.LambdaThrottlesAlarm.Properties.Dimensions = [];
    expect(violations(th, "prod").some((x) => /LambdaThrottlesAlarm: not scoped to this function/.test(x))).toBe(true);
    // the DynamoDB alarms cover every operation the log makes
    const ops = (id: string) => p[id].Properties.Metrics.filter((m: Json) => m.MetricStat).map((m: Json) => m.MetricStat.Metric.Dimensions.find((d: Json) => d.Name === "Operation").Value).sort();
    expect(ops("DdbSystemErrorsAlarm")).toEqual(["GetItem", "PutItem", "Query", "TransactWriteItems", "UpdateItem"]);
    expect(ops("DdbThrottledAlarm")).toEqual(ops("DdbSystemErrorsAlarm"));
    const m = clone(t);
    delete m.Resources.Api5xxAlarm;
    expect(violations(m, "prod").some((x) => /Api5xxAlarm: missing/.test(x))).toBe(true);
    const f = clone(t);
    f.Resources.AlarmPrefixFilter.Properties.FilterPattern = '"alarm"';
    expect(violations(f, "prod").some((x) => /AlarmPrefixFilter: pattern/.test(x))).toBe(true);
  });

  it("[LDB-AX4] the akldb-alarm: log prefix becomes the metric akldb/<stage>/Alarms, and any such line alarms within one 5-minute period", () => {
    for (const s of stages) {
      const R = resolveStage(t, s).resources;
      const f = R.AlarmPrefixFilter.Properties;
      expect(f.FilterPattern).toBe('"akldb-alarm:"');
      expect(f.LogGroupName).toEqual({ Ref: "LogGroup" });
      expect(f.MetricTransformations).toEqual([{ MetricNamespace: { "Fn::Sub": "akldb/${Stage}" }, MetricName: "Alarms", MetricValue: "1", Unit: "Count" }]);
      expect(R.AlarmPrefixAlarm.Properties).toMatchObject({ Namespace: { "Fn::Sub": "akldb/${Stage}" }, MetricName: "Alarms", Statistic: "Sum", Period: 300, EvaluationPeriods: 1, Threshold: 0, ComparisonOperator: "GreaterThanThreshold", TreatMissingData: "notBreaching" });
    }
    const m = clone(t);
    m.Resources.AlarmPrefixAlarm.Properties.EvaluationPeriods = 2;
    expect(violations(m, "staging").some((x) => /AlarmPrefixAlarm: not Alarms > 0, 1 of 1/.test(x))).toBe(true);
  });

  it("[LDB-AX4] the budget is prod's alone: $2 and $5 actual, $5 forecast, to the alarm email", () => {
    expect(Object.keys(resolveStage(t, "staging").resources)).not.toContain("Budget");
    expect(Object.keys(resolveStage(t, "shadow").resources)).not.toContain("Budget");
    const b = resolveStage(t, "prod").resources.Budget.Properties;
    expect(b.Budget).toMatchObject({ BudgetName: "akldb-monthly", BudgetType: "COST", TimeUnit: "MONTHLY" });
    expect(b.NotificationsWithSubscribers.map((n: Json) => [n.Notification.NotificationType, n.Notification.Threshold])).toEqual([["ACTUAL", 2], ["ACTUAL", 5], ["FORECASTED", 5]]);
    const m = clone(t);
    delete m.Resources.Budget.Condition;
    expect(violations(m, "staging").some((x) => /Budget/.test(x))).toBe(true);
  });

  it("[LDB-AX4] reserved concurrency is a parameter, unset by default (the account limit of 10 leaves no room) and applied when given", () => {
    expect(t.Parameters.ReservedConcurrency.Default).toBe("");
    for (const s of stages) {
      expect("ReservedConcurrentExecutions" in resolveStage(t, s).resources.ApiFunction.Properties).toBe(false);
      expect(resolveStage(t, s, { ReservedConcurrency: "4" }).resources.ApiFunction.Properties.ReservedConcurrentExecutions).toEqual({ Ref: "ReservedConcurrency" });
    }
    expect(t.Resources.ApiFunction.Properties.ReservedConcurrentExecutions).toEqual({ "Fn::If": ["HasReservedConcurrency", { Ref: "ReservedConcurrency" }, { Ref: "AWS::NoValue" }] });
  });
});

describe("logs never expire (AX5)", () => {
  it("[LDB-AX5] prod's STANDARD log group (so metric filters and FilterLogEvents work) has no retention and survives stack deletion; other stages keep 14 days and go with their stack", () => {
    const prod = resolveStage(t, "prod").resources.LogGroup;
    for (const s of stages) expect(resolveStage(t, s).resources.LogGroup.Properties.LogGroupClass, s).toBe("STANDARD");
    expect("RetentionInDays" in prod.Properties).toBe(false);
    for (const s of ["staging", "shadow"]) expect(resolveStage(t, s).resources.LogGroup.Properties.RetentionInDays).toBe(14);
    expect(prod.DeletionPolicy).toBe("Retain");
    expect(resolveStage(t, "prod").resources.ApiFunction.Properties.LoggingConfig.LogGroup).toEqual({ Ref: "LogGroup" });
    const m = clone(t);
    m.Resources.LogGroup.Properties.RetentionInDays = 30;
    expect(violations(m, "prod").some((x) => /prod logs must never expire/.test(x))).toBe(true);
  });

  it("[LDB-AX5] nothing else here expires current data: dumps and snapshots stay, only overwritten versions go after 35 days", () => {
    const rules = resolveStage(t, "prod").resources.DataBucket.Properties.LifecycleConfiguration.Rules as Json[];
    expect(rules.some((r) => "ExpirationInDays" in r || "ExpirationDate" in r)).toBe(false);
    expect(rules.find((r) => r.NoncurrentVersionExpiration).NoncurrentVersionExpiration.NoncurrentDays).toBe(35);
  });
});

describe("keep-warm schedule (AX6)", () => {
  it("[LDB-AX6] a rate(5 minutes) schedule on the live alias asks for KeepWarm (default 4) concurrent pings; the scheduler may invoke only that alias", () => {
    for (const s of stages) {
      const R = resolveStage(t, s).resources;
      const w = R.KeepWarmSchedule.Properties;
      expect(w.ScheduleExpression).toBe("rate(5 minutes)");
      expect(w.Target.Arn).toEqual({ Ref: "LiveAlias" });
      expect(w.Target.Input["Fn::Sub"]).toBe('{"akldb":"warm","k":${KeepWarm}}');
      expect(R.JobsSchedule.Properties.Target.Input).toBe('{"akldb":"tick"}');
      expect(R.SchedulerRole.Properties.Policies[0].PolicyDocument.Statement).toEqual([{ Effect: "Allow", Action: "lambda:InvokeFunction", Resource: { Ref: "LiveAlias" } }]);
    }
    expect(t.Parameters.KeepWarm).toMatchObject({ Default: 4, MinValue: 1 });
    expect(t.Parameters.KeepWarm.MaxValue).toBeLessThanOrEqual(8); // the account's concurrency limit is 10
    // the function may fan out to its own alias and nothing else
    const own = policyDocs(resolveStage(t, "prod").resources).flatMap(([n, d]) => (n.startsWith("ApiRole") ? (d.Statement as Json[]) : [])).find((s) => s.Sid === "WarmFanOut");
    expect(own.Resource["Fn::Sub"]).toBe("arn:aws:lambda:${AWS::Region}:${AWS::AccountId}:function:akldb-${Stage}-api:live");
    const m = clone(t);
    m.Resources.KeepWarmSchedule.Properties.Target.Arn = { "Fn::GetAtt": ["ApiFunction", "Arn"] };
    expect(violations(m, "prod").some((x) => /does not target the live alias/.test(x))).toBe(true);
  });
});

describe("CI file", () => {
  const wf = parse(fs.readFileSync(file("design", "ci", "aws-deploy.yml"), "utf8")) as Json;
  const stepsOf = (job: string): Json[] => wf.jobs[job].steps;

  it("[LDB-AX3] tests first, then staging on a push to aws-a/main and prod on a manual dispatch, with the IAM user key from the akldb-production environment", () => {
    expect(wf.on.push.branches).toEqual(["aws-a/main"]);
    expect(Object.keys(wf.on.workflow_dispatch.inputs ?? {})).toContain("stage");
    expect(wf.jobs["deploy-staging"].needs).toBe("test");
    expect(wf.jobs["deploy-prod"].needs).toBe("test");
    expect(wf.jobs["deploy-prod"].environment).toBe("akldb-production");
    expect(wf.jobs["deploy-prod"].if).toMatch(/workflow_dispatch/);
    expect(wf.jobs["deploy-staging"].if).toMatch(/push/);
    for (const job of ["deploy-staging", "deploy-prod"]) {
      const text = JSON.stringify(stepsOf(job));
      expect(text).toContain("secrets.AKLDB_CI_ACCESS_KEY_ID");
      expect(text).toContain("role-to-assume");
      expect(text).toContain("arn:aws:iam::335937358231:role/akldb-deploy");
      expect(text).toMatch(/deploy-aws\.sh --stage (staging|prod|\$\{\{ inputs\.stage \}\}) --profile none --execute/);
    }
    expect(JSON.stringify(stepsOf("test"))).toContain("npm test");
  });
});
