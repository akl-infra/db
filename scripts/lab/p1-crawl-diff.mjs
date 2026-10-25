#!/usr/bin/env node
// P1 crawler diff (design/aws-port.md §9, P1 gate): boots two local Workers
// (`wrangler dev --local`) built from two commits -- by default origin/main
// and HEAD -- on byte-identical copies of the same seeded D1, with the clock
// and every random id frozen per request, then sends both the same requests
// and diffs status, contract headers and body bytes, and finally the full
// table state. Any difference is reported; the expected-difference list is
// empty (P1 claims byte-identical behaviour).
//
//   node scripts/lab/p1-crawl-diff.mjs [--base origin/main] [--head HEAD]
//     [--dump <file.json|file.json.gz>|fixture] [--out <dir>] [--work <dir>]
//     [--ports 18911,18912,18913] [--concurrency 12] [--keep]
//
// Needs git, sqlite3 and this repo's node_modules (shared into both trees by
// symlink: the commits must have the same package-lock.json). Touches no
// remote service: the dump is a local file (the public dump is fine for
// reads; `fixture` uses tests/fixtures/seed-upstream-100.dump.json).
//
// Determinism. Each tree gets an extra entry module (.lab-entry.ts, written
// into the temporary checkout only) that wraps src/index.ts: `Date` and
// `Date.now()` return the instant in the request's `x-lab-now` header, and
// `crypto.getRandomValues`/`randomUUID` draw from a PRNG reseeded from
// `x-lab-seed`. Both Workers see the same headers, so the same code makes
// the same ULIDs, nonces and timestamps. Client-lane requests are signed
// here (Ed25519 is deterministic) with a lab client seeded into the D1, and
// Discord-lane requests use a local fake Discord.
import { spawn, execFileSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import url from "node:url";
import zlib from "node:zlib";

const REPO = path.resolve(path.dirname(url.fileURLToPath(import.meta.url)), "..", "..");

function parseArgs(argv) {
  const a = { base: "origin/main", head: "HEAD", dump: "fixture", out: null, work: null, ports: [18911, 18912, 18913], concurrency: 12, keep: false };
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    const v = () => argv[++i];
    if (k === "--base") a.base = v();
    else if (k === "--head") a.head = v();
    else if (k === "--dump") a.dump = v();
    else if (k === "--out") a.out = v();
    else if (k === "--work") a.work = v();
    else if (k === "--ports") a.ports = v().split(",").map(Number);
    else if (k === "--concurrency") a.concurrency = Number(v());
    else if (k === "--keep") a.keep = true;
    else throw new Error(`unknown argument ${k}`);
  }
  return a;
}

// Imported by scripts/lab/fuzz (lane L) for its helpers; only the CLI parses
// arguments, makes the work directory and runs.
const IS_MAIN = process.argv[1] !== undefined && url.pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;
const args = IS_MAIN ? parseArgs(process.argv.slice(2)) : null;
const WORK = IS_MAIN ? (args.work ?? fs.mkdtempSync(path.join(os.tmpdir(), "akldb-p1-crawl-"))) : null;
const OUT = IS_MAIN ? (args.out ?? path.join(WORK, "report")) : null;
if (IS_MAIN) fs.mkdirSync(OUT, { recursive: true });
const log = (...m) => console.log(`[p1-crawl] ${m.join(" ")}`);

// ---------------------------------------------------------------------------
// Trees, seed, servers
// ---------------------------------------------------------------------------

const LAB_ENTRY = `// Written by scripts/lab/p1-crawl-diff.mjs into a temporary checkout only.
import app from "./src/index.ts";
const RealDate = Date;
let frozenMs = RealDate.parse("2026-10-25T12:00:00.000Z");
class LabDate extends RealDate {
  constructor(...args: any[]) {
    if (args.length === 0) super(frozenMs);
    else super(...(args as [any]));
  }
  static now() {
    return frozenMs;
  }
}
(globalThis as any).Date = LabDate;
let state = 1;
function next(): number {
  state = (state + 0x6d2b79f5) | 0;
  let t = Math.imul(state ^ (state >>> 15), 1 | state);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return (t ^ (t >>> 14)) >>> 0;
}
function fill(arr: ArrayBufferView): ArrayBufferView {
  const u8 = new Uint8Array(arr.buffer, arr.byteOffset, arr.byteLength);
  for (let i = 0; i < u8.length; i++) u8[i] = next() & 0xff;
  return arr;
}
Object.defineProperty(crypto, "getRandomValues", { configurable: true, writable: true, value: fill });
Object.defineProperty(crypto, "randomUUID", {
  configurable: true,
  writable: true,
  value: () => {
    const b = new Uint8Array(16);
    fill(b);
    b[6] = (b[6]! & 0x0f) | 0x40;
    b[8] = (b[8]! & 0x3f) | 0x80;
    const h = [...b].map((x) => x.toString(16).padStart(2, "0")).join("");
    return h.slice(0, 8) + "-" + h.slice(8, 12) + "-" + h.slice(12, 16) + "-" + h.slice(16, 20) + "-" + h.slice(20);
  },
});
function arm(req: Request) {
  const n = req.headers.get("x-lab-now");
  if (n !== null) frozenMs = RealDate.parse(n);
  const s = req.headers.get("x-lab-seed");
  if (s !== null) state = Number(s) >>> 0;
}
export default {
  fetch(req: Request, env: unknown, ctx: unknown) {
    arm(req);
    return (app as any).fetch(req, env, ctx);
  },
  scheduled(ev: unknown, env: unknown, ctx: unknown) {
    return (app as any).scheduled(ev, env, ctx);
  },
};
`;

