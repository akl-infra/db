#!/usr/bin/env node
// Lane R: Logpush replay driver (design/aws-port.md §5.1, design/p2-p5-briefs.md "Lane R").
//
//   node scripts/lab/replay/replay.mjs --logs <dir|file> --after <export.json[.gz]> [--before <export.json[.gz]>]
//     [--a http://127.0.0.1:<d1-oracle>] [--b http://127.0.0.1:<aws-lab>] [--speed 1|10] [--concurrency 16]
//     [--out <dir>] [--script <ScriptName>] [--max-skip 0.01] [--dry-run] [--emit-lab-client]
//
// --logs   the Logpush tree (`<YYYYMMDD>/<YYYYMMDD>/<start>_<end>_<id>.log.gz`) the main session copied in
// --before the private export taken just before the window (the state both lab sides are loaded from)
// --after  the private export taken just after it (events, revs, submissions, comment text, message urls)
// --a/--b  the two lab servers (loopback only): a = D1 oracle, b = DynamoDB lab. Without them, or with --dry-run, only
//          the plan and the skipped-request report are produced.
// --emit-lab-client  print the `clients` row to import into both lab copies so the re-signed requests verify
// Exit code: 0 when the skip gate holds and there are no diffs/errors, 1 otherwise, 2 on bad usage.
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { diffPair } from "../diff/pair.mjs";
import { loadExport } from "./exports.mjs";
import { readLogs } from "./parse.mjs";
import { buildPlan } from "./plan.mjs";
import { renderSkipReport, skipReport } from "./report.mjs";
import { runPlan } from "./run.mjs";
import { createSigner, labClientRow } from "./sign.mjs";

export function parseArgs(argv) {
  const a = { speed: 1, concurrency: 16, maxSkip: 0.01, dryRun: false, emitLabClient: false };
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    const v = () => argv[++i];
    if (k === "--logs") a.logs = v();
    else if (k === "--before") a.before = v();
    else if (k === "--after") a.after = v();
    else if (k === "--a") a.a = v();
    else if (k === "--b") a.b = v();
    else if (k === "--speed") a.speed = Number(v());
    else if (k === "--concurrency") a.concurrency = Number(v());
    else if (k === "--out") a.out = v();
    else if (k === "--script") a.script = v();
    else if (k === "--max-skip") a.maxSkip = Number(v());
    else if (k === "--dry-run") a.dryRun = true;
    else if (k === "--emit-lab-client") a.emitLabClient = true;
    else throw new Error(`unknown argument ${k}`);
  }
  return a;
}

/** A side over HTTP. No cloud, ever: only loopback hosts are accepted. */
export function httpSide(name, base) {
  const u = new URL(base);
  if (!["127.0.0.1", "localhost", "[::1]"].includes(u.hostname)) throw new Error(`replay sends only to loopback (got ${u.hostname})`);
  return {
    name,
    async send(wire) {
      const r = await fetch(new URL(wire.pathWithQuery, u), { method: wire.method, headers: wire.headers, body: wire.body, redirect: "manual" });
      const headers = {};
      r.headers.forEach((val, key) => {
        headers[key] = val;
      });
      return { status: r.status, headers, body: Buffer.from(await r.arrayBuffer()) };
    },
  };
}

async function main() {
  const a = parseArgs(process.argv.slice(2));
  if (a.emitLabClient) {
    console.log(JSON.stringify(labClientRow(), null, 2));
    return 0;
  }
  if (a.logs === undefined || a.after === undefined) {
    console.error("usage: replay.mjs --logs <dir> --after <export> [--before <export>] [--a <url> --b <url>] [--speed 1|10] [--dry-run]");
    return 2;
  }
  const { requests, errors, files, filtered } = readLogs(a.logs, { script: a.script });
  const ex = { after: loadExport(a.after), before: a.before === undefined ? undefined : loadExport(a.before) };
  const plan = buildPlan(requests, ex);
  const skip = skipReport(plan, { maxFraction: a.maxSkip });
  console.log(`[replay] ${files} log files, ${requests.length} requests (${filtered} filtered by script), parse errors ${JSON.stringify(errors)}`);
  console.log(renderSkipReport(skip));
  const outDir = a.out ?? null;
  if (outDir !== null) {
    fs.mkdirSync(outDir, { recursive: true });
    fs.writeFileSync(path.join(outDir, "skip-report.json"), JSON.stringify(skip, null, 2));
  }
  let code = skip.ok ? 0 : 1;
  if (!a.dryRun && a.a !== undefined && a.b !== undefined) {
    console.log(`[replay] differ: scripts/lab/diff/pair.mjs; speed ${a.speed}x`);
    const res = await runPlan(plan, { sides: [httpSide("oracle", a.a), httpSide("aws", a.b)], diffPair, signer: createSigner(), speed: a.speed, concurrency: a.concurrency });
    console.log(`[replay] sent ${res.sent} pairs (${res.primes} 304 primes, ${res.longpolls} long-polls), ${res.diffs.length} diffs, ${res.errors.length} errors, max lag ${Math.round(res.lagMaxMs)} ms`);
    for (const d of res.diffs.slice(0, 20)) console.log(`  DIFF ${d.method} ${d.path}${d.query}: ${d.problems.map((p) => p.detail).join("; ").slice(0, 300)}`);
    if (outDir !== null) fs.writeFileSync(path.join(outDir, `replay-${a.speed}x.json`), JSON.stringify({ diffs: res.diffs, errors: res.errors, sent: res.sent, primes: res.primes, lagMaxMs: res.lagMaxMs }, null, 2));
    if (res.diffs.length > 0 || res.errors.length > 0) code = 1;
  }
  return code;
}

if (import.meta.url === `file://${process.argv[1]}`) main().then((c) => process.exit(c), (e) => { console.error(e); process.exit(2); });
