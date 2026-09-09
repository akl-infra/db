#!/usr/bin/env node
// db/scripts/drill-restore.mjs -- step 2 of the Fly restore drill
// (design/layout-db/12-implementation-phase5.md §3 X4, LDB-D5): restores
// a (already fetched + integrity-checked, `drill-fetch-dump.mjs`'s job)
// dump into a LOCAL D1 through the real restore code path --
// `restoreSql()` (`../src/dump/restore.ts`), the exact function
// `scripts/rehost.mjs` (the human operator's tool) and `tests/
// rehost.test.ts` (the in-process CI proof) both already go through. This
// is a third, independent caller of that same function -- not a
// re-implementation of it (12 §3 X4's own instruction) -- proving the
// restore actually works end to end via `wrangler d1 execute --local`.
// `wrangler dev --local` (run by `db/drill/run.sh`, step 3) then serves
// this SAME local D1 state (same cwd, same default `.wrangler/state`
// persistence dir) for `drill-verify.mjs` to check over real HTTP.
//
// Deliberately no "refuse if not empty" guard the way `rehost.mjs` has for
// a human operator: the drill's local D1 is a throwaway, freshly
// migrated database every run (a fresh container each day on Fly, or a
// fresh checkout locally) -- `restoreSql()`'s own `DELETE FROM` pass
// (dump/restore.ts) makes re-restoring over it safe either way.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import url from "node:url";
import { restoreSql } from "../src/dump/restore.ts";

const SCRIPTS_DIR = path.dirname(url.fileURLToPath(import.meta.url));
const DB_ROOT = path.join(SCRIPTS_DIR, "..");

function parseArgs(argv) {
  const out = { dump: null, db: "akl-db", sqlOut: path.join(DB_ROOT, ".drill-restore.sql") };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--dump") out.dump = argv[++i];
    else if (argv[i] === "--db") out.db = argv[++i];
    else if (argv[i] === "--sql-out") out.sqlOut = argv[++i];
  }
  return out;
}

// `db` here must be a name declared in wrangler.toml's `[[d1_databases]]`
// (default "akl-db", the top-level binding) -- `wrangler dev --local`
// resolves its local sqlite state from the SAME config, by database id,
// not by an arbitrary string, so an unregistered `--db` would restore
// into state `wrangler dev` never sees.
function wrangler(args) {
  return execFileSync("npx", ["wrangler", ...args, "--config", "wrangler.toml"], {
    cwd: DB_ROOT,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "inherit"],
  });
}

function d1Query(d1Name, sql) {
  const out = wrangler(["d1", "execute", d1Name, "--local", "--command", sql, "--json"]);
  const parsed = JSON.parse(out);
  return parsed[0]?.results ?? [];
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.dump) {
    console.error("usage: node scripts/drill-restore.mjs --dump <path-to-decompressed-dump.json> [--db <name>]");
    process.exit(1);
    return;
  }

  let dump;
  try {
    dump = JSON.parse(fs.readFileSync(args.dump, "utf8"));
  } catch (e) {
    console.log(JSON.stringify({ ok: false, step: "read-dump", path: args.dump, error: String(e) }));
    process.exit(1);
    return;
  }

  try {
    console.error(`drill-restore.mjs: applying migrations to '${args.db}' (--local)`);
    wrangler(["d1", "migrations", "apply", args.db, "--local"]);

    const statements = restoreSql(dump);
    fs.writeFileSync(args.sqlOut, statements.join(";\n") + ";\n");
    try {
      console.error(`drill-restore.mjs: restoring ${statements.length} statement(s) into '${args.db}' (--local)`);
      wrangler(["d1", "execute", args.db, "--local", "--file", path.relative(DB_ROOT, args.sqlOut)]);
    } finally {
      fs.rmSync(args.sqlOut, { force: true });
    }
  } catch (e) {
    console.log(JSON.stringify({ ok: false, step: "restore", error: String(e) }));
    process.exit(1);
    return;
  }

  const [layoutRow] = d1Query(args.db, "SELECT COUNT(*) AS n FROM layouts WHERE deleted = 0");
  const [eventRow] = d1Query(args.db, "SELECT MAX(seq) AS seq FROM events");
  const layout_count = layoutRow?.n ?? 0;
  const seq = eventRow?.seq ?? 0;
  const expected = { layout_count: dump.meta?.layout_count ?? 0, seq: dump.meta?.seq ?? 0 };
  const match = layout_count === expected.layout_count && seq === expected.seq;

  console.log(JSON.stringify({ ok: match, layout_count, seq, expected }));
  if (!match) process.exit(1);
}

main().catch((err) => {
  console.error(err);
  console.log(JSON.stringify({ ok: false, step: "unexpected", error: String(err) }));
  process.exit(1);
});