function sh(cmd, argv, opts = {}) {
  return execFileSync(cmd, argv, { stdio: ["ignore", "pipe", "pipe"], encoding: "utf8", maxBuffer: 1 << 30, ...opts });
}

function checkout(name, rev) {
  const dir = path.join(WORK, name);
  if (!fs.existsSync(dir)) sh("git", ["-C", REPO, "worktree", "add", "--detach", dir, rev]);
  const sha = sh("git", ["-C", dir, "rev-parse", "HEAD"]).trim();
  const nm = path.join(dir, "node_modules");
  if (!fs.existsSync(nm)) fs.symlinkSync(path.join(REPO, "node_modules"), nm);
  fs.writeFileSync(path.join(dir, ".lab-entry.ts"), LAB_ENTRY);
  return { dir, sha };
}

function loadDump(spec) {
  const file = spec === "fixture" ? path.join(REPO, "tests/fixtures/seed-upstream-100.dump.json") : spec;
  const raw = fs.readFileSync(file);
  return JSON.parse((file.endsWith(".gz") ? zlib.gunzipSync(raw) : raw).toString("utf8"));
}

// Lab identities. Snowflake-shaped ids no real Discord user holds.
const ADMIN = "100000000000000001";
const USER_A = "100000000000000002";
const USER_B = "100000000000000003";
const USER_C = "100000000000000004";
const LAB_APP_ID = "1100000000000000001";
// A fixed lab key: the pubkey lands in the clients row, so a random one made every run's final state differ (lane F, LDB-FZ1).
const LAB_PRIV = crypto.createPrivateKey({ key: Buffer.concat([Buffer.from("302e020100300506032b657004220420", "hex"), crypto.createHash("sha256").update("akldb-lab-client-key").digest()]), format: "der", type: "pkcs8" });
const LAB_PUB = crypto.createPublicKey(LAB_PRIV);
const LAB_PUB_RAW = LAB_PUB.export({ format: "der", type: "spki" }).subarray(-32).toString("base64url");
const LAB_CLIENT = "01JAB0000000000000000P1C01";

function sqlLit(v) {
  return v === null ? "NULL" : typeof v === "number" ? String(v) : `'${String(v).replace(/'/g, "''")}'`;
}

async function seed(baseTree, dump) {
  const seedDir = path.join(WORK, "seed");
  if (fs.existsSync(seedDir)) fs.rmSync(seedDir, { recursive: true });
  sh("npx", ["wrangler", "d1", "migrations", "apply", "akl-db", "--local", "--persist-to", seedDir, "--config", "wrangler.toml"], { cwd: baseTree.dir, env: { ...process.env, CI: "1" } });
  const sqlite = findSqlite(seedDir);
  const { restoreSql } = await import(url.pathToFileURL(path.join(REPO, "src/store/d1/dump.ts")).href);
  const extra = [
    `INSERT INTO clients (id, name, pubkey, owner_user_id, caps, discord_app_id, status, created_at, revoked_at) VALUES (${sqlLit(LAB_CLIENT)}, 'p1-crawl-diff', ${sqlLit(LAB_PUB_RAW)}, ${sqlLit(ADMIN)}, 'act-as-user,feed:wait', NULL, 'active', '2026-10-25T00:00:00.000Z', NULL)`,
    `INSERT OR IGNORE INTO admins (user_id, added_by, added_at, note) VALUES (${sqlLit(ADMIN)}, NULL, '2026-10-25T00:00:00.000Z', 'p1-crawl-diff')`,
    `INSERT OR IGNORE INTO authors (user_id, name, first_seen_at, last_seen_at, name_source) VALUES (${sqlLit(USER_C)}, 'lab-c', '2026-10-25T00:00:00.000Z', '2026-10-25T00:00:00.000Z', 'import')`,
  ];
  const sqlFile = path.join(WORK, "seed.sql");
  fs.writeFileSync(sqlFile, "BEGIN;\n" + [...restoreSql(dump), ...extra].join(";\n") + ";\nCOMMIT;\n");
  sh("sqlite3", [sqlite], { input: fs.readFileSync(sqlFile), stdio: ["pipe", "pipe", "pipe"] });
  return seedDir;
}

function findSqlite(dir) {
  const hits = [];
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const f = path.join(d, e.name);
      if (e.isDirectory()) walk(f);
      else if (e.name.endsWith(".sqlite") && e.name !== "metadata.sqlite" && f.includes(`${path.sep}d1${path.sep}`)) hits.push(f);
    }
  };
  walk(dir);
  if (hits.length !== 1) throw new Error(`expected one D1 sqlite under ${dir}, found ${hits.length}`);
  return hits[0];
}

