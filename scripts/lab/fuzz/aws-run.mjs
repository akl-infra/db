#!/usr/bin/env node
// The fuzzer gate's launcher (lane F; design/aws-port.md §4.3). Run by the main session only, as
//   aws-vault exec akldb -- node scripts/lab/fuzz/aws-run.mjs --commit <sha>
// It: reads the Fargate vCPU quotas and prints the plan with the expected wall time; deploys infra/fuzz.yaml; builds the
// image for linux/arm64 and pushes it; launches the work units (Spot first, --on-demand for FARGATE) keeping exactly as
// many tasks running as the quota allows; polls S3 for unit results; syncs them down and runs aggregate.mjs.
//
//   --commit <sha>           the akldb commit under test (required)
//   --run <id>               result prefix (default fuzz-<sha7>)
//   --plan                   print the plan and expected wall time, make no AWS call (add --quota <vcpu> to set the quota)
//   --resume                 relaunch only the units without a result (or whose result carries an infrastructure error)
//   --on-demand              FARGATE instead of FARGATE_SPOT
//   --vcpu auto|8|4|2|1      task size (default auto: the size that uses the most of the quota)
//   --quota <vcpu>           use this quota instead of reading Service Quotas
//   --seeds 20 --sequences 10000 --unit 500 --steps 10
//   --retries 2              relaunches of a unit whose task stopped without a result (Spot interruption)
//   --poll 30                seconds between polls
//   --step-seconds 1         per-step time used for the wall-time estimate (the design's conservative figure)
//   --fault-rate 0           injected conflict rate on the DynamoDB side
//   --ddb-local-dir <dir>    default ~/git/akl/handoff/dynamodb-local
//   --repo <dir>             the akldb checkout (default: this one)
//   --region us-east-2  --stack akldb-fuzz  --state-dir <dir>
//   --skip-build             the image for this commit is already in the repository
//   --teardown               delete the stack at the end (the results bucket is retained)
//   --no-wait                launch and exit; use --resume later to collect
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import url from "node:url";
import { aggregate } from "./aggregate.mjs";
import { estimate, expectedUnits, formatEstimate, lanesFor, memoryMiB, planCapacity, unitKey } from "./units.mjs";

const HERE = path.dirname(url.fileURLToPath(import.meta.url));
const DEFAULT_REPO = path.resolve(HERE, "..", "..", "..");

export function parseArgs(argv) {
  const a = {
    commit: undefined, run: undefined, plan: false, resume: false, onDemand: false, vcpu: "auto", quota: undefined, seeds: 20, sequences: 10000, unit: 500, steps: 10,
    retries: 2, poll: 30, stepSeconds: 1, faultRate: 0, ddbDir: path.join(os.homedir(), "git/akl/handoff/dynamodb-local"), repo: DEFAULT_REPO, region: "us-east-2",
    stack: "akldb-fuzz", stateDir: undefined, skipBuild: false, teardown: false, wait: true,
  };
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    const v = () => argv[++i];
    if (k === "--commit") a.commit = v();
    else if (k === "--run") a.run = v();
    else if (k === "--plan") a.plan = true;
    else if (k === "--resume") a.resume = true;
    else if (k === "--on-demand") a.onDemand = true;
    else if (k === "--vcpu") a.vcpu = v();
    else if (k === "--quota") a.quota = Number(v());
    else if (k === "--seeds") a.seeds = Number(v());
    else if (k === "--sequences") a.sequences = Number(v());
    else if (k === "--unit") a.unit = Number(v());
    else if (k === "--steps") a.steps = Number(v());
    else if (k === "--retries") a.retries = Number(v());
    else if (k === "--poll") a.poll = Number(v());
    else if (k === "--step-seconds") a.stepSeconds = Number(v());
    else if (k === "--fault-rate") a.faultRate = Number(v());
    else if (k === "--ddb-local-dir") a.ddbDir = v();
    else if (k === "--repo") a.repo = v();
    else if (k === "--region") a.region = v();
    else if (k === "--stack") a.stack = v();
    else if (k === "--state-dir") a.stateDir = v();
    else if (k === "--skip-build") a.skipBuild = true;
    else if (k === "--teardown") a.teardown = true;
    else if (k === "--no-wait") a.wait = false;
    else throw new Error(`unknown argument ${k}`);
  }
  return a;
}

/** The task size to use: `auto` (most of the quota) or a fixed one that the quota can hold at least once. */
export function chooseSize(vcpuArg, quotaVcpu) {
  if (vcpuArg === "auto") return planCapacity(quotaVcpu);
  const vcpu = Number(vcpuArg);
  const concurrent = Math.floor(quotaVcpu / vcpu);
  if (![8, 4, 2, 1].includes(vcpu) || concurrent < 1) return null;
  return { vcpu, concurrent, used: concurrent * vcpu, lanes: lanesFor(vcpu), memoryMiB: memoryMiB(vcpu) };
}

