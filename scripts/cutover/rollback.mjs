#!/usr/bin/env node
// The rollback: AWS design A back to Cloudflare, as a resumable step machine (design/aws-a-cutover.md, "Rollback").
//
//   node scripts/cutover/rollback.mjs [--execute] [--from <step>] [--only <step>] [--variant original-d1|fresh-d1] [options]
//
//   steps      decide aws-readonly capture d1-prove create-d1 import verify point-worker dns-back reopen report
//   variants   original-d1  AWS took no write past the image (only operator flag units): reuse the ORIGINAL D1, proven equal to the image
//              fresh-d1     otherwise: capture AWS, import into a fresh D1 (--new-d1, default akl-db-rollback-<date>), prove it equal,
//                           point the Worker at it (manual: a PR; re-run with --worker-pointed)
//              both         then saltorbit puts the DNS record back on the Worker (dns-back polls), and the flag is cleared (reopen)
//   (none)     DRY RUN: prints the commands each step would run and does nothing
//
// The same options as run.mjs (--stage, --d1, --worker-url, --stack, --profile, --state, --work, --report ...).
// Exit: 0 done, 1 a step failed, 2 usage. The old D1 is never modified in the fresh-d1 variant.
import fs from "node:fs";
import url from "node:url";
import { buildOptions, parseArgs, realPorts, systemClock } from "./cli.mjs";
import { runPlan } from "./machine.mjs";
import { steps } from "./rollback-steps.mjs";

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
    o.statePath = parsed.flags.state ? o.statePath : o.statePath.replace(/state\.json$/, "rollback-state.json");
    o.report = parsed.flags.report ? o.report : o.report.replace(/report\.md$/, "rollback-report.md");
  } catch (e) {
    out(`rollback.mjs: ${e.message}`);
    return 2;
  }
  const f = parsed.flags;
  const execute = f.execute === true;
  if (execute && ports === undefined) {
    try {
      ports = realPorts(o, { env, exec, fetchImpl, clock });
    } catch (e) {
      out(`rollback.mjs: ${e.message}`);
      return 2;
    }
  }
  o.resumeCommand = (id) => `node scripts/cutover/rollback.mjs --execute --from ${id}${f.state ? ` --state ${f.state}` : ""}${f.stage ? ` --stage ${f.stage}` : ""}${o.workerPointed ? " --worker-pointed" : ""}`;
  const ctx = { ports, o, out, clock };
  const result = await runPlan("rollback", steps(o), ctx, { statePath: o.statePath, execute, from: f.from, only: f.only });
  if (result.message) out(`rollback.mjs: ${result.message}`);
  if (execute && result.ok) out(`\nrollback.mjs: done (${result.ran.join(", ")}). State: ${o.statePath}`);
  return result.exit;
}

if (process.argv[1] && import.meta.url === url.pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (e) => {
      console.error(`rollback.mjs: ${e?.stack ?? e}`);
      process.exit(1);
    },
  );
}
