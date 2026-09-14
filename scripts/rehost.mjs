#!/usr/bin/env node
// `npm run rehost -- --dump <file|url> [--local|--remote] [--force] [--env preview] [--wipe=akl-db] [--accept-loss]`
// (07-implementation-phase1.md §6 S7; 04-governance.md §4's rehost drill).
// Applies migrations, then restores a dump's full event log into D1 via
// `wrangler d1 execute --file` -- `restoreSql()` (src/dump/restore.ts)
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
// Imports `../src/dump/restore.ts` directly -- Node 24's native TypeScript
// support strips its (purely erasable) type annotations at load time, no
// build step needed for this plain-Node script.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import url from "node:url";
import zlib from "node:zlib";
import { restoreSql } from "../src/dump/restore.ts";

const SCRIPTS_DIR = path.dirname(url.fileURLToPath(import.meta.url));
const DB_ROOT = path.join(SCRIPTS_DIR, "..");
const RESTORE_SQL_PATH = path.join(DB_ROOT, ".rehost-restore.sql");

function parseArgs(argv) {
  const out = { dump: null, remote: false, force: false, env: null, wipe: null, acceptLoss: false };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--dump") out.dump = argv[++i];
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

async function main() {
  const args = parseArgs(process.argv.slice(2));
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
