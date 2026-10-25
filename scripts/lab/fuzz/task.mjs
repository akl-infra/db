#!/usr/bin/env node
// The fuzzer gate's container entry (lane F; design/aws-port.md §4.3): one work unit = (seed, from, count).
// Starts DynamoDB Local (unless --ddb names one that is already listening), runs the unit's range over N fuzz lanes in
// parallel (each lane its own fuzz.mjs: its own D1 Worker, DynamoDB lab server and table pair), merges the lane reports
// into one unit result JSON, writes it to --result / $RESULT_URL, and exits 0 only when the unit is clean.
//
//   node scripts/lab/fuzz/task.mjs --seed 1 --from 0 --count 500 [--lanes 6] [--steps 10]
//     [--result s3://bucket/run/1/0.json | file:///tmp/x.json] [--run <id>] [--commit <sha>]
//     [--ddb http://127.0.0.1:18561 | --ddb-port 8000 --ddb-dir /opt/dynamodb-local]
//     [--port-base 18562] [--fault-rate 0] [--keep]
// Env fallbacks (the Fargate task sets these): SEED FROM COUNT LANES STEPS RESULT_URL RUN_ID COMMIT FAULT_RATE DDB_LOCAL_DIR.
// Lane k uses ports base+2k (D1 Worker) and base+2k+1 (DynamoDB lab server); one shared fake Discord on base+2*lanes.
import { spawn } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import url from "node:url";
import { startFakeDiscord } from "../p1-crawl-diff.mjs";
import { classifyDiffs, isClean, splitLanes } from "./units.mjs";

const HERE = path.dirname(url.fileURLToPath(import.meta.url));

export function parseArgs(argv, env = process.env) {
  const a = {
    seed: Number(env.SEED ?? 1),
    from: Number(env.FROM ?? 0),
    count: Number(env.COUNT ?? 500),
    lanes: Number(env.LANES ?? 6),
    steps: Number(env.STEPS ?? 10),
    result: env.RESULT_URL,
    run: env.RUN_ID ?? "local",
    commit: env.COMMIT ?? "unknown",
    ddb: undefined,
    ddbPort: 8000,
    ddbDir: env.DDB_LOCAL_DIR ?? "/opt/dynamodb-local",
    portBase: 18562,
    faultRate: Number(env.FAULT_RATE ?? 0),
    keep: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    const v = () => argv[++i];
    if (k === "--seed") a.seed = Number(v());
    else if (k === "--from") a.from = Number(v());
    else if (k === "--count") a.count = Number(v());
    else if (k === "--lanes") a.lanes = Number(v());
    else if (k === "--steps") a.steps = Number(v());
    else if (k === "--result") a.result = v();
    else if (k === "--run") a.run = v();
    else if (k === "--commit") a.commit = v();
    else if (k === "--ddb") a.ddb = v();
    else if (k === "--ddb-port") a.ddbPort = Number(v());
    else if (k === "--ddb-dir") a.ddbDir = v();
    else if (k === "--port-base") a.portBase = Number(v());
    else if (k === "--fault-rate") a.faultRate = Number(v());
    else if (k === "--keep") a.keep = true;
    else throw new Error(`unknown argument ${k}`);
  }
  return a;
}

function listening(port) {
  return new Promise((resolve) => {
    const s = net.connect(port, "127.0.0.1");
    s.once("connect", () => (s.destroy(), resolve(true)));
    s.once("error", () => resolve(false));
  });
}

