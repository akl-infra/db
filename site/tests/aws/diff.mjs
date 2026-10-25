#!/usr/bin/env node
// The local site diff (design/aws-port.md §3a, LDB-SITE9): the Worker under
// `wrangler dev` against the Lambda entry on 127.0.0.1, same requests, same
// fake upstream. Everything talks to 127.0.0.1; nothing reaches Cloudflare,
// AWS, Discord or akldb.
//
//   npm run build && node tests/aws/diff.mjs
//
// Ports: 18511 wrangler dev (the Worker), 18512 the Lambda adapter (the
// CloudFront emulation: host function, SPA-fallback function, static files),
// 18513 the fake Discord + fake akldb.
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";
import { HOST_FUNCTION_SOURCE, manifestOf, spaFallbackSource } from "../../aws/cf-functions.mjs";
import { handleEvent } from "../../server/lambda.ts";

const SITE = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const DIST = join(SITE, "dist");
const [WORKER_PORT, LAMBDA_PORT, FAKE_PORT] = [18511, 18512, 18513];
const ORIGIN_SECRET = "diff-origin-secret-0123456789";
const VIEWER_HOST = "next.akldb.org";
const env = {
  DB_BASE_URL: `http://127.0.0.1:${FAKE_PORT}`,
  SITE_NAME: "akldb",
  DISCORD_AUTHORIZE_URL: `http://127.0.0.1:${FAKE_PORT}/oauth2/authorize`,
  DISCORD_TOKEN_URL: `http://127.0.0.1:${FAKE_PORT}/oauth2/token`,
  DISCORD_CLIENT_ID: "diff-client",
  DISCORD_CLIENT_SECRET: "diff-secret",
  SESSION_SECRET: "diff-session-secret",
};

if (!existsSync(join(DIST, "index.html"))) throw new Error("run `npm run build` first");

// --- the fake Discord + akldb --------------------------------------------------
const fake = createServer(async (req, res) => {
  const url = new URL(req.url, "http://x");
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const body = Buffer.concat(chunks).toString();
  const json = (status, obj, extra = {}) => {
    res.writeHead(status, { "content-type": "application/json", ...extra });
    res.end(JSON.stringify(obj));
  };
  if (url.pathname === "/oauth2/token") return json(200, { access_token: "tok-good", expires_in: 3600 });
  if (url.pathname === "/v1/me") {
    if (req.headers.authorization === "Bearer tok-good") return json(200, { user_id: "u1", name: "Ann", via: "discord", admin: false });
    return json(401, { error: "token_invalid" });
  }
  if (url.pathname === "/v1/layouts") {
    if (req.method === "POST") {
      return json(
        201,
        { echo: body.length > 100 ? body.length : body, ct: req.headers["content-type"], ua: req.headers["user-agent"], auth: req.headers.authorization ?? null, xakl: req.headers["x-akl-secret"] ?? null },
        { etag: '"v1"', "set-cookie": "leak=1", "www-authenticate": "Bearer" },
      );
    }
    return json(200, { q: url.search, auth: req.headers.authorization ?? null, cookie: req.headers.cookie ?? null }, { etag: '"v2"', "cache-control": "public, max-age=30", "set-cookie": "leak=1", "x-wait-ignored": "1" });
  }
  if (url.pathname === "/v1/secure") return json(401, { error: "token_invalid" });
  json(404, { error: "not_found" });
}).listen(FAKE_PORT, "127.0.0.1");

// --- the Lambda adapter: CloudFront in front of the handler --------------------
const manifest = await manifestOf(DIST);
const load = (src) => { const c = {}; vm.runInNewContext(src, c); return c.handler; };
const spaFn = load(spaFallbackSource(manifest));
const hostFn = load(HOST_FUNCTION_SOURCE);
const FORWARD = ["x-requested-with", "sec-fetch-site", "content-type", "accept", "if-match", "if-none-match", "idempotency-key"];
const MIME = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".md": "text/markdown; charset=utf-8", ".svg": "image/svg+xml", ".json": "application/json", ".png": "image/png", ".ico": "image/x-icon", ".txt": "text/plain; charset=utf-8" };

