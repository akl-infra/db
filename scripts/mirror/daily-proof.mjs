#!/usr/bin/env node
// The daily proof (design/aws-port.md §5.2 item 3): pause the applier at the export's (seq, time), export the mirror, compare it
// to the D1 export row for row over every non-ephemeral table, resume.
//
//   node scripts/mirror/daily-proof.mjs <d1-export.sqlite|rows.json> --main <table> --ephemeral <table> --export-at-ms <ms>
//     [--quiet-ms 30000] [--timeout-ms 600000] [--endpoint <url>] [--region us-east-2] [--blobs-module <file>]
//
// Exit 0 = every table identical; 1 = differences (listed) or the pause point was not reached; the pause is always lifted.
// A one-off mismatch can be a call that committed in the milliseconds around the snapshot; take a fresh export and rerun
// before treating it as a divergence. A halted applier (MIRROR_DIVERGED) fails the proof at once.
import process from "node:process";
import { COMMON, connect, loadOps, parseArgs, readRows } from "./cli.mjs";

const a = parseArgs(process.argv.slice(2), {
  defaults: { ...COMMON.defaults, "export-at-ms": 0, "quiet-ms": 30000, "timeout-ms": 600000 },
  flags: { ...COMMON.flags, "export-at-ms": "number", "quiet-ms": "number", "timeout-ms": "number" },
});
if (a._.length !== 1 || !a.main || !a.ephemeral || !a["export-at-ms"]) {
  console.error("usage: daily-proof.mjs <d1-export.sqlite|rows.json> --main <table> --ephemeral <table> --export-at-ms <ms> [options]");
  process.exit(2);
}
const ops = await loadOps();
const { ctx, queue, applyDeps } = await connect(ops, a);
const r = await ops.dailyProof({ ctx, queue, rows: readRows(a._[0]), atMs: a["export-at-ms"], quietMs: a["quiet-ms"], timeoutMs: a["timeout-ms"], applyDeps, log: (m) => console.log(`[proof] ${m}`) });
console.log(JSON.stringify(r, null, 2));
process.exit(r.ok ? 0 : 1);
