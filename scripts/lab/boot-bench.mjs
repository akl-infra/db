#!/usr/bin/env node
// Boot benchmark for design A (phase B): how long does a cold Lambda container spend before it can answer?
// A script, not a test (no wall-clock assertion anywhere in the suite). Self-contained: the database is generated here from
// the repo's real migrations with synthetic rows, so a fresh clone of this community repo can run it with no data and no AWS.
//
//   node scripts/lab/boot-bench.mjs [--mb 44] [--runs 5]
//
// It prints, for a synthetic database of about --mb megabytes (default 44, akldb's size):
//   import      the bundled Lambda host's module-evaluation time, in a fresh Node process each run (esbuild bundle of the same
//               module graph as src/lambda.ts, without that file's top-level call: it would start a boot against AWS)
//               and, for comparison, the time ajv spent compiling the route-body schemas at load (what RP5 removed)
//   zstd-19     the snapshot's compressed size and the compression time (paid by the jobs tick, not by a cold start)
//   decompress  zstd -> raw image
//   deserialize node:sqlite DatabaseSync.deserialize
//   first query a point read joined to its format, and a keyset list page, on the freshly deserialized database
// then the cold-start sum import + decompress + deserialize + first query against the Mac target of 120 ms. On Lambda
// expect roughly 5-7x at 2 GB (measured by the study); the S3 GET (about 50-300 ms with a cold TLS connection) overlaps
// module load and is not in this number.
import { spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import url from "node:url";
import zlib from "node:zlib";
import { DatabaseSync } from "node:sqlite";

const ROOT = path.join(path.dirname(url.fileURLToPath(import.meta.url)), "..", "..");
const arg = (name, dflt) => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? Number(process.argv[i + 1]) : dflt;
};
const TARGET_MB = arg("mb", 44);
const RUNS = arg("runs", 5);
const ms = (ns) => Number(ns) / 1e6;
const median = (xs) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];
const fmt = (xs) => `${median(xs).toFixed(1)} ms (min ${Math.min(...xs).toFixed(1)}, max ${Math.max(...xs).toFixed(1)}, n=${xs.length})`;
const time = (fn) => {
  const t = process.hrtime.bigint();
  const out = fn();
  return [out, ms(process.hrtime.bigint() - t)];
};

// ---- a deterministic PRNG, so two runs build the same database ----
let seed = 0x9e3779b9;
const rnd = () => {
  seed = (seed + 0x6d2b79f5) >>> 0;
  let t = seed;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};
const pick = (xs) => xs[Math.floor(rnd() * xs.length)];
const B32 = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const ulid = () => Array.from({ length: 26 }, () => B32[Math.floor(rnd() * 32)]).join("");
const snowflake = () => String(1e17 + Math.floor(rnd() * 9e17));
const WORDS = "alpha beta gamma delta colemak dvorak qwerty ortho stagger split ergo thumb pinky ring middle index home row angle wide cut magic rolls alt".split(" ");
const iso = (day) => new Date(Date.UTC(2025, 0, 1) + day * 86_400_000 + Math.floor(rnd() * 86_400_000)).toISOString();

/** A spark/1-shaped payload: a key map with coordinates and fingers, plus optional alts/magic. About 3-5 KB of mostly incompressible numbers and names. */
function payload() {
  const keys = {};
  for (const c of "abcdefghijklmnopqrstuvwxyz,./;'") keys[c] = { x: +(rnd() * 14).toFixed(4), y: +(rnd() * 4).toFixed(4), finger: Math.floor(rnd() * 8), effort: +rnd().toFixed(6) };
  const magic = Object.fromEntries(Array.from({ length: Math.floor(rnd() * 12) }, () => [pick("abcdefghijklmnopqrstuvwxyz"), pick(WORDS) + pick(WORDS)]));
  return JSON.stringify({ name: pick(WORDS) + "-" + Math.floor(rnd() * 1e6), keys, magic, notes: Array.from({ length: 4 }, () => pick(WORDS)).join(" ") + " " + crypto.randomBytes(24).toString("hex") });
}