function startFakeDiscord(port) {
  const server = http.createServer((req, res) => {
    const auth = req.headers.authorization ?? "";
    const m = /^Bearer lab-(\d{17,20})$/.exec(auth);
    if (req.url === "/api/oauth2/@me" && m) {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ application: { id: LAB_APP_ID }, user: { id: m[1], username: `lab${m[1].slice(-2)}` }, scopes: ["identify"] }));
      return;
    }
    res.writeHead(401, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ message: "401: Unauthorized", code: 0 }));
  });
  return new Promise((resolve) => server.listen(port, "127.0.0.1", () => resolve(server)));
}

function startWorker(tree, persist, port, inspector, discordPort, logName) {
  const out = fs.openSync(path.join(OUT, `${logName}.log`), "w");
  const child = spawn(
    "npx",
    ["wrangler", "dev", ".lab-entry.ts", "--config", "wrangler.toml", "--local", "--persist-to", persist, "--port", String(port), "--ip", "127.0.0.1", "--inspector-port", String(inspector), "--var", `DISCORD_API_URL:http://127.0.0.1:${discordPort}/api`, "--show-interactive-dev-session=false"],
    { cwd: tree.dir, stdio: ["ignore", out, out], env: { ...process.env, CI: "1", WRANGLER_SEND_METRICS: "false" }, detached: true },
  );
  return child;
}

async function waitReady(base) {
  for (let i = 0; i < 240; i++) {
    try {
      const r = await fetch(`${base}/v1/formats`);
      if (r.status === 200) return;
    } catch {
      // not up yet
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`${base} never came up`);
}

// ---------------------------------------------------------------------------
// Requests and the diff
// ---------------------------------------------------------------------------

const CONTRACT_HEADERS = ["etag", "cache-control", "content-type", "x-akldb-api", "x-wait-ignored", "retry-after", "deprecation", "sunset", "location", "content-length", "www-authenticate"];
const CLOCK0 = Date.parse("2026-10-25T12:00:00.000Z");

let tick = 0;
let seedCounter = 1000;
function labHeaders(stepMs) {
  tick += stepMs;
  return { "x-lab-now": new Date(CLOCK0 + tick).toISOString(), "x-lab-seed": String(++seedCounter) };
}

function signedHeaders(method, pathWithQuery, body, actor, nowIso, nonceSeed) {
  const timestamp = String(Math.floor(Date.parse(nowIso) / 1000));
  const nonce = crypto.createHash("sha256").update(`nonce:${nonceSeed}`).digest().subarray(0, 16).toString("base64url");
  const bodyHash = crypto.createHash("sha256").update(body ?? Buffer.alloc(0)).digest("base64url");
  const message = `akl-v1\n${method.toUpperCase()}\n${pathWithQuery}\n${timestamp}\n${nonce}\n${actor}\n${bodyHash}`;
  const signature = crypto.sign(null, Buffer.from(message, "utf8"), LAB_PRIV).toString("base64url");
  return { "X-Akl-Client": LAB_CLIENT, "X-Akl-Timestamp": timestamp, "X-Akl-Nonce": nonce, "X-Akl-Actor": actor, "X-Akl-Signature": signature };
}

const results = { requests: 0, diffs: [], families: {}, writes: [] };

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

function firstDiff(a, b) {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) if (a[i] !== b[i]) return i;
  return a.length === b.length ? -1 : n;
}

// One request to both Workers. `opts.actor` signs it on the client lane;
// `opts.bearer` sends a fake-Discord bearer. Returns the base side's response.
async function pair(family, method, p, opts = {}) {
  const body = opts.json !== undefined ? Buffer.from(JSON.stringify(opts.json)) : undefined;
  const lab = labHeaders(opts.stepMs ?? 0);
  const headers = { ...lab, ...(opts.headers ?? {}) };
  if (body !== undefined) headers["Content-Type"] = "application/json";
  if (opts.actor !== undefined) Object.assign(headers, signedHeaders(method, p, body, opts.actor, lab["x-lab-now"], lab["x-lab-seed"]));
  if (opts.bearer !== undefined) headers.Authorization = `Bearer lab-${opts.bearer}`;
  const spec = { method, path: p, headers, body };
  const [a, b] = await Promise.all([send(BASE_URL, spec), send(HEAD_URL, spec)]);
  results.requests++;
  const fam = (results.families[family] ??= { requests: 0, diffs: 0, statuses: {} });
  fam.requests++;
  fam.statuses[a.status] = (fam.statuses[a.status] ?? 0) + 1;
  const problems = [];
  if (a.status !== b.status) problems.push(`status ${a.status} vs ${b.status}`);
  for (const h of CONTRACT_HEADERS) if (a.headers[h] !== b.headers[h]) problems.push(`header ${h}: ${JSON.stringify(a.headers[h])} vs ${JSON.stringify(b.headers[h])}`);
  const at = firstDiff(a.body, b.body);
  if (at !== -1) problems.push(`body differs at byte ${at} (${a.body.length} vs ${b.body.length} bytes): ${JSON.stringify(a.body.subarray(Math.max(0, at - 40), at + 80).toString("utf8"))} vs ${JSON.stringify(b.body.subarray(Math.max(0, at - 40), at + 80).toString("utf8"))}`);
  if (problems.length > 0) {
    fam.diffs++;
    results.diffs.push({ family, method, path: p, problems });
  }
  // The conditional half of every ETag'd read: both must 304 on their own tag.
  if (method === "GET" && a.headers.etag !== undefined && opts.conditional !== false) {
    await pair(`${family} (If-None-Match)`, "GET", p, { ...opts, conditional: false, headers: { ...(opts.headers ?? {}), "If-None-Match": a.headers.etag } });
  }
  let json = null;
  try {
    json = JSON.parse(a.body.toString("utf8"));
  } catch {
    // not JSON
  }
  return { status: a.status, json, etag: a.headers.etag };
}