const lambda = createServer(async (req, res) => {
  const url = new URL(req.url, "http://x");
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const dynamic = url.pathname.startsWith("/auth/") || url.pathname.startsWith("/api/");
  if (!dynamic) {
    const r = spaFn({ request: { uri: url.pathname, headers: {} } });
    if (r.statusCode) { res.writeHead(r.statusCode, { location: r.headers.location.value }); return res.end(); }
    const ext = r.uri.slice(r.uri.lastIndexOf("."));
    if (r.statusCode) { res.writeHead(r.statusCode, { location: r.headers.location.value }); return res.end(); }
    res.writeHead(200, { "content-type": MIME[ext] ?? "application/octet-stream", "cache-control": "public, max-age=0, must-revalidate" });
    return res.end(readFileSync(join(DIST, r.uri)));
  }
  const viewer = { uri: url.pathname, headers: { host: { value: req.headers.host } } };
  const after = hostFn({ request: viewer });
  const headers = { "x-origin-verify": ORIGIN_SECRET, "x-forwarded-host": after.headers["x-forwarded-host"].value, host: "abc.lambda-url.us-east-2.on.aws" };
  for (const n of FORWARD) if (req.headers[n] !== undefined) headers[n] = req.headers[n];
  const event = {
    rawPath: url.pathname,
    rawQueryString: url.search.slice(1),
    cookies: req.headers.cookie ? req.headers.cookie.split("; ") : undefined,
    headers,
    body: chunks.length ? Buffer.concat(chunks).toString("base64") : undefined,
    isBase64Encoded: chunks.length > 0,
    requestContext: { http: { method: req.method } },
  };
  const out = await handleEvent(event, { originVerify: ORIGIN_SECRET, env });
  const h = { ...out.headers };
  if (out.cookies) h["set-cookie"] = out.cookies;
  res.writeHead(out.statusCode, h);
  res.end(Buffer.from(out.body, "base64"));
}).listen(LAMBDA_PORT, "127.0.0.1");

// --- wrangler dev ---------------------------------------------------------------
const dir = mkdtempSync(join(tmpdir(), "site-diff-"));
writeFileSync(
  join(dir, "wrangler.toml"),
  `name = "akldb-site-diff"
main = "${SITE}/server/workers.ts"
compatibility_date = "2026-08-22"
compatibility_flags = ["nodejs_compat"]
[assets]
directory = "${DIST}"
binding = "ASSETS"
not_found_handling = "single-page-application"
run_worker_first = ["/auth/*", "/api/*"]
[vars]
${Object.entries(env).map(([k, v]) => `${k} = "${v}"`).join("\n")}
`,
);
const wr = spawn("npx", ["wrangler", "dev", "--config", join(dir, "wrangler.toml"), "--local", "--port", String(WORKER_PORT), "--ip", "127.0.0.1", "--inspector-port", "0"], {
  cwd: SITE,
  env: { ...process.env, WRANGLER_SEND_METRICS: "false", CI: "1" },
  stdio: ["ignore", "pipe", "pipe"],
});
let wlog = "";
wr.stdout.on("data", (d) => (wlog += d));
wr.stderr.on("data", (d) => (wlog += d));
process.on("exit", () => wr.kill("SIGTERM"));

