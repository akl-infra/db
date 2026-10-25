// LDB-INF1..INF19: the akldb stacks (design/aws-port.md sections 3, 5.2). Run: node --test infra/
// No AWS call is made; cfn-lint runs through uvx when available.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { expectedResources, loadTemplate, policyDocs, resolveStage, violations } from "./checks.mjs";

const dir = path.dirname(fileURLToPath(import.meta.url));
const file = (n) => path.join(dir, n);
const t = loadTemplate(file("akldb.yaml"));
const stages = ["lab", "staging", "prod"];
const clone = (x) => structuredClone(x);
const withCert = { CertificateArn: "arn:aws:acm:us-east-1:335937358231:certificate/00000000-0000-0000-0000-000000000000" };

test("LDB-INF1 cfn-lint is clean on both templates", (ctx) => {
  const r = spawnSync("uvx", ["cfn-lint", file("akldb.yaml"), file("acm-us-east-1.yaml")], { encoding: "utf8" });
  if (r.error) return ctx.skip("uvx unavailable");
  assert.equal(r.status, 0, r.stdout + r.stderr);
});

test("LDB-INF2 each stage's resource set is exact", () => {
  for (const s of stages) {
    assert.deepEqual(Object.keys(resolveStage(t, s).resources).sort(), expectedResources(s), s);
  }
});

test("LDB-INF3 every stage passes the structural checks, with and without the certificate", () => {
  for (const s of stages) {
    assert.deepEqual(violations(t, s), [], s);
    assert.deepEqual(violations(t, s, withCert), [], s);
    assert.deepEqual(violations(t, s, { ...withCert, MirrorMode: "record" }), [], s);
  }
});

