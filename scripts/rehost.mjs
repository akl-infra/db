#!/usr/bin/env node
// `npm run rehost -- --dump <file|url> [--local|--remote] [--force] [--env preview] [--wipe=akl-db] [--accept-loss]`
// (07-implementation-phase1.md §6 S7; 04-governance.md §4's rehost drill).
// Applies migrations, then restores a dump's full event log into D1 via
// `wrangler d1 execute --file` -- `restoreSql()` (src/store/d1/dump.ts)
// renders the exact SQL text this runs. `--remote` points at the real
// akl-db; this agent proved the flow with `--local` only, against a fresh
// local D1 seeded by `npm run import -- --once --fixture` (README.md's
// rehost procedure covers the `--remote` drill). `--env preview` targets
// the preview environment (09-implementation-phase2.md §3 T7) -- its D1 is
// `akl-db-preview`, a distinct database from production `akl-db`, so both
// the identifier every wrangler call names and `--env preview` itself must
// travel together.
//
// akldb is no longer disposable (docs/decisions/21-formats.md D8, amended
// 2026-09-14) -- a `--remote` run naming no `--env` targets PRODUCTION
// `akl-db` directly, so it gets two extra guards `--local`/`--env preview`
// don't need:
//   1. `--wipe=akl-db` (the literal database name) must be passed, checked
//      BEFORE anything else runs (no dump load, no migrations) -- a typo'd
//      or missing flag refuses loudly instead of silently overwriting prod.
//   2. Before restoring, the live production `/v1/meta` is fetched and its
//      `seq` compared against the dump's own `meta.seq` -- if the live
//      service has moved on since the dump was taken, restoring it would
//      lose real event history. Refused unless `--accept-loss` is passed;
//      both numbers are always printed either way.
//
// Imports `../src/store/d1/dump.ts` directly -- Node 24's native TypeScript
// support strips its (purely erasable) type annotations at load time, no
// build step needed for this plain-Node script.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import url from "node:url";
import zlib from "node:zlib";
import { restoreSql } from "../src/store/d1/dump.ts";

const SCRIPTS_DIR = path.dirname(url.fileURLToPath(import.meta.url));
const DB_ROOT = path.join(SCRIPTS_DIR, "..");
const RESTORE_SQL_PATH = path.join(DB_ROOT, ".rehost-restore.sql");

function parseArgs(argv) {
  const out = {
    dump: null, remote: false, force: false, env: null, wipe: null, acceptLoss: false,
    target: "d1", endpoint: null, mainTable: null, ephemeralTable: null, blobsDir: null,
  };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--target") out.target = argv[++i];
    else if (argv[i] === "--endpoint") out.endpoint = argv[++i];
    else if (argv[i] === "--main-table") out.mainTable = argv[++i];
    else if (argv[i] === "--ephemeral-table") out.ephemeralTable = argv[++i];
    else if (argv[i] === "--blobs") out.blobsDir = argv[++i];
    else if (argv[i] === "--dump") out.dump = argv[++i];
    else if (argv[i] === "--remote") out.remote = true;
    else if (argv[i] === "--local") out.remote = false;
    else if (argv[i] === "--force") out.force = true;
    else if (argv[i] === "--env") out.env = argv[++i];
    else if (argv[i] === "--wipe") out.wipe = argv[++i];
    else if (argv[i].startsWith("--wipe=")) out.wipe = argv[i].slice("--wipe=".length);
    else if (argv[i] === "--accept-loss") out.acceptLoss = true;
  }
  return out;
}

// The production-target guards below (docs/decisions/21-formats.md D8,
// amended 2026-09-14) apply to exactly one combination: `--remote` with no
// `--env` -- that's the only invocation that ever touches production
// `akl-db` (`--local` and `--env preview` are unaffected, and stay exactly
// as they were). Exported so tests/tools/rehost-guard.test.ts can drive
// these decisions directly, with no wrangler/fetch involved.
export function isProductionTarget(remote, env) {
  return remote === true && (env === null || env === undefined);
}

// Guard 1: refused before the dump is even loaded, let alone migrations
// applied -- `wipe` must be the literal database name, not just any truthy
// flag, so this can't be fat-fingered into a no-op.
export function checkWipeFlag(remote, env, wipe) {
  if (!isProductionTarget(remote, env)) return null;
  if (wipe !== "akl-db") {
    return (
      "rehost.mjs: refusing -- a --remote run with no --env targets PRODUCTION 'akl-db' directly. " +
      "Pass --wipe=akl-db to confirm you mean to overwrite it. " +
      "(Would have applied every migration to akl-db and then restored the dump into it.)"
    );
  }
  return null;
}

