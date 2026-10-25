// The differential fuzzer's runner (design/aws-port.md §5.1 item 2; lane L).
// Drives the D1 Worker (the oracle: wrangler dev --local on d1-lab-entry.ts)
// and the DynamoDB lab server (scripts/lab/serve-ddb.mjs) with the same seeded
// request stream, diffs every response (status, contract headers, body bytes)
// and, after each sequence, the full table state (D1 SQLite vs exportRows);
// after every step it asks the DynamoDB server to prove catalog.current() ==
// rebuildFromScan() and the index checker clean (/__lab/check).
//
// `mode: "self"` runs a second D1 Worker in place of DynamoDB: a determinism
// check of the lab entry, the generator and the differ themselves.
//
// No cloud: DynamoDB Local on 127.0.0.1, a fake Discord on 127.0.0.1, the
// Workers under wrangler's local simulator.
import { spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import url from "node:url";
import { ADMIN, CONTRACT_HEADERS, LAB_CLIENT, LAB_PUB_RAW, findSqlite, firstDiff, loadDump, sh, signedHeaders, sqlLit, startFakeDiscord, waitReady } from "../p1-crawl-diff.mjs";
import { Generator } from "./generator.mjs";
import { makeRng, mixSeed } from "./rng.mjs";

const REPO = path.resolve(path.dirname(url.fileURLToPath(import.meta.url)), "..", "..", "..");
const CLOCK0 = Date.parse("2026-10-25T12:00:00.000Z");
// content-length is added by workerd for buffered bodies but a Node server cannot know which bodies workerd would have buffered; the body bytes are compared anyway.
const HEADERS_COMPARED = CONTRACT_HEADERS.filter((h) => h !== "content-length");
const NON_TABLES = /^(sqlite_|_cf_|d1_migrations$)/;

function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.listen(0, "127.0.0.1", () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
    s.on("error", reject);
  });
}

const children = new Set();
function killAll() {
  for (const c of children) {
    try {
      process.kill(-c.pid, "SIGTERM");
    } catch {
      // gone
    }
  }
  children.clear();
}
process.on("exit", killAll);

function spawnLogged(cmd, argv, logFile, opts = {}) {
  const out = fs.openSync(logFile, "w");
  const child = spawn(cmd, argv, { stdio: ["ignore", out, out], detached: true, ...opts });
  children.add(child);
  child.on("exit", () => children.delete(child));
  return child;
}

async function stopChild(child) {
  if (child === undefined || child.exitCode !== null) return;
  try {
    process.kill(-child.pid, "SIGTERM");
  } catch {
    return;
  }
  await new Promise((r) => {
    const t = setTimeout(r, 4000);
    child.once("exit", () => (clearTimeout(t), r()));
  });
  children.delete(child);
}

// ---------------------------------------------------------------------------
// Seeding
// ---------------------------------------------------------------------------

function sqlite(file, sql, json = false) {
  return sh("sqlite3", [...(json ? ["-readonly", "-json"] : []), file, sql]);
}

function tableNames(file) {
  return JSON.parse(sqlite(file, "SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name", true) || "[]")
    .map((r) => r.name)
    .filter((n) => !NON_TABLES.test(n));
}

/** Every table's rows from a D1 sqlite file: { table: row[] }. */
export function readSqliteState(file) {
  const out = {};
  for (const t of tableNames(file)) out[t] = JSON.parse(sqlite(file, `SELECT * FROM "${t}"`, true) || "[]");
  return out;
}

async function buildTemplate(workDir, dumpSpec) {
  const dir = path.join(workDir, "template");
  fs.rmSync(dir, { recursive: true, force: true });
  sh("npx", ["wrangler", "d1", "migrations", "apply", "akl-db", "--local", "--persist-to", dir, "--config", "wrangler.toml"], { cwd: REPO, env: { ...process.env, CI: "1" } });
  const file = findSqlite(dir);
  const extra = [
    `INSERT INTO clients (id, name, pubkey, owner_user_id, caps, discord_app_id, status, created_at, revoked_at) VALUES (${sqlLit(LAB_CLIENT)}, 'ddb-fuzz', ${sqlLit(LAB_PUB_RAW)}, ${sqlLit(ADMIN)}, 'act-as-user,feed:wait', NULL, 'active', '2026-10-25T00:00:00.000Z', NULL)`,
    `INSERT OR IGNORE INTO admins (user_id, added_by, added_at, note) VALUES (${sqlLit(ADMIN)}, NULL, '2026-10-25T00:00:00.000Z', 'ddb-fuzz')`,
  ];
  let restore = [];
  if (dumpSpec) {
    const { restoreSql } = await import(url.pathToFileURL(path.join(REPO, "src/store/d1/dump.ts")).href);
    restore = restoreSql(loadDump(dumpSpec));
  }
  const sqlFile = path.join(workDir, "seed.sql");
  fs.writeFileSync(sqlFile, "BEGIN;\n" + [...restore, ...extra].join(";\n") + ";\nCOMMIT;\n");
  sh("sqlite3", [file], { input: fs.readFileSync(sqlFile), stdio: ["pipe", "pipe", "pipe"] });
  return { dir, file };
}