test("LDB-INF4 the template is plain CloudFormation: no anchors, under the inline size limit it deploys through S3", () => {
  const text = fs.readFileSync(file("akldb.yaml"), "utf8");
  assert.doesNotMatch(text, /^\s*[^#\n]*\s&\w+/m);
  assert.ok(Buffer.byteLength(text) < 1_000_000);
  assert.equal(t.Rules.RegionIsOhio.Assertions[0].Assert["Fn::Equals"][1], "us-east-2");
});

test("LDB-INF5 prod: alias, mirror and budget; non-prod: none", () => {
  const prod = resolveStage(t, "prod", withCert).resources;
  assert.deepEqual(prod.Distribution.Properties.DistributionConfig.Aliases, ["api.akldb.org"]);
  const stg = resolveStage(t, "staging", withCert).resources;
  assert.deepEqual(stg.Distribution.Properties.DistributionConfig.Aliases, ["staging-api.akldb.org"]);
  assert.deepEqual(resolveStage(t, "lab", withCert).resources.Distribution.Properties.DistributionConfig.Aliases ?? [], []);
  assert.deepEqual(resolveStage(t, "prod").resources.Distribution.Properties.DistributionConfig.Aliases ?? [], []);
});

test("LDB-INF6 mirror-apply has no URL and a schedule that follows MirrorMode", () => {
  assert.equal(resolveStage(t, "prod", { MirrorMode: "apply" }).resources.ApplySchedule.Properties.State, "ENABLED");
  assert.equal(resolveStage(t, "prod", { MirrorMode: "record" }).resources.ApplySchedule.Properties.State, "DISABLED");
  const urls = Object.values(resolveStage(t, "prod").resources).filter((r) => r.Type === "AWS::Lambda::Url");
  assert.deepEqual(urls.map((u) => u.Properties.TargetFunctionArn["Fn::GetAtt"][0]).sort(), ["ApiFn", "FeedFn", "MirrorIngestFn"]);
});

test("LDB-INF7 the jobs schedule is rate(5 minutes) and its state follows ScheduleEnabled", () => {
  assert.equal(t.Resources.JobsSchedule.Properties.ScheduleExpression, "rate(5 minutes)");
  assert.equal(resolveStage(t, "prod", { ScheduleEnabled: "false" }).resources.JobsSchedule.Properties.State, "DISABLED");
  assert.equal(resolveStage(t, "prod", { ScheduleEnabled: "true" }).resources.JobsSchedule.Properties.State, "ENABLED");
});

test("LDB-INF8 alarms stay within the free 10; prod uses all 10", () => {
  const n = (s) => Object.values(resolveStage(t, s).resources).filter((r) => r.Type === "AWS::CloudWatch::Alarm").length;
  assert.equal(n("prod"), 10);
  assert.equal(n("staging"), 9);
});

test("LDB-INF9 function environment carries the pinned Discord default and the remote-DynamoDB opt-in", () => {
  assert.equal(t.Parameters.DiscordApiUrl.Default, "https://discord.com/api");
  for (const id of ["ApiFn", "FeedFn", "JobsFn", "MirrorApplyFn"]) {
    const v = t.Resources[id].Properties.Environment.Variables;
    assert.equal(v.AKLDB_DDB_ALLOW_REMOTE, "1");
    assert.deepEqual(v.DISCORD_API_URL, { Ref: "DiscordApiUrl" });
  }
});

test("LDB-INF10 rejected mutation: a VPC", () => {
  const m = clone(t);
  m.Resources.ApiFn.Properties.VpcConfig = { SubnetIds: ["subnet-1"], SecurityGroupIds: ["sg-1"] };
  assert.ok(violations(m, "prod").some((x) => /VpcConfig/.test(x)));
  const m2 = clone(t);
  m2.Resources.Vpc = { Type: "AWS::EC2::VPC", Properties: { CidrBlock: "10.0.0.0/16" } };
  assert.ok(violations(m2, "prod").some((x) => /EC2/.test(x)));
});

test("LDB-INF11 rejected mutation: a wildcard action", () => {
  const m = clone(t);
  m.Resources.ApiRole.Properties.Policies[0].PolicyDocument.Statement[0].Action = ["dynamodb:*"];
  assert.ok(violations(m, "prod").some((x) => /wildcard action/.test(x)));
  const m2 = clone(t);
  m2.Resources.JobsRole.Properties.Policies[0].PolicyDocument.Statement[0].Resource = "*";
  assert.ok(violations(m2, "prod").some((x) => /Resource \*/.test(x)));
});

test("LDB-INF12 rejected mutation: prod without PITR or deletion protection", () => {
  const m = clone(t);
  m.Resources.MainTable.Properties.PointInTimeRecoverySpecification.PointInTimeRecoveryEnabled = false;
  assert.ok(violations(m, "prod").some((x) => /PITR off/.test(x)));
  const m2 = clone(t);
  m2.Resources.EphemeralTable.Properties.DeletionProtectionEnabled = false;
  assert.ok(violations(m2, "prod").some((x) => /deletion protection/.test(x)));
});

test("LDB-INF13 rejected mutation: a URL on mirror-apply", () => {
  const m = clone(t);
  m.Resources.ApplyUrl = { Type: "AWS::Lambda::Url", Condition: "IsProd", Properties: { TargetFunctionArn: { "Fn::GetAtt": ["MirrorApplyFn", "Arn"] }, AuthType: "NONE", InvokeMode: "BUFFERED" } };
  assert.ok(violations(m, "prod").some((x) => /MirrorApplyFn: has a Function URL/.test(x)));
});

test("LDB-INF14 rejected mutations: edge caching, a missing origin-verify header, OAC, a shared SNS Sid", () => {
  const m = clone(t);
  m.Resources.Distribution.Properties.DistributionConfig.DefaultCacheBehavior.CachePolicyId = "658327ea-f89d-4fab-a63d-7e88639e58f6";
  assert.ok(violations(m, "prod").some((x) => /caching enabled/.test(x)));
  const m2 = clone(t);
  m2.Resources.Distribution.Properties.DistributionConfig.Origins[0].OriginCustomHeaders = [];
  assert.ok(violations(m2, "prod").some((x) => /X-Origin-Verify/.test(x)));
  const m3 = clone(t);
  m3.Resources.Oac = { Type: "AWS::CloudFront::OriginAccessControl", Properties: {} };
  assert.ok(violations(m3, "prod").some((x) => /OAC/.test(x)));
  const m4 = clone(t);
  const st = m4.Resources.AlarmTopicPolicy.Properties.PolicyDocument.Statement;
  st.push({ ...st[0] });
  assert.ok(violations(m4, "prod").some((x) => /unique Sid/.test(x)));
});

test("LDB-INF15 rejected mutations: wrong runtime or architecture, an eleventh alarm, a retention period", () => {
  const m = clone(t);
  m.Resources.ApiFn.Properties.Runtime = "nodejs20.x";
  m.Resources.FeedFn.Properties.Architectures = ["x86_64"];
  const v = violations(m, "prod");
  assert.ok(v.some((x) => /runtime/.test(x)) && v.some((x) => /arm64/.test(x)));
  const m2 = clone(t);
  m2.Resources.ExtraAlarm = clone(m2.Resources.ApiErrorsAlarm);
  assert.ok(violations(m2, "prod").some((x) => /alarms/.test(x)));
  const m3 = clone(t);
  m3.Resources.LogGroup.Properties.RetentionInDays = 30;
  assert.ok(violations(m3, "prod").some((x) => /LogGroup/.test(x)));
});

const ci = JSON.parse(fs.readFileSync(file("iam-akldb-ci.json"), "utf8"));
const role = JSON.parse(fs.readFileSync(file("iam-akldb-cutover-role.json"), "utf8"));
const ROLE_ARN = "arn:aws:iam::335937358231:role/akldb-cutover-role";

test("LDB-INF16 the CI user can only assume the cutover role", () => {
  assert.equal(ci.UserName, "akldb-ci");
  assert.deepEqual(ci.Policy.Statement.length, 1);
  const s = ci.Policy.Statement[0];
  assert.deepEqual([s.Effect, s.Action, s.Resource], ["Allow", "sts:AssumeRole", ROLE_ARN]);
});

test("LDB-INF17 the cutover role trusts only the CI user, for one hour, and is least privilege", () => {
  assert.equal(role.MaxSessionDuration, 3600);
  assert.deepEqual(role.TrustPolicy.Statement.map((s) => s.Principal), [{ AWS: "arn:aws:iam::335937358231:user/akldb-ci" }]);
  for (const s of role.RolePolicy.Statement) {
    for (const a of [].concat(s.Action)) assert.ok(!a.includes("*"), a);
    for (const r of [].concat(s.Resource)) {
      assert.ok(r.includes("335937358231"), r);
      assert.ok(!r.includes("staging") && !r.includes("-lab-"), r);
      if (!/:key\/\*$/.test(r)) assert.ok(/prod|akldb-prod|stack\/akldb-prod|parameter\/akldb\/prod/.test(r), r);
    }
  }
  const actions = role.RolePolicy.Statement.flatMap((s) => [].concat(s.Action));
  for (const forbidden of ["iam:CreateUser", "iam:CreateAccessKey", "iam:AttachRolePolicy", "s3:PutObject", "dynamodb:DeleteTable", "cloudformation:DeleteStack", "cloudformation:CreateStack"]) {
    assert.ok(!actions.includes(forbidden), forbidden);
  }
  assert.ok(actions.includes("cloudformation:UpdateStack") && actions.includes("lambda:InvokeFunction"));
});

test("LDB-INF18 the cutover role names exactly the prod stack's resources", () => {
  const prod = resolveStage(t, "prod").resources;
  const fnNames = ["api", "feed", "jobs", "mirror-ingest", "mirror-apply"];
  for (const n of fnNames) assert.ok(prod[{ api: "ApiFn", feed: "FeedFn", jobs: "JobsFn", "mirror-ingest": "MirrorIngestFn", "mirror-apply": "MirrorApplyFn" }[n]]);
  const text = JSON.stringify(role.RolePolicy);
  for (const n of fnNames) assert.ok(text.includes(`function:akldb-prod-${n}`), n);
  assert.ok(text.includes("table/akldb-prod-main") && text.includes("table/akldb-prod-ephemeral"));
  assert.ok(text.includes("schedule/default/akldb-prod-jobs") && text.includes("schedule/default/akldb-prod-mirror-apply"));
  assert.ok(text.includes("role/akldb-prod-scheduler"));
  assert.equal(prod.SchedulerRole.Properties.RoleName["Fn::Sub"], "akldb-${Stage}-scheduler");
  // every IAM policy document in the template is also free of wildcard actions
  for (const [, d] of policyDocs(prod)) for (const s of [].concat(d.Statement)) for (const a of [].concat(s.Action)) assert.ok(!a.includes("*"), a);
});

test("LDB-INF19 deploy-aws.sh refuses to run without the akldb profile and makes no AWS call", () => {
  const env = { PATH: "/usr/bin:/bin", HOME: process.env.HOME };
  const r = spawnSync("bash", [path.join(dir, "..", "scripts", "deploy-aws.sh"), "staging"], { env, encoding: "utf8" });
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /AWS_PROFILE=akldb|aws-vault/);
  const bad = spawnSync("bash", [path.join(dir, "..", "scripts", "deploy-aws.sh"), "nonsense"], { env: { ...env, AWS_PROFILE: "akldb" }, encoding: "utf8" });
  assert.notEqual(bad.status, 0);
  assert.match(bad.stderr, /stage/);
});

test("LDB-INF30 cfn-guard (CFN_GUARD=<binary>) passes the template and rejects mutations", (ctx) => {
  const bin = process.env.CFN_GUARD;
  if (!bin || !fs.existsSync(bin)) return ctx.skip("set CFN_GUARD to the cfn-guard binary");
  const tmp = fs.mkdtempSync(path.join(process.env.TMPDIR ?? "/tmp", "guard-"));
  const run = (text) => {
    const f = path.join(tmp, "t.yaml");
    fs.writeFileSync(f, text);
    return spawnSync(bin, ["validate", "-r", file("akldb.guard"), "-d", f], { encoding: "utf8" }).status;
  };
  const src = fs.readFileSync(file("akldb.yaml"), "utf8");
  assert.equal(run(src), 0);
  assert.notEqual(run(src.replace("Runtime: nodejs24.x", "Runtime: nodejs20.x")), 0);
  assert.notEqual(run(src.replace("- dynamodb:GetItem\n", "- dynamodb:*\n")), 0);
  assert.notEqual(run(src.replace("PointInTimeRecoveryEnabled: true", "PointInTimeRecoveryEnabled: false")), 0);
  assert.notEqual(run(src.replace("Architectures: [ arm64 ]", "Architectures: [ x86_64 ]")), 0);
  fs.rmSync(tmp, { recursive: true });
});
