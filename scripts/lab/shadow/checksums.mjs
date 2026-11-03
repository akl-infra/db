#!/usr/bin/env node
// Nightly checksums, standalone (LDB-PV4): compare the dump-covered tables of two dumps table by table.
//
//   node scripts/lab/shadow/checksums.mjs --a <dump> --b <dump> [--json]
//   <dump> is a local file (.json or .json.gz) or https://api.akldb.org/... / https://shadow-api.akldb.org/... (a dump key,
//   or latest.json, which is followed to the dump it names). At most 2 GETs per URL, User-Agent akldb-shadow-dev/1.
//
// The two dumps must be at the same seq, or the comparison is "skipped" (exit 3): that is not a difference. Exit 0 = every FEED
// table equal (state tables are reported too; they are expected to differ between resyncs), 1 = a feed table differs, 2 = usage.
// This is the same comparison the shadow tick runs at its checkpoint (src/replica/shadow/checksum.ts).
import fs from "node:fs";
import process from "node:process";
import url from "node:url";
import zlib from "node:zlib";
import { loadTs } from "./load-ts.mjs";

const UA = "akldb-shadow-dev/1";
const ALLOWED_HOSTS = new Set(["api.akldb.org", "shadow-api.akldb.org", "staging-api.akldb.org"]);

async function get(u) {
  const res = await fetch(u, { headers: { "user-agent": UA } });
  if (!res.ok) throw new Error(`GET ${u}: ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
}

export async function readDump(spec) {
  let buf;
  if (/^https:\/\//.test(spec)) {
    const u = new URL(spec);
    if (!ALLOWED_HOSTS.has(u.hostname)) throw new Error(`refusing to read ${u.hostname}`);
    buf = await get(spec);
    if (u.pathname.endsWith("/latest.json")) buf = await get(`${u.origin}${JSON.parse(buf.toString("utf8")).url}`);
  } else buf = fs.readFileSync(spec);
  const text = (buf[0] === 0x1f && buf[1] === 0x8b ? zlib.gunzipSync(buf) : buf).toString("utf8");
  return JSON.parse(text);
}

export async function compare(a, b) {
  const { compareDumps, differingTables } = await loadTs("src/replica/shadow/checksum.ts");
  const cmp = compareDumps(a, b);
  return { cmp, differing: differingTables(cmp) };
}

async function main() {
  const arg = (n) => {
    const i = process.argv.indexOf(`--${n}`);
    return i >= 0 ? process.argv[i + 1] : undefined;
  };
  if (arg("a") === undefined || arg("b") === undefined) {
    console.error("usage: checksums.mjs --a <dump> --b <dump> [--json]");
    return 2;
  }
  const [a, b] = [await readDump(arg("a")), await readDump(arg("b"))];
  if (a.meta.seq !== b.meta.seq) {
    console.log(`skipped: the dumps are at different seqs (${a.meta.seq} vs ${b.meta.seq})`);
    return 3;
  }
  const { cmp, differing } = await compare(a, b);
  if (process.argv.includes("--json")) console.log(JSON.stringify({ seq: a.meta.seq, feedEqual: cmp.feedEqual, stateEqual: cmp.stateEqual, differing, tables: cmp.tables }, null, 2));
  else {
    console.log(`seq ${a.meta.seq}: feed tables ${cmp.feedEqual ? "EQUAL" : "DIFFER"}, state tables ${cmp.stateEqual ? "equal" : "differ (expected between resyncs)"}`);
    for (const [k, t] of Object.entries(cmp.tables)) console.log(`  ${t.equal ? "=" : "!"} ${k.padEnd(18)} ${t.class.padEnd(5)} rows ${t.shadowRows} / ${t.publicRows}  ${t.shadowSha.slice(0, 12)} ${t.publicSha.slice(0, 12)}`);
    if (cmp.meta.differing.length > 0) console.log(`  ! meta: ${cmp.meta.differing.join(", ")}`);
  }
  return cmp.feedEqual ? 0 : 1;
}

if (process.argv[1] !== undefined && url.pathToFileURL(process.argv[1]).href === import.meta.url) main().then((c) => process.exit(c), (e) => { console.error(String(e?.message ?? e)); process.exit(2); });
