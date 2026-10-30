#!/usr/bin/env node
// Lane R: builds tests/lab/fixtures/replay/ from a seeded local store (design/p2-p5-briefs.md "Lane R"). It drives the
// repo's own lab server on DynamoDB Local (scripts/lab/serve-ddb.mjs) through signed requests, so the before/after
// exports come from the repo's own `exportRows`, and writes the Logpush-shaped NDJSON for the window's requests.
// Loopback only. Not run by the test suite (the fixtures are committed); rerun to regenerate:
//
//   docker run -d --rm --name akldb-ddb-r -p 127.0.0.1:18421:8000 amazon/dynamodb-local:latest -jar DynamoDBLocal.jar -inMemory -sharedDb
//   node scripts/lab/replay/gen-fixtures.mjs --ddb http://127.0.0.1:18421 --ports 18422,18423 --out tests/lab/fixtures/replay [--verify]
//
// --verify then resets both servers to the BEFORE export and replays the generated window through the replay engine
// at 100x, expecting zero diffs, zero errors and a passing skip gate.
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import url from "node:url";
import zlib from "node:zlib";
import { diffPair } from "./diff-shim.mjs";
import { loadExport } from "./exports.mjs";
import { readLogs } from "./parse.mjs";
import { buildPlan } from "./plan.mjs";
import { renderSkipReport, skipReport } from "./report.mjs";
import { runPlan } from "./run.mjs";
import { LAB_ADMIN, createSigner, labClientRow } from "./sign.mjs";

const REPO = path.resolve(path.dirname(url.fileURLToPath(import.meta.url)), "..", "..", "..");
const A = "100000000000000002";
const B = "100000000000000003";
const C = "100000000000000004";
const T0 = Date.parse("2026-10-30T12:00:00.000Z");
const TABLES = ["layouts", "layout_formats", "layout_revs", "likes", "authors", "admins", "events", "clients", "bans", "link_submissions", "wpm_submissions", "layout_comments", "comment_likes"];

function args(argv) {
  const a = { ddb: "http://127.0.0.1:18421", ports: [18422, 18423], out: path.join(REPO, "tests/lab/fixtures/replay"), verify: false };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--ddb") a.ddb = argv[++i];
    else if (argv[i] === "--ports") a.ports = argv[++i].split(",").map(Number);
    else if (argv[i] === "--out") a.out = argv[++i];
    else if (argv[i] === "--verify") a.verify = true;
    else throw new Error(`unknown argument ${argv[i]}`);
  }
  return a;
}

async function startServer(port, ddb) {
  const child = spawn(process.execPath, ["scripts/lab/serve-ddb.mjs", "--port", String(port), "--ddb", ddb, "--prefix", `akldb-lab-r-${port}`], { cwd: REPO, stdio: ["ignore", "pipe", "pipe"] });
  let log = "";
  child.stdout.on("data", (d) => (log += d));
  child.stderr.on("data", (d) => (log += d));
  const base = `http://127.0.0.1:${port}`;
  for (let i = 0; ; i++) {
    try {
      if ((await fetch(`${base}/__lab/health`)).ok) break;
    } catch {
      /* not up yet */
    }
    if (child.exitCode !== null || i > 240) throw new Error(`lab server ${port} did not start:\n${log.slice(-1500)}`);
    await new Promise((r) => setTimeout(r, 500));
  }
  const lab = async (method, p, body) => {
    const r = await fetch(base + p, { method, body: body === undefined ? undefined : JSON.stringify(body), headers: body === undefined ? {} : { "content-type": "application/json" } });
    const text = await r.text();
    if (!r.ok) throw new Error(`${method} ${p} -> ${r.status} ${text.slice(0, 300)}`);
    return JSON.parse(text);
  };
  return { base, lab, child, stop: () => child.kill("SIGTERM") };
}

const pick = (rows) => Object.fromEntries(TABLES.map((t) => [t, rows[t] ?? []]));