function buildDatabase(targetMb) {
  const db = new DatabaseSync(":memory:", { enableForeignKeyConstraints: true });
  const dir = path.join(ROOT, "migrations");
  for (const f of fs.readdirSync(dir).filter((x) => x.endsWith(".sql")).sort()) db.exec(fs.readFileSync(path.join(dir, f), "utf8"));
  const size = () => db.prepare("PRAGMA page_count").get().page_count * db.prepare("PRAGMA page_size").get().page_size;
  const ins = {
    layout: db.prepare("INSERT INTO layouts (id, name, owner, n, layout_rev, created_at, modified_at, deleted, like_count) VALUES (?, ?, ?, ?, 1, ?, ?, 0, ?)"),
    format: db.prepare("INSERT INTO layout_formats (layout_id, lineage, format, rev, created_at, modified_at, payload_json, has_magic) VALUES (?, 'spark', 'spark/1', ?, ?, ?, ?, ?)"),
    rev: db.prepare("INSERT INTO layout_revs (layout_id, n, lineage, rev, event_seq, format, payload_json) VALUES (?, ?, 'spark', ?, ?, 'spark/1', ?)"),
    event: db.prepare("INSERT INTO events (at, kind, layout_id, name, owner, format, rev, actor, via, admin, detail_json, before_json, after_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'discord', 0, ?, ?, ?)"),
    like: db.prepare("INSERT OR IGNORE INTO likes (layout_id, user_id, at, via) VALUES (?, ?, ?, 'discord')"),
    author: db.prepare("INSERT OR IGNORE INTO authors (user_id, name, first_seen_at, last_seen_at, name_source) VALUES (?, ?, ?, ?, 'discord')"),
  };
  const owners = Array.from({ length: 900 }, snowflake);
  db.exec("BEGIN");
  for (const o of owners) ins.author.run(o, pick(WORDS) + Math.floor(rnd() * 1e4), iso(0), iso(300));
  db.exec("COMMIT");
  const names = [];
  let layouts = 0;
  while (size() < targetMb * 1024 * 1024) {
    db.exec("BEGIN");
    for (let i = 0; i < 250; i++, layouts++) {
      const id = ulid();
      const name = `${pick(WORDS)}-${pick(WORDS)}-${layouts}`;
      const owner = pick(owners);
      const created = iso(Math.floor(rnd() * 400));
      const likesN = Math.floor(rnd() * 24);
      ins.layout.run(id, name, owner, 1, created, created, likesN);
      const revs = 1 + Math.floor(rnd() * 5);
      for (let r = 1; r <= revs; r++) {
        const p = payload();
        const ev = ins.event.run(created, r === 1 ? "created" : "format_updated", id, name, owner, "spark/1", r, owner, JSON.stringify({ rev: r }), r === 1 ? null : JSON.stringify({ name, owner, rev: r - 1, keys: p.length }), JSON.stringify({ name, owner, rev: r, modified_at: created, source_client: "discord-app:bench" }));
        ins.rev.run(id, r, r, Number(ev.lastInsertRowid), p);
        if (r === revs) ins.format.run(id, r, created, created, p, p.length % 3 === 0 ? 1 : 0);
      }
      for (let k = 0; k < likesN; k++) ins.like.run(id, pick(owners), created);
      if (layouts % 17 === 0) names.push(name);
    }
    db.exec("COMMIT");
  }
  return { db, layouts, names };
}

