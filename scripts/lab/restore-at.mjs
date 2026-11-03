#!/usr/bin/env node
// Point-in-time restore by hand (design/aws-a-ops-boot.md): rebuild the database as it was at log seq K from the newest
// verified snapshot at or below K plus the log up to exactly K (restoreAt in src/replica/proof.ts), and write the SQLite image
// to a file. It READS the akldb log table and the data bucket with the credentials in your environment and writes nothing to
// AWS. Open the result with any SQLite (`sqlite3 out.sqlite`) or load it with node:sqlite.
//
//   node scripts/lab/restore-at.mjs --list   --table akldb-prod-log --bucket akldb-prod-data-<account>
//   node scripts/lab/restore-at.mjs --seq K  --table akldb-prod-log --bucket akldb-prod-data-<account> --out /tmp/akldb-at-K.sqlite
//
//   --region  us-east-2 (default)      --list   print the log head, POINTER, PREV and the daily snapshots, then stop
//   credentials: AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY / AWS_SESSION_TOKEN (e.g. `aws-vault exec akldb -- node ...`)
//
// Retention bounds what can be restored: seq K needs a snapshot at or below K and the log from there to K, so K older than the
// oldest retained daily snapshot (about 40 days) is gone. `--seq` below the log's current start is refused with that reason.
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import url from "node:url";

const ROOT = path.join(path.dirname(url.fileURLToPath(import.meta.url)), "..", "..");
const arg = (name) => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
};
const flag = (name) => process.argv.includes(`--${name}`);

if (flag("help") || process.argv.length < 3) {
  console.log(fs.readFileSync(url.fileURLToPath(import.meta.url), "utf8").split("\n").filter((l) => l.startsWith("//")).map((l) => l.slice(3)).join("\n"));
  process.exit(0);
}
const table = arg("table");
const bucket = arg("bucket");
const region = arg("region") ?? "us-east-2";
if (table === undefined || bucket === undefined) {
  console.error("restore-at: --table and --bucket are required (see --help)");
  process.exit(2);
}
for (const k of ["AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY"]) {
  if (!process.env[k]) {
    console.error(`restore-at: ${k} is not set in the environment`);
    process.exit(2);
  }
}

// bundle the replica layer the way scripts/deploy-aws.sh bundles the Lambda (TypeScript, extension-less imports)
const work = path.join(ROOT, "dist", `restore-at-${process.pid}`);
fs.mkdirSync(work, { recursive: true });
try {
  const entry = path.join(work, "entry.ts");
  fs.writeFileSync(
    entry,
    [`export { restoreAt } from ${JSON.stringify(path.join(ROOT, "src/replica/proof.ts"))};`, `export { createDdbLog, createDdbSnapshotState } from ${JSON.stringify(path.join(ROOT, "src/replica/log-ddb.ts"))};`, `export { createS3Objects } from ${JSON.stringify(path.join(ROOT, "src/replica/s3.ts"))};`].join("\n"),
  );
  const out = path.join(work, "restore.mjs");
  const r = spawnSync(path.join(ROOT, "node_modules", ".bin", "esbuild"), [entry, "--bundle", "--platform=node", "--target=node24", "--format=esm", "--external:node:sqlite", `--outfile=${out}`, "--log-level=error"], { encoding: "utf8" });
  if (r.status !== 0) throw new Error(`esbuild failed: ${r.stderr || r.stdout}`);
  const { restoreAt, createDdbLog, createDdbSnapshotState, createS3Objects } = await import(url.pathToFileURL(out).href);

  const credentials = () => ({ accessKeyId: process.env.AWS_ACCESS_KEY_ID, secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY, ...(process.env.AWS_SESSION_TOKEN ? { sessionToken: process.env.AWS_SESSION_TOKEN } : {}) });
  const objects = createS3Objects({ bucket, region, credentials });
  const log = createDdbLog({ table, region, credentials: credentials(), blobs: objects });
  const state = createDdbSnapshotState({ table, region, credentials: credentials() });

  if (flag("list")) {
    const show = (name, r) => console.log(`${name.padEnd(8)} ${r === null ? "(none)" : `seq ${r.seq}  ${r.at}  ${r.key}  ${(r.size / 1048576).toFixed(1)} MB raw${r.day ? `  day ${r.day}` : ""}`}`);
    console.log(`log head ${await log.head()}`);
    show("POINTER", await state.pointer());
    show("PREV", await state.previous());
    for (const d of await state.dailies()) show("DAILY", d);
    console.log(`retention has marked entries through seq ${await state.expiredThrough()} for expiry`);
  } else {
    const seq = Number(arg("seq"));
    const dest = arg("out");
    if (!Number.isInteger(seq) || seq < 1 || dest === undefined) {
      console.error("restore-at: --seq K and --out FILE are required (or --list)");
      process.exit(2);
    }
    const head = await log.head();
    if (seq > head) throw new Error(`seq ${seq} is past the log head ${head}`);
    const { replica, base } = await restoreAt(seq, { log, state, objects, logLine: (m) => console.error(m) });
    const bytes = replica.serialize();
    fs.writeFileSync(dest, bytes);
    console.log(`restored seq ${replica.seq} from ${base === null ? "a replay of the whole log" : `${base.key} (seq ${base.seq})`}: ${dest} (${bytes.byteLength} bytes)`);
    replica.close();
  }
} finally {
  fs.rmSync(work, { recursive: true, force: true });
  try {
    fs.rmdirSync(path.join(ROOT, "dist"));
  } catch {
    // dist/ has other contents
  }
}
