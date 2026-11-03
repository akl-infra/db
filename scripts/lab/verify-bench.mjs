#!/usr/bin/env node
// How long does the cutover's `verify` step take on akldb's real size? A script, not a test. Self-contained: it builds a synthetic database
// from the repo's migrations (about 44 MB, 33 tables, 4.9k layouts, ~50k events) and runs the REAL proof code (scripts/cutover/checksum.mjs)
// against it twice:
//   local   proveAll over node:sqlite (what the image side costs)
//   remote  proveAllBatched through a fake REST endpoint: it counts the calls and the bytes the D1 REST API would have to carry, and times
//           the node-side work (JSON parse stand-in, canonicalisation, sha256). It does NOT time the network: the projection below does.
// Projection for D1 over REST: calls x per-call latency / concurrency (70-150 ms measured by the study), plus bytes / bandwidth (assumed
// 10-40 MB/s from a Mac to Cloudflare's API), plus the node-side work measured here. Run:  node scripts/lab/verify-bench.mjs [--mb 44]
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import url from "node:url";
import { DatabaseSync } from "node:sqlite";
import { localSelect, proveAll, proveAllBatched } from "../cutover/checksum.mjs";

const ROOT = path.join(path.dirname(url.fileURLToPath(import.meta.url)), "..", "..");
const arg = (n, d) => (process.argv.includes(`--${n}`) ? Number(process.argv[process.argv.indexOf(`--${n}`) + 1]) : d);
const MB = arg("mb", 44);
let seed = 0x9e3779b9;
const rnd = () => ((seed = (seed + 0x6d2b79f5) >>> 0), ((Math.imul((seed ^ (seed >>> 15)) >>> 0, seed | 1) ^ (seed >>> 7)) >>> 0) / 4294967296);
const pick = (xs) => xs[Math.floor(rnd() * xs.length)];
const WORDS = "alpha beta gamma delta colemak dvorak qwerty ortho stagger split ergo thumb pinky ring middle index home row angle wide cut magic rolls alt".split(" ");
const B32 = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const ulid = () => Array.from({ length: 26 }, () => B32[Math.floor(rnd() * 32)]).join("");
const snow = () => String(1e17 + Math.floor(rnd() * 9e17));
const iso = (d) => new Date(Date.UTC(2025, 0, 1) + d * 86_400_000 + Math.floor(rnd() * 86_400_000)).toISOString();
const payload = () => {
  const keys = {};
  for (const c of "abcdefghijklmnopqrstuvwxyz,./;'") keys[c] = { x: +(rnd() * 14).toFixed(4), y: +(rnd() * 4).toFixed(4), finger: Math.floor(rnd() * 8), effort: +rnd().toFixed(6) };
  return JSON.stringify({ name: pick(WORDS), keys, notes: crypto.randomBytes(20).toString("hex") });
};