/**
 * Pure scheduling: which pending units to launch now. `running` counts the tasks the cluster has for this run, `slots`
 * is the concurrency the quota allows. A unit already attempted `retries + 1` times is given up on (the verdict then
 * lists it as missing).
 */
export function nextLaunches({ pending, running, slots, attempts, retries }) {
  const free = Math.max(0, slots - running);
  const out = [];
  const gaveUp = [];
  for (const u of pending) {
    if ((attempts[unitKey(u)] ?? 0) > retries) gaveUp.push(u);
    else if (out.length < free) out.push(u);
  }
  return { launch: out, gaveUp };
}

// ---------------------------------------------------------------------------
// AWS and docker plumbing (the only code that touches the cloud)
// ---------------------------------------------------------------------------

function makeAws(a) {
  const aws = (args, { json = true, input } = {}) => {
    const out = execFileSync("aws", [...args, "--region", a.region, ...(json ? ["--output", "json"] : [])], { encoding: "utf8", input, maxBuffer: 64 * 1024 * 1024, stdio: ["pipe", "pipe", "inherit"] });
    return json && out.trim() !== "" ? JSON.parse(out) : out;
  };
  return aws;
}

function readQuotas(aws) {
  const all = [];
  let token;
  do {
    const r = aws(["service-quotas", "list-service-quotas", "--service-code", "fargate", ...(token ? ["--starting-token", token] : [])]);
    all.push(...r.Quotas);
    token = r.NextToken;
  } while (token);
  const find = (re) => all.find((q) => re.test(q.QuotaName));
  return { onDemand: find(/on-demand.*vcpu/i)?.Value, spot: find(/spot.*vcpu/i)?.Value, names: all.map((q) => `${q.QuotaName}=${q.Value}`) };
}

function stackOutputs(aws, stack) {
  const r = aws(["cloudformation", "describe-stacks", "--stack-name", stack]);
  return Object.fromEntries(r.Stacks[0].Outputs.map((o) => [o.OutputKey, o.OutputValue]));
}

function listResultKeys(aws, bucket, prefix) {
  const keys = new Set();
  let token;
  do {
    const r = aws(["s3api", "list-objects-v2", "--bucket", bucket, "--prefix", `${prefix}/`, ...(token ? ["--starting-token", token] : [])]);
    for (const o of r.Contents ?? []) keys.add(o.Key.slice(prefix.length + 1));
    token = r.NextToken;
  } while (token);
  return keys;
}

function buildAndPush(a, sha, outputs, aws) {
  const ctx = fs.mkdtempSync(path.join(os.tmpdir(), "akldb-fuzz-ctx-"));
  try {
    fs.mkdirSync(path.join(ctx, "repo"));
    const archive = spawnSync("sh", ["-c", `git -C '${a.repo}' archive ${sha} | tar -x -C '${path.join(ctx, "repo")}'`], { stdio: "inherit" });
    if (archive.status !== 0) throw new Error("git archive failed");
    if (!fs.existsSync(path.join(a.ddbDir, "DynamoDBLocal.jar"))) throw new Error(`no DynamoDBLocal.jar in ${a.ddbDir} (--ddb-local-dir)`);
    fs.cpSync(a.ddbDir, path.join(ctx, "ddb"), { recursive: true });
    fs.copyFileSync(path.join(HERE, "..", "..", "..", "infra", "fuzz.Dockerfile"), path.join(ctx, "Dockerfile"));
    const host = outputs.RepositoryUri.split("/")[0];
    const pw = aws(["ecr", "get-login-password"], { json: false }).trim();
    execFileSync("docker", ["login", "--username", "AWS", "--password-stdin", host], { input: pw, stdio: ["pipe", "inherit", "inherit"] });
    execFileSync("docker", ["buildx", "build", "--platform", "linux/arm64", "--build-arg", `COMMIT=${sha}`, "-t", `${outputs.RepositoryUri}:${sha}`, "--push", ctx], { stdio: "inherit" });
  } finally {
    fs.rmSync(ctx, { recursive: true, force: true });
  }
}

const sleep = (s) => new Promise((r) => setTimeout(r, s * 1000));