async function pool(items, n, fn) {
  let i = 0;
  await Promise.all(
    Array.from({ length: n }, async () => {
      while (i < items.length) {
        const item = items[i++];
        await fn(item);
      }
    }),
  );
}

// ---------------------------------------------------------------------------
// The crawl
// ---------------------------------------------------------------------------

const enc = encodeURIComponent;

async function crawlReads(dump, label) {
  log(`reads (${label})`);
  const layouts = dump.records;
  const formats = ["spark/1", "mana2/1"];
  await pair(`${label} meta`, "GET", "/v1/meta");
  await pair(`${label} formats`, "GET", "/v1/formats");
  for (const f of ["spark", "mana2"]) await pair(`${label} formats`, "GET", `/v1/formats/${f}/1/schema.json`);
  await pair(`${label} formats`, "GET", "/v1/formats/nope/1/schema.json");

  // Layout detail, every format plus the error shapes, by id and by name.
  const detail = [];
  for (const l of layouts) {
    for (const f of formats) detail.push(["layout detail", `/v1/layouts/${l.id}?format=${enc(f)}`]);
    detail.push(["layout detail", `/v1/layouts/${l.id}`]);
    detail.push(["layout history", `/v1/layouts/${l.id}/history`]);
    detail.push(["layout history", `/v1/layouts/${l.id}/history?format=spark%2F1`]);
    detail.push(["layout likes", `/v1/layouts/${l.id}/likes`]);
    detail.push(["layout rev", `/v1/layouts/${l.id}/rev/1?format=spark%2F1`]);
    detail.push(["layout rev", `/v1/layouts/${l.id}/rev/1?format=mana2%2F1`]);
    if (!l.deleted) {
      detail.push(["layout by name", `/v1/layouts/${enc(l.name)}?format=spark%2F1`]);
      detail.push(["layout by name", `/v1/layouts/${enc(l.name.toUpperCase())}?format=spark%2F1`]);
      detail.push(["layout comments", `/v1/layouts/${l.id}/comments`]);
    }
  }
  const revs = new Map();
  for (const r of dump.layout_revs ?? []) if (r.lineage === "spark") revs.set(r.layout_id, Math.max(revs.get(r.layout_id) ?? 0, r.rev));
  for (const [id, rev] of revs) detail.push(["layout rev", `/v1/layouts/${id}/rev/${rev}?format=spark%2F1`], ["layout rev", `/v1/layouts/${id}/rev/${rev + 1}?format=spark%2F1`]);
  detail.push(["layout detail", "/v1/layouts/no-such-layout?format=spark%2F1"], ["layout detail", "/v1/layouts/01JAB0000000000000000NONE0?format=spark%2F1"], ["layout detail", `/v1/layouts/${layouts[0]?.id}?format=bogus%2F9`]);
  await pool(detail, args.concurrency, ([fam, p]) => pair(`${label} ${fam}`, "GET", p));

  // Lists: every sort x filter x format, with the whole cursor chain.
  const owners = [...new Set(layouts.map((l) => l.owner))].slice(0, 6);
  const likers = [...new Set((dump.likes ?? []).map((l) => l.user_id))].slice(0, 4);
  const filters = ["", "&has_magic=true", "&has_magic=false", "&has_alts=true", "&has_combos=true", "&since=2026-09-20T00:00:00.000Z", ...owners.map((o) => `&owner=${o}`), ...likers.map((u) => `&liked_by=${u}`)];
  const combos = [];
  for (const sort of ["name", "modified_at", "created_at", "like_count"]) for (const f of formats) for (const filter of filters) for (const limit of [97, 1000]) combos.push({ sort, f, filter, limit });
  await pool(combos, args.concurrency, async ({ sort, f, filter, limit }) => {
    let cursor = null;
    for (let page = 0; page < 200; page++) {
      const p = `/v1/layouts?format=${enc(f)}&sort=${sort}&limit=${limit}${filter}${cursor ? `&cursor=${enc(cursor)}` : ""}`;
      const r = await pair(`${label} list`, "GET", p);
      cursor = r.json?.next_cursor ?? null;
      if (cursor === null) break;
    }
  });
  for (const bad of ["&sort=bogus", "&limit=0", "&cursor=%%%", "&has_magic=maybe", "&liked_by=x"]) await pair(`${label} list errors`, "GET", `/v1/layouts?format=spark%2F1${bad}`);
  await pair(`${label} list errors`, "GET", "/v1/layouts");
  for (const f of formats) {
    await pair(`${label} full`, "GET", `/v1/layouts?format=${enc(f)}&full=1`);
    if (likers[0]) await pair(`${label} full`, "GET", `/v1/layouts?format=${enc(f)}&full=1&liked_by=${likers[0]}`);
  }

  // The feed from 0, plain and filtered.
  const kinds = ["created", "liked,unliked", "admin.added", "link_approved", "wpm_approved", "comment_approved"];
  const feeds = [""];
  for (const k of kinds) feeds.push(`&kinds=${enc(k)}`);
  for (const l of layouts.slice(0, 20)) feeds.push(`&layout=${l.id}`);
  for (const o of owners.slice(0, 3)) feeds.push(`&actor=${o}`);
  await pool(feeds, args.concurrency, async (filter) => {
    let since = 0;
    for (let page = 0; page < 2000; page++) {
      const r = await pair(`${label} changes`, "GET", `/v1/changes?since=${since}&limit=1000${filter}`);
      const next = r.json?.next;
      if (typeof next !== "number" || next === since || (r.json?.items?.length ?? 0) === 0) break;
      since = next;
    }
  });
  for (const bad of ["since=-1", "limit=0", "kinds=bogus", "layout=nope"]) await pair(`${label} changes errors`, "GET", `/v1/changes?${bad}`);
  await pair(`${label} changes`, "GET", "/v1/changes?since=0&limit=5&wait=1");
  await pair(`${label} changelog`, "GET", "/admin/changelog");
  await pair(`${label} changelog`, "GET", "/admin/changelog?kinds=created");

  // Authors, WPM, comments, dumps.
  await pair(`${label} authors`, "GET", "/v1/authors");
  await pair(`${label} authors`, "GET", "/v1/authors?by=name");
  await pool((dump.authors ?? []).map((a) => a.user_id), args.concurrency, (id) => pair(`${label} authors`, "GET", `/v1/authors/${id}`));
  await pair(`${label} authors`, "GET", "/v1/authors/123");
  await pair(`${label} wpm`, "GET", "/v1/wpm");
  for (const w of (dump.wpm_submissions ?? []).slice(0, 30)) {
    await pair(`${label} wpm`, "GET", `/v1/wpm?layout=${w.layout_id}`);
    await pair(`${label} wpm`, "GET", `/v1/wpm?user=${w.user_id}`);
  }
  await pair(`${label} comments`, "GET", "/v1/comment-counts");
  for (const id of [...new Set((dump.layout_comments ?? []).map((c) => c.layout_id))]) {
    await pair(`${label} comments`, "GET", `/v1/layouts/${id}/comments`);
    await pair(`${label} comments`, "GET", `/v1/layouts/${id}/comments?sort=newest`);
  }
  for (const p of ["/v1/dump", "/v1/dump/latest.json", "/v1/dump/dump-2026-10-25.json.gz", "/v1/dump/monthly/dump-2026-10.json.gz", "/v1/dump/nope"]) await pair(`${label} dump`, "GET", p);
}