// ---- the import time of the bundled host, one fresh process per run ----
function importTimes(workdir) {
  const entry = path.join(workdir, "entry.ts");
  fs.writeFileSync(
    entry,
    [
      `export * from ${JSON.stringify(path.join(ROOT, "src/platform/lambda.ts"))};`,
      `export * from ${JSON.stringify(path.join(ROOT, "src/replica/log-ddb.ts"))};`,
      `export * from ${JSON.stringify(path.join(ROOT, "src/replica/s3.ts"))};`,
      `export * from ${JSON.stringify(path.join(ROOT, "src/replica/boot.ts"))};`,
    ].join("\n"),
  );
  const bundle = path.join(workdir, "host.mjs");
  const esbuild = path.join(ROOT, "node_modules", ".bin", "esbuild");
  // the flags scripts/deploy-aws.sh uses
  const r = spawnSync(esbuild, [entry, "--bundle", "--platform=node", "--target=node24", "--format=esm", "--minify", "--external:node:sqlite", `--outfile=${bundle}`, "--banner:js=import{createRequire as __cr}from'node:module';const require=__cr(import.meta.url);", "--log-level=error"], { encoding: "utf8" });
  if (r.status !== 0) throw new Error(`esbuild failed: ${r.stderr || r.stdout}`);

  // for comparison: what the same schemas cost when ajv compiles them at module load (the pre-RP5 behaviour)
  const rt = path.join(workdir, "runtime-ajv.ts");
  fs.writeFileSync(rt, `import Ajv2020 from "ajv/dist/2020.js";\nimport { SCHEMAS } from ${JSON.stringify(path.join(ROOT, "src/routes/schema-defs.ts"))};\nconst t0 = performance.now();\nconst ajv = new Ajv2020({ allErrors: false, strict: true });\nexport const compiled = Object.values(SCHEMAS).map((s) => ajv.compile(s as never));\nexport const compileMs = performance.now() - t0;\n`);
  const rtBundle = path.join(workdir, "runtime-ajv.mjs");
  const r2 = spawnSync(esbuild, [rt, "--bundle", "--platform=node", "--target=node24", "--format=esm", "--minify", `--outfile=${rtBundle}`, "--banner:js=import{createRequire as __cr}from'node:module';const require=__cr(import.meta.url);", "--log-level=error"], { encoding: "utf8" });
  if (r2.status !== 0) throw new Error(`esbuild failed: ${r2.stderr || r2.stdout}`);

  const probe = (file, field) => {
    const out = [];
    for (let i = 0; i < RUNS; i++) {
      const p = spawnSync(process.execPath, ["--input-type=module", "-e", `const t=process.hrtime.bigint(); const m = await import(${JSON.stringify(url.pathToFileURL(file).href)}); console.log(${field === undefined ? "Number(process.hrtime.bigint()-t)/1e6" : `m.${field}`})`], { encoding: "utf8" });
      if (p.status !== 0) throw new Error(`importing ${file} failed: ${p.stderr}`);
      out.push(Number(p.stdout.trim()));
    }
    return out;
  };
  const baseline = (() => {
    const out = [];
    for (let i = 0; i < RUNS; i++) {
      const p = spawnSync(process.execPath, ["--input-type=module", "-e", `const t=process.hrtime.bigint(); await import('node:sqlite'); console.log(Number(process.hrtime.bigint()-t)/1e6)`], { encoding: "utf8" });
      out.push(Number(p.stdout.trim()));
    }
    return out;
  })();
  return { host: probe(bundle), runtimeAjv: probe(rtBundle), runtimeAjvCompile: probe(rtBundle, "compileMs"), nodeSqlite: baseline, bundleBytes: fs.statSync(bundle).size };
}