function build() {
  const db = new DatabaseSync(":memory:", { enableForeignKeyConstraints: true });
  const dir = path.join(ROOT, "migrations");
  for (const f of fs.readdirSync(dir).filter((x) => x.endsWith(".sql")).sort()) db.exec(fs.readFileSync(path.join(dir, f), "utf8"));
  const size = () => db.prepare("PRAGMA page_count").get().page_count * db.prepare("PRAGMA page_size").get().page_size;
  const owners = Array.from({ length: 900 }, snow);
  const ins = {
    author: db.prepare("INSERT OR IGNORE INTO authors (user_id, name, first_seen_at, last_seen_at, name_source) VALUES (?, ?, ?, ?, 'discord')"),
    layout: db.prepare("INSERT INTO layouts (id, name, owner, n, layout_rev, created_at, modified_at, deleted, like_count) VALUES (?, ?, ?, 1, 1, ?, ?, 0, ?)"),
    format: db.prepare("INSERT INTO layout_formats (layout_id, lineage, format, rev, created_at, modified_at, payload_json, has_magic) VALUES (?, 'spark', 'spark/1', 1, ?, ?, ?, 0)"),
    rev: db.prepare("INSERT INTO layout_revs (layout_id, n, lineage, rev, event_seq, format, payload_json) VALUES (?, ?, ?, ?, ?, ?, ?)"),
    event: db.prepare("INSERT INTO events (at, kind, layout_id, name, owner, format, rev, actor, via, admin, detail_json, before_json, after_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'discord', 0, ?, ?, ?)"),
    like: db.prepare("INSERT OR IGNORE INTO likes (layout_id, user_id, at, via) VALUES (?, ?, ?, 'discord')"),
  };
  db.exec("BEGIN");
  for (const o of owners) ins.author.run(o, pick(WORDS) + Math.floor(rnd() * 1e4), iso(0), iso(300));
  let layouts = 0;
  let events = 0;
  const EVENTS = 50_000;
  while (layouts < 4900) {
    const id = ulid();
    const name = `${pick(WORDS)}-${pick(WORDS)}-${layouts}`;
    const owner = pick(owners);
    const at = iso(Math.floor(rnd() * 400));
    const likesN = Math.floor(rnd() * 10);
    ins.layout.run(id, name, owner, at, at, likesN);
    ins.format.run(id, at, at, payload());
    const evs = Math.round((EVENTS / 4900) * (0.5 + rnd()));
    for (let r = 1; r <= evs && events < EVENTS; r++, events++) {
      const e = ins.event.run(at, r === 1 ? "created" : "format_updated", id, name, owner, "spark/1", r, owner, JSON.stringify({ rev: r }), r === 1 ? null : JSON.stringify({ name, owner, rev: r - 1, pad: "p".repeat(120) }), JSON.stringify({ name, owner, rev: r, modified_at: at, source_client: "discord-app:bench", pad: "q".repeat(120) }));
      ins.rev.run(id, r, "spark", r, Number(e.lastInsertRowid), "spark/1", null);
    }
    for (let k = 0; k < likesN; k++) ins.like.run(id, pick(owners), at);
    layouts++;
  }
  db.exec("COMMIT");
  return { db, layouts, events, mb: size() / 1024 / 1024 };
}

const t = (fn) => {
  const t0 = process.hrtime.bigint();
  return fn().then((v) => [v, Number(process.hrtime.bigint() - t0) / 1e6]);
};

const { db, layouts, events, mb } = build();
const tables = db.prepare("SELECT count(*) AS n FROM sqlite_master WHERE type = 'table'").get().n;
console.log(`database: ${mb.toFixed(1)} MB, ${tables} tables, ${layouts} layouts, ${events} events (target ${MB} MB)`);

const [, localMs] = await t(() => proveAll({ select: localSelect(db), db, pageRows: 500 }));
console.log(`local proveAll (500-row pages): ${localMs.toFixed(0)} ms`);

let bytes = 0;
let calls = 0;
const asRest = (sql) => {
  const rows = localSelect(db)(sql).map((r) => Object.fromEntries(Object.entries(r).map(([k, v]) => [k, typeof v === "bigint" ? Number(v) : v instanceof Uint8Array ? Array.from(v) : v])));
  bytes += JSON.stringify(rows).length;
  return rows;
};
const stats = {};
const [, batchedMs] = await t(() =>
  proveAllBatched({
    select: async (sql) => (calls++, asRest(sql)),
    selectMany: async (sqls) => (calls++, sqls.map(asRest)),
    db,
    pageRows: 2000,
    targetPageBytes: 3_000_000,
    concurrency: 4,
    stats,
  }),
);
console.log(`remote-shaped proveAllBatched: ${batchedMs.toFixed(0)} ms of node-side work, ${calls} calls, ${(bytes / 1e6).toFixed(1)} MB of JSON`);
for (const l of stats.log) console.log(`  ${l}`);
console.log("\nprojection (D1 REST, concurrency 4):");
console.log("  per-call latency  bandwidth    network      + node work   = verify (D1 side)");
for (const lat of [70, 150]) {
  for (const bw of [10, 40]) {
    const net = (calls * lat) / 4 + (bytes / 1e6 / bw) * 1000;
    console.log(`  ${String(lat).padStart(4)} ms          ${String(bw).padStart(3)} MB/s   ${(net / 1000).toFixed(1).padStart(6)} s   ${(batchedMs / 1000).toFixed(1).padStart(6)} s   = ${((net + batchedMs) / 1000).toFixed(1)} s   (+ ${(localMs / 1000).toFixed(1)} s for the image side, overlappable)`);
  }
}
