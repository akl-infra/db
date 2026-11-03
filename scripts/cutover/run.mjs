#!/usr/bin/env node
// The cutover: akldb from Cloudflare (Worker + D1) to AWS design A, as a resumable step machine (design/aws-a-cutover.md).
//
//   node scripts/cutover/run.mjs [--execute] [--from <step>] [--only <step>] [--abort] [--state <file>] [options]
//
//   steps      preflight freeze export load verify image serve proxy open post-smoke report
//   (none)     DRY RUN: prints the commands each step would run and does nothing (no state file is written)
//   --execute  run the steps; the state (--state, default dist/cutover-<stage>/state.json) is written after every step
//   --from X   resume at step X (re-running it and everything after); --only X runs one step; --abort undoes the freeze
//              while nothing is in the AWS log yet (after the image: scripts/cutover/rollback.mjs)
//
//   --stage prod|staging   staging is the rehearsal: it REQUIRES --d1 <scratch D1> and --worker-url <rehearsal Worker>
//   --d1 akl-db  --worker-url https://api.akldb.org  --aws-url https://aws-api.akldb.org  --stack akldb-prod  --profile <aws profile>
//   --min-api-minor N  the API minor the Worker build with the modes announces (default: this tree's WIRE_VERSION + 1)
//   --write-route "POST /v1/admin/nightly/tick"  --write-body '{}'   the signed write of the post-smoke (ops client from db.env.ops)
//   --page-rows 500 --concurrency 4 --allow-pending --work <dir> --report <file> --migrations-dir <dir>
//
// Credentials, from the environment and never printed: CLOUDFLARE_ACCOUNT_ID (+ wrangler's login), AWS_* (aws-vault exec akldb-admin
// -- node scripts/cutover/run.mjs ...), CLIENT_ID / CLIENT_PRIVATE_KEY / OPS_ACTOR (db.env.ops) for the post-smoke.
// Exit: 0 done (or dry run), 1 a step failed (the message says how to resume), 2 usage.
import fs from "node:fs";
import url from "node:url";
import { buildOptions, parseArgs, realPorts, systemClock } from "./cli.mjs";
import { abortSteps, steps } from "./cutover-steps.mjs";
import { runPlan } from "./machine.mjs";

/** Entry point, injectable for tests: `ports` replaces the real ones, `out` collects the output. Returns the exit code. */
export async function main(argv, { env = process.env, out = (s) => console.log(s), clock = systemClock, ports, exec, fetchImpl } = {}) {
  let parsed;
  let o;
  try {
    parsed = parseArgs(argv);
    if (parsed.flags.help) {
      out(fs.readFileSync(url.fileURLToPath(import.meta.url), "utf8").split("\n").filter((l) => l.startsWith("//")).map((l) => l.slice(3)).join("\n"));
      return 0;
    }
    o = buildOptions(parsed.flags, { env, now: clock.now });
  } catch (e) {
    out(`run.mjs: ${e.message}`);
    return 2;
  }
  const f = parsed.flags;
  const execute = f.execute === true;
  if (f.abort && (f.from || f.only)) {
    out("run.mjs: --abort is exclusive with --from/--only");
    return 2;
  }
  if (execute && ports === undefined) {
    try {
      ports = realPorts(o, { env, exec, fetchImpl, clock });
    } catch (e) {
      out(`run.mjs: ${e.message}`);
      return 2;
    }
  }
  o.resumeCommand = (id) => `node scripts/cutover/run.mjs --execute --from ${id}${f.state ? ` --state ${f.state}` : ""}${f.stage ? ` --stage ${f.stage}` : ""}`;
  const ctx = { ports, o, out, clock };
  const plan = f.abort ? abortSteps(o) : steps(o);
  const result = await runPlan("cutover", plan, ctx, { statePath: o.statePath, execute, from: f.abort ? "abort" : f.from, only: f.only });
  if (result.message) out(`run.mjs: ${result.message}`);
  if (execute && result.ok && !f.abort && result.ran.length > 0) out(`\nrun.mjs: done (${result.ran.join(", ")}). State: ${o.statePath}`);
  return result.exit;
}

if (process.argv[1] && import.meta.url === url.pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (e) => {
      console.error(`run.mjs: ${e?.stack ?? e}`);
      process.exit(1);
    },
  );
}