async function main() {
  const a = args(process.argv.slice(2));
  const signer = createSigner();
  const dump = JSON.parse(fs.readFileSync(path.join(REPO, "tests/fixtures/seed-upstream-100.dump.json"), "utf8"));
  const payloads = dump.layout_formats.filter((f) => f.lineage === "spark").map((f) => JSON.parse(f.payload_json)).sort((x, y) => JSON.stringify(x).length - JSON.stringify(y).length);
  const [P1, P2, P3] = payloads;
  const s1 = await startServer(a.ports[0], a.ddb);
  const logged = [];
  let seed = 7000;
  let clock = T0 - 3600_000;
  const base = { clients: [labClientRow()], admins: [{ user_id: LAB_ADMIN, added_by: null, added_at: "2026-10-25T00:00:00.000Z", note: "replay-fixture" }] };
  await s1.lab("POST", "/__lab/import", base);

  // One signed (or public) request to server `s`. `log` records it as a Logpush event at the request's clock.
  const call = async (s, method, p, { actor, json, headers = {}, log = false, step = 1500 } = {}) => {
    clock += step;
    const sd = ++seed;
    const body = json === undefined ? undefined : Buffer.from(JSON.stringify(json));
    const h = { "x-lab-now": new Date(clock).toISOString(), "x-lab-seed": String(sd), ...headers };
    if (body !== undefined) h["content-type"] = "application/json";
    if (actor !== undefined) Object.assign(h, signer.sign({ method, pathWithQuery: p, body, actor, nowMs: clock, nonceSeed: sd }));
    const r = await fetch(s.base + p, { method, headers: h, body });
    const text = await r.text();
    if (log) logged.push({ ts: clock, method, path: p, status: r.status });
    let j = null;
    try {
      j = JSON.parse(text);
    } catch {
      /* not json */
    }
    return { status: r.status, json: j, etag: r.headers.get("etag") };
  };
  const must = (r, what) => {
    if (r.status >= 300) throw new Error(`${what} -> ${r.status} ${JSON.stringify(r.json)}`);
    return r;
  };

  // ---- seed phase (before the window; not logged) ---------------------------------------------------------------
  const L1 = must(await call(s1, "POST", "/v1/layouts", { actor: A, json: { name: "alpha", format: "spark/1", payload: P1 } }), "seed alpha").json.id;
  const L2 = must(await call(s1, "POST", "/v1/layouts", { actor: B, json: { name: "beta", format: "spark/1", payload: P2 } }), "seed beta").json.id;
  const before = pick(await s1.lab("GET", "/__lab/export"));
  clock = T0;

  // ---- the window (logged) --------------------------------------------------------------------------------------
  const L = { log: true };
  const r1 = await call(s1, "GET", "/v1/meta", L);
  await call(s1, "GET", "/v1/meta", { ...L, headers: { "if-none-match": r1.etag } }); // logged as a 304
  await call(s1, "GET", "/v1/layouts?format=spark%2F1&limit=2", L);
  await call(s1, "GET", "/v1/me", { ...L, actor: A });
  const created = must(await call(s1, "POST", "/v1/layouts", { ...L, actor: A, json: { name: "gamma", format: "spark/1", payload: P3 } }), "create gamma").json.id;
  must(await call(s1, "PUT", `/v1/layouts/${L1}`, { ...L, actor: A, json: { format: "spark/1", payload: P3 }, headers: { "If-Match": '"spark:1"' } }), "put");
  must(await call(s1, "PATCH", `/v1/layouts/${L2}`, { ...L, actor: B, json: { name: "beta2" }, headers: { "If-Match": '"layout:1"' } }), "rename");
  must(await call(s1, "PUT", `/v1/layouts/${L1}/like`, { ...L, actor: B }), "like");
  await call(s1, "PUT", `/v1/layouts/${L1}/like`, { ...L, actor: B }); // already liked: no event
  must(await call(s1, "DELETE", `/v1/layouts/${L1}/like`, { ...L, actor: B }), "unlike");
  must(await call(s1, "PUT", `/v1/layouts/beta2/like`, { ...L, actor: C }), "like by name");
  must(await call(s1, "POST", `/v1/layouts/${L2}/transfer`, { ...L, actor: B, json: { to: C }, headers: { "If-Match": '"layout:2"' } }), "transfer");
  must(await call(s1, "DELETE", `/v1/layouts/${L2}`, { ...L, actor: C, headers: { "If-Match": '"layout:3"' } }), "delete");
  must(await call(s1, "POST", `/v1/layouts/${L2}/restore`, { ...L, actor: C, json: {} }), "restore");
  await call(s1, "POST", "/v1/layouts", { ...L, actor: A, json: { name: "ALPHA", format: "spark/1", payload: P1 } }); // 409: name taken

  const link = must(await call(s1, "PUT", `/v1/layouts/${L1}/link`, { ...L, actor: A, json: { url: "https://example.com/replay-fixture" } }), "link").json;
  const lid = link.submission?.id ?? link.id;
  await call(s1, "GET", "/v1/admin/link-queue", { ...L, actor: LAB_ADMIN });
  must(await call(s1, "POST", `/v1/admin/link-queue/${lid}/approve`, { ...L, actor: LAB_ADMIN, json: {} }), "link approve");

  const w = must(await call(s1, "POST", "/v1/wpm", { ...L, actor: A, json: { layout: L1, wpm: 120, proof: "https://www.youtube.com/watch?v=replayfx1" } }), "wpm").json;
  const wid = w.submission?.id ?? w.id;
  await call(s1, "GET", `/v1/wpm/submissions/${wid}`, { ...L, actor: A });
  must(await call(s1, "POST", `/v1/admin/wpm-queue/${wid}/approve`, { ...L, actor: LAB_ADMIN, json: { review_version: 0 } }), "wpm approve");
  must(await call(s1, "POST", `/v1/admin/wpm-queue/${wid}/reopen`, { ...L, actor: LAB_ADMIN, json: { status: "approved", review_version: 0 } }), "wpm reopen");
  must(await call(s1, "POST", `/v1/admin/wpm-queue/${wid}/reject`, { ...L, actor: LAB_ADMIN, json: { reason: "fixture", review_version: 1 } }), "wpm reject");
  must(await call(s1, "PUT", `/v1/wpm/submissions/${wid}/discord-message`, { ...L, actor: A, json: { guild_id: "300000000000000001", channel_id: "300000000000000002", message_id: "300000000000000003" } }), "bind");
  await call(s1, "POST", "/v1/admin/wpm", { ...L, actor: LAB_ADMIN, json: { user_id: B, layout: L1, wpm: 95, proof: "https://www.youtube.com/watch?v=replayfx2" } });

  const c1 = must(await call(s1, "PUT", `/v1/layouts/${L1}/comment`, { ...L, actor: A, json: { body: "a kept comment on alpha" } }), "comment").json;
  const c1id = c1.submission?.id ?? c1.id;
  must(await call(s1, "POST", `/v1/admin/comment-queue/${c1id}/approve`, { ...L, actor: LAB_ADMIN, json: { review_version: 0 } }), "comment approve");
  must(await call(s1, "PUT", `/v1/layouts/${L1}/comments/${A}/like`, { ...L, actor: C }), "comment like");
  must(await call(s1, "PUT", `/v1/layouts/${L1}/comment`, { ...L, actor: B, json: { body: "this one is erased afterwards" } }), "comment B");
  must(await call(s1, "DELETE", `/v1/layouts/${L1}/comment`, { ...L, actor: B }), "comment delete"); // body is NULL in the after export

  must(await call(s1, "PUT", `/v1/admin/bans/${C}`, { ...L, actor: LAB_ADMIN, json: { reason: "fixture" } }), "ban");
  must(await call(s1, "DELETE", `/v1/admin/bans/${C}`, { ...L, actor: LAB_ADMIN }), "unban");
  await call(s1, "GET", "/v1/admin/bans", { ...L, actor: LAB_ADMIN });
  await call(s1, "GET", "/v1/layouts/no-such-layout", L); // 404

  const after = pick(await s1.lab("GET", "/__lab/export"));
  s1.stop();
  void created;

  // ---- the Logpush files ----------------------------------------------------------------------------------------
  const line = (ts, method, p, status, extra = {}) =>
    JSON.stringify({ EventTimestampMs: ts, Event: { Request: { URL: `https://api.akldb.org${p}`, Method: method }, Response: { Status: status } }, Outcome: "ok", ScriptName: "akldb", WallTimeMs: 12, CPUTimeMs: 3, ...extra });
  const lines = logged.map((e) => line(e.ts, e.method, e.path, e.status));
  const end = clock;
  // Logged-only extras: a long-poll, a 500 write (infra), a Discord interaction, non-API traffic, and read padding so
  // the handful of unreplayable requests stays well under the 1% gate (production is ~63k requests/day).
  lines.push(line(T0 + 4000, "GET", "/v1/changes?since=0&limit=50&wait=20", 200, { WallTimeMs: 20000 }));
  lines.push(line(T0 + 4100, "POST", "/v1/layouts", 500, { Outcome: "exception" }));
  lines.push(line(T0 + 4200, "POST", "/discord/interactions", 401));
  lines.push(line(T0 + 4300, "GET", "/robots.txt", 404));
  lines.push("this is not json");
  for (let i = 0; i < 480; i++) lines.push(line(T0 + 1000 + i * 150, "GET", i % 3 === 0 ? `/v1/layouts/${L1}?format=spark%2F1` : i % 3 === 1 ? "/v1/layouts?format=spark%2F1&limit=2" : "/v1/meta", 200));
  const sorted = lines.slice().sort();
  const half = Math.floor(sorted.length / 2);
  const dir = path.join(a.out, "logs", "20261030", "20261030");
  fs.rmSync(path.join(a.out, "logs"), { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  const f = (s, e, id, ls) => fs.writeFileSync(path.join(dir, `20261030T120000Z_20261030T${s}Z_${id}.log.gz`), zlib.gzipSync(`${ls.join("\n")}\n`));
  f("120100", "120100", "a1b2c3d4", sorted.slice(0, half));
  f("120200", "120200", "e5f6a7b8", sorted.slice(half));
  fs.writeFileSync(path.join(a.out, "before.json.gz"), zlib.gzipSync(JSON.stringify(before)));
  fs.writeFileSync(path.join(a.out, "after.json.gz"), zlib.gzipSync(JSON.stringify(after)));
  fs.writeFileSync(path.join(a.out, "ids.json"), JSON.stringify({ L1, L2, T0, end, A, B, C, admin: LAB_ADMIN }, null, 2));
  console.log(`[gen] wrote ${lines.length} log lines and the exports to ${a.out}`);

  if (a.verify) {
    await new Promise((r) => setTimeout(r, 1500));
    const s2 = await startServer(a.ports[1], a.ddb);
    const s3 = await startServer(a.ports[0], a.ddb);
    try {
      const sides = [];
      for (const s of [s2, s3]) {
        await s.lab("POST", "/__lab/reset");
        await s.lab("POST", "/__lab/import", before);
        sides.push({ name: s.base, send: async (w) => {
          const r = await fetch(s.base + w.pathWithQuery, { method: w.method, headers: w.headers, body: w.body });
          const headers = {};
          r.headers.forEach((v, k) => (headers[k] = v));
          return { status: r.status, headers, body: Buffer.from(await r.arrayBuffer()) };
        } });
      }
      const { requests } = readLogs(path.join(a.out, "logs"));
      const plan = buildPlan(requests, { before: loadExport(before), after: loadExport(after) });
      console.log(renderSkipReport(skipReport(plan)));
      const res = await runPlan(plan, { sides, diffPair, signer, speed: 100, concurrency: 1 });
      console.log(`[verify] sent ${res.sent}, diffs ${res.diffs.length}, errors ${res.errors.length}`);
      for (const d of res.diffs.slice(0, 10)) console.log("  DIFF", d.method, d.path, d.problems.map((p) => p.detail).join("; ").slice(0, 300));
      for (const e of res.errors.slice(0, 10)) console.log("  ERR", e);
      const statuses = {};
      for (const r of res.results) statuses[r.status[0]] = (statuses[r.status[0]] ?? 0) + 1;
      console.log("[verify] oracle-side statuses", JSON.stringify(statuses));
      const seen = new Set();
      for (const r of res.results) if (r.status[0] >= 400 && !seen.has(r.method + r.path + r.status[0])) { seen.add(r.method + r.path + r.status[0]); console.log("  non-2xx", r.status.join("/"), r.method, r.path + r.query); }
      const finalA = pick(await s2.lab("GET", "/__lab/export"));
      const finalB = pick(await s3.lab("GET", "/__lab/export"));
      console.log(`[verify] final event counts: replay A ${finalA.events.length}, replay B ${finalB.events.length}, original ${after.events.length}`);
      if (JSON.stringify(finalA) !== JSON.stringify(finalB)) console.log("[verify] FINAL STATE DIFFERS between the two replays");
      process.exitCode = res.diffs.length + res.errors.length > 0 ? 1 : 0;
    } finally {
      s2.stop();
      s3.stop();
    }
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