// Guard 2: refused only when the LIVE service is strictly ahead of the
// dump being restored -- an equal or behind live seq means the dump is at
// least as fresh, nothing to lose. `--accept-loss` overrides.
export function checkSeqLoss(remote, env, liveSeq, dumpSeq, acceptLoss) {
  if (!isProductionTarget(remote, env)) return null;
  if (liveSeq > dumpSeq && !acceptLoss) {
    return (
      `rehost.mjs: refusing -- live akl-db is at seq ${liveSeq}, ahead of this dump's seq ${dumpSeq}. ` +
      `Restoring would lose ${liveSeq - dumpSeq} event(s) of real history. Pass --accept-loss to restore anyway.`
    );
  }
  return null;
}

// `DB_BASE_URL` (same env var `diff-upstream.mjs`/`reseed-magic.mjs` read)
// names the origin; this always appends `/v1/meta`. Defaults to the real
// production origin -- there is no local equivalent to default to, since
// this URL is only ever fetched for the production-target guard above.
export function metaUrlFor(dbBaseUrl) {
  const base = (dbBaseUrl ?? "https://api.akldb.org").replace(/\/+$/, "");
  return `${base}/v1/meta`;
}

async function loadDump(spec) {
  let bytes;
  if (/^https?:\/\//.test(spec)) {
    const res = await fetch(spec);
    if (!res.ok) throw new Error(`GET ${spec} -> ${res.status}`);
    bytes = Buffer.from(await res.arrayBuffer());
  } else {
    bytes = fs.readFileSync(spec);
  }
  const looksGzipped = spec.endsWith(".gz") || (bytes[0] === 0x1f && bytes[1] === 0x8b);
  const json = looksGzipped ? zlib.gunzipSync(bytes) : bytes;
  return JSON.parse(json.toString("utf8"));
}

// `env` is `null` for production (top-level config) or `"preview"` (etc.) to
// pass `--env <env>` through to wrangler -- every call needs it together
// with the matching D1 identifier, or wrangler resolves the wrong (or no)
// database for that environment (09-implementation-phase2.md §3 T7).
function wrangler(args, env) {
  const envFlag = env ? ["--env", env] : [];
  return execFileSync("npx", ["wrangler", ...args, ...envFlag, "--config", "wrangler.toml"], {
    cwd: DB_ROOT,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "inherit"],
  });
}

// `wrangler d1 execute <db> --command "..." --json` prints one JSON array
// (one entry per statement in the command; ours is always a single SELECT).
function d1Query(d1Name, remote, env, sql) {
  const out = wrangler(["d1", "execute", d1Name, remote ? "--remote" : "--local", "--command", sql, "--json"], env);
  const parsed = JSON.parse(out);
  return parsed[0]?.results ?? [];
}


// ---------------------------------------------------------------------------
// `--target ddb`: restore the dump into a LOCAL DynamoDB (design/aws-port.md
// §4.1 `rehost`). No remote exists for this path: `createDocClient` refuses any
// endpoint but 127.0.0.1 unless AKLDB_DDB_ALLOW_REMOTE=1, which this script
// never sets. The same two guards as the D1 path, adapted:
//   1. a store that already holds layouts or events is refused without
//      `--force`, and `--force` also needs `--wipe=<main table name>` (the
//      literal name, checked before anything is read or written);
//   2. the stored HEAD seq is compared with the dump's `meta.seq`; refused when
//      the store is strictly ahead, unless `--accept-loss`.
// A forced restore deletes and recreates both tables first.
// ---------------------------------------------------------------------------

export const DDB_DEFAULT_TABLES = { main: "akldb-main", ephemeral: "akldb-ephemeral" };

export function checkDdbWipeFlag(populated, force, wipe, mainTable) {
  if (!populated) return null;
  if (!force) {
    return `rehost.mjs: refusing -- '${mainTable}' already holds layouts or events. Pass --force --wipe=${mainTable} to delete it and restore over it.`;
  }
  if (wipe !== mainTable) {
    return `rehost.mjs: refusing -- --force needs --wipe=${mainTable} (the literal main table name) to confirm you mean to delete it.`;
  }
  return null;
}

export function checkDdbSeqLoss(populated, storedSeq, dumpSeq, acceptLoss) {
  if (!populated) return null;
  if (storedSeq > dumpSeq && !acceptLoss) {
    return (
      `rehost.mjs: refusing -- the store is at seq ${storedSeq}, ahead of this dump's seq ${dumpSeq}. ` +
      `Restoring would lose ${storedSeq - dumpSeq} event(s) of real history. Pass --accept-loss to restore anyway.`
    );
  }
  return null;
}