// ---- main ----
// under dist/ (gitignored) so esbuild resolves the repo's node_modules from the generated entry files
const workdir = path.join(ROOT, "dist", `boot-bench-${process.pid}`);
fs.mkdirSync(workdir, { recursive: true });
try {
  console.log(`node ${process.version} on ${os.platform()}/${os.arch()}, ${os.cpus()[0]?.model ?? "cpu"}; target ${TARGET_MB} MB, ${RUNS} runs\n`);

  const [{ db, layouts, names }, genMs] = time(() => buildDatabase(TARGET_MB));
  const [image, serializeMs] = time(() => db.serialize());
  console.log(`database    ${(image.byteLength / 1048576).toFixed(1)} MB raw, ${layouts} layouts, ${db.prepare("SELECT count(*) AS n FROM events").get().n} events, ${db.prepare("SELECT count(*) AS n FROM layout_revs").get().n} revs (generated in ${(genMs / 1000).toFixed(1)} s; serialize ${serializeMs.toFixed(1)} ms)`);
  db.close();

  const level = zlib.constants.ZSTD_c_compressionLevel;
  const [packed, packMs] = time(() => zlib.zstdCompressSync(image, { params: { [level]: 19 } }));
  console.log(`zstd-19     ${(packed.byteLength / 1048576).toFixed(2)} MB (${(image.byteLength / packed.byteLength).toFixed(1)}x; random numbers and hex make this a pessimistic ratio), compressed in ${(packMs / 1000).toFixed(1)} s by the jobs tick`);
  // the jobs tick pays for compression (Lambda timeout 35 s, and compression runs on one vCPU): the cost of the other levels, for tuning SNAPSHOT_ZSTD_LEVEL
  for (const lv of [3, 9, 12, 15]) {
    const [p, t] = time(() => zlib.zstdCompressSync(image, { params: { [level]: lv } }));
    const [, d] = time(() => zlib.zstdDecompressSync(p));
    console.log(`  level ${String(lv).padStart(2)}  ${(p.byteLength / 1048576).toFixed(2)} MB, compress ${(t / 1000).toFixed(2)} s, decompress ${d.toFixed(1)} ms`);
  }
  console.log("");

  const dec = [];
  const des = [];
  const q1 = [];
  const q2 = [];
  for (let i = 0; i < RUNS; i++) {
    const [raw, d] = time(() => zlib.zstdDecompressSync(packed));
    const target = new DatabaseSync(":memory:", { enableForeignKeyConstraints: true });
    const [, s] = time(() => target.deserialize(raw));
    const name = names[(i * 7919) % names.length];
    const [row, a] = time(() => target.prepare("SELECT l.*, f.payload_json FROM layouts l JOIN layout_formats f ON f.layout_id = l.id WHERE l.name = ? AND l.deleted = 0").get(name));
    if (row === undefined) throw new Error("the first query found nothing");
    const [page, b] = time(() => target.prepare("SELECT l.id, l.name, f.payload_json FROM layouts l CROSS JOIN layout_formats f ON f.layout_id = l.id WHERE l.deleted = 0 AND l.name > ? ORDER BY l.name LIMIT 51").all(name));
    if (page.length === 0) throw new Error("the list page is empty");
    dec.push(d);
    des.push(s);
    q1.push(a);
    q2.push(b);
    target.close();
  }

  const imp = importTimes(workdir);
  console.log(`import      ${fmt(imp.host)}   (bundle ${(imp.bundleBytes / 1024).toFixed(0)} KB; node:sqlite alone ${median(imp.nodeSqlite).toFixed(1)} ms of it)`);
  console.log(`            ${fmt(imp.runtimeAjvCompile)}   <- ajv compiling the 19 route-body schemas at load (what RP5 removed); ajv itself and the formats' own compile stay`);
  console.log(`decompress  ${fmt(dec)}`);
  console.log(`deserialize ${fmt(des)}`);
  console.log(`first query ${fmt(q1)}   point read + join`);
  console.log(`            ${fmt(q2)}   keyset list page (51 rows with payloads)\n`);

  const sum = median(imp.host) + median(dec) + median(des) + median(q1);
  console.log(`cold start (import + decompress + deserialize + first query), median: ${sum.toFixed(1)} ms; Mac target <= 120 ms: ${sum <= 120 ? "met" : "NOT met"}`);
  console.log("(on Lambda at 2 GB multiply by about 5-7; the S3 GET and the log head read overlap module load and are not included)");
} finally {
  fs.rmSync(workdir, { recursive: true, force: true });
}
