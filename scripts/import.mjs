#!/usr/bin/env node
// `npm run import -- --once [--fixture]` (07 §6 S5, §8): drives ONE cmini
// import tick against the LOCAL D1 (`npm run migrate` first) by starting
// `wrangler dev --test-scheduled` and hitting its `/__scheduled` endpoint --
// the same mechanism `wrangler dev --test-scheduled` + `curl
// "http://localhost:8787/__scheduled?cron=*/5+*+*+*+*"` documented in 07 §8,
// just scripted so it also works offline.
//
// `--fixture`: serves the frozen `tests/fixtures/upstream-100` snapshot from
// a tiny in-process HTTP server and points the dev Worker's
// `IMPORT_SOURCE_URL` var at it (`wrangler dev --var`) for this run only --
// nothing in wrangler.toml changes. Without `--fixture`, the real
// `IMPORT_SOURCE_URL` from wrangler.toml is used (https://clemenpine.com/
// layoutapi/v3 by default): a real tick against the live upstream.
import { spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import url from "node:url";

const SCRIPTS_DIR = path.dirname(url.fileURLToPath(import.meta.url));
const DB_ROOT = path.join(SCRIPTS_DIR, "..");
const FIXTURE_DIR = path.join(DB_ROOT, "tests", "fixtures", "upstream-100");

const args = process.argv.slice(2);
if (!args.includes("--once")) {
  console.log("usage: npm run import -- --once [--fixture]");
  console.log("  (07-implementation-phase1.md §8 -- this is the only mode S5 implements)");
  process.exit(1);
}
const USE_FIXTURE = args.includes("--fixture");

const WRANGLER_PORT = Number(process.env.IMPORT_SCRIPT_WRANGLER_PORT ?? 8787);
const FIXTURE_PORT = Number(process.env.IMPORT_SCRIPT_FIXTURE_PORT ?? 8788);

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

// A flat-route stand-in for clemenpine.com/layoutapi/v3, serving the frozen
// snapshot byte-for-byte (mirrors tests/import/fake-upstream.ts's routing,
// minus the mutation knobs -- this is for a human running it locally, not
// for assertions).
function startFixtureServer(port) {
  const list = readJson(path.join(FIXTURE_DIR, "list.json"));
  const full = readJson(path.join(FIXTURE_DIR, "full.json"));
  const authors = readJson(path.join(FIXTURE_DIR, "authors.json"));
  const nameById = new Map(list.layouts.map((e) => [e.id, e.name]));
  const byName = new Map(full.layouts.map((d) => [d.name, d]));

  const server = http.createServer((req, res) => {
    const u = new URL(req.url ?? "/", `http://127.0.0.1:${port}`);
    res.setHeader("Content-Type", "application/json");
    if (u.pathname === "/meta") {
      res.end(JSON.stringify({ revision: "fixture-1", layout_count: list.layouts.length, author_count: Object.keys(authors).length }));
      return;
    }
    if (u.pathname === "/authors") {
      res.end(JSON.stringify(authors));
      return;
    }
    if (u.pathname === "/layouts" && u.searchParams.get("full") === "1") {
      res.end(JSON.stringify(full));
      return;
    }
    if (u.pathname === "/layouts") {
      res.end(JSON.stringify(list));
      return;
    }
    const m = /^\/layouts\/([^/]+)$/.exec(u.pathname);
    if (m) {
      const id = decodeURIComponent(m[1]);
      const name = nameById.get(id);
      const detail = name !== undefined ? byName.get(name) : undefined;
      if (detail === undefined) {
        res.statusCode = 404;
        res.end(JSON.stringify({ error: "not_found" }));
        return;
      }
      res.end(JSON.stringify(detail));
      return;
    }
    res.statusCode = 404;
    res.end(JSON.stringify({ error: "not_found" }));
  });

  return new Promise((resolve, reject) => {
    server.on("error", reject);
    server.listen(port, "127.0.0.1", () => resolve(server));
  });
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor(urlStr, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let lastErr;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(urlStr);
      if (res.ok) return;
      lastErr = new Error(`${urlStr} -> ${res.status}`);
    } catch (e) {
      lastErr = e;
    }
    await sleep(300);
  }
  throw new Error(`timed out waiting for ${urlStr}: ${lastErr}`);
}

async function main() {
  const children = [];
  const killAll = () => {
    for (const child of children) {
      if (!child.killed) child.kill("SIGTERM");
    }
  };
  process.on("exit", killAll);
  process.on("SIGINT", () => {
    killAll();
    process.exit(130);
  });

  let fixtureServer = null;
  const wranglerArgs = ["dev", "--config", "wrangler.toml", "--test-scheduled", "--port", String(WRANGLER_PORT), "--local"];

  if (USE_FIXTURE) {
    fixtureServer = await startFixtureServer(FIXTURE_PORT);
    wranglerArgs.push("--var", `IMPORT_SOURCE_URL:http://127.0.0.1:${FIXTURE_PORT}`);
    console.log(`import.mjs: serving tests/fixtures/upstream-100 at http://127.0.0.1:${FIXTURE_PORT}`);
  } else {
    console.log("import.mjs: hitting the real upstream (IMPORT_SOURCE_URL from wrangler.toml)");
  }

  console.log(`import.mjs: starting wrangler dev --test-scheduled on port ${WRANGLER_PORT}`);
  const wrangler = spawn("npx", ["wrangler", ...wranglerArgs], {
    cwd: DB_ROOT,
    stdio: ["ignore", "pipe", "pipe"],
  });
  children.push(wrangler);
  wrangler.stdout.on("data", (d) => process.stdout.write(`[wrangler] ${d}`));
  wrangler.stderr.on("data", (d) => process.stderr.write(`[wrangler] ${d}`));

  try {
    await waitFor(`http://127.0.0.1:${WRANGLER_PORT}/v1/meta`, 30_000);

    console.log("import.mjs: triggering one tick via /__scheduled?cron=*/5+*+*+*+*");
    const scheduledRes = await fetch(`http://127.0.0.1:${WRANGLER_PORT}/__scheduled?cron=*/5+*+*+*+*`);
    if (!scheduledRes.ok) throw new Error(`/__scheduled -> ${scheduledRes.status}`);

    // The scheduled handler runs in the background relative to the HTTP
    // response above; give it a moment, then poll /v1/meta for the result.
    await sleep(1000);
    const metaRes = await fetch(`http://127.0.0.1:${WRANGLER_PORT}/v1/meta`);
    const meta = await metaRes.json();
    console.log("import.mjs: /v1/meta after the tick:");
    console.log(JSON.stringify(meta, null, 2));
  } finally {
    killAll();
    if (fixtureServer) await new Promise((resolve) => fixtureServer.close(resolve));
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