async function waitReady() {
  for (let i = 0; i < 120; i++) {
    try { if ((await fetch(`http://127.0.0.1:${WORKER_PORT}/auth/me`)).status) return; } catch {}
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error("wrangler dev never came up:\n" + wlog.slice(-2000));
}

// --- the cases ------------------------------------------------------------------
const J = { "content-type": "application/json" };
const CSRF = { "x-requested-with": "akldb", "sec-fetch-site": "same-origin" };
const cases = [
  ["GET", "/auth/me"],
  ["GET", "/auth/login"],
  ["GET", "/auth/callback"],
  ["GET", "/auth/callback?code=x&state=y"],
  ["GET", "/auth/callback?error=access_denied"],
  ["GET", "/auth/nope"],
  ["POST", "/auth/logout"],
  ["POST", "/auth/logout", CSRF],
  ["GET", "/api/v1/layouts?wait=30&x=1"],
  ["GET", "/api/v1/layouts", { cookie: "unrelated=1" }],
  ["POST", "/api/v1/layouts", J, '{"a":1}'],
  ["POST", "/api/v1/layouts", { ...J, ...CSRF, "x-akl-secret": "s" }, '{"a":"é"}'],
  ["POST", "/api/v1/layouts", { ...J, ...CSRF, "sec-fetch-site": "cross-site" }, "{}"],
  ["POST", "/api/v1/layouts", { ...J, ...CSRF }, "x".repeat(4 * 1024 * 1024 + 1)],
  ["GET", "/api/v1/secure"],
  ["GET", "/api/v2/layouts"],
  ["GET", "/api/other"],
  ["GET", "/"],
  ["GET", "/index.html"],
  ["GET", "/l/abc"],
  ["GET", "/changes"],
  ["GET", "/docs"],
  ["GET", "/admin"],
  ["GET", "/adoption.md"],
  ["GET", "/missing.js"],
  ["GET", "/assets/nope-123.css"],
  ...manifest.filter((p) => p.startsWith("/assets/")).slice(0, 4).map((p) => ["GET", p]),
];

async function flow(base) {
  const jar = new Map();
  const absorb = (res) => { for (const c of res.headers.getSetCookie()) { const [kv] = c.split(";"); const i = kv.indexOf("="); jar.set(kv.slice(0, i), kv.slice(i + 1)); } };
  const cookie = () => [...jar].filter(([, v]) => v).map(([k, v]) => `${k}=${v}`).join("; ");
  const call = (path) => fetch(base + path, { redirect: "manual", headers: { host: VIEWER_HOST, ...(jar.size ? { cookie: cookie() } : {}) } });
  const login = await call("/auth/login"); absorb(login);
  const state = new URL(login.headers.get("location")).searchParams.get("state");
  const cb = await call(`/auth/callback?code=c&state=${state}`); absorb(cb);
  const me = await call("/auth/me");
  const api = await call("/api/v1/layouts");
  const good = jar.get("__Host-akldb_session");
  jar.set("__Host-akldb_session", "garbage");
  const meBad = await call("/auth/me");
  jar.set("__Host-akldb_session", good);
  return { login, cb, me, api, meBad };
}

const normalize = (s) => s
  .replace(/https?(:\/\/|%3A%2F%2F)127\.0\.0\.1(:|%3A)1851[12]/g, "https$1next.akldb.org")
  .replace(/state=[0-9a-f-]{36}/g, "state=S")
  .replace(/http:\/\/next\.akldb\.org/g, "https://next.akldb.org")
  .replace(/__Host-akldb_session=[^;]+/g, "__Host-akldb_session=SEALED")
  .replace(/__Host-akldb_oauth_state=[0-9a-f-]{36}/g, "__Host-akldb_oauth_state=S")
  .replace(/Max-Age=\d+/g, "Max-Age=N");
const KEEP = ["content-type", "cache-control", // etag: S3 supplies it in production
   "location", "retry-after", "x-wait-ignored", "www-authenticate"];

async function observe(base, [method, path, headers = {}, body]) {
  const res = await fetch(base + path, { method, redirect: "manual", headers: { host: VIEWER_HOST, ...headers }, body });
  const h = {};
  for (const k of KEEP) if (res.headers.has(k)) h[k] = normalize(res.headers.get(k));
  const text = normalize(await res.text());
  return { status: res.status, headers: h, cookies: res.headers.getSetCookie().map(normalize), body: text.length > 4000 ? `len:${text.length}:${text.slice(0, 200)}` : text };
}

async function flowShape(r) {
  return JSON.stringify([r.status, normalize(r.headers.get("location") ?? ""), r.headers.getSetCookie().map(normalize), normalize(await r.text())]);
}

let failed = 0;
try {
  await waitReady();
  const W = `http://127.0.0.1:${WORKER_PORT}`;
  const L = `http://127.0.0.1:${LAMBDA_PORT}`;
  for (const c of cases) {
    const [a, b] = [await observe(W, c), await observe(L, c)];
    if (JSON.stringify(a) === JSON.stringify(b)) console.log(`same ${c[0]} ${c[1]} -> ${a.status}`);
    else { failed++; console.log(`DIFF ${c[0]} ${c[1]}\n  worker: ${JSON.stringify(a)}\n  lambda: ${JSON.stringify(b)}`); }
  }
  const [fw, fl] = [await flow(W), await flow(L)];
  for (const k of Object.keys(fw)) {
    const [a, b] = [await flowShape(fw[k]), await flowShape(fl[k])];
    if (a === b) console.log(`same flow ${k}`);
    else { failed++; console.log(`DIFF flow ${k}\n  worker: ${a}\n  lambda: ${b}`); }
  }
} finally {
  wr.kill("SIGTERM");
  fake.close();
  lambda.close();
}
console.log(failed ? `\n${failed} differences` : "\nno differences");
process.exit(failed ? 1 : 0);
