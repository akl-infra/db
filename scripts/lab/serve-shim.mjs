#!/usr/bin/env node
// The lab server on the D1 shim (design A, phase A): runs the app over a replica and a commit log at a given port,
// with the same `Date`/PRNG overrides as the fuzzer's D1 oracle (scripts/lab/fuzz/d1-lab-entry.ts), keyed on
// x-lab-now / x-lab-seed. See src/platform/node-lab-server.ts for the request path and the /__lab/* control routes
// the fuzzer drives.
//
//   node scripts/lab/serve-shim.mjs --port 18418 [--discord http://127.0.0.1:<p>/api]
//     [--fault-rate 0.2] [--fault-seed 1] [--ddb http://127.0.0.1:18407]
//
// Without --ddb the log is in memory; with it, every reset makes a fresh table on DynamoDB Local (127.0.0.1 only).
// Bundled with esbuild into node_modules/.cache (the TypeScript sources use extensionless imports plain Node cannot load).
import { build } from "esbuild";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import url from "node:url";

const REPO = path.resolve(path.dirname(url.fileURLToPath(import.meta.url)), "..", "..");

function parseArgs(argv) {
  const a = { port: 18418, discord: null, faultRate: 0, faultSeed: 1, ddb: null };
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    const v = () => argv[++i];
    if (k === "--port") a.port = Number(v());
    else if (k === "--discord") a.discord = v();
    else if (k === "--fault-rate") a.faultRate = Number(v());
    else if (k === "--fault-seed") a.faultSeed = Number(v());
    else if (k === "--ddb") a.ddb = v();
    else throw new Error(`unknown argument ${k}`);
  }
  if (a.ddb !== null && !/^http:\/\/127\.0\.0\.1:\d+$/.test(a.ddb)) throw new Error("--ddb must be DynamoDB Local on 127.0.0.1");
  return a;
}

/** Bundle the lab server and return the file. */
export async function bundleLabServer() {
  const contents = [
    `import { startLabServer } from "./src/platform/node-lab-server.ts";`,
    `const cfg = JSON.parse(process.env.AKLDB_LAB_CONFIG);`,
    `const vars = { STREAM_MAX_MS: "500", STREAM_POLL_MS: "20", IMPORT_ENABLED: "on" };`,
    `if (cfg.discord) vars.DISCORD_API_URL = cfg.discord;`,
    `const server = await startLabServer({ port: cfg.port, repoRoot: ${JSON.stringify(REPO)}, vars, faultRate: cfg.faultRate, faultSeed: cfg.faultSeed, log: cfg.ddb ? { ddb: cfg.ddb, tablePrefix: "akldb-shim-" + cfg.port } : "memory" });`,
    `console.log("[serve-shim] listening " + server.url + " log " + (cfg.ddb ?? "memory"));`,
    `const stop = async () => { await server.close(); process.exit(0); };`,
    `process.on("SIGTERM", stop); process.on("SIGINT", stop);`,
  ].join("\n");
  const outDir = path.join(REPO, "node_modules", ".cache", "akldb-lab");
  fs.mkdirSync(outDir, { recursive: true });
  const outfile = path.join(outDir, `serve-shim-${crypto.createHash("sha1").update(contents).update(fs.readFileSync(url.fileURLToPath(import.meta.url))).digest("hex").slice(0, 8)}.mjs`);
  await build({
    stdin: { contents, resolveDir: REPO, sourcefile: "serve-shim-main.ts", loader: "ts" },
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

const isMain = process.argv[1] !== undefined && url.pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;
if (isMain) {
  const a = parseArgs(process.argv.slice(2));
  const file = await bundleLabServer();
  process.env.AKLDB_LAB_CONFIG = JSON.stringify({ port: a.port, discord: a.discord, faultRate: a.faultRate, faultSeed: a.faultSeed, ddb: a.ddb });
  await import(url.pathToFileURL(file).href);
}
