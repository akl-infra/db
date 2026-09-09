#!/usr/bin/env node
// `npm run rehost -- --dump <file|url> [--local|--remote] [--force]`
// (07-implementation-phase1.md §6 S7; 04-governance.md §4's rehost drill).
// Applies migrations, then restores a dump's full event log into D1 via
// `wrangler d1 execute --file` -- `restoreSql()` (src/dump/restore.ts)
// renders the exact SQL text this runs. `--remote` points at the real
// akl-db; this agent proved the flow with `--local` only, against a fresh
// local D1 seeded by `npm run import -- --once --fixture` (README.md's
// rehost procedure covers the `--remote` drill).
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
const D1_NAME = "akl-db";

function parseArgs(argv) {
  const out = { dump: null, remote: false, force: false };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--dump") out.dump = argv[++i];
    else if (argv[i] === "--remote") out.remote = true;
    else if (argv[i] === "--local") out.remote = false;
    else if (argv[i] === "--force") out.force = true;
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

function wrangler(args) {
  return execFileSync("npx", ["wrangler", ...args, "--config", "wrangler.toml"], {
    cwd: DB_ROOT,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "inherit"],
  });
}

// `wrangler d1 execute <db> --command "..." --json` prints one JSON array
// (one entry per statement in the command; ours is always a single SELECT).
function d1Query(remote, sql) {
  const out = wrangler(["d1", "execute", D1_NAME, remote ? "--remote" : "--local", "--command", sql, "--json"]);
  const parsed = JSON.parse(out);
  return parsed[0]?.results ?? [];
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.dump) {
    console.log("usage: npm run rehost -- --dump <file|url> [--local|--remote] [--force]");
    console.log("  (07-implementation-phase1.md §6 S7 / 04-governance.md §4)");
    process.exit(1);
  }
  const mode = args.remote ? "--remote" : "--local";

  console.log(`rehost.mjs: loading dump from ${args.dump}`);
  const dump = await loadDump(args.dump);
  console.log(
    `rehost.mjs: dump version ${dump.version}, date ${dump.date}, ${dump.records.length} records, ${dump.events.length} events`,
  );

  console.log(`rehost.mjs: applying migrations (${mode})`);
  wrangler(["d1", "migrations", "apply", D1_NAME, mode]);

  const existing = d1Query(args.remote, "SELECT COUNT(*) AS n FROM layouts");
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
    wrangler(["d1", "execute", D1_NAME, mode, "--file", path.relative(DB_ROOT, RESTORE_SQL_PATH)]);
  } finally {
    fs.rmSync(RESTORE_SQL_PATH, { force: true });
  }

  const [layoutRow] = d1Query(args.remote, "SELECT COUNT(*) AS n FROM layouts WHERE deleted = 0");
  const [authorRow] = d1Query(args.remote, "SELECT COUNT(*) AS n FROM authors");
  const [eventRow] = d1Query(args.remote, "SELECT MAX(seq) AS seq FROM events");
  console.log("rehost.mjs: restored -- /v1/meta-equivalent counts:");
  console.log(
    JSON.stringify({ layout_count: layoutRow?.n ?? 0, author_count: authorRow?.n ?? 0, seq: eventRow?.seq ?? 0 }, null, 2),
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
