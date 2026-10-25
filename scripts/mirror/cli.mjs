// Shared by reseed.mjs and daily-proof.mjs: bundle scripts/mirror/ops.ts (the TypeScript sources use extensionless imports plain Node
// cannot load) and build the DynamoDB context, queue and store from the common flags. Nothing here touches AWS unless
// AKLDB_DDB_ALLOW_REMOTE=1 is set by the main session (aws-vault exec akldb); otherwise only DynamoDB Local on 127.0.0.1 is reachable.
import { build } from "esbuild";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import url from "node:url";

const REPO = path.resolve(path.dirname(url.fileURLToPath(import.meta.url)), "..", "..");

export function parseArgs(argv, spec) {
  const a = { ...spec.defaults };
  const rest = [];
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    if (!k.startsWith("--")) {
      rest.push(k);
      continue;
    }
    const name = k.slice(2);
    if (!(name in spec.flags)) throw new Error(`unknown argument ${k}`);
    const kind = spec.flags[name];
    a[name] = kind === "bool" ? true : kind === "number" ? Number(argv[++i]) : argv[++i];
  }
  return { ...a, _: rest };
}

export async function loadOps() {
  const entry = path.join(os.tmpdir(), `akldb-mirror-ops-${process.pid}.ts`);
  const out = path.join(REPO, "node_modules/.cache", `mirror-ops-${process.pid}.mjs`);
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(
    entry,
    [
      `export * from ${JSON.stringify(path.join(REPO, "scripts/mirror/ops.ts"))};`,
      `export { runApplier, emfMetrics } from ${JSON.stringify(path.join(REPO, "src/mirror/apply.ts"))};`,
      `export { createKvQueue } from ${JSON.stringify(path.join(REPO, "src/mirror/queue.ts"))};`,
      `export { ddbKv } from ${JSON.stringify(path.join(REPO, "src/mirror/kv-ddb.ts"))};`,
      `export { createDdbStore } from ${JSON.stringify(path.join(REPO, "src/store/ddb/index.ts"))};`,
      `export { createDocClient } from ${JSON.stringify(path.join(REPO, "src/store/ddb/client.ts"))};`,
    ].join("\n"),
  );
  await build({ entryPoints: [entry], outfile: out, bundle: true, platform: "node", format: "esm", target: "node24", external: ["@aws-sdk/*"], absWorkingDir: REPO, logLevel: "error" });
  fs.rmSync(entry, { force: true });
  const ops = await import(url.pathToFileURL(out).href);
  process.on("exit", () => fs.rmSync(out, { force: true }));
  return ops;
}

/** Context, store and queue from --endpoint/--region/--main/--ephemeral/--direction/--blobs-module. */
export async function connect(ops, a) {
  const doc = ops.createDocClient({ endpoint: a.endpoint || undefined, region: a.region });
  let blobs;
  if (a["blobs-module"]) blobs = await (await import(url.pathToFileURL(path.resolve(a["blobs-module"])).href)).default();
  else {
    const m = new Map(); // lab default: in memory (a record over 250 KB or a payload spill is then lost; production passes the S3 module)
    blobs = {
      async get(k) {
        const v = m.get(k);
        return v === undefined ? null : { body: new Response(v).body, httpEtag: '"x"', contentType: "application/json", size: v.length };
      },
      async put(k, b) {
        m.set(k, typeof b === "string" ? b : Buffer.from(b));
      },
    };
  }
  const tables = { main: a.main, ephemeral: a.ephemeral };
  const ctx = { doc, tables, blobs };
  const queue = ops.createKvQueue(ops.ddbKv({ doc, table: tables.ephemeral, direction: a.direction, blobs }), a.direction);
  const store = ops.createDdbStore({ doc, tables, blobs });
  const applyDeps = { store, queue, nowMs: () => Date.now(), log: (l) => console.log(JSON.stringify(l)), metrics: ops.emfMetrics(a.direction) };
  return { ctx, queue, store, applyDeps };
}

/** Every table of a D1 sqlite export as { table: rows[] }, D1-shaped. */
export function readSqliteRows(file) {
  const sh = (sql) => execFileSync("sqlite3", ["-readonly", "-json", file, sql], { encoding: "utf8", maxBuffer: 1 << 30 });
  const names = JSON.parse(sh("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name") || "[]").map((r) => r.name).filter((n) => !/^(sqlite_|_cf_|d1_migrations$)/.test(n));
  const out = {};
  for (const t of names) out[t] = JSON.parse(sh(`SELECT * FROM "${t}"`) || "[]");
  return out;
}

export function readRows(file) {
  return file.endsWith(".json") ? JSON.parse(fs.readFileSync(file, "utf8")) : readSqliteRows(file);
}

export const COMMON = {
  defaults: { endpoint: "http://127.0.0.1:18531", region: "us-east-2", main: "", ephemeral: "", direction: "d1->ddb", "blobs-module": "" },
  flags: { endpoint: "string", region: "string", main: "string", ephemeral: "string", direction: "string", "blobs-module": "string" },
};