// ---------------------------------------------------------------------------
// Backends
// ---------------------------------------------------------------------------

async function startD1(o) {
  const persist = path.join(o.workDir, `persist-${o.name}`);
  fs.rmSync(persist, { recursive: true, force: true });
  fs.cpSync(o.template.dir, persist, { recursive: true });
  const inspector = await freePort();
  const child = spawnLogged(
    "npx",
    ["wrangler", "dev", "scripts/lab/fuzz/d1-lab-entry.ts", "--config", "wrangler.toml", "--local", "--persist-to", persist, "--port", String(o.port), "--ip", "127.0.0.1", "--inspector-port", String(inspector),
      "--var", `DISCORD_API_URL:${o.discord}`, "--var", "STREAM_MAX_MS:500", "--var", "STREAM_POLL_MS:20", "--var", "IMPORT_ENABLED:on", "--show-interactive-dev-session=false"],
    path.join(o.outDir, `${o.name}.log`),
    { cwd: REPO, env: { ...process.env, CI: "1", WRANGLER_SEND_METRICS: "false" } },
  );
  const base = `http://127.0.0.1:${o.port}`;
  await waitReady(base);
  return {
    name: o.name,
    kind: "d1",
    url: base,
    async check() {
      return { ok: true, problems: [] };
    },
    async restart() {},
    async state() {
      return readSqliteState(findSqlite(persist));
    },
    stop: () => stopChild(child),
  };
}

async function startDdb(o) {
  const child = spawnLogged(
    process.execPath,
    ["scripts/lab/serve-ddb.mjs", "--port", String(o.port), "--ddb", o.endpoint, "--prefix", `akldb-fuzz-${o.port}`, "--discord", o.discord, "--fault-rate", String(o.faultRate), "--fault-seed", String(o.faultSeed)],
    path.join(o.outDir, "ddb.log"),
    { cwd: REPO },
  );
  const base = `http://127.0.0.1:${o.port}`;
  for (let i = 0; ; i++) {
    try {
      if ((await fetch(`${base}/__lab/health`)).ok) break;
    } catch {
      // not up yet
    }
    if (child.exitCode !== null || i > 240) throw new Error(`DynamoDB lab server did not start (see ${path.join(o.outDir, "ddb.log")})`);
    await new Promise((r) => setTimeout(r, 500));
  }
  const lab = async (method, p, body) => {
    const r = await fetch(base + p, { method, body: body === undefined ? undefined : JSON.stringify(body), headers: body === undefined ? {} : { "content-type": "application/json" } });
    const text = await r.text();
    if (!r.ok) throw new Error(`${method} ${p} -> ${r.status} ${text.slice(0, 300)}`);
    return JSON.parse(text);
  };
  return {
    name: "ddb",
    kind: "ddb",
    url: base,
    lab,
    check: () => lab("GET", "/__lab/check"),
    restart: () => lab("POST", "/__lab/restart"),
    state: () => lab("GET", "/__lab/export"),
    stop: () => stopChild(child),
  };
}

// ---------------------------------------------------------------------------
// Requests and the diff
// ---------------------------------------------------------------------------

async function send(base, spec) {
  const r = await fetch(base + spec.path, { method: spec.method, headers: spec.headers, body: spec.body, redirect: "manual" });
  const body = Buffer.from(await r.arrayBuffer());
  const headers = {};
  for (const h of CONTRACT_HEADERS) {
    const v = r.headers.get(h);
    if (v !== null) headers[h] = v;
  }
  return { status: r.status, headers, body };
}

function compareResponses(a, b) {
  const problems = [];
  if (a.status !== b.status) problems.push(`status ${a.status} vs ${b.status}`);
  for (const h of HEADERS_COMPARED) if (a.headers[h] !== b.headers[h]) problems.push(`header ${h}: ${JSON.stringify(a.headers[h])} vs ${JSON.stringify(b.headers[h])}`);
  const at = firstDiff(a.body, b.body);
  if (at !== -1) {
    const ctx = (r) => JSON.stringify(r.body.subarray(Math.max(0, at - 60), at + 120).toString("utf8"));
    problems.push(`body differs at byte ${at} (${a.body.length} vs ${b.body.length} bytes): ${ctx(a)} vs ${ctx(b)}`);
  }
  return problems;
}

