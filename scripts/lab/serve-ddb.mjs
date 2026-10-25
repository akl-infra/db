#!/usr/bin/env node
// The lab server on DynamoDB (design/aws-port.md §5.1; lane L): runs the app
// on the DynamoDB store at a given port, with the same `Date`/PRNG overrides
// as p1-crawl-diff.mjs's `.lab-entry.ts`, keyed on x-lab-now / x-lab-seed.
// See src/platform/node-lab-server.ts for the request path and the /__lab/*
// control routes the fuzzer drives.
//
//   node scripts/lab/serve-ddb.mjs --port 18318 --ddb http://127.0.0.1:18307
//     [--prefix akldb-lab-18318] [--discord http://127.0.0.1:<p>/api]
//     [--fault-rate 0.2] [--fault-seed 1] [--keep-tables]
//
// DynamoDB Local only (the document client refuses any other endpoint). The
// server is bundled with esbuild into node_modules/.cache (the TypeScript
// sources use extensionless imports plain Node cannot load). The codec and
// the index checker (lane N) are bundled when src/store/ddb/{codec,checker}.ts
// exist; /__lab/{import,export,check} report 501 or skip the checker without.
import { build } from "esbuild";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import url from "node:url";

const REPO = path.resolve(path.dirname(url.fileURLToPath(import.meta.url)), "..", "..");

function parseArgs(argv) {
  const a = { port: 18318, ddb: "http://127.0.0.1:18307", prefix: null, discord: null, faultRate: 0, faultSeed: 1, keepTables: false };
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    const v = () => argv[++i];
    if (k === "--port") a.port = Number(v());
    else if (k === "--ddb") a.ddb = v();
    else if (k === "--prefix") a.prefix = v();
    else if (k === "--discord") a.discord = v();
    else if (k === "--fault-rate") a.faultRate = Number(v());
    else if (k === "--fault-seed") a.faultSeed = Number(v());
    else if (k === "--keep-tables") a.keepTables = true;
    else throw new Error(`unknown argument ${k}`);
  }
  return a;
}

/** Bundle the lab server (and lane N's modules when present) and return the file. */
export async function bundleLabServer() {
  const has = (f) => fs.existsSync(path.join(REPO, "src/store/ddb", f));
  const lines = [
    `import { startLabServer } from "./src/platform/node-lab-server.ts";`,
    `import { createDocClient } from "./src/store/ddb/client.ts";`,
    `import { createTables, deleteTables } from "./src/store/ddb/tables.ts";`,
  ];
  if (has("codec.ts")) lines.push(`import * as codec from "./src/store/ddb/codec.ts";`);
  if (has("checker.ts")) lines.push(`import * as checker from "./src/store/ddb/checker.ts";`);
  lines.push(
    `const cfg = JSON.parse(process.env.AKLDB_LAB_CONFIG);`,
    `const tables = { main: cfg.prefix + "-main", ephemeral: cfg.prefix + "-eph" };`,
    `if (!cfg.keepTables) {`,
    `  const doc = createDocClient({ endpoint: cfg.ddb, region: "us-east-2" });`,
    `  await deleteTables(doc, tables).catch(() => {});`,
    `  await createTables(doc, tables, { ttl: false });`,
    `}`,
    `const hooks = {`,
    has("codec.ts") ? `  exportRows: codec.exportRows, importRows: codec.importRows,` : ``,
    has("checker.ts") ? `  checkIndexes: checker.checkIndexes,` : ``,
    `};`,
    `const vars = { STREAM_MAX_MS: "500", STREAM_POLL_MS: "20", IMPORT_ENABLED: "on" };`,
    `if (cfg.discord) vars.DISCORD_API_URL = cfg.discord;`,
    `const server = await startLabServer({ port: cfg.port, endpoint: cfg.ddb, tables, repoRoot: ${JSON.stringify(REPO)}, vars, faultRate: cfg.faultRate, faultSeed: cfg.faultSeed }, hooks);`,
    `console.log("[serve-ddb] listening " + server.url + " tables " + tables.main + " / " + tables.ephemeral);`,
    `const stop = async () => { await server.close(); if (!cfg.keepTables) { const doc = createDocClient({ endpoint: cfg.ddb, region: "us-east-2" }); await deleteTables(doc, tables).catch(() => {}); } process.exit(0); };`,
    `process.on("SIGTERM", stop); process.on("SIGINT", stop);`,
  );
  const contents = lines.join("\n");
  const outDir = path.join(REPO, "node_modules", ".cache", "akldb-lab");
  fs.mkdirSync(outDir, { recursive: true });
  const outfile = path.join(outDir, `serve-ddb-${crypto.createHash("sha1").update(contents).digest("hex").slice(0, 8)}.mjs`);
  await build({
    stdin: { contents, resolveDir: REPO, sourcefile: "serve-ddb-main.ts", loader: "ts" },
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
  process.env.AKLDB_LAB_CONFIG = JSON.stringify({ port: a.port, ddb: a.ddb, prefix: a.prefix ?? `akldb-lab-${a.port}`, discord: a.discord, faultRate: a.faultRate, faultSeed: a.faultSeed, keepTables: a.keepTables });
  await import(url.pathToFileURL(file).href);
}
