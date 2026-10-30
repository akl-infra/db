#!/usr/bin/env node
// The cutover orchestrator (design/aws-port.md §5.2): `run.mjs --to aws|d1`, exactly the one-PR cutover's steps 1-7 and the rollback's.
// It runs from CI (the `cutover` job, design/lab/ci-cutover.patch) whenever `cutover/akldb.json` changes on main, and by hand for rehearsals.
//
//   node scripts/cutover/run.mjs --to aws|d1 [--dry-run] [--status] [--rehearse <worker>] [--stage lab|staging|prod]
//        [--max-pause-ms 30000] [--ports <module>] [--json]
//
//   --dry-run   print the plan (steps, the calls each makes, what a failure does); touches nothing, needs no credentials
//   --status    print both modes and exit (what a failed job left behind)
//   --rehearse  run against that Worker (`akl-db-rehearsal`, its own D1 via REHEARSAL_D1_ID) and the lab/staging AWS stage
//   --ports     a module exporting `createPorts({ clock, log, options })`: the local stand-ins of tests/cutover, or any other stage
//
// Credentials it reads, and nothing else: CLOUDFLARE_DB_TOKEN (+ CLOUDFLARE_DB_ACCOUNT_ID), the akldb-ci key (AWS_ACCESS_KEY_ID /
// AWS_SECRET_ACCESS_KEY, assumed into akldb-cutover-role), and the ops client (CLIENT_ID / CLIENT_PRIVATE_KEY / OPS_ACTOR) for the smoke.
// Exit 0 = done (or already there), 1 = the run failed (it aborted or rolled back, see the last JSON line), 2 = usage or not wired.
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { describePlan, DEFAULTS, runPlan } from "./steps.mjs";
import { createRealPorts, UNWIRED } from "./ports-real.mjs";

const REPO = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..", "..");

export function parseArgs(argv) {
  const a = { json: false, dryRun: false, status: false, maxPauseMs: DEFAULTS.maxPauseMs };
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    const next = () => {
      const v = argv[++i];
      if (v === undefined) throw new Error(`${k} needs a value`);
      return v;
    };
    if (k === "--to") a.to = next();
    else if (k === "--dry-run") a.dryRun = true;
    else if (k === "--status") a.status = true;
    else if (k === "--json") a.json = true;
    else if (k === "--rehearse") a.rehearse = next();
    else if (k === "--stage") a.stage = next();
    else if (k === "--ports") a.ports = next();
    else if (k === "--max-pause-ms") a.maxPauseMs = Number(next());
    else throw new Error(`unknown argument ${k}`);
  }
  if (!a.status && a.to !== "aws" && a.to !== "d1") throw new Error("--to aws|d1 is required");
  if (a.rehearse !== undefined && !/^akl-db-rehearsal/.test(a.rehearse)) throw new Error("--rehearse names a rehearsal Worker (akl-db-rehearsal...), never the production Worker");
  if (a.stage !== undefined && !["lab", "staging", "prod"].includes(a.stage)) throw new Error("--stage is lab, staging or prod");
  if (a.rehearse !== undefined && (a.stage === undefined || a.stage === "prod")) throw new Error("--rehearse needs --stage lab or staging");
  if (!Number.isFinite(a.maxPauseMs) || a.maxPauseMs <= 0) throw new Error("--max-pause-ms must be a positive number");
  return a;
}

/** `cutover/akldb.json`'s primary, for the CI job: `node scripts/cutover/run.mjs --to "$(node -p ...)"`. */
export function readPrimary(file = path.join(REPO, "cutover", "akldb.json")) {
  const j = JSON.parse(fs.readFileSync(file, "utf8"));
  if (j.primary !== "d1" && j.primary !== "aws") throw new Error(`${file}: primary must be "d1" or "aws"`);
  return j.primary;
}

const systemClock = { now: () => Date.now(), sleep: (ms) => new Promise((r) => setTimeout(r, ms)) };

/** Entry point, injectable for tests. Returns the exit code. */
export async function main(argv, { env = process.env, out = (s) => console.log(s), clock = systemClock, exec, fetchImpl } = {}) {
  let a;
  try {
    a = parseArgs(argv);
  } catch (e) {
    out(`run.mjs: ${e.message}`);
    return 2;
  }
  const options = { maxPauseMs: a.maxPauseMs, rehearse: a.rehearse };
  if (a.dryRun) {
    out(describePlan(a.to, options));
    return 0;
  }
  const log = (event) => out(JSON.stringify(event));
  let ports;
  if (a.ports !== undefined) {
    ports = (await import(pathToFileURL(path.resolve(a.ports)).href)).createPorts({ clock, log, options });
  } else {
    const real = realPortsFor(a, { env, clock, log, exec, fetchImpl });
    if (real.error) {
      out(`run.mjs: ${real.error}`);
      return 2;
    }
    ports = real.ports;
  }
  if (a.status) {
    out(JSON.stringify({ d1: await ports.d1.getMode(), aws: await ports.aws.getMode() }));
    return 0;
  }
  const result = await runPlan(a.to, ports, { maxPauseMs: a.maxPauseMs });
  out(JSON.stringify({ event: "summary", ...result }));
  return result.ok ? 0 : 1;
}

function realPortsFor(a, { env, clock, log, exec, fetchImpl }) {
  const missing = ["CLOUDFLARE_DB_TOKEN", "AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY"].filter((k) => !env[k]);
  if (!(env.CLOUDFLARE_ACCOUNT_ID || env.CLOUDFLARE_DB_ACCOUNT_ID)) missing.push("CLOUDFLARE_DB_ACCOUNT_ID");
  if (missing.length > 0) return { error: `missing credentials: ${missing.join(", ")}` };
  const d1Id = a.rehearse !== undefined ? env.REHEARSAL_D1_ID : env.AKLDB_D1_ID ?? "53f596d5-9cb5-43b0-9026-17518d18052f";
  if (!d1Id) return { error: "REHEARSAL_D1_ID is not set" };
  if (UNWIRED.length > 0) return { error: `the real mirror/ephemeral/proof/smoke ports are not wired yet (${UNWIRED.join(", ")}); refusing to freeze anything. Use --dry-run, or --ports for a stand-in.` };
  const stage = a.stage === undefined || a.stage === "prod" ? undefined : stageFor(a.stage);
  return { ports: createRealPorts({ env, exec, fetchImpl, clock, log, worker: a.rehearse ?? "akl-db", d1Id, stage }) };
}

function stageFor(name) {
  // Rehearsals use the lab/staging stack: same shape as prod, different names and no account-wide role.
  return {
    stack: `akldb-${name}`,
    region: "us-east-2",
    mainTable: `akldb-${name}-main`,
    functions: ["api", "feed", "jobs"].map((f) => `akldb-${name}-${f}`),
    schedules: { jobs: `akldb-${name}-jobs`, applier: `akldb-${name}-mirror-apply` },
    ssmPrefix: `/akldb/${name}`,
    discordParams: [],
    roleName: "akldb-cutover-role",
    account: "335937358231",
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (e) => {
      console.error(`run.mjs: ${e?.stack ?? e}`);
      process.exit(1);
    },
  );
}