function canonRow(r) {
  return JSON.stringify(Object.fromEntries(Object.entries(r).sort(([x], [y]) => (x < y ? -1 : x > y ? 1 : 0))));
}

/** Per-table differences between two { table: rows[] } states, as multisets of canonical rows. */
export function diffStates(a, b, ignore = []) {
  const out = [];
  for (const t of new Set([...Object.keys(a), ...Object.keys(b)])) {
    if (ignore.includes(t)) continue;
    const ra = (a[t] ?? []).map(canonRow).sort();
    const rb = (b[t] ?? []).map(canonRow).sort();
    if (ra.length === rb.length && ra.every((x, i) => x === rb[i])) continue;
    const sb = new Set(rb);
    const sa = new Set(ra);
    out.push({
      table: t,
      rows: [ra.length, rb.length],
      only_oracle: ra.filter((x) => !sb.has(x)).slice(0, 3),
      only_other: rb.filter((x) => !sa.has(x)).slice(0, 3),
    });
  }
  return out;
}

// ---------------------------------------------------------------------------

/**
 * @param {object} o
 * @param {number[]} o.seeds
 * @param {number} o.sequences      sequences per seed
 * @param {number} o.steps          steps per sequence
 * @param {"ddb"|"self"} [o.mode]
 * @param {string} [o.ddbEndpoint]  DynamoDB Local (default http://127.0.0.1:18307)
 * @param {number[]} [o.ports]      [oracle D1, DDB server (or second D1), fake Discord, spare]
 * @param {number} [o.faultRate]    injected conflict/throttle rate on the DynamoDB side
 * @param {number} [o.checkEvery]   /__lab/check every N steps (default 1)
 * @param {number} [o.stateEvery]   full state diff every N sequences (default 1)
 * @param {string[]} [o.ignoreTables]
 * @param {string} [o.dump]         "fixture" or a dump path to seed both sides
 * @param {string} [o.out]
 * @param {number} [o.maxDiffs]
 * @param {(m: string) => void} [o.log]
 */
