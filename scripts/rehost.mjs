#!/usr/bin/env node
// `npm run rehost -- --dump <file|url> [--local|--remote] [--force] [--env preview]`
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
// Imports `../src/dump/restore.ts` directly -- Node 24's native TypeScript
// support strips its (purely erasable) type annotations at load time, no
// build step needed for this plain-Node script.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import url from "node:url";
import zlib from "node:zlib";
import { restoreSql } from "../src/dump/restore.ts";

const SCRIPTS_DIR = path.dirname(url.fileURLToPath(import.meta.url));
const DB_ROOT = path.join(SCRIPTS_DIR, "..");
const RESTORE_SQL_PATH = path.join(DB_ROOT, ".rehost-restore.sql");

function parseArgs(argv) {
  const out = { dump: null, remote: false, force: false, env: null };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--dump") out.dump = argv[++i];
    else if (argv[i] === "--remote") out.remote = true;
    else if (argv[i] === "--local") out.remote = false;
    else if (argv[i] === "--force") out.force = true;
    else if (argv[i] === "--env") out.env = argv[++i];
  }
  return out;
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
    console.log("usage: npm run rehost -- --dump <file|url> [--local|--remote] [--force] [--env preview]");
    console.log("  (07-implementation-phase1.md §6 S7 / 04-governance.md §4; 09-implementation-phase2.md §3 T7)");
    process.exit(1);
  }
  const mode = args.remote ? "--remote" : "--local";
  const d1Name = args.env === "preview" ? "akl-db-preview" : "akl-db";

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

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