async function startDdbLocal(a, log) {
  const child = spawn("java", ["-Xmx3g", "-Djava.library.path=./DynamoDBLocal_lib", "-jar", "DynamoDBLocal.jar", "-inMemory", "-sharedDb", "-port", String(a.ddbPort)], { cwd: a.ddbDir, stdio: ["ignore", "inherit", "inherit"] });
  for (let i = 0; i < 120; i++) {
    if (child.exitCode !== null) throw new Error(`DynamoDB Local exited with ${child.exitCode}`);
    if (await listening(a.ddbPort)) {
      log(`DynamoDB Local up on ${a.ddbPort}`);
      return child;
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  child.kill();
  throw new Error("DynamoDB Local did not start in 60 s");
}

function runLane(a, lane, endpoint, discordUrl, laneDir, log) {
  const p1 = a.portBase + 2 * lane.lane;
  const argv = [
    path.join(HERE, "fuzz.mjs"), "--seeds", String(a.seed), "--from", String(lane.from), "--sequences", String(lane.count), "--steps", String(a.steps),
    "--ddb", endpoint, "--ports", `${p1},${p1 + 1},0`, "--discord-url", discordUrl, "--fault-rate", String(a.faultRate), "--max-diffs", "50",
    "--out", path.join(laneDir, "report"), "--work", path.join(laneDir, "work"),
  ];
  fs.mkdirSync(laneDir, { recursive: true });
  const logFile = path.join(laneDir, "lane.log");
  const out = fs.openSync(logFile, "w");
  return new Promise((resolve) => {
    const child = spawn(process.execPath, argv, { stdio: ["ignore", out, out] });
    child.on("error", (e) => resolve({ lane, exit: 2, error: String(e) }));
    child.on("exit", (code, signal) => {
      let report = null;
      try {
        report = JSON.parse(fs.readFileSync(path.join(laneDir, "report", "fuzz-report.json"), "utf8"));
      } catch {
        // crashed before the report
      }
      const tail = fs.readFileSync(logFile, "utf8").slice(-1500);
      log(`lane ${lane.lane} (${lane.from}+${lane.count}) exit ${code ?? signal}`);
      resolve({ lane, exit: code ?? 128, signal, report, tail });
    });
    lanes.add(child);
  });
}
const lanes = new Set();

/** Merge lane results into the unit result. Pure: exported for the tests. */
export function mergeUnit(a, laneResults, startedMs, endedMs) {
  const diffs = [];
  const errors = [];
  let steps = 0, sequences_run = 0, requests = 0, checks = 0;
  const laneSummaries = [];
  for (const r of laneResults) {
    const rep = r.report;
    if (rep === null || rep === undefined) errors.push(`lane ${r.lane.lane} (${r.lane.from}+${r.lane.count}) produced no report (exit ${r.exit}): ${(r.tail ?? r.error ?? "").slice(-600)}`);
    else {
      diffs.push(...rep.diffs);
      steps += rep.steps_run;
      sequences_run += rep.sequences_run ?? 0;
      requests += rep.requests;
      checks += rep.checks;
      if (r.exit === 2) errors.push(`lane ${r.lane.lane} crashed: ${(r.tail ?? "").slice(-600)}`);
    }
    laneSummaries.push({ lane: r.lane.lane, from: r.lane.from, count: r.lane.count, exit: r.exit, sequences_run: rep?.sequences_run ?? 0, steps: rep?.steps_run ?? 0, diffs: rep?.diffs.length ?? 0 });
  }
  const buckets = classifyDiffs(diffs);
  const result = {
    run: a.run, commit: a.commit, seed: a.seed, from: a.from, count: a.count, steps_per_sequence: a.steps, lanes: laneSummaries,
    sequences_run, steps, requests, checks, duration_ms: endedMs - startedMs, started: new Date(startedMs).toISOString(),
    response_state_diffs: buckets.response_state_diffs.slice(0, 50), catalog_mismatches: buckets.catalog_mismatches.slice(0, 50), index_problems: buckets.index_problems.slice(0, 50),
    diff_totals: { response_state: buckets.response_state_diffs.length, catalog: buckets.catalog_mismatches.length, index: buckets.index_problems.length },
    errors,
  };
  result.clean = isClean(result) && laneResults.every((r) => r.exit === 0);
  return result;
}

export async function writeResult(target, result) {
  const body = JSON.stringify(result, null, 2);
  if (target === undefined) return;
  if (target.startsWith("file://")) {
    const f = url.fileURLToPath(target);
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.writeFileSync(f, body);
  } else if (target.startsWith("s3://")) {
    const m = /^s3:\/\/([^/]+)\/(.+)$/.exec(target);
    if (m === null) throw new Error(`bad result url ${target}`);
    // installed in the image only (not a dependency of the repo): the task role may only s3:PutObject
    const { S3Client, PutObjectCommand } = await import("@aws-sdk/client-s3");
    await new S3Client({}).send(new PutObjectCommand({ Bucket: m[1], Key: m[2], Body: body, ContentType: "application/json" }));
  } else throw new Error(`result url must be s3:// or file://, got ${target}`);
}

async function main() {
  const a = parseArgs(process.argv.slice(2));
  const log = (m) => console.log(`[task seed ${a.seed} from ${a.from}] ${m}`);
  const started = Date.now();
  const laneSplit = splitLanes(a.from, a.count, a.lanes);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "akldb-fuzz-task-"));
  let ddbChild;
  let discord;
  let laneResults = [];
  const errors = [];
  const stop = () => {
    for (const c of lanes) c.kill("SIGTERM");
    ddbChild?.kill("SIGTERM");
  };
  process.on("SIGTERM", () => (stop(), process.exit(143)));
  try {
    const endpoint = a.ddb ?? `http://127.0.0.1:${a.ddbPort}`;
    if (a.ddb === undefined) ddbChild = await startDdbLocal(a, log);
    const discordPort = a.portBase + 2 * laneSplit.length;
    discord = await startFakeDiscord(discordPort);
    const discordUrl = `http://127.0.0.1:${discordPort}/api`;
    log(`${laneSplit.length} lanes over sequences ${a.from}..${a.from + a.count - 1}`);
    laneResults = await Promise.all(laneSplit.map((l) => runLane(a, l, endpoint, discordUrl, path.join(root, `lane-${l.lane}`), log)));
  } catch (e) {
    errors.push(String(e?.stack ?? e));
  } finally {
    stop();
    discord?.close();
  }
  const result = mergeUnit(a, laneResults, started, Date.now());
  result.errors.push(...errors);
  result.clean = result.clean && errors.length === 0;
  if (!a.keep) fs.rmSync(root, { recursive: true, force: true });
  try {
    await writeResult(a.result, result);
  } catch (e) {
    console.error(`could not write the result: ${e}`);
    process.exitCode = 3;
    console.log(JSON.stringify(result));
    return;
  }
  log(`${result.clean ? "CLEAN" : "NOT CLEAN"}: ${result.sequences_run}/${a.count} sequences, ${result.steps} steps, ${result.diff_totals.response_state} diffs, ${result.diff_totals.catalog} catalog, ${result.diff_totals.index} index, ${result.errors.length} errors, ${(result.duration_ms / 1000).toFixed(0)} s`);
  process.exitCode = result.clean ? 0 : 1;
}

if (process.argv[1] !== undefined && url.pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  main().then(() => process.exit(process.exitCode ?? 0), (e) => (console.error(e), process.exit(2)));
}
