#!/usr/bin/env node
// Deploys akldb.org to AWS (design/aws-port.md §3a): build, bundle the site
// Lambda, render infra/site.yaml with the build's asset manifest, deploy the
// stack, upload the static build (hashed assets first, index.html last), and
// invalidate. The main session runs it with `aws-vault exec akldb -- ...`; it
// refuses to run under any other profile (LDB-SITE7).
//
//   node scripts/deploy-aws.mjs <lab|staging|prod> [--dry-run]
//
// --dry-run builds nothing and calls no AWS API: it prints the commands the real
// run would execute, in order.
//
// Environment (all optional unless said):
//   CERTIFICATE_ARN        the us-east-1 ACM certificate (required on staging and prod)
//   DB_BASE_URL            overrides the stage's API origin (lab has no default)
//   DISCORD_AUTHORIZE_URL, DISCORD_TOKEN_URL   lab only: the fake Discord
//   ARTIFACTS_BUCKET       default akldb-deploy-artifacts-<account>
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { manifestOf, renderTemplate } from "../aws/cf-functions.mjs";

export const AKLDB_ACCOUNT = "335937358231";
export const REGION = "us-east-2";
export const STAGES = {
  lab: { dbBaseUrl: undefined },
  staging: { dbBaseUrl: "https://staging-api.akldb.org" },
  prod: { dbBaseUrl: "https://api.akldb.org" },
};
export const CACHE_CONTROL = "public, max-age=0, must-revalidate";

/** The akldb profile, whether set directly or by aws-vault. Anything else is refused. */
export function profileOk(env) {
  return env.AWS_PROFILE === "akldb" || env.AWS_VAULT === "akldb";
}

export function stackName(stage) {
  return `akldb-site-${stage}`;
}

/** The ordered commands of a deploy, as data, so a dry run and the real run cannot differ. */
export function plan({ stage, siteDir, workDir, env, manifest, originVerify }) {
  const cfg = STAGES[stage];
  const dbBaseUrl = env.DB_BASE_URL || cfg.dbBaseUrl;
  if (!dbBaseUrl) throw new Error(`stage ${stage} needs DB_BASE_URL`);
  if (stage !== "lab" && !env.CERTIFICATE_ARN) throw new Error(`stage ${stage} needs CERTIFICATE_ARN (us-east-1)`);
  const bucket = env.ARTIFACTS_BUCKET || `akldb-deploy-artifacts-${AKLDB_ACCOUNT}`;
  const zip = join(workDir, "site-lambda.zip");
  const key = `site/${stage}/${Date.now()}.zip`;
  const template = join(workDir, "site.yaml");
  const dist = join(siteDir, "dist");
  const aws = (...args) => ({ cmd: "aws", args: [...args, "--region", REGION] });
  const stack = stackName(stage);
  const outputs = (name) => ({
    cmd: "aws",
    args: ["cloudformation", "describe-stacks", "--stack-name", stack, "--region", REGION, "--query", `Stacks[0].Outputs[?OutputKey=='${name}'].OutputValue`, "--output", "text"],
    capture: name,
  });
  const params = [
    `Stage=${stage}`,
    `DbBaseUrl=${dbBaseUrl}`,
    `CodeBucket=${bucket}`,
    `CodeKey=${key}`,
    `OriginVerifyValue=${originVerify}`,
    ...(env.CERTIFICATE_ARN ? [`CertificateArn=${env.CERTIFICATE_ARN}`] : []),
    ...(env.DISCORD_AUTHORIZE_URL ? [`DiscordAuthorizeUrl=${env.DISCORD_AUTHORIZE_URL}`] : []),
    ...(env.DISCORD_TOKEN_URL ? [`DiscordTokenUrl=${env.DISCORD_TOKEN_URL}`] : []),
  ];
  return {
    template,
    manifest,
    steps: [
      { cmd: "npm", args: ["run", "build"], cwd: siteDir },
      {
        cmd: "npx",
        args: ["esbuild", "server/lambda.ts", "--bundle", "--platform=node", "--target=node24", "--format=esm", "--external:@aws-sdk/*", `--outfile=${join(workDir, "lambda", "index.mjs")}`, "--out-extension:.js=.mjs"],
        cwd: siteDir,
      },
      { cmd: "zip", args: ["-j", "-q", zip, join(workDir, "lambda", "index.mjs")] },
      aws("s3api", "create-bucket", "--bucket", bucket, "--create-bucket-configuration", `LocationConstraint=${REGION}`),
      aws("s3api", "put-public-access-block", "--bucket", bucket, "--public-access-block-configuration", "BlockPublicAcls=true,IgnorePublicAcls=true,BlockPublicPolicy=true,RestrictPublicBuckets=true"),
      aws("s3", "cp", zip, `s3://${bucket}/${key}`),
      aws("cloudformation", "deploy", "--stack-name", stack, "--template-file", template, "--capabilities", "CAPABILITY_IAM", "--no-fail-on-empty-changeset", "--parameter-overrides", ...params),
      outputs("BucketName"),
      outputs("DistributionId"),
      // hashed assets first, then index.html, so a page never names an asset that is not there yet
      { cmd: "aws", args: ["s3", "sync", dist, "s3://$BucketName/", "--exclude", "index.html", "--cache-control", CACHE_CONTROL, "--region", REGION] },
      { cmd: "aws", args: ["s3", "cp", join(dist, "index.html"), "s3://$BucketName/index.html", "--cache-control", CACHE_CONTROL, "--region", REGION] },
      { cmd: "aws", args: ["cloudfront", "create-invalidation", "--distribution-id", "$DistributionId", "--paths", "/index.html", "--region", "us-east-1"] },
    ],
  };
}

