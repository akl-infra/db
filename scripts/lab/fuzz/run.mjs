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
import { comparableBody, comparableDump, maskStateRows } from "./dumpmask.mjs";
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
  return { dir, file, resetScript: buildResetScript(file) };
}

/**
 * The statements that rebuild a D1 database to exactly this seeded template, in place (lane F: sequence i of seed s is a
 * pure function of (s, i), so every sequence starts from the template). Triggers and indexes are created after the rows,
 * so re-inserting the rows fires nothing. Every statement is one string: D1 never has to split SQL text.
 */
export function buildResetScript(file) {
  const q = (sql) => JSON.parse(sqlite(file, sql, true) || "[]");
  const master = q("SELECT type, name, sql FROM sqlite_master WHERE sql IS NOT NULL AND substr(name, 1, 7) <> 'sqlite_' AND substr(name, 1, 4) <> '_cf_' ORDER BY rowid");
  const of = (type) => master.filter((m) => m.type === type);
  const drop = [...of("trigger").map((m) => `DROP TRIGGER IF EXISTS "${m.name}"`), ...of("view").map((m) => `DROP VIEW IF EXISTS "${m.name}"`), ...of("table").map((m) => `DROP TABLE IF EXISTS "${m.name}"`)];
  const inserts = [];
  for (const t of of("table")) {
    // table_xinfo hidden = 0: ordinary columns (a generated column cannot be inserted into)
    const cols = q(`SELECT name FROM pragma_table_xinfo('${t.name.replaceAll("'", "''")}') WHERE hidden = 0 ORDER BY cid`).map((c) => c.name);
    if (cols.length === 0) continue;
    const list = cols.map((c) => `"${c}"`).join(", ");
    const vals = cols.map((c) => `quote("${c}")`).join(" || ',' || ");
    const r = q(`SELECT json_group_array('INSERT INTO "${t.name}" (${list}) VALUES (' || ${vals} || ')') AS j FROM "${t.name}"`);
    inserts.push(...JSON.parse(r[0].j));
  }
  return { statements: ["PRAGMA defer_foreign_keys = on", ...drop, ...of("table").map((m) => m.sql), ...inserts, ...of("index").map((m) => m.sql), ...of("trigger").map((m) => m.sql), ...of("view").map((m) => m.sql)] };
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
    async reset(script) {
      const r = await fetch(`${base}/__lab/reset`, { method: "POST", body: JSON.stringify(script), headers: { "content-type": "application/json" } });
      if (!r.ok) throw new Error(`${o.name} reset -> ${r.status} ${(await r.text()).slice(0, 400)}`);
    },
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

function compareResponses(a, b, pathAndQuery = "") {
  const problems = [];
  if (a.status !== b.status) problems.push(`status ${a.status} vs ${b.status}`);
  // A dump's ETag is the md5 of its (encoder-dependent) gzip bytes, and latest.json's follows its sha256: see dumpmask.mjs.
  const onDumpRoute = pathAndQuery.startsWith("/v1/dump");
  const ba = comparableBody(pathAndQuery, a.body);
  const bb = comparableBody(pathAndQuery, b.body);
  for (const h of HEADERS_COMPARED) {
    if (h === "etag" && onDumpRoute && Buffer.compare(ba, bb) === 0) continue;
    if (a.headers[h] !== b.headers[h]) problems.push(`header ${h}: ${JSON.stringify(a.headers[h])} vs ${JSON.stringify(b.headers[h])}`);
  }
  const at = firstDiff(ba, bb);
  if (at !== -1) {
    const ctx = (r) => JSON.stringify(r.subarray(Math.max(0, at - 60), at + 120).toString("utf8"));
    problems.push(`body differs at byte ${at} (${ba.length} vs ${bb.length} bytes): ${ctx(ba)} vs ${ctx(bb)}`);
  }
  return problems;
}

/** After a step that wrote a dump: fetch the dump each side produced, gunzip, and require equal bytes. */
async function compareProducedDumps(A, B) {
  const get = async (base, p) => {
    const r = await fetch(base + p, { redirect: "manual" });
    return { status: r.status, body: Buffer.from(await r.arrayBuffer()) };
  };
  const la = await get(A.url, "/v1/dump/latest.json");
  const lb = await get(B.url, "/v1/dump/latest.json");
  if (la.status !== 200 || lb.status !== 200) return la.status === lb.status ? [] : [`latest.json status ${la.status} vs ${lb.status}`];
  const ka = JSON.parse(la.body.toString("utf8")).key;
  const kb = JSON.parse(lb.body.toString("utf8")).key;
  if (ka !== kb) return [`latest dump key ${ka} vs ${kb}`];
  const da = await get(A.url, `/v1/dump/${ka}`);
  const db = await get(B.url, `/v1/dump/${kb}`);
  if (da.status !== 200 || db.status !== 200) return [`dump ${ka} status ${da.status} vs ${db.status}`];
  const ga = comparableDump(da.body);
  const gb = comparableDump(db.body);
  const at = firstDiff(ga, gb);
  const ctx = (g) => JSON.stringify(g.subarray(Math.max(0, at - 120), at + 160).toString("utf8"));
  return at === -1 ? [] : [`gunzipped dump ${ka} differs at byte ${at} (${ga.length} vs ${gb.length} bytes): ${ctx(ga)} vs ${ctx(gb)}`];
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
 * @param {number} [o.from]         first sequence index (default 0): sequences from .. from+sequences-1
 * @param {"inplace"|"restart"} [o.reset]  how the D1 oracle returns to the template between sequences
 * @param {boolean} [o.verifyReset] compare the oracle with the template after every reset (always done for the first)
 * @param {string} [o.discordUrl]   an already-running fake Discord (default: start one on ports[2])
 * @param {string} [o.transcript]   write one JSON line per step and per sequence state (the determinism proof)
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
  const discord = o.discordUrl === undefined ? await startFakeDiscord(portDiscord) : undefined;
  const discordUrl = o.discordUrl ?? `http://127.0.0.1:${portDiscord}/api`;
  const from = o.from ?? 0;
  const reset = o.reset ?? "inplace";
  const verifyReset = o.verifyReset ?? false;
  const transcript = o.transcript === undefined ? undefined : fs.createWriteStream(o.transcript);
  const sha = (b) => crypto.createHash("sha256").update(b).digest("hex").slice(0, 16);
  const tableHashes = (st) => Object.fromEntries(Object.keys(st).sort().map((t) => [t, sha(JSON.stringify(st[t].map(canonRow).sort()))]));
  const canonState = (st) => JSON.stringify(Object.keys(st).sort().map((t) => [t, st[t].map(canonRow).sort()]));

  const report = { mode, seeds: o.seeds, from, sequences: o.sequences, sequences_run: 0, reset_ms: 0, steps: o.steps, requests: 0, steps_run: 0, checks: 0, state_diffs_run: 0, diffs: [], by_label: {}, statuses: {}, ok_by_label: {}, started: new Date().toISOString() };
  const addDiff = (d) => {
    d.repro = `node scripts/lab/fuzz/fuzz.mjs --seeds ${d.seed} --from ${d.sequence} --sequences 1 --steps ${o.steps}${mode === "self" ? " --mode self" : ""}`;
    report.diffs.push(d);
    log(`DIFF seed ${d.seed} seq ${d.sequence} step ${d.step} ${d.kind}: ${d.label ?? ""} ${(d.problems ?? []).join(" | ").slice(0, 400)}`);
  };

  try {
    for (const seed of o.seeds) {
      log(`seed ${seed}: starting backends`);
      let A = await startD1({ name: "d1-oracle", port: portA, workDir, outDir, template, discord: discordUrl });
      let B;
      try {
        B =
          mode === "self"
            ? await startD1({ name: "d1-other", port: portB, workDir, outDir, template, discord: discordUrl })
            : await startDdb({ port: portB, endpoint, outDir, discord: discordUrl, faultRate: o.faultRate ?? 0, faultSeed: mixSeed(seed, 77) });
        const resetB = async () => {
          if (B.kind === "ddb") {
            await B.lab("POST", "/__lab/reset");
            await B.lab("POST", "/__lab/import", rows);
          } else await B.reset(template.resetScript);
        };
        // the reset must land exactly on the template: compare the oracle's rows with the freshly built one
        const verifyTemplate = async (a) => {
          const got = await a.state();
          const sd = diffStates(rows, got, ignore);
          if (sd.length > 0) throw new Error(`D1 reset did not land on the template: ${JSON.stringify(sd).slice(0, 600)}`);
        };

        for (let sequence = from; sequence < from + o.sequences && report.diffs.length < maxDiffs; sequence++) {
          // Sequence i of seed s is a pure function of (s, i): its own generator, clock, ULID seeds and restart point, and
          // both backends rebuilt to the seeded template first (lane F, LDB-FZ1).
          if (reset === "restart" && sequence !== from) {
            await A.stop();
            A = await startD1({ name: "d1-oracle", port: portA, workDir, outDir, template, discord: discordUrl });
          }
          const t0 = Date.now();
          await Promise.all([A.reset(template.resetScript), resetB()]);
          if (sequence === from || verifyReset) await verifyTemplate(A);
          report.reset_ms += Date.now() - t0;
          const gen = new Generator({ seed: mixSeed(seed, 1, sequence), corpus });
          const seqRng = makeRng(mixSeed(seed, 2, sequence));
          const restartAt = seqRng.chance(0.3) ? seqRng.int(1, Math.max(1, o.steps - 1)) : -1; // a cold DynamoDB model mid-sequence
          let tick = 0;
          let seedCounter = 1000 + (mixSeed(seed, 3, sequence) % 1_000_000) * 1000;
          report.sequences_run++;
          for (let i = 0; i < o.steps && report.diffs.length < maxDiffs; i++) {
            const stepNo = i;
            if (i === restartAt) await B.restart();
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
            const problems = compareResponses(ra, rb, step.path);
            transcript?.write(JSON.stringify({ seed, sequence, step: i, label: step.label, method: step.method, path: step.path, status: ra.status, body: sha(comparableBody(step.path, ra.body)), status_b: rb.status, body_b: sha(comparableBody(step.path, rb.body)) }) + "\n");
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
            if (step.conditional && step.method === "GET" && !step.path.startsWith("/v1/dump") && ra.headers.etag !== undefined) {
              const cspec = { ...spec, headers: { ...headers, "If-None-Match": ra.headers.etag } };
              const [ca, cb] = await Promise.all([send(A.url, cspec), send(B.url, cspec)]);
              report.requests += 2;
              const cp = compareResponses(ca, cb, step.path);
              if (cp.length > 0) addDiff({ seed, sequence, step: stepNo, kind: "response (If-None-Match)", label: step.label, method: step.method, path: step.path, problems: cp });
            }

            if ((step.label === "dump write" || step.label === "nightly tick") && ra.status < 300 && rb.status === ra.status) {
              const dp = await compareProducedDumps(A, B);
              if (dp.length > 0) addDiff({ seed, sequence, step: stepNo, kind: "dump", label: step.label, problems: dp });
            }

            if (i % checkEvery === 0 && B.kind === "ddb") {
              report.checks++;
              const c = await B.check();
              if (!c.ok) addDiff({ seed, sequence, step: stepNo, kind: "check", label: step.label, problems: c.problems });
            }
          }
          if ((sequence - from + 1) % stateEvery === 0 || sequence === from + o.sequences - 1) {
            report.state_diffs_run++;
            const [sa, sb] = [await A.state(), await B.state()];
            transcript?.write(JSON.stringify({ seed, sequence, state: sha(canonState(maskStateRows(sa))), state_b: sha(canonState(maskStateRows(sb))), tables: tableHashes(maskStateRows(sa)) }) + "\n");
            const sd = diffStates(maskStateRows(sa), maskStateRows(sb), ignore);
            if (sd.length > 0) addDiff({ seed, sequence, step: stepNo, kind: "state", problems: sd.map((d) => `${d.table}: ${d.rows[0]} vs ${d.rows[1]} rows; oracle-only ${JSON.stringify(d.only_oracle)}; other-only ${JSON.stringify(d.only_other)}`) });
          }
        }
      } finally {
        await B?.stop();
        await A.stop();
      }
      log(`seed ${seed}: ${report.steps_run} steps so far, ${report.diffs.length} diffs`);
      if (report.diffs.length >= maxDiffs) break;
    }
  } finally {
    discord?.close();
    killAll();
    await new Promise((r) => (transcript === undefined ? r() : transcript.end(r)));
  }
  report.finished = new Date().toISOString();
  report.ok = report.diffs.length === 0;
  fs.writeFileSync(path.join(outDir, "fuzz-report.json"), JSON.stringify(report, null, 2));
  log(`${report.steps_run} steps, ${report.requests} requests, ${report.checks} catalog/index checks, ${report.state_diffs_run} state diffs, ${report.diffs.length} diffs -> ${report.ok ? "IDENTICAL" : "DIFFERENT"}; report ${path.join(outDir, "fuzz-report.json")}`);
  return report;
}
