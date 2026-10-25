#!/usr/bin/env node
// `npm run dev`: akldb on DynamoDB Local, no AWS account (design/aws-port.md §6; lane M).
//
//   node scripts/dev.mjs [--port 18501] [--host 127.0.0.1] [--ddb-port 18502]
//     [--seed empty|fixture|<dump file>] [--dir .dev] [--tick-ms 300000] [--prefix akldb-dev]
//     [--ddb http://127.0.0.1:<port>]
//
// Starts DynamoDB Local (the local `amazon/dynamodb-local:latest` image if Docker is up and has
// it, else the jar with Java 21), creates both tables with createTables, seeds them, registers a
// dev client and serves the API on --port (src/platform/node.ts). Port 0 picks a free port.
// --ddb uses a DynamoDB Local that is already running (the process is then not started or stopped).
//
// The jar is looked up in $AKLDB_DDB_JAR_DIR, <dir>/dynamodb-local, <repo>/.dev/dynamodb-local and
// ~/git/akl/handoff/dynamodb-local. Nothing is downloaded. Only 127.0.0.1 is ever reached: the
// document client refuses any other endpoint.
//
// <dir>/client.json keeps the dev client's key between runs; <dir>/dev.json says where the
// running server is (url, endpoint, client id, private key) and is removed on exit. Sign a
// request with scripts/client-sign.mjs (CLIENT_ID, CLIENT_PRIVATE_KEY, OPS_ACTOR from client.json).
import { build } from "esbuild";
import { spawn, spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import url from "node:url";

const REPO = path.resolve(path.dirname(url.fileURLToPath(import.meta.url)), "..");
const IMAGE = "amazon/dynamodb-local:latest";
/** wrangler.toml / migrations 0001: the bootstrap admin, whom the dev client acts as. */
const DEV_ACTOR = "184412255822020608";

function parseArgs(argv) {
  const a = { port: 18501, host: "127.0.0.1", ddbPort: 18502, ddb: null, seed: "empty", dir: path.join(REPO, ".dev"), tickMs: 300_000, prefix: "akldb-dev" };
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    const v = () => {
      if (i + 1 >= argv.length) throw new Error(`${k} needs a value`);
      return argv[++i];
    };
    if (k === "--port") a.port = Number(v());
    else if (k === "--host") a.host = v();
    else if (k === "--ddb-port") a.ddbPort = Number(v());
    else if (k === "--ddb") a.ddb = v();
    else if (k === "--seed") a.seed = v();
    else if (k === "--dir") a.dir = path.resolve(v());
    else if (k === "--tick-ms") a.tickMs = Number(v());
    else if (k === "--prefix") a.prefix = v();
    else throw new Error(`unknown argument ${k}`);
  }
  for (const [n, x] of [["--port", a.port], ["--ddb-port", a.ddbPort], ["--tick-ms", a.tickMs]]) {
    if (!Number.isInteger(x) || x < 0) throw new Error(`${n} must be a non-negative integer`);
  }
  return a;
}

function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.once("error", reject);
    s.listen(0, "127.0.0.1", () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });
}

function listening(port) {
  return new Promise((resolve) => {
    const s = net.connect({ host: "127.0.0.1", port });
    s.once("connect", () => (s.destroy(), resolve(true)));
    s.once("error", () => resolve(false));
  });
}

async function waitDdb(endpoint, ms) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    try {
      await fetch(endpoint, { method: "POST", headers: { "content-type": "application/x-amz-json-1.0", "x-amz-target": "DynamoDB_20120810.ListTables" }, body: "{}" });
      return;
    } catch {
      await new Promise((r) => setTimeout(r, 150));
    }
  }
  throw new Error(`DynamoDB Local did not answer at ${endpoint}`);
}

function dockerReady() {
  if (process.env.AKLDB_DEV_NO_DOCKER === "1") return false; // force the jar path (a test of "Docker stopped")
  if (spawnSync("docker", ["info"], { stdio: "ignore", timeout: 15_000 }).status !== 0) return false;
  return spawnSync("docker", ["image", "inspect", IMAGE], { stdio: "ignore", timeout: 15_000 }).status === 0;
}

function findJarDir(dir) {
  const candidates = [process.env.AKLDB_DDB_JAR_DIR, path.join(dir, "dynamodb-local"), path.join(REPO, ".dev/dynamodb-local"), path.join(os.homedir(), "git/akl/handoff/dynamodb-local")].filter(Boolean);
  return candidates.find((d) => fs.existsSync(path.join(d, "DynamoDBLocal.jar")));
}