async function main() {
  const a = parseArgs(process.argv.slice(2));
  if (a.commit === undefined) throw new Error("--commit <sha> is required");
  const sha = a.plan && !fs.existsSync(path.join(a.repo, ".git")) ? a.commit : execFileSync("git", ["-C", a.repo, "rev-parse", a.commit], { encoding: "utf8" }).trim();
  const run = a.run ?? `fuzz-${sha.slice(0, 7)}`;
  const log = (m) => console.log(`[aws-run] ${m}`);
  const units = expectedUnits({ seeds: a.seeds, sequences: a.sequences, unit: a.unit });
  const market = a.onDemand ? "FARGATE" : "FARGATE_SPOT";
  const aws = a.plan ? null : makeAws(a);

  // 1. the quota decides the task size, the concurrency and the expected wall time
  let quota = a.quota;
  if (quota === undefined) {
    const q = readQuotas(aws);
    quota = a.onDemand ? q.onDemand : q.spot;
    log(`Fargate quotas: ${q.names.filter((n) => /vcpu/i.test(n)).join("; ")}`);
    if (quota === undefined) throw new Error("could not find the Fargate vCPU quota in Service Quotas; pass --quota <vcpu>");
  }
  const size = chooseSize(a.vcpu, quota);
  if (size === null) throw new Error(`the ${market} quota of ${quota} vCPU cannot hold a ${a.vcpu} vCPU task`);
  const est = estimate({ units: units.length, count: a.unit, steps: a.steps, quotaVcpu: quota, stepSeconds: a.stepSeconds });
  const sized = a.vcpu === "auto" ? est : { ...est, ...size, waves: Math.ceil(units.length / size.concurrent), unitMinutes: (a.unit * a.steps * a.stepSeconds) / size.lanes / 60 + 2 };
  if (a.vcpu !== "auto") sized.wallHours = (sized.waves * sized.unitMinutes) / 60;
  log(`${market}: quota ${quota} vCPU -> ${formatEstimate(sized)}; ${units.length} units of ${a.unit} sequences x ${a.steps} steps`);
  if (quota < 160) log("a quota under 160 vCPU stretches the gate; the Spot increase to 160 was requested 2026-10-25");
  if (a.plan) return;

  // 2. the stack
  const vpc = aws(["ec2", "describe-vpcs", "--filters", "Name=isDefault,Values=true"]).Vpcs[0];
  if (vpc === undefined) throw new Error("no default VPC");
  const subnets = aws(["ec2", "describe-subnets", "--filters", `Name=vpc-id,Values=${vpc.VpcId}`, "Name=map-public-ip-on-launch,Values=true"]).Subnets.map((s) => s.SubnetId);
  if (subnets.length === 0) throw new Error("the default VPC has no public subnet");
  log(`deploying ${a.stack} (run ${run}, image tag ${sha.slice(0, 12)}...)`);
  aws(["cloudformation", "deploy", "--template-file", path.join(HERE, "..", "..", "..", "infra", "fuzz.yaml"), "--stack-name", a.stack, "--capabilities", "CAPABILITY_IAM", "--no-fail-on-empty-changeset",
    "--parameter-overrides", `RunId=${run}`, `ImageTag=${sha}`, `VpcId=${vpc.VpcId}`], { json: false });
  const out = stackOutputs(aws, a.stack);

  // 3. the image
  let have = false;
  try {
    aws(["ecr", "describe-images", "--repository-name", "akldb-fuzz", "--image-ids", `imageTag=${sha}`]);
    have = true;
  } catch {
    // not pushed yet
  }
  if (!have && !a.skipBuild) buildAndPush(a, sha, out, aws);
  else log(have ? "the image for this commit is already in the repository" : "--skip-build: not building");

  // 4. launch, poll
  const stateDir = a.stateDir ?? path.join(os.tmpdir(), `akldb-fuzz-${run}`);
  fs.mkdirSync(stateDir, { recursive: true });
  const resultsDir = path.join(stateDir, "results");
  const attempts = {};
  const taskOf = {}; // unit key -> task arn
  const startedBy = `fuzz-${run}`.slice(0, 36);
  const done = listResultKeys(aws, out.Bucket, run);
  let todo = units.filter((u) => !done.has(unitKey(u)));
  if (a.resume) {
    // a result that carries an infrastructure error is relaunched too; a real diff is not (it would only fail again)
    sync(aws, out.Bucket, run, resultsDir);
    const r = aggregate({ units, read: (k) => readJson(path.join(resultsDir, k)), commit: sha });
    const infra = r.bad.filter((b) => b.errors > 0).map(({ seed, from, count }) => ({ seed, from, count }));
    todo = [...r.missing, ...r.wrongCommit.map(({ seed, from, count }) => ({ seed, from, count })), ...infra];
    log(`resume: ${todo.length} units to launch`);
  }
  log(`${done.size} results already in s3://${out.Bucket}/${run}/; launching ${todo.length} units, ${size.concurrent} at a time`);
  const gaveUp = new Set();
  const overrides = (u) => ({
    cpu: String(size.vcpu * 1024),
    memory: String(size.memoryMiB),
    containerOverrides: [{ name: "fuzz", environment: [
      { name: "SEED", value: String(u.seed) }, { name: "FROM", value: String(u.from) }, { name: "COUNT", value: String(u.count) }, { name: "STEPS", value: String(a.steps) },
      { name: "LANES", value: String(size.lanes) }, { name: "FAULT_RATE", value: String(a.faultRate) }, { name: "RESULT_URL", value: `s3://${out.Bucket}/${run}/${unitKey(u)}` },
    ] }],
  });
  const t0 = Date.now();
  while (a.wait || todo.length > 0) {
    const have = listResultKeys(aws, out.Bucket, run);
    const running = aws(["ecs", "list-tasks", "--cluster", out.Cluster, "--started-by", startedBy, "--desired-status", "RUNNING"]).taskArns;
    // a launched unit whose task is gone and has no result was interrupted: it goes back in the queue
    const live = new Set(running);
    for (const u of units) {
      const k = unitKey(u);
      if (taskOf[k] !== undefined && !live.has(taskOf[k]) && !have.has(k)) {
        log(`unit ${k} stopped without a result (attempt ${attempts[k] ?? 1})`);
        delete taskOf[k];
        if (!todo.some((x) => unitKey(x) === k)) todo.push(u);
      }
    }
    todo = todo.filter((u) => !have.has(unitKey(u)) && !gaveUp.has(unitKey(u)));
    const pendingNow = todo.filter((u) => taskOf[unitKey(u)] === undefined);
    const { launch, gaveUp: lost } = nextLaunches({ pending: pendingNow, running: running.length, slots: size.concurrent, attempts, retries: a.retries });
    for (const u of lost) gaveUp.add(unitKey(u));
    for (const u of launch) {
      const k = unitKey(u);
      const r = aws(["ecs", "run-task", "--cluster", out.Cluster, "--task-definition", out.TaskDefinition, "--count", "1", "--started-by", startedBy,
        "--capacity-provider-strategy", `capacityProvider=${market},weight=1`,
        "--network-configuration", `awsvpcConfiguration={subnets=[${subnets.join(",")}],securityGroups=[${out.SecurityGroup}],assignPublicIp=ENABLED}`,
        "--overrides", JSON.stringify(overrides(u))]);
      attempts[k] = (attempts[k] ?? 0) + 1;
      if (r.tasks.length > 0) taskOf[k] = r.tasks[0].taskArn;
      else log(`unit ${k}: ${market} refused (${(r.failures ?? []).map((f) => f.reason).join(", ")}); will retry`);
    }
    const finished = units.filter((u) => have.has(unitKey(u))).length;
    log(`${finished}/${units.length} results, ${running.length} running, ${todo.length - Object.keys(taskOf).filter((k) => todo.some((u) => unitKey(u) === k)).length} waiting, ${gaveUp.size} given up; ${((Date.now() - t0) / 3.6e6).toFixed(1)} h elapsed`);
    if (todo.length === 0 && running.length === 0) break;
    if (!a.wait && launch.length === 0) break;
    if (!a.wait) {
      log("--no-wait: launched what fits; run again with --resume to launch more and collect");
      return;
    }
    await sleep(a.poll);
  }

  // 5. verdict
  sync(aws, out.Bucket, run, resultsDir);
  const res = spawnSync(process.execPath, [path.join(HERE, "aggregate.mjs"), "--results", resultsDir, "--commit", sha, "--seeds", String(a.seeds), "--sequences", String(a.sequences), "--unit", String(a.unit), "--missing-out", path.join(stateDir, "missing.json")], { stdio: "inherit" });
  if (a.teardown) {
    log(`deleting ${a.stack} (the bucket akldb-fuzz-<account> is retained for its 30-day lifecycle)`);
    aws(["cloudformation", "delete-stack", "--stack-name", a.stack], { json: false });
  } else log(`${a.stack} is still deployed; delete it with --teardown (or aws cloudformation delete-stack) after the campaign`);
  process.exit(res.status ?? 2);
}

function sync(aws, bucket, run, dir) {
  fs.mkdirSync(dir, { recursive: true });
  aws(["s3", "sync", `s3://${bucket}/${run}/`, dir, "--only-show-errors"], { json: false });
}

function readJson(f) {
  try {
    return JSON.parse(fs.readFileSync(f, "utf8"));
  } catch {
    return undefined;
  }
}

if (process.argv[1] !== undefined && url.pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  main().catch((e) => (console.error(e instanceof Error ? e.message : e), process.exit(2)));
}