// A directory-backed BlobStore, so payloads spilled over 350 KB survive this process.
export function fsBlobs(dir) {
  const file = (key) => path.join(dir, ...key.split("/"));
  return {
    async get(key) {
      let bytes;
      try {
        bytes = fs.readFileSync(file(key));
      } catch (e) {
        if (e.code === "ENOENT") return null;
        throw e;
      }
      return {
        body: new ReadableStream({ start(c) { c.enqueue(new Uint8Array(bytes)); c.close(); } }),
        httpEtag: `"${bytes.length}"`,
        contentType: "application/json",
        size: bytes.length,
      };
    },
    async put(key, body) {
      fs.mkdirSync(path.dirname(file(key)), { recursive: true });
      fs.writeFileSync(file(key), typeof body === "string" ? body : Buffer.from(body));
    },
  };
}

// `lib` is the ddb codec surface (createDocClient, createTables, deleteTables,
// dumpToRows, importRows, hasPrimaryData, runMigrations, exportRows). The CLI
// bundles it with esbuild (Node cannot load the extension-less TS imports);
// tests/ddb/rehost-ddb.test.ts passes the real modules. Returns a summary or
// throws RehostRefusal.
export class RehostRefusal extends Error {}

export async function rehostIntoDdb(opts, lib) {
  const tables = { main: opts.mainTable ?? DDB_DEFAULT_TABLES.main, ephemeral: opts.ephemeralTable ?? DDB_DEFAULT_TABLES.ephemeral };
  const doc = lib.createDocClient({ endpoint: opts.endpoint, region: "us-east-2" });
  const blobs = opts.blobs;
  const ctx = { doc, tables, blobs };
  await lib.createTables(doc, tables);
  const populated = await lib.hasPrimaryData(ctx);
  const wipeRefusal = checkDdbWipeFlag(populated, opts.force === true, opts.wipe ?? null, tables.main);
  if (wipeRefusal) throw new RehostRefusal(wipeRefusal);
  if (populated) {
    const storedSeq = await lib.storedSeq(ctx);
    const seqRefusal = checkDdbSeqLoss(populated, storedSeq, opts.dump.meta.seq, opts.acceptLoss === true);
    if (seqRefusal) throw new RehostRefusal(seqRefusal);
    await lib.deleteTables(doc, tables);
    await lib.createTables(doc, tables);
  }
  const rows = lib.dumpToRows(opts.dump);
  await lib.importRows(ctx, rows);
  const migrated = await lib.runMigrations(ctx);
  const back = await lib.exportRows(ctx);
  return {
    layout_count: back.layouts.filter((r) => r.deleted === 0).length,
    author_count: back.authors.length,
    seq: back.events.reduce((m, r) => Math.max(m, r.seq), 0),
    migrations_ran: migrated.ran,
  };
}

export async function loadDdbLib() {
  const esbuild = await import("esbuild");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rehost-ddb-"));
  const outfile = path.join(dir, "lib.mjs");
  const ddb = path.join(DB_ROOT, "src", "store", "ddb");
  await esbuild.build({
    stdin: {
      contents:
        `export { createDocClient } from ${JSON.stringify(path.join(ddb, "client.ts"))};\n` +
        `export { createTables, deleteTables } from ${JSON.stringify(path.join(ddb, "tables.ts"))};\n` +
        `export { dumpToRows, importRows, hasPrimaryData, exportRows, storedSeq } from ${JSON.stringify(path.join(ddb, "codec.ts"))};\n` +
        `export { runMigrations } from ${JSON.stringify(path.join(ddb, "migrate.ts"))};\n`,
      resolveDir: DB_ROOT,
      loader: "ts",
    },
    bundle: true,
    platform: "node",
    format: "esm",
    outfile,
    packages: "external",
    logLevel: "error",
  });
  return await import(url.pathToFileURL(outfile).href);
}

