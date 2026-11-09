// Stress runner against a LOCAL akldb (scripts/stress/serve.mjs). Refuses any base URL that is not loopback.
//   node scripts/stress/run.mjs --state <dir> [--base http://127.0.0.1:4246] [--only name,name] [--soak-minutes 15]
//        [--workers 16] [--owners 50] [--layouts 60] [--seed 1]
// Without --soak-minutes it runs the scenarios (fast, ~1 min); with it, the scenarios first and then the soak.
import { DatabaseSync } from "node:sqlite";
import { readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import * as S from "../../tests/stress/scenarios.ts";

const arg = (k, d) => { const i = process.argv.indexOf(`--${k}`); return i < 0 ? d : process.argv[i + 1]; };
const base = arg("base", "http://127.0.0.1:4246");
if (!/^http:\/\/(127\.0\.0\.1|localhost):\d+$/.test(base)) { console.error(`refusing non-loopback base ${base}`); process.exit(2); }
const state = resolve(arg("state", ""));
const d1dir = join(state, "v3/d1/miniflare-D1DatabaseObject");
const file = readdirSync(d1dir).filter((f) => f.endsWith(".sqlite") && f !== "metadata.sqlite").map((f) => join(d1dir, f));
if (file.length !== 1) { console.error(`expected one D1 file in ${d1dir}, found ${file.length}`); process.exit(2); }
const db = new DatabaseSync(file[0], { readOnly: true });
db.exec("PRAGMA busy_timeout = 5000");

const target = {
  async call({ method, path, user, body, headers }) {
    const h = { ...(headers ?? {}) };
    if (user !== undefined) h.Authorization = `Bearer t${S.userId(user)}`;
    if (body !== undefined) h["content-type"] = "application/json";
    const res = await fetch(base + path, { method, headers: h, body: body === undefined ? undefined : JSON.stringify(body) });
    if ((res.headers.get("content-type") ?? "").includes("gzip")) return { status: res.status, etag: res.headers.get("etag"), json: null, bytes: new Uint8Array(await res.arrayBuffer()) };
    const text = await res.text();
    let json = null; try { json = JSON.parse(text); } catch { json = text; }
    return { status: res.status, etag: res.headers.get("etag"), json };
  },
  async sql(q, ...p) { return db.prepare(q).all(...p); },
};

const only = arg("only", "").split(",").filter(Boolean);
const scale = Number(arg("scale", "1"));
const scenarios = {
  sameScopeCas: () => S.sameScopeCas(target, { writers: 8, rounds: Math.round(30 * scale), owner: 1 }),
  crossScope: () => S.crossScope(target, { rounds: Math.round(25 * scale), perScope: 4, owner: 2 }),
  createSameName: () => S.createSameName(target, { creators: 8, rounds: Math.round(25 * scale) }),
  readersDuringWrites: () => S.readersDuringWrites(target, { rounds: Math.round(40 * scale), readers: 4, owner: 3 }),
  unaryAltPayloads: () => S.unaryAltPayloads(target, { owner: 4 }),
  deleteRecreateRaces: () => S.deleteRecreateRaces(target, { rounds: Math.round(25 * scale), owner: 5 }),
  likeRaces: () => S.likeRaces(target, { likers: 10, owner: 7 }),
  idempotentCreate: () => S.idempotentCreate(target, { copies: 8, owner: 8 }),
  dumpDuringWrites: () => S.dumpDuringWrites(target, { owner: 9, dumps: Math.round(8 * scale), writers: 6 }),
};
let bad = 0;
for (const [name, fn] of Object.entries(scenarios)) {
  if (only.length && !only.includes(name)) continue;
  const t0 = Date.now();
  const r = await fn();
  console.log(`${r.failures.length === 0 ? "PASS" : "FAIL"} ${name} ${((Date.now() - t0) / 1000).toFixed(1)}s ${JSON.stringify(r.stats)}`);
  for (const f of r.failures.slice(0, 15)) console.log(`   - ${f}`);
  bad += r.failures.length;
}
const soakMin = Number(arg("soak-minutes", "0"));
if (soakMin > 0 && (only.length === 0 || only.includes("soak"))) {
  console.log(`soak: ${soakMin} min, workers=${arg("workers", "16")}`);
  const r = await S.soak(target, { durationMs: soakMin * 60000, workers: Number(arg("workers", "16")), owners: Number(arg("owners", "50")), layouts: Number(arg("layouts", "60")), seed: Number(arg("seed", "1")), skip: arg("skip", "").split(",").filter(Boolean), log: (s) => console.log(s) });
  console.log(`${r.failures.length === 0 ? "PASS" : "FAIL"} soak ${JSON.stringify(r.stats)}`);
  for (const f of r.failures.slice(0, 40)) console.log(`   - ${f}`);
  bad += r.failures.length;
}
process.exit(bad === 0 ? 0 : 1);