// ---------------------------------------------------------------------------
// Scripted writes (signed client lane, plus the Discord bearer lane)
// ---------------------------------------------------------------------------

async function writes(dump) {
  log("writes");
  const W = async (label, method, p, opts) => {
    const r = await pair("writes", method, p, { stepMs: 1000, ...opts });
    results.writes.push({ label, method, path: p, status: r.status });
    return r;
  };
  const sample = dump.records.find((l) => !l.deleted);
  const src = (await pair("writes (setup)", "GET", `/v1/layouts/${sample.id}?format=spark%2F1`)).json;
  const payload = src.payload;

  await W("me (client lane)", "GET", "/v1/me", { actor: USER_A });
  await W("me (bearer lane)", "GET", "/v1/me", { bearer: USER_B });
  await W("me (bad bearer)", "GET", "/v1/me", { headers: { Authorization: "Bearer nope" } });
  await W("touch user B", "GET", "/v1/me", { actor: USER_B });

  const created = await W("create", "POST", "/v1/layouts", { actor: USER_A, json: { name: "lab-p1-one", format: "spark/1", payload } });
  const id = created.json?.id;
  await W("create again (name taken)", "POST", "/v1/layouts", { actor: USER_A, json: { name: "LAB-P1-ONE", format: "spark/1", payload } });
  await W("create (bad name)", "POST", "/v1/layouts", { actor: USER_A, json: { name: "", format: "spark/1", payload } });
  await W("create (unknown format)", "POST", "/v1/layouts", { actor: USER_A, json: { name: "lab-x", format: "bogus/1", payload } });
  await W("create (idempotent)", "POST", "/v1/layouts", { actor: USER_A, json: { name: "lab-p1-idem", format: "spark/1", payload }, headers: { "Idempotency-Key": "lab-key-1" } });
  await W("create (idempotent replay)", "POST", "/v1/layouts", { actor: USER_A, json: { name: "lab-p1-idem", format: "spark/1", payload }, headers: { "Idempotency-Key": "lab-key-1" } });
  await W("create (idempotent mismatch)", "POST", "/v1/layouts", { actor: USER_A, json: { name: "lab-p1-idem2", format: "spark/1", payload }, headers: { "Idempotency-Key": "lab-key-1" } });
  await W("put (replace)", "PUT", `/v1/layouts/${id}`, { actor: USER_A, json: { format: "spark/1", payload }, headers: { "If-Match": '"spark:1"' } });
  await W("put (stale)", "PUT", `/v1/layouts/${id}`, { actor: USER_A, json: { format: "spark/1", payload }, headers: { "If-Match": '"spark:1"' } });
  await W("put (no If-Match)", "PUT", `/v1/layouts/${id}`, { actor: USER_A, json: { format: "spark/1", payload } });
  await W("put (not owner)", "PUT", `/v1/layouts/${id}`, { actor: USER_B, json: { format: "spark/1", payload }, headers: { "If-Match": '"spark:2"' } });
  await W("patch fingermap", "PATCH", `/v1/layouts/${id}`, { actor: USER_A, json: { format: "spark/1", fingermap: {} }, headers: { "If-Match": '"spark:2"' } });
  await W("patch mixed", "PATCH", `/v1/layouts/${id}`, { actor: USER_A, json: { name: "x", format: "spark/1", fingermap: {} }, headers: { "If-Match": '"layout:1"' } });
  await W("rename", "PATCH", `/v1/layouts/${id}`, { actor: USER_A, json: { name: "lab-p1-renamed" }, headers: { "If-Match": '"layout:1"' } });
  await W("like", "PUT", `/v1/layouts/${id}/like`, { actor: USER_B });
  await W("like again", "PUT", `/v1/layouts/${id}/like`, { actor: USER_B });
  await W("like (bearer)", "PUT", `/v1/layouts/${id}/like`, { bearer: USER_C });
  await W("unlike", "DELETE", `/v1/layouts/${id}/like`, { actor: USER_B });
  await W("unlike again", "DELETE", `/v1/layouts/${id}/like`, { actor: USER_B });
  await W("like back", "PUT", `/v1/layouts/${id}/like`, { actor: USER_B });
  await W("transfer", "POST", `/v1/layouts/${id}/transfer`, { actor: USER_A, json: { to: USER_B }, headers: { "If-Match": '"layout:2"' } });
  await W("transfer (unknown user)", "POST", `/v1/layouts/${id}/transfer`, { actor: USER_B, json: { to: "199999999999999999" }, headers: { "If-Match": '"layout:3"' } });
  await W("delete", "DELETE", `/v1/layouts/${id}`, { actor: USER_B, headers: { "If-Match": '"layout:3"' } });
  await W("get tombstone", "GET", `/v1/layouts/${id}?format=spark%2F1`);
  await W("restore", "POST", `/v1/layouts/${id}/restore`, { actor: USER_B, json: {} });
  await W("restore (not deleted)", "POST", `/v1/layouts/${id}/restore`, { actor: USER_B, json: {} });

  // A name reclaimed from a liked tombstone (LDB-P9).
  const two = await W("create two", "POST", "/v1/layouts", { actor: USER_A, json: { name: "lab-p1-two", format: "spark/1", payload } });
  await W("like two", "PUT", `/v1/layouts/${two.json?.id}/like`, { actor: USER_B });
  await W("delete two", "DELETE", `/v1/layouts/${two.json?.id}`, { actor: USER_A, headers: { "If-Match": '"layout:1"' } });
  await W("reclaim two", "POST", "/v1/layouts", { actor: USER_C, json: { name: "lab-p1-two", format: "spark/1", payload } });

  // Link: submit, queue, approve, clear; and a rejection.
  await W("link submit", "PUT", `/v1/layouts/${id}/link`, { actor: USER_B, json: { url: "https://example.com/lab-p1" } });
  await W("link get", "GET", `/v1/layouts/${id}/link`, { actor: USER_B });
  const lq = await W("link queue", "GET", "/v1/admin/link-queue", { actor: ADMIN });
  const linkId = lq.json?.submissions?.[0]?.id;
  await W("link approve", "POST", `/v1/admin/link-queue/${linkId}/approve`, { actor: ADMIN, json: {} });
  await W("link clear", "DELETE", `/v1/layouts/${id}/link`, { actor: USER_B });
  await W("link submit 2", "PUT", `/v1/layouts/${id}/link`, { actor: USER_B, json: { url: "https://example.com/lab-p1-2" } });
  const lq2 = await W("link queue 2", "GET", "/v1/admin/link-queue", { actor: ADMIN });
  await W("link reject", "POST", `/v1/admin/link-queue/${lq2.json?.submissions?.[0]?.id}/reject`, { actor: ADMIN, json: { reason: "lab" } });

  // WPM: submit, receipt, queue, approve, reject, reopen; on-behalf.
  const w1 = await W("wpm submit", "POST", "/v1/wpm", { actor: USER_A, json: { layout: id, wpm: 101, proof: "https://www.youtube.com/watch?v=lab1" } });
  const wid = w1.json?.submission?.id;
  await W("wpm receipt", "GET", `/v1/wpm/submissions/${wid}`, { actor: USER_A });
  await W("wpm receipt (other)", "GET", `/v1/wpm/submissions/${wid}`, { actor: USER_C });
  await W("wpm queue", "GET", "/v1/admin/wpm-queue", { actor: ADMIN });
  await W("wpm approve", "POST", `/v1/admin/wpm-queue/${wid}/approve`, { actor: ADMIN, json: { review_version: 0 } });
  await W("wpm reopen", "POST", `/v1/admin/wpm-queue/${wid}/reopen`, { actor: ADMIN, json: { status: "approved", review_version: 0 } });
  await W("wpm reject", "POST", `/v1/admin/wpm-queue/${wid}/reject`, { actor: ADMIN, json: { reason: "lab", review_version: 1 } });
  await W("wpm history", "GET", `/v1/admin/wpm-queue/${wid}/history`, { actor: ADMIN });
  await W("wpm on behalf", "POST", "/v1/admin/wpm", { actor: ADMIN, json: { user_id: USER_B, layout: id, wpm: 99, proof: "https://www.youtube.com/watch?v=lab2" } });
  await W("wpm records", "GET", `/v1/wpm?layout=${id}`);

  // Comments: submit, approve, like, edit, reject, remove, delete.
  const c1 = await W("comment submit", "PUT", `/v1/layouts/${id}/comment`, { actor: USER_A, json: { body: "lab comment one" } });
  const cid = c1.json?.submission?.id ?? c1.json?.id;
  await W("comment queue", "GET", "/v1/admin/comment-queue", { actor: ADMIN });
  await W("comment approve", "POST", `/v1/admin/comment-queue/${cid}/approve`, { actor: ADMIN, json: { review_version: 0 } });
  await W("comment like", "PUT", `/v1/layouts/${id}/comments/${USER_A}/like`, { actor: USER_C });
  await W("comment like own", "PUT", `/v1/layouts/${id}/comments/${USER_A}/like`, { actor: USER_A });
  await W("comments list", "GET", `/v1/layouts/${id}/comments`, { actor: USER_C });
  await W("own comment", "GET", `/v1/layouts/${id}/comment`, { actor: USER_A });
  await W("my comments", "GET", "/v1/me/comments", { actor: USER_A });
  const c2 = await W("comment edit", "PUT", `/v1/layouts/${id}/comment`, { actor: USER_A, json: { body: "lab comment edited" } });
  await W("comment reject", "POST", `/v1/admin/comment-queue/${c2.json?.submission?.id ?? c2.json?.id}/reject`, { actor: ADMIN, json: { reason: "lab" } });
  await W("comment remove", "POST", `/v1/admin/comments/${cid}/remove`, { actor: ADMIN, json: { reason: "lab" } });
  await W("comment reopen", "POST", `/v1/admin/comment-queue/${cid}/reopen`, { actor: ADMIN, json: { status: "approved", review_version: 0 } });
  await W("comment unlike", "DELETE", `/v1/layouts/${id}/comments/${USER_A}/like`, { actor: USER_C });
  await W("comment submit B", "PUT", `/v1/layouts/${id}/comment`, { actor: USER_B, json: { body: "lab comment b" } });
  await W("comment delete own", "DELETE", `/v1/layouts/${id}/comment`, { actor: USER_B });
  await W("comment counts", "GET", "/v1/comment-counts");

  // Moderation and admin.
  await W("ban", "PUT", `/v1/admin/bans/${USER_C}`, { actor: ADMIN, json: { reason: "lab" } });
  await W("banned write", "PUT", `/v1/layouts/${id}/like`, { actor: USER_C });
  await W("bans", "GET", "/v1/admin/bans", { actor: ADMIN });
  await W("unban", "DELETE", `/v1/admin/bans/${USER_C}`, { actor: ADMIN });
  await W("author rename", "PUT", `/v1/admin/authors/${USER_C}`, { actor: ADMIN, json: { name: "lab-c-renamed" } });
  await W("admins", "GET", "/v1/admin/admins", { actor: ADMIN });
  await W("admin add", "POST", "/v1/admin/admins", { actor: ADMIN, json: { user_id: USER_C, note: "lab" } });
  await W("admin remove", "DELETE", `/v1/admin/admins/${USER_C}`, { actor: ADMIN });
  await W("clients", "GET", "/v1/admin/clients", { actor: ADMIN });
  await W("not admin", "GET", "/v1/admin/clients", { actor: USER_A });
  await W("dump write", "POST", "/v1/admin/dump", { actor: ADMIN, json: {} });
  for (const p of ["/v1/dump", "/v1/dump/latest.json", "/v1/dump/dump-2026-10-25.json.gz"]) await W(`dump read ${p}`, "GET", p);
  await W("nightly tick", "POST", "/v1/admin/nightly/tick", { actor: ADMIN, json: {} });
  await W("unsigned write", "POST", "/v1/layouts", { json: { name: "lab-nope", format: "spark/1", payload } });
  await W("bad signature", "POST", "/v1/layouts", { json: { name: "lab-nope", format: "spark/1", payload }, headers: { "X-Akl-Client": LAB_CLIENT, "X-Akl-Timestamp": "1", "X-Akl-Nonce": "AAAA", "X-Akl-Actor": USER_A, "X-Akl-Signature": "AAAA" } });
  await W("long-poll (signed, wait=1)", "GET", "/v1/changes?since=999999&wait=1", { actor: USER_A });
  return { id };
}

