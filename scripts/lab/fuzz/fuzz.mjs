#!/usr/bin/env node
// CLI for the differential fuzzer (lane L). See run.mjs for what it does.
//
//   node scripts/lab/fuzz/fuzz.mjs [--seeds 1,2,3 | --seed-count 20] [--sequences 50] [--steps 10]
//     [--mode ddb|self] [--ddb http://127.0.0.1:18307] [--ports 18317,18318,18319,18320]
//     [--fault-rate 0.2] [--check-every 1] [--state-every 1] [--ignore-tables a,b]
//     [--from <i>] [--reset inplace|restart] [--verify-reset] [--discord-url <url>] [--transcript <file>]
//     [--dump fixture|<file>] [--out <dir>] [--work <dir>] [--max-diffs 20]
//
// Sequence i of seed s is a pure function of (s, i): every sequence starts from the seeded template, so
// `--seeds s --from i --sequences 1` reproduces exactly what a unit of the gate saw (lane F; LDB-FZ1).
// The gate (design §9): 10k sequences x 20 seeds, zero diffs. DynamoDB Local must
// already be listening (docker run -d --rm --name akldb-ddb-l -p 127.0.0.1:18307:8000
// amazon/dynamodb-local:latest -jar DynamoDBLocal.jar -inMemory -sharedDb).
import process from "node:process";
import { runFuzz } from "./run.mjs";

const a = { seeds: [1], sequences: 50, steps: 10, mode: "ddb", ddbEndpoint: "http://127.0.0.1:18307", ports: undefined, faultRate: 0, checkEvery: 1, stateEvery: 1, ignoreTables: [], dump: undefined, from: 0, reset: "inplace", verifyReset: false, discordUrl: undefined, transcript: undefined, out: undefined, work: undefined, maxDiffs: 20 };
const argv = process.argv.slice(2);
for (let i = 0; i < argv.length; i++) {
  const k = argv[i];
  const v = () => argv[++i];
  if (k === "--seeds") a.seeds = v().split(",").map(Number);
  else if (k === "--seed-count") a.seeds = Array.from({ length: Number(v()) }, (_, n) => n + 1);
  else if (k === "--sequences") a.sequences = Number(v());
  else if (k === "--steps") a.steps = Number(v());
  else if (k === "--mode") a.mode = v();
  else if (k === "--ddb") a.ddbEndpoint = v();
  else if (k === "--ports") a.ports = v().split(",").map(Number);
  else if (k === "--fault-rate") a.faultRate = Number(v());
  else if (k === "--check-every") a.checkEvery = Number(v());
  else if (k === "--state-every") a.stateEvery = Number(v());
  else if (k === "--ignore-tables") a.ignoreTables = v().split(",");
  else if (k === "--dump") a.dump = v();
  else if (k === "--from") a.from = Number(v());
  else if (k === "--reset") a.reset = v();
  else if (k === "--verify-reset") a.verifyReset = true;
  else if (k === "--discord-url") a.discordUrl = v();
  else if (k === "--transcript") a.transcript = v();
  else if (k === "--out") a.out = v();
  else if (k === "--work") a.work = v();
  else if (k === "--max-diffs") a.maxDiffs = Number(v());
  else throw new Error(`unknown argument ${k}`);
}
try {
  const report = await runFuzz(a);
  process.exit(report.ok ? 0 : 1);
} catch (e) {
  console.error(e);
  process.exit(2);
}