export async function runFuzz(o) {
  const log = o.log ?? ((m) => console.log(`[fuzz] ${m}`));
  const mode = o.mode ?? "ddb";
  const [portA, portB, portDiscord, portSpare] = o.ports ?? [18317, 18318, 18319, 18320];
  const workDir = o.work ?? fs.mkdtempSync(path.join(os.tmpdir(), "akldb-fuzz-"));
  const outDir = o.out ?? path.join(workDir, "report");
  fs.mkdirSync(outDir, { recursive: true });
  const checkEvery = o.checkEvery ?? 1;
  const stateEvery = o.stateEvery ?? 1;
  const maxDiffs = o.maxDiffs ?? 20;
  const ignore = o.ignoreTables ?? [];
  const endpoint = o.ddbEndpoint ?? "http://127.0.0.1:18307";

  const fixture = JSON.parse(fs.readFileSync(path.join(REPO, "tests/fixtures/seed-upstream-100.dump.json"), "utf8"));
  const corpus = fixture.layout_formats.filter((f) => f.lineage === "spark").map((f) => JSON.parse(f.payload_json));

  log(`work dir ${workDir}`);
  const template = await buildTemplate(workDir, o.dump);
  const rows = readSqliteState(template.file);
  const discord = await startFakeDiscord(portDiscord);
  const discordUrl = `http://127.0.0.1:${portDiscord}/api`;

  const report = { mode, seeds: o.seeds, sequences: o.sequences, steps: o.steps, requests: 0, steps_run: 0, checks: 0, state_diffs_run: 0, diffs: [], by_label: {}, statuses: {}, ok_by_label: {}, started: new Date().toISOString() };
  const addDiff = (d) => {
    report.diffs.push(d);
    log(`DIFF seed ${d.seed} seq ${d.sequence} step ${d.step} ${d.kind}: ${d.label ?? ""} ${(d.problems ?? []).join(" | ").slice(0, 400)}`);
  };

  try {
    for (const seed of o.seeds) {
      log(`seed ${seed}: starting backends`);
      const A = await startD1({ name: "d1-oracle", port: portA, workDir, outDir, template, discord: discordUrl });
      let B;
      try {
        B =
          mode === "self"
            ? await startD1({ name: "d1-other", port: portB, workDir, outDir, template, discord: discordUrl })
            : await startDdb({ port: portB, endpoint, outDir, discord: discordUrl, faultRate: o.faultRate ?? 0, faultSeed: mixSeed(seed, 77) });
        if (B.kind === "ddb") {
          await B.lab("POST", "/__lab/reset");
          await B.lab("POST", "/__lab/import", rows);
        }

        const gen = new Generator({ seed: mixSeed(seed, 1), corpus });
        const rng = makeRng(mixSeed(seed, 2));
        let tick = 0;
        let seedCounter = 1000 + seed * 100000;
        let stepNo = 0;
        for (let sequence = 0; sequence < o.sequences && report.diffs.length < maxDiffs; sequence++) {
          for (let i = 0; i < o.steps && report.diffs.length < maxDiffs; i++, stepNo++) {
            const step = gen.next();
            report.steps_run++;
            report.by_label[step.label] = (report.by_label[step.label] ?? 0) + 1;
            if (step.restart) {
              await B.restart();
              continue;
            }
            tick += step.stepMs;
            const nowIso = new Date(CLOCK0 + tick).toISOString();
            const lab = { "x-lab-now": nowIso, "x-lab-seed": String(++seedCounter) };
            const body = step.json === undefined ? undefined : Buffer.from(JSON.stringify(step.json));
            const headers = { ...lab, ...(step.headers ?? {}) };
            if (body !== undefined) headers["Content-Type"] = "application/json";
            if (step.badSignature) Object.assign(headers, { "X-Akl-Client": LAB_CLIENT, "X-Akl-Timestamp": "1", "X-Akl-Nonce": "AAAA", "X-Akl-Actor": step.actor, "X-Akl-Signature": "AAAA" });
            else if (step.actor !== undefined) Object.assign(headers, signedHeaders(step.method, step.path, body, step.actor, nowIso, lab["x-lab-seed"]));
            if (step.bearer !== undefined) headers.Authorization = `Bearer lab-${step.bearer}`;
            const spec = { method: step.method, path: step.path, headers, body };
            const [ra, rb] = await Promise.all([send(A.url, spec), send(B.url, spec)]);
            report.requests += 2;
            const problems = compareResponses(ra, rb);
            if (problems.length > 0) addDiff({ seed, sequence, step: stepNo, kind: "response", label: step.label, method: step.method, path: step.path, request: step.json, problems });
            let json = null;
            try {
              json = JSON.parse(ra.body.toString("utf8"));
            } catch {
              // not JSON
            }
            report.statuses[ra.status] = (report.statuses[ra.status] ?? 0) + 1;
            if (ra.status < 300) report.ok_by_label[step.label] = (report.ok_by_label[step.label] ?? 0) + 1;
            gen.observe(step, { status: ra.status, json, etag: ra.headers.etag });

            // The conditional half of every ETag'd read: both must agree on the same If-None-Match.
            if (step.conditional && step.method === "GET" && ra.headers.etag !== undefined) {
              const cspec = { ...spec, headers: { ...headers, "If-None-Match": ra.headers.etag } };
              const [ca, cb] = await Promise.all([send(A.url, cspec), send(B.url, cspec)]);
              report.requests += 2;
              const cp = compareResponses(ca, cb);
              if (cp.length > 0) addDiff({ seed, sequence, step: stepNo, kind: "response (If-None-Match)", label: step.label, method: step.method, path: step.path, problems: cp });
            }

            if (stepNo % checkEvery === 0 && B.kind === "ddb") {
              report.checks++;
              const c = await B.check();
              if (!c.ok) addDiff({ seed, sequence, step: stepNo, kind: "check", label: step.label, problems: c.problems });
            }
          }
          if ((sequence + 1) % stateEvery === 0 || sequence === o.sequences - 1) {
            report.state_diffs_run++;
            const [sa, sb] = [await A.state(), await B.state()];
            const sd = diffStates(sa, sb, ignore);
            if (sd.length > 0) addDiff({ seed, sequence, step: stepNo, kind: "state", problems: sd.map((d) => `${d.table}: ${d.rows[0]} vs ${d.rows[1]} rows; oracle-only ${JSON.stringify(d.only_oracle)}; other-only ${JSON.stringify(d.only_other)}`) });
          }
          if (B.kind === "ddb" && rng.chance(0.25)) await B.restart();
        }
      } finally {
        await B?.stop();
        await A.stop();
      }
      log(`seed ${seed}: ${report.steps_run} steps so far, ${report.diffs.length} diffs`);
      if (report.diffs.length >= maxDiffs) break;
    }
  } finally {
    discord.close();
    killAll();
  }
  report.finished = new Date().toISOString();
  report.ok = report.diffs.length === 0;
  fs.writeFileSync(path.join(outDir, "fuzz-report.json"), JSON.stringify(report, null, 2));
  log(`${report.steps_run} steps, ${report.requests} requests, ${report.checks} catalog/index checks, ${report.state_diffs_run} state diffs, ${report.diffs.length} diffs -> ${report.ok ? "IDENTICAL" : "DIFFERENT"}; report ${path.join(outDir, "fuzz-report.json")}`);
  return report;
}