// ---------------------------------------------------------------------------
// Final table state
// ---------------------------------------------------------------------------

function tableState(sqlite) {
  const tables = JSON.parse(sh("sqlite3", ["-json", sqlite, "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%' ORDER BY name"]) || "[]").map((r) => r.name);
  const out = {};
  for (const t of tables) out[t] = sh("sqlite3", ["-json", sqlite, `SELECT * FROM "${t}" ORDER BY rowid`]);
  return out;
}

// ---------------------------------------------------------------------------

let BASE_URL;
let HEAD_URL;

async function main() {
  log(`work dir ${WORK}`);
  const base = checkout("base", args.base);
  const head = checkout("head", args.head);
  log(`base ${args.base} = ${base.sha.slice(0, 9)}, head ${args.head} = ${head.sha.slice(0, 9)}`);
  const lockA = fs.readFileSync(path.join(base.dir, "package-lock.json"));
  const lockB = fs.readFileSync(path.join(head.dir, "package-lock.json"));
  if (!lockA.equals(lockB)) throw new Error("the two commits have different package-lock.json; this tool shares one node_modules");

  const dump = loadDump(args.dump);
  log(`dump: ${dump.records.length} layouts, ${dump.events.length} events (seq ${dump.meta?.seq})`);
  const seedDir = await seed(base, dump);
  const persistA = path.join(WORK, "persist-base");
  const persistB = path.join(WORK, "persist-head");
  for (const d of [persistA, persistB]) {
    if (fs.existsSync(d)) fs.rmSync(d, { recursive: true });
    fs.cpSync(seedDir, d, { recursive: true });
  }

  const [pA, pB, pD] = args.ports;
  const discord = await startFakeDiscord(pD);
  const wA = startWorker(base, persistA, pA, pA + 100, pD, "worker-base");
  const wB = startWorker(head, persistB, pB, pB + 100, pD, "worker-head");
  BASE_URL = `http://127.0.0.1:${pA}`;
  HEAD_URL = `http://127.0.0.1:${pB}`;
  const stop = () => {
    for (const w of [wA, wB]) {
      try {
        process.kill(-w.pid, "SIGTERM");
      } catch {
        // already gone
      }
    }
    discord.close();
  };
  let tables = null;
  try {
    await Promise.all([waitReady(BASE_URL), waitReady(HEAD_URL)]);
    log("both Workers up");
    const t0 = Date.now();
    await crawlReads(dump, "before");
    await writes(dump);
    await crawlReads({ ...dump, records: dump.records.slice(0, 200), layout_revs: [], authors: (dump.authors ?? []).slice(0, 50) }, "after");
    results.seconds = Math.round((Date.now() - t0) / 1000);
  } finally {
    stop();
    await new Promise((r) => setTimeout(r, 3000));
  }
  const stateA = tableState(findSqlite(persistA));
  const stateB = tableState(findSqlite(persistB));
  tables = { compared: Object.keys(stateA).length, differing: [] };
  for (const t of new Set([...Object.keys(stateA), ...Object.keys(stateB)])) {
    if (stateA[t] !== stateB[t]) tables.differing.push({ table: t, base_bytes: stateA[t]?.length ?? null, head_bytes: stateB[t]?.length ?? null, first_diff: firstDiff(Buffer.from(stateA[t] ?? ""), Buffer.from(stateB[t] ?? "")) });
  }

  const report = { base: { rev: args.base, sha: base.sha }, head: { rev: args.head, sha: head.sha }, dump: { source: args.dump, layouts: dump.records.length, seq: dump.meta?.seq ?? null }, requests: results.requests, response_diffs: results.diffs.length, tables, families: results.families, writes: results.writes, diffs: results.diffs.slice(0, 200), seconds: results.seconds };
  fs.writeFileSync(path.join(OUT, "report.json"), JSON.stringify(report, null, 2));
  const ok = results.diffs.length === 0 && tables.differing.length === 0;
  log(`${results.requests} request pairs, ${results.diffs.length} response diffs, ${tables.differing.length}/${tables.compared} tables differ -> ${ok ? "IDENTICAL" : "DIFFERENT"}`);
  log(`report: ${path.join(OUT, "report.json")}`);
  if (!args.keep) {
    for (const n of ["base", "head"]) sh("git", ["-C", REPO, "worktree", "remove", "--force", path.join(WORK, n)]);
  }
  process.exit(ok ? 0 : 1);
}

if (IS_MAIN) {
  main().catch((e) => {
    console.error(e);
    process.exit(2);
  });
}

export { ADMIN, CONTRACT_HEADERS, LAB_APP_ID, LAB_CLIENT, LAB_PUB_RAW, USER_A, USER_B, USER_C, findSqlite, firstDiff, loadDump, sh, signedHeaders, sqlLit, startFakeDiscord, waitReady };
