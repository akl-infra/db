// Local akldb for the stress harness: a fake Discord (GET /api/oauth2/@me, token "t<digits>" is user <digits>)
// plus `wrangler dev` on a FRESH local D1 + R2 under --state <dir>. Never touches a remote: wrangler dev is
// local-only and the child gets a scrubbed environment (no Cloudflare credentials).
//   node scripts/stress/serve.mjs --state <dir> [--port 4246] [--discord-port 4247]
// Prints "READY pid=<wrangler pid>"; stop it with SIGTERM to this process (it kills its own children by PID).
import { spawn, spawnSync } from "node:child_process";
import { createServer } from "node:http";
import { rmSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";

const arg = (k, d) => { const i = process.argv.indexOf(`--${k}`); return i < 0 ? d : process.argv[i + 1]; };
const state = resolve(arg("state", ""));
if (!arg("state")) { console.error("--state <dir> required"); process.exit(2); }
const port = Number(arg("port", "4246"));
const dport = Number(arg("discord-port", "4247"));
const root = resolve(import.meta.dirname, "../..");
const keep = process.argv.includes("--keep");
if (!keep) rmSync(state, { recursive: true, force: true });
mkdirSync(state, { recursive: true });

const discord = createServer((req, res) => {
  const m = /^Bearer t(\d{17,20})$/.exec(req.headers.authorization ?? "");
  if (!req.url.endsWith("/oauth2/@me") || !m) { res.writeHead(401).end("{}"); return; }
  res.writeHead(200, { "content-type": "application/json" });
  res.end(JSON.stringify({ application: { id: "stress-app" }, scopes: ["identify"], expires: "2099-01-01T00:00:00.000Z", user: { id: m[1], username: `u${m[1]}`, global_name: null } }));
});
discord.listen(dport, "127.0.0.1");

const env = { PATH: process.env.PATH, HOME: process.env.HOME, TMPDIR: process.env.TMPDIR, CI: "1", WRANGLER_SEND_METRICS: "false" };
const wr = (a) => ["node_modules/.bin/wrangler", ...a];
const mig = spawnSync(wr(["d1", "migrations", "apply", "akl-db", "--local", "--persist-to", state, "--config", "wrangler.toml"])[0],
  wr(["d1", "migrations", "apply", "akl-db", "--local", "--persist-to", state, "--config", "wrangler.toml"]).slice(1), { cwd: root, env, encoding: "utf8" });
if (mig.status !== 0) { console.error(mig.stdout, mig.stderr); process.exit(1); }
const child = spawn(wr([])[0], ["dev", "--config", "wrangler.toml", "--local", "--ip", "127.0.0.1", "--port", String(port), "--persist-to", state,
  "--var", `DISCORD_API_URL:http://127.0.0.1:${dport}/api`], { cwd: root, env, stdio: ["ignore", "pipe", "pipe"] });
let ready = false;
const onData = (b) => { const s = b.toString(); if (!ready && /Ready on/.test(s)) { ready = true; console.log(`READY pid=${child.pid} url=http://127.0.0.1:${port}`); } };
child.stdout.on("data", onData); child.stderr.on("data", onData);
const stop = () => { try { child.kill("SIGTERM"); } catch {} discord.close(); setTimeout(() => process.exit(0), 500); };
process.on("SIGTERM", stop); process.on("SIGINT", stop);
child.on("exit", (c) => { console.log(`wrangler exited ${c}`); process.exit(c ?? 1); });