function sh(step, vars) {
  const args = step.args.map((a) => a.replace(/\$(\w+)/g, (m, n) => vars[n] ?? m));
  return execFileSync(step.cmd, args, { cwd: step.cwd, encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] });
}

async function main(argv, env) {
  const stage = argv.find((a) => !a.startsWith("--"));
  const dry = argv.includes("--dry-run");
  if (!stage || !(stage in STAGES)) throw new Error("usage: deploy-aws.mjs <lab|staging|prod> [--dry-run]");
  if (!profileOk(env)) {
    throw new Error("refusing to run: AWS_PROFILE (or AWS_VAULT) must be akldb. Run it as `aws-vault exec akldb -- node scripts/deploy-aws.mjs <stage>`.");
  }
  const siteDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const workDir = mkdtempSync(join(tmpdir(), "akldb-site-deploy-"));
  mkdirSync(join(workDir, "lambda"));

  if (!dry) {
    const who = JSON.parse(execFileSync("aws", ["sts", "get-caller-identity", "--region", REGION, "--output", "json"], { encoding: "utf8" }));
    if (who.Account !== AKLDB_ACCOUNT) throw new Error(`wrong AWS account ${who.Account}; akldb is ${AKLDB_ACCOUNT}`);
  }
  const originVerify = dry
    ? "<origin-verify from SSM>"
    : execFileSync("aws", ["ssm", "get-parameter", "--name", env.SSM_ORIGIN_VERIFY || `/akldb/${stage}/site/origin-verify`, "--with-decryption", "--query", "Parameter.Value", "--output", "text", "--region", REGION], { encoding: "utf8" }).trim();

  // The manifest needs the build, so the build is the one step run before the plan.
  if (!dry) execFileSync("npm", ["run", "build"], { cwd: siteDir, stdio: "inherit" });
  const manifest = dry ? ["/index.html"] : await manifestOf(join(siteDir, "dist"));
  const p = plan({ stage, siteDir, workDir, env, manifest, originVerify });
  const template = readFileSync(join(siteDir, "..", "infra", "site.yaml"), "utf8");
  writeFileSync(p.template, renderTemplate(template, manifest));

  const vars = {};
  for (const step of p.steps) {
    const shown = [step.cmd, ...step.args.map((a) => (a.startsWith("OriginVerifyValue=") ? "OriginVerifyValue=***" : a))].join(" ");
    if (dry) {
      console.log(shown);
      continue;
    }
    if (step.cmd === "npm" && step.args[1] === "build") continue; // already run above
    console.error(`+ ${shown}`);
    if (step.args[0] === "s3api" && step.args[1] === "create-bucket") {
      try { sh(step, vars); } catch { /* exists already: the next step checks it is private */ }
      continue;
    }
    const out = sh(step, vars);
    if (step.capture) vars[step.capture] = out.trim();
  }
  if (!dry) console.error(`\nDone. Distribution ${vars.DistributionId}.`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2), process.env).catch((e) => {
    console.error(e.message);
    process.exit(1);
  });
}
