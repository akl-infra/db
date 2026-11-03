#!/usr/bin/env node
// The GET replay differ (LDB-PV3, PV8): real recent public GETs against production and shadow, diffed.
//
//   node scripts/lab/shadow/replay.mjs --source obs --hours 6 [--n 400] [--rps 2] [--seed 1] [--out DIR] [--execute]
//   node scripts/lab/shadow/replay.mjs --source logpush --logs DIR_OR_FILE [...same]
//   node scripts/lab/shadow/replay.mjs --source plan --plan DIR/plan.json [...]     (replay a plan made earlier)
//
// --source obs      the last --hours of akl-db request events from Workers Observability (the telemetry query API of account
//                   58a5eb82948e2134d8b7b242e9567ac4; token in the environment as CF_OBS_TOKEN, read only; paged by time window,
//                   at most --max-pages requests to Cloudflare). Only method, URL and the presence of If-None-Match are kept;
//                   every header value is dropped when the event is read.
// --source logpush  an already-fetched Logpush NDJSON tree (no headers in those records).
// Without --execute it stops after writing the plan (DIR/plan.json) and printing its counts: nothing is sent to production or
// shadow. With --execute it sends, to --prod (default https://api.akldb.org) and --shadow (default https://shadow-api.akldb.org),
// the planned public GETs at no more than --rps requests per second (each request goes to both), no credentials, and writes
// DIR/replay.ndjson and DIR/summary.md. Exit 0 when no record is a diff or an error, 1 otherwise, 2 for usage.
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import url from "node:url";
import { buildPlan } from "./replay/plan.mjs";
import { renderMarkdown, summarize } from "./replay/report.mjs";
import { runReplay } from "./replay/run.mjs";
import { extractRequest, fetchTelemetry, readLogpush } from "./replay/source.mjs";

export const ALLOWED_HOSTS = new Set(["api.akldb.org", "shadow-api.akldb.org", "staging-api.akldb.org"]);

export function parseArgs(argv) {
  const a = { source: "obs", hours: 6, n: 400, rps: 2, seed: 1, prod: "https://api.akldb.org", shadow: "https://shadow-api.akldb.org", execute: false, maxPages: 60, allowLocal: false };
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    const v = () => argv[++i];
    if (k === "--source") a.source = v();
    else if (k === "--hours") a.hours = Number(v());
    else if (k === "--from") a.from = Date.parse(v());
    else if (k === "--to") a.to = Date.parse(v());
    else if (k === "--logs") a.logs = v();
    else if (k === "--plan") a.planFile = v();
    else if (k === "--n") a.n = Number(v());
    else if (k === "--rps") a.rps = Number(v());
    else if (k === "--seed") a.seed = Number(v());
    else if (k === "--prod") a.prod = v();
    else if (k === "--shadow") a.shadow = v();
    else if (k === "--out") a.out = v();
    else if (k === "--max-pages") a.maxPages = Number(v());
    else if (k === "--execute") a.execute = true;
    else if (k === "--allow-local") a.allowLocal = true; // tests: loopback servers
    else throw new Error(`unknown argument ${k}`);
  }
  return a;
}

/** Origins the replay may send to: the three akldb hosts, or (--allow-local) loopback. */
export function checkBase(base, allowLocal) {
  let u;
  try {
    u = new URL(base);
  } catch {
    throw new Error(`not a URL: ${base}`);
  }
  if (allowLocal && u.hostname === "127.0.0.1") return u.origin;
  if (u.protocol !== "https:" || !ALLOWED_HOSTS.has(u.hostname) || u.pathname !== "/") throw new Error(`the replay sends only to ${[...ALLOWED_HOSTS].join(", ")} (got ${base})`);
  return u.origin;
}

export async function loadRequests(a, env = process.env, fetchImpl = fetch) {
  if (a.source === "logpush") {
    if (a.logs === undefined) throw new Error("--logs is required for --source logpush");
    return { requests: readLogpush(a.logs), meta: { source: "logpush", logs: a.logs } };
  }
  if (a.source === "obs") {
    const token = env.CF_OBS_TOKEN;
    if (token === undefined || token === "") throw new Error("CF_OBS_TOKEN is not set (a read-only Workers Observability token for the akl account)");
    const toMs = a.to ?? Date.now();
    const fromMs = a.from ?? toMs - a.hours * 3_600_000;
    const got = await fetchTelemetry({ token, fromMs, toMs, maxPages: a.maxPages, fetchImpl });
    const requests = got.events.map(extractRequest).filter((r) => r !== null);
    return { requests, meta: { source: "obs", from: new Date(fromMs).toISOString(), to: new Date(toMs).toISOString(), events: got.events.length, pages: got.pages, truncated: got.truncated } };
  }
  throw new Error(`unknown --source ${a.source}`);
}

async function main(argv) {
  const a = parseArgs(argv);
  const prod = checkBase(a.prod, a.allowLocal);
  const shadow = checkBase(a.shadow, a.allowLocal);
  const out = a.out ?? path.join(process.cwd(), `shadow-replay-${new Date().toISOString().replace(/[:.]/g, "-")}`);
  fs.mkdirSync(out, { recursive: true });
  let plan;
  let meta = {};
  if (a.source === "plan") {
    plan = JSON.parse(fs.readFileSync(a.planFile, "utf8"));
  } else {
    const got = await loadRequests(a);
    meta = got.meta;
    plan = buildPlan(got.requests, { n: a.n, rps: a.rps, seed: a.seed });
    plan.meta = meta;
    fs.writeFileSync(path.join(out, "plan.json"), JSON.stringify(plan, null, 2));
  }
  const perClass = {};
  for (const it of plan.items) perClass[it.class] = (perClass[it.class] ?? 0) + 1;
  console.log(`plan: ${plan.items.length} requests from ${plan.considered ?? "?"} seen (${plan.uniques ?? "?"} unique), ${a.rps}/s; by class ${JSON.stringify(perClass)}; dropped ${JSON.stringify(plan.dropped ?? {})}`);
  if (!a.execute) {
    console.log(`not sent (no --execute). Plan: ${path.join(out, "plan.json")}`);
    return 0;
  }
  const sink = fs.createWriteStream(path.join(out, "replay.ndjson"));
  const records = await runReplay({ plan, prod, shadow, onRecord: (r) => sink.write(`${JSON.stringify(r)}\n`) });
  await new Promise((r) => sink.end(r));
  fs.writeFileSync(path.join(out, "summary.md"), renderMarkdown(records, { ...meta, note: `prod ${prod}, shadow ${shadow}, ${a.rps} requests per second, seed ${a.seed}` }));
  const s = summarize(records);
  console.log(`replay: ${records.length} records: ${JSON.stringify(s.totals)}. Out: ${out}`);
  return s.totals.diff + s.totals.error === 0 ? 0 : 1;
}

if (process.argv[1] !== undefined && url.pathToFileURL(process.argv[1]).href === import.meta.url) main(process.argv.slice(2)).then((c) => process.exit(c), (e) => { console.error(String(e?.message ?? e)); process.exit(2); });
