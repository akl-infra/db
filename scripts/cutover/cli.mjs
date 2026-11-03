// Shared by run.mjs and rollback.mjs: argument parsing, the options object and the real ports.
import fs from "node:fs";
import path from "node:path";
import url from "node:url";
import { loadKit } from "./kit.mjs";
import { createAwsPort, createD1Port, createDumpsPort, createHttpPort, realExec, realOperatorFactory } from "./ports-real.mjs";
import { CACHE_WAIT_MS } from "./cutover-steps.mjs";

export const REPO = path.resolve(path.dirname(url.fileURLToPath(import.meta.url)), "..", "..");
export const systemClock = { now: () => Date.now(), sleep: (ms) => new Promise((r) => setTimeout(r, ms)) };

const PROD = { stack: "akldb-prod", workerUrl: "https://api.akldb.org", awsUrl: "https://aws-api.akldb.org", d1: "akl-db" };
const STAGING = { stack: "akldb-staging", awsUrl: "https://staging-api.akldb.org" };

/** The WIRE_VERSION in this tree + 1: the API minor the Worker build with the modes is expected to announce. */
export function defaultMinMinor() {
  const m = /export const WIRE_VERSION = (\d+);/.exec(fs.readFileSync(path.join(REPO, "src", "core", "etag.ts"), "utf8"));
  return m === null ? 0 : Number(m[1]) + 1;
}

const VALUE_FLAGS = ["state", "work", "from", "only", "d1", "worker-url", "aws-url", "stack", "stage", "profile", "region", "min-api-minor", "report", "page-rows", "concurrency", "write-route", "write-body", "migrations-dir", "date", "cutover-state", "new-d1", "variant"];
const BOOL_FLAGS = ["execute", "abort", "allow-pending", "worker-pointed", "help", "json"];

export function parseArgs(argv) {
  const a = { flags: {} };
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    if (!k.startsWith("--")) throw new Error(`unexpected argument ${k}`);
    const name = k.slice(2);
    if (BOOL_FLAGS.includes(name)) a.flags[name] = true;
    else if (VALUE_FLAGS.includes(name)) {
      const v = argv[++i];
      if (v === undefined || v.startsWith("--")) throw new Error(`${k} needs a value`);
      a.flags[name] = v;
    } else throw new Error(`unknown argument ${k}`);
  }
  return a;
}

/** The options both machines share. `which`: "cutover" | "rollback". */
export function buildOptions(flags, { env = process.env, now = Date.now } = {}) {
  const stage = flags.stage ?? "prod";
  if (!["prod", "staging"].includes(stage)) throw new Error("--stage is prod or staging");
  const base = stage === "prod" ? PROD : { ...PROD, ...STAGING };
  const d1Name = flags.d1 ?? (stage === "prod" ? PROD.d1 : undefined);
  if (d1Name === undefined) throw new Error("--stage staging needs --d1 <scratch D1 name>: a rehearsal never defaults to a database");
  if (stage === "staging" && d1Name === PROD.d1) throw new Error(`--stage staging refuses the production D1 (${PROD.d1}): name the scratch D1`);
  const workerUrl = flags["worker-url"] ?? (stage === "prod" ? PROD.workerUrl : undefined);
  if (workerUrl === undefined) throw new Error("--stage staging needs --worker-url <the rehearsal Worker>");
  if (stage === "staging" && /^https:\/\/api\.akldb\.org/.test(workerUrl)) throw new Error("--stage staging refuses https://api.akldb.org as the Worker: use the rehearsal Worker's URL");
  const work = path.resolve(flags.work ?? path.join(REPO, "dist", `cutover-${stage}`));
  const date = flags.date ?? new Date(now()).toISOString().slice(0, 10);
  const [writeMethod, writePath] = (flags["write-route"] ?? "POST /v1/admin/nightly/tick").split(" ");
  return {
    stage,
    d1Name,
    stack: flags.stack ?? base.stack,
    workerUrl: workerUrl.replace(/\/$/, ""),
    awsUrl: (flags["aws-url"] ?? base.awsUrl).replace(/\/$/, ""),
    profile: flags.profile,
    region: flags.region ?? "us-east-2",
    minMinor: flags["min-api-minor"] === undefined ? defaultMinMinor() : Number(flags["min-api-minor"]),
    work,
    statePath: path.resolve(flags.state ?? path.join(work, "state.json")),
    report: path.resolve(flags.report ?? path.join(work, "report.md")),
    migrationsDir: path.resolve(flags["migrations-dir"] ?? path.join(REPO, "migrations")),
    pageRows: Number(flags["page-rows"] ?? 500),
    concurrency: Number(flags.concurrency ?? 4),
    allowPending: flags["allow-pending"] === true,
    cacheWaitMs: CACHE_WAIT_MS,
    writeMethod,
    writePath,
    writeBody: flags["write-body"] ?? (writeMethod === "GET" ? undefined : "{}"),
    date,
    newD1Name: flags["new-d1"] ?? `akl-db-rollback-${date}`,
    cutoverState: flags["cutover-state"],
    variant: flags.variant,
    workerPointed: flags["worker-pointed"] === true,
    params: { stage, d1Name, stack: flags.stack ?? base.stack },
  };
}

export function realPorts(o, { env = process.env, exec = realExec, fetchImpl, clock = systemClock } = {}) {
  if (!env.CLOUDFLARE_ACCOUNT_ID) throw new Error("CLOUDFLARE_ACCOUNT_ID is not set (wrangler needs it for the akl account)");
  const http = createHttpPort({ fetchImpl, env });
  const aws = createAwsPort({ exec, region: o.region, profile: o.profile, stack: o.stack, operatorFactory: (outputs) => realOperatorFactory(outputs, { env, region: o.region, loadKit }) });
  return { clock, d1: createD1Port({ exec, env }), http, aws, dumps: createDumpsPort({ env, outputs: () => aws.stackOutputs(), fetchImpl, region: o.region }) };
}
