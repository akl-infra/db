// infra/site.yaml: the resource set, the rejected mutations (cfn-guard), and
// cfn-lint. The two tools are required in CI (AKLDB_REQUIRE_CFN_TOOLS=1) and
// skipped with a notice where they are not installed.
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { parseDocument } from "yaml";
// @ts-expect-error plain .mjs without types
import { renderTemplate } from "../../aws/cf-functions.mjs";

const INFRA = resolve(import.meta.dirname, "..", "..", "..", "infra");
const raw = readFileSync(join(INFRA, "site.yaml"), "utf8");
const rendered: string = renderTemplate(raw, ["/index.html", "/assets/a.js"]);
const tmp = mkdtempSync(join(tmpdir(), "site-tpl-"));

function has(cmd: string): boolean {
  return spawnSync(cmd, ["--version"], { stdio: "ignore" }).status === 0;
}
const required = process.env.AKLDB_REQUIRE_CFN_TOOLS === "1";
const guard = has("cfn-guard");
const lint = has("cfn-lint");
if (required) {
  if (!guard || !lint) throw new Error("cfn-guard and cfn-lint are required (AKLDB_REQUIRE_CFN_TOOLS=1)");
}

// CloudFormation short-form tags (!Ref, !Sub, ...) parsed into {"Fn::X": v} / {Ref: v}.
const tagged = ["Ref", "Sub", "GetAtt", "Select", "Split", "If", "Not", "Equals", "Join"];
function load(text: string): any {
  const doc = parseDocument(text, {
    customTags: tagged.map((t) => ({
      tag: `!${t}`,
      resolve: (v: any) => ({ [t === "Ref" ? "Ref" : `Fn::${t}`]: v }),
    })) as any,
  });
  if (doc.errors.length) throw doc.errors[0];
  return doc.toJS();
}
const tpl = load(rendered);
const res = tpl.Resources as Record<string, { Type: string; Properties: any }>;

describe("[LDB-SITE8] infra/site.yaml", () => {
  it("is the site's resource set, and only that", () => {
    const types = Object.values(res).map((r) => r.Type).sort();
    expect(types).toEqual(
      [
        "AWS::CloudFront::Distribution",
        "AWS::CloudFront::Function",
        "AWS::CloudFront::Function",
        "AWS::CloudFront::OriginAccessControl",
        "AWS::CloudFront::OriginRequestPolicy",
        "AWS::IAM::Role",
        "AWS::Lambda::Function",
        "AWS::Lambda::Permission",
        "AWS::Lambda::Permission",
        "AWS::Lambda::Url",
        "AWS::Logs::LogGroup",
        "AWS::S3::Bucket",
        "AWS::S3::BucketPolicy",
      ].sort(),
    );
  });

  it("takes the three stages, and the stage decides the hostnames", () => {
    expect(tpl.Parameters.Stage.AllowedValues).toEqual(["lab", "staging", "prod"]);
    const aliases = JSON.stringify(res.Distribution!.Properties.DistributionConfig.Aliases);
    expect(aliases).toContain("next.akldb.org");
    expect(aliases).toContain("akldb.org");
    expect(aliases).toContain("www.akldb.org");
    expect(JSON.stringify(tpl.Conditions)).toContain("lab"); // lab: the CloudFront domain only
  });

  it("serves /auth/* and /api/* from the Lambda, uncached, and everything else from S3", () => {
    const cfg = res.Distribution!.Properties.DistributionConfig;
    expect(cfg.DefaultCacheBehavior.TargetOriginId).toBe("static");
    expect(cfg.CacheBehaviors.map((b: any) => [b.PathPattern, b.TargetOriginId])).toEqual([
      ["/auth/*", "dynamic"],
      ["/api/*", "dynamic"],
    ]);
    for (const b of cfg.CacheBehaviors) expect(b.CachePolicyId).toBe("4135ea2d-6df8-44a3-9df3-4b5a84be39ad");
  });

  it("holds both functions' code, with no placeholder left", () => {
    expect(rendered).not.toMatch(/__[A-Z_]+__/);
    for (const f of Object.values(res).filter((r) => r.Type === "AWS::CloudFront::Function")) {
      expect(f.Properties.FunctionCode).toContain("function handler(event)");
    }
  });

  const guardCases: Array<[string, (t: any) => void, string]> = [
    ["a VPC", (t) => (t.Resources.SiteFunction.Properties.VpcConfig = { SubnetIds: ["s-1"], SecurityGroupIds: ["sg-1"] }), "no_vpc"],
    ["a wildcard action", (t) => (t.Resources.SiteRole.Properties.Policies[0].PolicyDocument.Statement[1].Action = "ssm:*"), "no_wildcard_actions"],
    ["a wildcard resource", (t) => (t.Resources.SiteRole.Properties.Policies[0].PolicyDocument.Statement[1].Resource = "*"), "no_wildcard_actions"],
    ["a Function URL without the origin header", (t) => delete t.Resources.Distribution.Properties.DistributionConfig.Origins[1].OriginCustomHeaders, "function_url_is_gated"],
    ["a public bucket", (t) => (t.Resources.SiteBucket.Properties.PublicAccessBlockConfiguration.BlockPublicPolicy = false), "bucket_private"],
    ["plain http for viewers", (t) => (t.Resources.Distribution.Properties.DistributionConfig.DefaultCacheBehavior.ViewerProtocolPolicy = "allow-all"), "viewer_https_only"],
    ["an x86 Lambda", (t) => (t.Resources.SiteFunction.Properties.Architectures = ["x86_64"]), "lambda_runtime"],
  ];

  function guardRun(template: unknown): { ok: boolean; out: string } {
    const f = join(tmp, `t-${Math.random().toString(36).slice(2)}.json`);
    writeFileSync(f, JSON.stringify(template));
    const r = spawnSync("cfn-guard", ["validate", "-d", f, "-r", join(INFRA, "site.guard"), "--show-summary", "fail"], { encoding: "utf8" });
    return { ok: r.status === 0, out: r.stdout + r.stderr };
  }

  it.skipIf(!guard)("passes cfn-guard", () => {
    const r = guardRun(tpl);
    expect(r.out).toBe(r.ok ? r.out : "");
    expect(r.ok).toBe(true);
  });

  for (const [name, mutate, rule] of guardCases) {
    it.skipIf(!guard)(`cfn-guard rejects ${name}`, () => {
      const t = structuredClone(tpl);
      mutate(t);
      const r = guardRun(t);
      expect(r.ok).toBe(false);
      expect(r.out).toContain(rule);
    });
  }

  it.skipIf(!lint)("passes cfn-lint", () => {
    const f = join(tmp, "site.yaml");
    writeFileSync(f, rendered);
    execFileSync("cfn-lint", [f], { stdio: "pipe" });
  }, 60_000);
});