/** Start DynamoDB Local on `port`; resolves to { stop }. */
async function startDdb(port, dir) {
  if (dockerReady()) {
    const name = `akldb-ddb-dev-${port}`;
    spawnSync("docker", ["rm", "-f", name], { stdio: "ignore" });
    const r = spawnSync("docker", ["run", "-d", "--rm", "--name", name, "-p", `127.0.0.1:${port}:8000`, IMAGE, "-jar", "DynamoDBLocal.jar", "-inMemory", "-sharedDb"], { encoding: "utf8" });
    if (r.status !== 0) throw new Error(`docker run ${name} failed: ${r.stderr}`);
    return { how: `docker ${name}`, stop: () => void spawnSync("docker", ["stop", "-t", "1", name], { stdio: "ignore" }) };
  }
  const jarDir = findJarDir(dir);
  if (jarDir === undefined) {
    throw new Error(
      "no DynamoDB Local: Docker is not running (or lacks amazon/dynamodb-local:latest) and no DynamoDBLocal.jar was found.\n" +
        "Start Docker, or put the DynamoDB Local download (DynamoDBLocal.jar and DynamoDBLocal_lib/) in .dev/dynamodb-local or $AKLDB_DDB_JAR_DIR (needs Java 21).",
    );
  }
  const child = spawn("java", [`-Djava.library.path=${path.join(jarDir, "DynamoDBLocal_lib")}`, "-jar", path.join(jarDir, "DynamoDBLocal.jar"), "-inMemory", "-sharedDb", "-port", String(port)], { cwd: jarDir, stdio: "ignore" });
  child.once("error", (e) => console.error(`[dev] java failed: ${e.message}`));
  return { how: `jar ${jarDir}`, stop: () => void child.kill() };
}

/** The dev client: a key kept in <dir>/client.json so a restart keeps it. */
function devClient(dir) {
  const file = path.join(dir, "client.json");
  try {
    const c = JSON.parse(fs.readFileSync(file, "utf8"));
    if (typeof c.id === "string" && typeof c.pubkey === "string" && typeof c.privateKey === "string") return c;
  } catch {
    // none yet
  }
  const { publicKey, privateKey } = crypto.generateKeyPairSync("ed25519");
  const c = {
    id: `dev-${crypto.randomBytes(6).toString("hex")}`,
    pubkey: publicKey.export({ format: "jwk" }).x,
    privateKey: privateKey.export({ format: "der", type: "pkcs8" }).toString("base64url"),
    actor: DEV_ACTOR,
  };
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(c, null, 2)}\n`, { mode: 0o600 });
  return c;
}

async function bundleDevServer() {
  const contents = `export { startDevServer } from "./src/platform/node.ts";`;
  const outDir = path.join(REPO, "node_modules", ".cache", "akldb-dev");
  fs.mkdirSync(outDir, { recursive: true });
  const outfile = path.join(outDir, `dev-${crypto.createHash("sha1").update(contents + process.pid).digest("hex").slice(0, 8)}.mjs`);
  await build({
    stdin: { contents, resolveDir: REPO, sourcefile: "dev-main.ts", loader: "ts" },
    outfile,
    bundle: true,
    platform: "node",
    format: "esm",
    target: "node24",
    packages: "external",
    logLevel: "warning",
    sourcemap: "inline",
  });
  return outfile;
}

function loadSeed(seed) {
  if (seed === "empty") return "empty";
  const file = seed === "fixture" ? path.join(REPO, "tests/fixtures/seed-upstream-100.dump.json") : path.resolve(seed);
  return { dump: JSON.parse(fs.readFileSync(file, "utf8")) };
}

const a = parseArgs(process.argv.slice(2));
const seed = loadSeed(a.seed);
fs.mkdirSync(path.join(a.dir, "blobs"), { recursive: true });

let ddb = null;
let endpoint = a.ddb;
if (endpoint === null) {
  const port = a.ddbPort === 0 ? await freePort() : a.ddbPort;
  if (await listening(port)) throw new Error(`127.0.0.1:${port} is taken; pass --ddb http://127.0.0.1:${port} to use what runs there, or another --ddb-port`);
  ddb = await startDdb(port, a.dir);
  endpoint = `http://127.0.0.1:${port}`;
}
const stopDdb = () => ddb?.stop();
process.once("exit", stopDdb);

let server;
const devJson = path.join(a.dir, "dev.json");
const shutdown = async () => {
  try {
    await server?.close();
  } finally {
    fs.rmSync(devJson, { force: true });
    stopDdb();
    process.exit(0);
  }
};
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);

try {
  await waitDdb(endpoint, 60_000);
  const client = devClient(a.dir);
  const bundle = await bundleDevServer();
  const { startDevServer } = await import(url.pathToFileURL(bundle).href);
  fs.rmSync(bundle, { force: true });
  server = await startDevServer({
    repoRoot: REPO,
    endpoint,
    prefix: a.prefix,
    port: a.port === 0 ? await freePort() : a.port,
    host: a.host,
    blobsDir: path.join(a.dir, "blobs"),
    seed,
    client: { id: client.id, pubkey: client.pubkey, ownerUserId: client.actor },
    tickMs: a.tickMs,
  });
  fs.writeFileSync(devJson, `${JSON.stringify({ url: server.url, ddb: endpoint, clientId: client.id, privateKey: client.privateKey, actor: client.actor, pid: process.pid }, null, 2)}\n`, { mode: 0o600 });
  console.log(`[dev] DynamoDB Local ${ddb?.how ?? `at ${endpoint}`}; seed ${a.seed}; tables ${server.tables.main} / ${server.tables.ephemeral}`);
  console.log(`[dev] listening ${server.url}  (client ${client.id} acts as ${client.actor}; key in ${path.join(a.dir, "client.json")})`);
} catch (e) {
  console.error(`[dev] ${e instanceof Error ? e.message : String(e)}`);
  stopDdb();
  process.exit(1);
}
