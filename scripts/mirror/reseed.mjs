#!/usr/bin/env node
// Reseed the AWS mirror from a fresh full private D1 export (design/aws-port.md §5.2 "Recovery"): halt the applier, wipe both
// tables (the queue survives), import the export, verify it row for row, open the queue from S+1, replay it, report.
//
//   node scripts/mirror/reseed.mjs <export.sqlite|rows.json> --main <table> --ephemeral <table> --export-at-ms <ms>
//     [--endpoint <url>] [--region us-east-2] [--direction d1->ddb] [--blobs-module <file>] [--no-replay]
//
// <export.sqlite> must be a consistent snapshot; --export-at-ms is the instant it was taken (queued calls that returned at or
// before it are already in the export and are dropped). Run by the main session under aws-vault with AKLDB_DDB_ALLOW_REMOTE=1;
// against DynamoDB Local it needs neither. Exit 0 only if the load verified and the replay did not halt.
import process from "node:process";
import { COMMON, connect, loadOps, parseArgs, readRows } from "./cli.mjs";

const a = parseArgs(process.argv.slice(2), {
  defaults: { ...COMMON.defaults, "export-at-ms": 0, "no-replay": false },
  flags: { ...COMMON.flags, "export-at-ms": "number", "no-replay": "bool" },
});
if (a._.length !== 1 || !a.main || !a.ephemeral || !a["export-at-ms"]) {
  console.error("usage: reseed.mjs <export.sqlite|rows.json> --main <table> --ephemeral <table> --export-at-ms <ms> [options]");
  process.exit(2);
}
const ops = await loadOps();
const { ctx, queue, applyDeps } = await connect(ops, a);
const r = await ops.reseed({ ctx, queue, rows: readRows(a._[0]), exportAtMs: a["export-at-ms"], applyDeps: a["no-replay"] ? undefined : applyDeps, log: (m) => console.log(`[reseed] ${m}`) });
console.log(JSON.stringify({ seedSeq: r.seedSeq, wiped: r.wiped, loadDiffs: r.verified, replay: r.replay && { applied: r.replay.applied, skipped: r.replay.skipped, halted: r.replay.halted, appliedSeq: r.replay.appliedSeq }, replayVerified: r.replayVerified }, null, 2));
process.exit(r.verified.length === 0 && r.replayVerified ? 0 : 1);
