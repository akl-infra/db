#!/usr/bin/env node
// The phase D gate report (LDB-PV10): the D row of the build plan as a table, from the run's evidence.
//
//   node scripts/lab/shadow/gate.mjs --replay DIR/replay.ndjson [--replay ...] --logs LOGS.json --probe PROBE.json \
//        --mac LATENCY.md [--colos COLOS.json] [--metrics METRICS.json --run RUN.json] [--prices PRICES.json] [--out gate.md] [--json]
//
//   --replay   the NDJSON of scripts/lab/shadow/replay.mjs, one per day (each record carries its UTC time)
//   --logs     (repeat for the api and the jobs function) the shadow functions' log lines: `aws logs filter-log-events` JSON (any pages), or plain text. Read:
//              `akldb-checkpoint:` (nightly checksums), `akldb-alarm:` (halts, follower alarms), `akldb-cold:` (cold starts), REPORT lines
//   --probe    the answer of `scripts/aws/probe.sh run` (gate (a), us-east-2)
//   --mac      latency-compare.py's markdown from the Mac, run against shadow (gate (b))
//   --colos    JSON [{colo, share, prod_ms, shadow_ms | rtt_ms + origin_ms}] (gate (c)); who supplied the numbers goes in the file
//   --metrics  { "ApiRequests": n, "Invocations": n, "Duration": ms, "ConsumedReadCapacityUnits": n, "ConsumedWriteCapacityUnits": n }
//              (sums over the run window) and --run { window_hours, scale, lambda_memory_mb, storage_gb, logs_gb_per_window, s3_gets, s3_puts }
// Exit 0 only when every row is PASS.
import fs from "node:fs";
import process from "node:process";
import url from "node:url";
import { PRICES_FILE, loadJson } from "./gate/cost.mjs";
import { evaluate, logLines, parseLogs, parseMac, renderGate } from "./gate/lib.mjs";
import { CLASSES } from "./replay/routes.mjs";

function parseArgs(argv) {
  const a = { replay: [] };
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    const v = () => argv[++i];
    if (k === "--replay") a.replay.push(v());
    else if (k === "--logs") (a.logs ??= []).push(v());
    else if (k === "--probe") a.probe = v();
    else if (k === "--mac") a.mac = v();
    else if (k === "--colos") a.colos = v();
    else if (k === "--metrics") a.metrics = v();
    else if (k === "--run") a.run = v();
    else if (k === "--prices") a.prices = v();
    else if (k === "--out") a.out = v();
    else if (k === "--json") a.json = true;
    else throw new Error(`unknown argument ${k}`);
  }
  return a;
}

export function gateFromFiles(a) {
  const records = a.replay.flatMap((f) => fs.readFileSync(f, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)));
  return evaluate({
    records,
    logs: a.logs === undefined ? undefined : parseLogs(a.logs.flatMap((f) => logLines(fs.readFileSync(f, "utf8")))),
    probe: a.probe === undefined ? undefined : loadJson(a.probe),
    mac: a.mac === undefined ? undefined : parseMac(fs.readFileSync(a.mac, "utf8")),
    colos: a.colos === undefined ? undefined : loadJson(a.colos),
    metrics: a.metrics === undefined ? undefined : loadJson(a.metrics),
    run: a.run === undefined ? undefined : loadJson(a.run),
    prices: loadJson(a.prices ?? PRICES_FILE),
    classes: CLASSES.filter((c) => !c.startsWith("dump-")),
  });
}

if (process.argv[1] !== undefined && url.pathToFileURL(process.argv[1]).href === import.meta.url) {
  try {
    const g = gateFromFiles(parseArgs(process.argv.slice(2)));
    const a = parseArgs(process.argv.slice(2));
    const text = a.json ? JSON.stringify(g, null, 2) : renderGate(g, { generated: new Date().toISOString().slice(0, 10) });
    if (a.out) fs.writeFileSync(a.out, text);
    else process.stdout.write(text);
    process.exit(g.pass ? 0 : 1);
  } catch (e) {
    console.error(String(e?.message ?? e));
    process.exit(2);
  }
}