async function mainDdb(args) {
  const endpoint = args.endpoint ?? process.env.AKLDB_DDB_ENDPOINT ?? `http://127.0.0.1:${process.env.AKLDB_DDB_PORT ?? 8000}`;
  const blobsDir = path.resolve(args.blobsDir ?? path.join(DB_ROOT, ".rehost-blobs"));
  console.log(`rehost.mjs: loading dump from ${args.dump}`);
  const dump = await loadDump(args.dump);
  console.log(`rehost.mjs: --target ddb, endpoint ${endpoint}, blobs ${blobsDir}`);
  const lib = await loadDdbLib();
  try {
    const summary = await rehostIntoDdb({ ...args, endpoint, dump, blobs: fsBlobs(blobsDir) }, lib);
    console.log("rehost.mjs: restored -- /v1/meta-equivalent counts:");
    console.log(JSON.stringify(summary, null, 2));
  } catch (e) {
    if (e instanceof RehostRefusal) {
      console.error(e.message);
      process.exit(1);
    }
    throw e;
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.target === "ddb") {
    if (!args.dump) {
      console.log("usage: npm run rehost -- --target ddb --dump <file|url> [--endpoint http://127.0.0.1:PORT] [--main-table N] [--ephemeral-table N] [--blobs DIR] [--force --wipe=<main table>] [--accept-loss]");
      process.exit(1);
    }
    return mainDdb(args);
  }
  if (args.target !== "d1") {
    console.error(`rehost.mjs: unknown --target '${args.target}' (d1 or ddb)`);
    process.exit(1);
  }
  if (!args.dump) {
    console.log("usage: npm run rehost -- --dump <file|url> [--local|--remote] [--force] [--env preview] [--wipe=akl-db] [--accept-loss]");
    console.log("  (07-implementation-phase1.md §6 S7 / 04-governance.md §4; 09-implementation-phase2.md §3 T7)");
    console.log("  --wipe=akl-db and --accept-loss are required only for a --remote run with no --env (production akl-db).");
    process.exit(1);
  }
  const mode = args.remote ? "--remote" : "--local";
  const d1Name = args.env === "preview" ? "akl-db-preview" : "akl-db";

  // Guard 1 (production only): refused before the dump is loaded or a
  // single migration is applied.
  const wipeRefusal = checkWipeFlag(args.remote, args.env, args.wipe);
  if (wipeRefusal) {
    console.error(wipeRefusal);
    process.exit(1);
  }

  console.log(`rehost.mjs: loading dump from ${args.dump}`);
  const dump = await loadDump(args.dump);
  console.log(
    `rehost.mjs: dump version ${dump.version}, date ${dump.date}, ${dump.records.length} records, ${dump.events.length} events`,
  );

  console.log(`rehost.mjs: applying migrations (${mode}${args.env ? `, env ${args.env}` : ""})`);
  wrangler(["d1", "migrations", "apply", d1Name, mode], args.env);

  const existing = d1Query(d1Name, args.remote, args.env, "SELECT COUNT(*) AS n FROM layouts");
  const existingCount = existing[0]?.n ?? 0;
  if (existingCount > 0 && !args.force) {
    console.error(
      `rehost.mjs: refusing -- 'layouts' (${mode}) already has ${existingCount} row(s). Pass --force to restore over it anyway.`,
    );
    process.exit(1);
  }

  // Guard 2 (production only): compare the LIVE service's seq against the
  // dump's own meta.seq before restoring -- printed either way, whether or
  // not it ends up refusing.
  if (isProductionTarget(args.remote, args.env)) {
    const metaUrl = metaUrlFor(process.env.DB_BASE_URL);
    console.log(`rehost.mjs: checking live seq before restoring production akl-db (${metaUrl})`);
    const metaRes = await fetch(metaUrl);
    if (!metaRes.ok) throw new Error(`GET ${metaUrl} -> ${metaRes.status}`);
    const liveMeta = await metaRes.json();
    const liveSeq = liveMeta.seq;
    const dumpSeq = dump.meta.seq;
    console.log(`rehost.mjs: live seq=${liveSeq} dump seq=${dumpSeq}`);
    const seqRefusal = checkSeqLoss(args.remote, args.env, liveSeq, dumpSeq, args.acceptLoss);
    if (seqRefusal) {
      console.error(seqRefusal);
      process.exit(1);
    }
  }

  const statements = restoreSql(dump);
  fs.writeFileSync(RESTORE_SQL_PATH, statements.join(";\n") + ";\n");
  console.log(`rehost.mjs: wrote ${statements.length} statements to ${path.relative(DB_ROOT, RESTORE_SQL_PATH)}`);

  try {
    console.log(`rehost.mjs: restoring (${mode})`);
    wrangler(["d1", "execute", d1Name, mode, "--file", path.relative(DB_ROOT, RESTORE_SQL_PATH)], args.env);
  } finally {
    fs.rmSync(RESTORE_SQL_PATH, { force: true });
  }

  const [layoutRow] = d1Query(d1Name, args.remote, args.env, "SELECT COUNT(*) AS n FROM layouts WHERE deleted = 0");
  const [authorRow] = d1Query(d1Name, args.remote, args.env, "SELECT COUNT(*) AS n FROM authors");
  const [eventRow] = d1Query(d1Name, args.remote, args.env, "SELECT MAX(seq) AS seq FROM events");
  console.log("rehost.mjs: restored -- /v1/meta-equivalent counts:");
  console.log(
    JSON.stringify({ layout_count: layoutRow?.n ?? 0, author_count: authorRow?.n ?? 0, seq: eventRow?.seq ?? 0 }, null, 2),
  );
}

// Guarded so tests/tools/rehost-guard.test.ts can import this module for
// its exported pure functions without running the CLI (same convention
// scripts/reseed-magic.mjs's own `main()` guard uses).
if (process.argv[1] && import.meta.url === url.pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
