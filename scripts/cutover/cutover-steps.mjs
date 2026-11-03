// The cutover plan (LDB-CV15..CV22): D1 + Worker -> AWS design A. Pure orchestration over injected `ports` (see ports-real.mjs for the real
// ones and tests/cutover/world.ts for the fakes), so every step is testable without a network.
//
//  preflight -> copy-dumps -> freeze -> export -> load -> verify -> image -> serve -> dns -> open -> post-smoke -> report
//
// There is ONE hostname, api.akldb.org. The Worker needs only the read_only flag (D1's import_state['cutover.mode']); there is no proxy mode.
// `serve` proves the prod stack by talking to it directly (its regional domain target, Host: api.akldb.org, the origin secret from a local env
// file); `dns` is saltorbit moving the DNS record from the Worker's custom domain to the stack, and the tool polls until api.akldb.org answers from
// AWS; `open` clears the flag on AWS only after that.
//
// Write pause: from the freeze (the first D1 write of `cutover.mode`) until `open` clears the flag on AWS. Everything between is
// read-only for clients: reads keep working (the Worker until the record moves, AWS after it).
//
// Failure policy: before `image` nothing on AWS changed; `--abort` clears D1's flag. After `image` and before `open`: rollback.mjs variant
// original-d1. After `open`: rollback.mjs (original-d1 while AWS has no writes past the image, fresh-d1 after). Nothing is undone automatically.
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { SEQUENCE_TABLE, compareProofs, feedPosition, localSelect, proveAll, proveAllBatched, provenTables } from "./checksum.mjs";
import { fail, need } from "./machine.mjs";
import { compareWithDrift } from "./drift.mjs";
import { loadExportSql, loadRowsOnly, sanityChecks, tablesCreatedBy } from "./sqlfile.mjs";

export const MODE_KEY = "cutover.mode";
/** The format layout reads name: the API refuses a layout list or a layout without one (400 format_required). */
export const LIST_FORMAT = "spark/1";
export const setModeSql = (mode) => `INSERT INTO import_state (key, value) VALUES ('${MODE_KEY}', '${mode}') ON CONFLICT(key) DO UPDATE SET value = excluded.value`;
export const CLEAR_MODE_SQL = `DELETE FROM import_state WHERE key = '${MODE_KEY}'`;
const readModeSql = `SELECT value FROM import_state WHERE key = '${MODE_KEY}'`;

/** The caches of the mode flag are 1 s; waiting this long makes the flip visible everywhere (saltorbit's 3 s). */
export const CACHE_WAIT_MS = 3000;
export const AWS_HEADER = "x-akldb-backend";

const sha256File = (file) => crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
const sha256 = (b) => crypto.createHash("sha256").update(b).digest("hex");
const lc = (h) => Object.fromEntries(Object.entries(h ?? {}).map(([k, v]) => [k.toLowerCase(), v]));

/**
 * A harmless probe: a SIGNED (ops client) empty `POST /v1/layouts`. read_only is mounted after actor resolution (LDB-CV1: requireActorOnWrites first),
 * so an anonymous write answers 401 whether the Worker is frozen or not and tells nothing. Signed: 503 read_only when frozen, 400 (the empty body is
 * refused) when writes are open. Anything else (401, 403) is "inconclusive" and the callers refuse to read it as either. The signature spends one nonce
 * on whatever database answers (D1 before the export, AWS after `open`); that is the read-path bookkeeping of LDB-CV25 and is harmless.
 */
export const STACK = "stack"; // writeProbe(ports, STACK): straight at the prod stack, past the DNS name
export async function writeProbe(ports, base) {
  const r = base === STACK ? await ports.stack.signed("POST", "/v1/layouts", { body: "" }) : await ports.http.signed("POST", `${base}/v1/layouts`, { body: "" });
  let reason = null;
  try {
    reason = JSON.parse(r.body)?.error ?? null;
  } catch {
    reason = null;
  }
  const readOnly = r.status === 503 && (reason === "read_only" || /read_only/.test(r.body));
  return { status: r.status, frozen: r.status === 503, readOnly, open: r.status === 400, retryAfter: lc(r.headers)["retry-after"] ?? null, backend: lc(r.headers)[AWS_HEADER] ?? null, reason };
}

/** Why a probe that is neither frozen nor open cannot be trusted (for messages). */
export const inconclusive = (probe) => (probe.status === 401 || probe.status === 403 ? ` The probe is signed with the ops client and was refused (${probe.status} ${probe.reason ?? ""}): is the ops client of ../db.env.ops (CLIENT_ID / CLIENT_PRIVATE_KEY / OPS_ACTOR) registered on this database?` : "");

export async function d1Mode(ports, db) {
  const rows = await ports.d1.select(readModeSql, db);
  return rows.length === 0 ? null : String(rows[0].value);
}

/** Strip the clock-dependent fields before comparing two /v1/meta bodies (health.*.age_s). */
export function normalizeMeta(text) {
  const strip = (v) => {
    if (Array.isArray(v)) return v.map(strip);
    if (v !== null && typeof v === "object") return Object.fromEntries(Object.entries(v).filter(([k]) => k !== "age_s").map(([k, x]) => [k, strip(x)]));
    return v;
  };
  try {
    return JSON.stringify(strip(JSON.parse(text)));
  } catch {
    return text;
  }
}

/** Every /v1/dump* answer must be the Worker's own, status, Content-Type, Cache-Control, ETag, redirect and bytes alike (LDB-CV20). */
async function dumpsEqual(ports, o) {
  const latest = await ports.http.request(`${o.workerUrl}/v1/dump/latest.json`, { method: "GET" });
  const key = latest.status === 200 ? JSON.parse(latest.body)?.key : undefined;
  const paths = ["/v1/dump/latest.json", "/v1/dump", ...(key ? [`/v1/dump/${key}`] : [])];
  const checks = [];
  for (const p of paths) {
    const [a, b] = await Promise.all([ports.http.request(`${o.workerUrl}${p}`, { method: "GET" }), ports.stack.request(p, { method: "GET" })]);
    const [ha, hb] = [lc(a.headers), lc(b.headers)];
    const diffs = [];
    if (a.status !== b.status) diffs.push(`status ${a.status} vs ${b.status}`);
    // the ETag compared weakly (Cloudflare marks it W/ when it compresses the Worker's answer, LDB-CV19); a redirect relative to each side's own origin
    // (the same name at the flip; the rehearsal Worker and staging differ by host only)
    const norm = { etag: (v, _) => v.replace(/^W\//, ""), location: (v, origin) => (v.startsWith(origin) ? v.slice(origin.length) : v) };
    const sides = [[ha, new URL(o.workerUrl).origin], [hb, new URL(o.publicUrl).origin]];
    for (const h of ["content-type", "cache-control", "etag", "location"]) {
      const [va, vb] = sides.map(([hs, origin]) => (hs[h] === undefined ? null : norm[h] ? norm[h](hs[h], origin) : hs[h]));
      if (va !== vb) diffs.push(`${h} ${ha[h] ?? "absent"} vs ${hb[h] ?? "absent"}`);
    }
    if (a.status === 200 && a.sha256 !== b.sha256) diffs.push("body bytes differ");
    checks.push({ path: p, status: [a.status, b.status], diffs });
  }
  return checks;
}

async function readsEqual(ports, o, paths) {
  const checks = [];
  for (const p of paths) {
    const [a, b] = await Promise.all([ports.http.request(`${o.workerUrl}${p}`, { method: "GET" }), ports.stack.request(p, { method: "GET" })]);
    const norm = p.startsWith("/v1/meta") ? normalizeMeta : (x) => x;
    const ea = lc(a.headers).etag ?? null;
    const eb = lc(b.headers).etag ?? null;
    // weak comparison (RFC 9110 8.8.3.2, what If-None-Match uses): Cloudflare marks an ETag W/ when it compresses the answer, and the stack does when it
    // gzips one (LDB-CV19), so only the opaque tag is compared
    const opaque = (e) => (e === null ? null : e.replace(/^W\//, ""));
    checks.push({ path: p, status: [a.status, b.status], bodyEqual: a.status === b.status && norm(a.body) === norm(b.body), etagEqual: opaque(ea) === opaque(eb), etag: eb, etags: [ea, eb] });
  }
  return checks;
}

/** What saltorbit does at the `dns` step (also printed in the dry run, and mirrored by the rollback). */
export function dnsInstructions(o, { target }) {
  const host = new URL(o.publicUrl).host;
  return [
    `1. Cloudflare dashboard > Workers & Pages > akl-db > Settings > Domains & Routes: remove the custom domain ${host} (this deletes its DNS record; the Worker stays reachable at ${o.workerDirectUrl}).`,
    `2. Cloudflare dashboard > akldb.org > DNS: add CNAME  ${host.split(".")[0]}  ->  ${target}   Proxied (orange cloud), SSL/TLS mode Full (strict).`,
    `   (The Transform Rule that adds x-akldb-origin for host ${host} already exists.)`,
  ];
}

export function steps(o) {
  const db = o.d1Name;
  const W = (sql) => `wrangler d1 execute ${db} --remote --command "${sql}"`;
  const R = (sql) => `wrangler d1 execute ${db} --remote --json --command "${sql}"`;
  const exportFile = () => path.join(o.work, "export.sql");
  const imageFile = () => path.join(o.work, "image.sqlite");

  return [
    {
      id: "preflight",
      title: "check the prod stack, the empty log, the Worker build and record the D1 Time Travel bookmark",
      commands: () => [
        `aws cloudformation describe-stacks --stack-name ${o.stack} --query 'Stacks[0].Outputs'`,
        `aws lambda get-function-configuration --function-name <FunctionName>:live --query Environment.Variables.AKLDB_AWAIT_IMAGE   # must be 1`,
        `aws dynamodb get-item --table-name <LogTable> --key '{"pk":{"S":"HEAD"},"sk":{"S":"HEAD"}}' --consistent-read   # no item: the log is empty`,
        `curl -s ${o.workerUrl}/v1/meta   # api.minor >= ${o.minMinor}`,
        R(readModeSql) + "   # no cutover.mode yet",
        `wrangler d1 time-travel info ${db}`,
      ],
      async run(c) {
        const out = await c.ports.aws.stackOutputs();
        for (const k of ["ApiDomainTarget", "FunctionName", "LogTable", "DataBucket"]) need(out?.[k], `the stack ${o.stack} has no output ${k}: is it deployed (infra/akldb.yaml, scripts/deploy-aws.sh --stage prod)?`);
        const env = await c.ports.aws.lambdaEnv();
        need(env.AKLDB_AWAIT_IMAGE === "1", `the prod function does not await its image (AKLDB_AWAIT_IMAGE=${env.AKLDB_AWAIT_IMAGE ?? "unset"}): a deploy could migrate the empty log before the image (CV12)`, { hint: "deploy with the AwaitImage parameter auto or 1 (AWAIT_IMAGE=1 sh scripts/deploy-aws.sh --stage prod --execute)" });
        const head = await c.ports.aws.logHead();
        need(head === 0, `the AWS log is not empty (head ${head}): the image must be seq 1. Use the rollback tooling, or a fresh stack`);
        const meta = await c.ports.http.request(`${o.workerUrl}/v1/meta`, { method: "GET" });
        need(meta.status === 200, `GET ${o.workerUrl}/v1/meta answered ${meta.status}`);
        const minor = JSON.parse(meta.body)?.api?.minor;
        need(Number.isInteger(minor) && minor >= o.minMinor, `the Worker serves api.minor ${minor}, the modes shipped in ${o.minMinor}: deploy the Worker build with cutover.mode first`);
        const problems = await c.ports.stack.check();
        need(problems.length === 0, `the direct read of the stack (serve) is not possible: ${problems.join("; ")}`);
        const signer = await c.ports.http.check();
        need(signer.length === 0, `the signed probes need the ops client in the environment (${signer.join(", ")}): source ../db.env.ops`);
        const mode = await d1Mode(c.ports, db);
        need(mode === null || c.state.steps.freeze !== undefined, `D1 already has cutover.mode=${mode} and this run never froze it: another cutover or a half-finished one? (--abort clears it)`);
        const tt = await c.ports.d1.timeTravelInfo(db);
        need(tt?.bookmark, "wrangler d1 time-travel info gave no bookmark");
        c.data.bookmark ??= tt.bookmark;
        c.data.bookmarkAt ??= tt.timestamp ?? null;
        c.data.stack = out;
        return { message: `log empty, awaiting image, api.minor ${minor}, bookmark ${c.data.bookmark}`, proof: { head, awaitImage: true, minor, bookmark: c.data.bookmark } };
      },
    },
    {
      id: "copy-dumps",
      title: "copy (re-sync) the dump history R2 -> S3: every object, content type kept, md5 and size verified; just before the freeze, so nothing here is inside the write pause",
      commands: () => [`node scripts/cutover/copy-dumps.mjs --execute --dest-bucket <DataBucket>   # R2 akl-db-dumps (${o.r2Env}) -> s3://<DataBucket>/dumps/<key>; the first run is long, a re-run copies only what changed`],
      async precondition(c) {
        need(c.state.steps.preflight?.status === "done", "preflight has not passed");
        const missing = await c.ports.dumps.check();
        need(missing.length === 0, `the dump copy needs ${missing.join(", ")} (the R2 read credentials file ${o.r2Env}: R2_KEY_ID, R2_SECRET, R2_ENDPOINT; bucket-scoped list and read on akl-db-dumps)`);
      },
      async run(c) {
        const r = await c.ports.dumps.sync();
        need(r.ok, `the dump copy found mismatches: ${r.mismatches.map((m) => `${m.key}: ${m.why}`).join(" | ")}`);
        need(r.objects > 0, "the R2 bucket lists no objects: wrong bucket or token scope?");
        return { message: `${r.objects} objects: ${r.copied.length} copied, ${r.skipped.length} already there, ${r.bytes} bytes`, proof: { objects: r.objects, copied: r.copied.length, skipped: r.skipped.length, bytes: r.bytes } };
      },
    },
    {
      id: "freeze",
      title: "set cutover.mode=read_only on D1 and prove writes are refused (503 read_only, not 400)",
      commands: () => [W(setModeSql("read_only")), `curl -s -o /dev/null -w '%{http_code}' -X POST -H 'content-type: application/json' --data '' ${o.workerUrl}/v1/layouts   # 503 read_only`, `sleep ${o.cacheWaitMs / 1000}`],
      async precondition(c) {
        need(c.state.steps.preflight?.status === "done", "preflight has not passed");
      },
      async run(c) {
        c.data.freezeAt ??= c.ports.clock.now(); // the first freeze write: the write pause starts here, and a retry keeps it
        await c.ports.d1.write(setModeSql("read_only"), db);
        need((await d1Mode(c.ports, db)) === "read_only", "D1 did not take cutover.mode=read_only");
        await c.ports.clock.sleep(o.cacheWaitMs);
        const probe = await writeProbe(c.ports, o.workerUrl);
        need(probe.readOnly, `the Worker did not refuse writes after the freeze: the signed POST /v1/layouts with an empty body answered ${probe.status} (${probe.reason ?? "no reason"}), not 503 read_only.${inconclusive(probe)} Otherwise the Worker build lacks the modes or the flag is not read; clear it with --abort`);
        need(probe.retryAfter !== null, "the 503 carries no Retry-After");
        const pos = await feedPosition((sql) => c.ports.d1.select(sql, db));
        c.data.freezeSeq = pos.metaSeq;
        return { message: `frozen at events seq ${pos.metaSeq}, writes answer 503 read_only (Retry-After ${probe.retryAfter})`, proof: { probe, freezeSeq: pos.metaSeq } };
      },
    },
    {
      id: "export",
      title: "export D1 to a SQL file (reads may stall while it runs)",
      commands: () => [`wrangler d1 export ${db} --remote --output ${exportFile()}`],
      async precondition(c) {
        need(c.state.steps.freeze?.status === "done", "the freeze has not been verified");
        need((await d1Mode(c.ports, db)) === "read_only", "D1 is not frozen any more (cutover.mode is not read_only): re-run the freeze");
      },
      async run(c) {
        fs.mkdirSync(o.work, { recursive: true });
        fs.rmSync(exportFile(), { force: true });
        const t0 = c.ports.clock.now();
        await c.ports.d1.exportTo(db, exportFile());
        const ms = c.ports.clock.now() - t0;
        need(fs.existsSync(exportFile()) && fs.statSync(exportFile()).size > 0, "the export file is missing or empty");
        c.data.exportSha = sha256File(exportFile());
        c.data.exportBytes = fs.statSync(exportFile()).size;
        return { message: `${c.data.exportBytes} bytes in ${ms} ms`, proof: { bytes: c.data.exportBytes, sha256: c.data.exportSha, exportMs: ms } };
      },
    },
    {
      id: "load",
      title: "build SQLite from the export; integrity_check, every table present, d1_migrations complete",
      commands: () => [`node:sqlite  load ${exportFile()} -> ${imageFile()}   # PRAGMA integrity_check; foreign_key_check; tables of migrations/*.sql; d1_migrations == migrations/*.sql`],
      async precondition(c) {
        need(c.state.steps.export?.status === "done", "the export has not run");
        need(fs.existsSync(exportFile()) && sha256File(exportFile()) === c.data.exportSha, "the export file changed since the export step recorded it");
      },
      async run(c) {
        const files = fs.readdirSync(o.migrationsDir).filter((f) => f.endsWith(".sql")).sort();
        const local = loadExportSql(fs.readFileSync(exportFile(), "utf8"));
        try {
          // The export may omit sqlite_sequence or lower it: the AUTOINCREMENT counters are D1 state, so copy them (only ever UP) and say so.
          const repairs = [];
          const d1seq = await c.ports.d1.select(`SELECT name, seq FROM ${SEQUENCE_TABLE}`, db);
          const hasSeqTable = local.prepare("SELECT 1 AS x FROM sqlite_master WHERE name = ?").get(SEQUENCE_TABLE) !== undefined;
          if (hasSeqTable) {
            for (const r of d1seq) {
              const cur = local.prepare(`SELECT seq FROM ${SEQUENCE_TABLE} WHERE name = ?`).get(r.name);
              if (cur === undefined) {
                local.prepare(`INSERT INTO ${SEQUENCE_TABLE} (name, seq) VALUES (?, ?)`).run(r.name, r.seq);
                repairs.push({ name: r.name, from: null, to: Number(r.seq) });
              } else if (Number(cur.seq) < Number(r.seq)) {
                local.prepare(`UPDATE ${SEQUENCE_TABLE} SET seq = ? WHERE name = ?`).run(r.seq, r.name);
                repairs.push({ name: r.name, from: Number(cur.seq), to: Number(r.seq) });
              }
            }
          }
          const created = tablesCreatedBy(files.map((f) => fs.readFileSync(path.join(o.migrationsDir, f), "utf8")));
          const sanity = sanityChecks(local, { migrationNames: files, expectedTables: [...created, "d1_migrations"], allowPending: o.allowPending });
          if (!sanity.ok) {
            const bad = sanity.checks.filter((x) => !x.ok).map((x) => `${x.name}: ${x.detail}`);
            fail(`the loaded database failed its sanity checks: ${bad.join(" | ")}`);
          }
          const image = local.serialize();
          fs.writeFileSync(imageFile(), image);
          c.data.imageSha = sha256(image);
          c.data.imageBytes = image.byteLength;
          c.data.sequenceRepairs = repairs;
          return { message: `${provenTables(local).length} tables, image ${image.byteLength} bytes, sha256 ${c.data.imageSha.slice(0, 12)}, ${sanity.applied.length} migrations${repairs.length ? `, sqlite_sequence raised for ${repairs.map((r) => r.name).join(", ")}` : ""}`, proof: { checks: sanity.checks, sequenceRepairs: repairs, imageSha: c.data.imageSha, imageBytes: c.data.imageBytes, pending: sanity.pending } };
        } finally {
          local.close();
        }
      },
    },
    {
      id: "verify",
      title: "prove the image equals the export file (every table), and live D1 outside the read-path drift set; meta.seq and the next-seq rule equal",
      commands: () => [`node:sqlite  SELECT rowid, * FROM <table> ORDER BY rowid LIMIT ${o.pageRows}   # per table, on ${imageFile()}`, R(`SELECT rowid AS __rid, * FROM <table> WHERE rowid > <n> ORDER BY rowid LIMIT ${o.pageRows}`) + "   # per table, paged", R("SELECT COALESCE(MAX(seq), 0) AS seq FROM events"), R("SELECT name, seq FROM sqlite_sequence")],
      async precondition(c) {
        need(c.state.steps.load?.status === "done", "the load has not run");
        need(fs.existsSync(imageFile()) && sha256File(imageFile()) === c.data.imageSha, "the image file changed since the load step recorded it");
        need(fs.existsSync(exportFile()) && sha256File(exportFile()) === c.data.exportSha, "the export file changed since the export step recorded it");
        need((await d1Mode(c.ports, db)) === "read_only", "D1 is not frozen any more: its data may have moved after the export");
      },
      async run(c) {
        const local = new DatabaseSync(":memory:");
        local.deserialize(fs.readFileSync(imageFile())); // the bytes that will be the log's image, not the loader's handle
        let rowsOnly;
        try {
          const d1select = (sql) => c.ports.d1.select(sql, db);
          const t0 = c.ports.clock.now();
          const stats = {};
          const problems = [];
          const localProof = await proveAll({ select: localSelect(local), db: local, pageRows: o.pageRows });
          // (a) load fidelity: the image equals the export file itself, table by table, read a second, independent way (rows only: no trigger, index or
          // view existed to touch them). sqlite_sequence is D1's own value, repaired in from D1 where the export lacks it, so it is proven against D1 in (b).
          rowsOnly = loadRowsOnly(fs.readFileSync(exportFile(), "utf8"));
          const fileProof = await proveAll({ select: localSelect(rowsOnly), db: rowsOnly, pageRows: o.pageRows });
          const fid = compareProofs(Object.fromEntries(Object.entries(localProof).filter(([t]) => t !== SEQUENCE_TABLE)), Object.fromEntries(Object.entries(fileProof).filter(([t]) => t !== SEQUENCE_TABLE)), { left: "image", right: "export" });
          for (const d of fid.diffs) problems.push(`load fidelity, ${d.table}: ${d.field} image ${d.image} != export file ${d.export}`);
          // (b) the image equals live D1 on every table outside the read-path drift set, and on the drift tables except in the drift columns and rows
          // that appeared after the export (Spark polls signed, akl.gg reads with bearers: both bookkeep on a frozen D1, LDB-CV25)
          const live = await compareWithDrift({ localDb: local, leftProof: localProof, remoteSelect: d1select, ...(c.ports.d1.selectMany ? { remoteSelectMany: (sqls) => c.ports.d1.selectMany(sqls, db) } : {}), pageRows: o.pageRows, concurrency: o.concurrency, stats });
          problems.push(...live.problems);
          const lp = await feedPosition(localSelect(local));
          const rp = await feedPosition(d1select);
          if (lp.metaSeq !== rp.metaSeq) problems.push(`meta.seq: sqlite ${lp.metaSeq} != d1 ${rp.metaSeq}`);
          if (lp.eventsCounter !== rp.eventsCounter) problems.push(`next-seq rule (CV17): sqlite_sequence for events is ${lp.eventsCounter}, D1's is ${rp.eventsCounter}`);
          if (rp.eventsCounter !== null && rp.eventsCounter < rp.metaSeq) problems.push(`D1's own sqlite_sequence (${rp.eventsCounter}) is below MAX(seq) (${rp.metaSeq})`);
          const schemaSql = "SELECT type, name, tbl_name, sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%' ORDER BY type, name";
          const [ls, rs] = [localSelect(local)(schemaSql), await d1select(schemaSql)];
          const key = (r) => JSON.stringify([r.type, r.name, r.tbl_name, r.sql]);
          const lset = new Set(ls.map(key));
          const rset = new Set(rs.map(key));
          for (const k of lset) if (!rset.has(k)) problems.push(`schema: ${JSON.parse(k)[0]} ${JSON.parse(k)[1]} differs or is missing on D1`);
          for (const k of rset) if (!lset.has(k)) problems.push(`schema: ${JSON.parse(k)[0]} ${JSON.parse(k)[1]} is on D1 but not in the export`);
          const lost = live.lost;
          const driftReport = Object.fromEntries(Object.entries(live.drift).map(([t, d]) => [t, { liveOnly: d.rightOnly, columnsDiffering: d.tolerated }]));
          const proof = { ok: problems.length === 0, tables: live.plain.tables + Object.keys(live.drift).length, rows: live.plain.rows, metaSeq: rp.metaSeq, eventsCounter: rp.eventsCounter, verifyMs: c.ports.clock.now() - t0, d1Calls: stats.calls, fidelity: { tables: fid.tables, rows: fid.rows }, drift: driftReport, lostOnAws: lost, problems, perTable: localProof };
          if (!proof.ok) {
            const e = new Error(`VERIFY FAILED, nothing was written to AWS: ${problems.slice(0, 8).join(" | ")}${problems.length > 8 ? ` (+${problems.length - 8} more)` : ""}`);
            e.proof = proof;
            throw e;
          }
          c.data.finalSeq = rp.metaSeq;
          c.data.eventsCounter = rp.eventsCounter;
          c.data.tables = localProof;
          c.data.lostOnAws = lost;
          const lostText = Object.entries(lost).map(([t, n]) => `${t} ${n}`).join(", ");
          return { message: `${fid.tables} tables equal the export file, ${live.plain.tables} tables and meta.seq ${rp.metaSeq} equal live D1, events counter ${rp.eventsCounter} (${stats.calls} D1 calls)${lostText ? `; read-path bookkeeping since the export, lost on AWS: ${lostText}` : ""}`, proof };
        } finally {
          local.close();
          rowsOnly?.close();
        }
      },
    },
    {
      id: "image",
      title: "append the image to the prod log as seq 1 (S3 spill + conditional append), then write the snapshot pointer at seq 1",
      commands: () => [`aws s3api put-object --bucket <DataBucket> --key log/<unitId>.image.zst --body <zstd ${imageFile()}>   # via the replica kit`, `aws dynamodb transact-write-items   # Put LOG#000000000001 (kind image) if absent + Update HEAD seq=1 if absent`, `aws s3api put-object --bucket <DataBucket> --key snap/slot-0.sqlite.zst   # + the SNAP/POINTER item at seq 1`],
      async precondition(c) {
        const v = c.state.steps.verify;
        need(v?.status === "done" && v.proof?.ok === true, "CV16: the image is appended only after verify passed (counts, checksums and meta.seq equal)");
        need(fs.existsSync(imageFile()) && sha256File(imageFile()) === c.data.imageSha, "the image file is not the one verify proved");
        const head = await c.ports.aws.logHead();
        if (head !== 0) {
          const first = await c.ports.aws.firstEntry();
          need(first?.kind === "image" && first.hash === c.data.imageSha, `the AWS log already has ${head} entries and seq 1 is not this image: refusing (CV10)`);
        }
      },
      async run(c) {
        const raw = fs.readFileSync(imageFile());
        const appended = await c.ports.aws.operator.appendImage({ raw, tables: c.data.tables, source: { bookmark: c.data.bookmark, freezeSeq: c.data.freezeSeq, d1: db, exportSha256: c.data.exportSha } });
        need(appended.seq === 1 && appended.hash === c.data.imageSha, "the appended image is not the verified one");
        const head = await c.ports.aws.logHead();
        // first run: the image is the only entry and the pointer lands on seq 1; a re-run after the cutover opened just finds both unchanged
        need(appended.outcome === "already" ? head >= 1 : head === 1, `after the image the AWS log head is ${head}${appended.outcome === "already" ? "" : ", expected 1"}`);
        const snap = await c.ports.aws.operator.snapshot();
        need(appended.outcome === "already" ? snap.seq >= 1 : snap.seq === 1, `the snapshot pointer is at seq ${snap.seq}${appended.outcome === "already" ? "" : ", expected 1"}`);
        c.data.imageUnit = appended.unitId;
        return { message: `${appended.outcome} unit ${appended.unitId}, hash ${appended.hash.slice(0, 12)}, snapshot ${snap.key} at seq 1`, proof: { outcome: appended.outcome, unitId: appended.unitId, hash: appended.hash, snapshot: snap } };
      },
    },
    {
      id: "serve",
      title: "invoke migrate (a no-op: the image is complete) and warm k=4, then read the prod stack DIRECTLY and compare with D1's answers",
      commands: () => [
        `aws lambda invoke --function-name <FunctionName> --qualifier live --payload '{"akldb":"migrate"}' out.json   # applied: [], seq 1`,
        `aws lambda invoke --function-name <FunctionName> --qualifier live --payload '{"akldb":"warm","k":4}' out.json`,
        `# the stack directly: TCP to <ApiDomainTarget> (resolve override), TLS SNI and Host ${new URL(o.publicUrl).host}, header x-akldb-origin read from ${o.originEnv} (never printed)`,
        `for p in /v1/meta '/v1/layouts?limit=20&format=spark/1' '/v1/layouts/<id1>?format=spark/1' '/v1/layouts/<id2>?format=spark/1' '/v1/layouts/<id3>?format=spark/1' /v1/dump/latest.json /v1/dump /v1/dump/<newest>; do curl -si ${o.workerUrl}$p; curl -si --resolve ${new URL(o.publicUrl).host}:443:<ip of ApiDomainTarget> -H 'x-akldb-origin: ***' ${o.publicUrl}$p; done   # equal bodies, ETags, headers`,
      ],
      async precondition(c) {
        need(c.state.steps.image?.status === "done", "the image has not been appended");
        need((await c.ports.aws.logHead()) >= 1, "the AWS log is empty");
        const problems = await c.ports.stack.check();
        need(problems.length === 0, `the direct read of the stack is not possible: ${problems.join("; ")}`);
      },
      async run(c) {
        const mig = await c.ports.aws.invoke({ akldb: "migrate" });
        need(mig?.ok === true && mig.awaiting === undefined, `migrate answered ${JSON.stringify(mig)}: the image is not visible to the function`);
        need(Array.isArray(mig.applied) && mig.applied.length === 0, `migrate applied ${JSON.stringify(mig.applied)}: the bundle ships migrations the image lacks (the load step checks this; the deployed code differs from the repo?)`);
        need(mig.seq >= 1, `migrate saw seq ${mig.seq}`);
        const warm = await c.ports.aws.invoke({ akldb: "warm", k: 4 });
        need(warm?.ok === true, `warm answered ${JSON.stringify(warm)}`);
        need(warm.warmup === "ok", `warm: the warm-up read is ${warm.warmup}, not ok`);
        const list = await c.ports.stack.request(`/v1/layouts?limit=20&format=${LIST_FORMAT}`, { method: "GET" });
        need(list.status === 200, `the stack answered GET /v1/layouts?limit=20&format=${LIST_FORMAT} with ${list.status} (a 403 means the origin secret in ${o.originEnv} is not the stack's)`);
        const ids = (JSON.parse(list.body).items ?? []).slice(0, 3).map((x) => x.id);
        need(ids.length === 3, `the list page has ${ids.length} layouts, the smoke needs 3`);
        const paths = ["/v1/meta", `/v1/layouts?limit=20&format=${LIST_FORMAT}`, ...ids.map((id) => `/v1/layouts/${id}?format=${LIST_FORMAT}`)];
        const checks = await readsEqual(c.ports, o, paths);
        const bad = checks.filter((x) => !x.bodyEqual || !x.etagEqual || x.status[0] !== 200);
        need(bad.length === 0, `reads differ between D1 and the prod stack: ${bad.map((x) => `${x.path} status ${x.status} body ${x.bodyEqual ? "=" : "!="} etag ${x.etagEqual ? "=" : "!="}`).join("; ")}`);
        const dumps = await dumpsEqual(c.ports, o);
        const badDumps = dumps.filter((x) => x.diffs.length > 0);
        need(badDumps.length === 0, `the dump routes differ between the Worker and the prod stack (CV20): ${badDumps.map((x) => `${x.path}: ${x.diffs.join(", ")}`).join("; ")}`);
        const head = await c.ports.stack.request(`/v1/meta`, { method: "GET" });
        need(lc(head.headers)[AWS_HEADER] === "aws", `the stack answers without ${AWS_HEADER}: aws (CV13): the deployed code is not this build`);
        return { message: `migrate no-op at seq ${mig.seq}, warm ${warm.containers?.length ?? "?"} containers, ${checks.length} reads and ${dumps.length} dump routes equal`, proof: { migrate: mig, warm: { containers: warm.containers, warmup: warm.warmup }, checks, dumps } };
      },
    },
    {
      id: "dns",
      title: `saltorbit moves the DNS record ${new URL(o.publicUrl).host} from the Worker to the stack; poll until it answers from AWS, ${o.dnsConsecutive} times in a row on fresh connections`,
      commands: () => [
        ...dnsInstructions(o, { target: "<ApiDomainTarget>" }),
        `curl -s ${o.publicUrl}/v1/meta   # x-akldb-backend: aws and seq == the image's meta.seq, ${o.dnsConsecutive} fresh connections in a row, every ${o.dnsPollMs / 1000} s, at most ${o.dnsTimeoutMs / 1000} s`,
      ],
      async precondition(c) {
        need(c.state.steps.serve?.status === "done", "the prod stack has not been proven to serve (serve)");
        need(c.state.steps.image?.status === "done", "the image has not been appended");
      },
      async run(c) {
        const sameName = new URL(o.publicUrl).host === new URL(o.workerUrl).host;
        if (sameName) {
          c.out("      ---- ACTION FOR SALTORBIT (Cloudflare dashboard, akl account) ----");
          for (const line of dnsInstructions(o, { target: c.data.stack.ApiDomainTarget })) c.out(`      ${line}`);
          c.out("      ------------------------------------------------------------------");
        } else c.out(`      (rehearsal: ${o.publicUrl} is not the Worker's name, nothing to move; polling it anyway)`);
        const started = c.ports.clock.now();
        let consecutive = 0;
        let polls = 0;
        let last = "no answer yet";
        for (;;) {
          polls++;
          let ok = false;
          try {
            const r = await c.ports.http.fresh(`${o.publicUrl}/v1/meta`, { method: "GET" });
            const backend = lc(r.headers)[AWS_HEADER] ?? null;
            let seq = null;
            try {
              seq = JSON.parse(r.body).seq;
            } catch {
              seq = null;
            }
            ok = r.status === 200 && backend === "aws" && seq === c.data.finalSeq;
            last = `status ${r.status}, ${AWS_HEADER} ${backend ?? "absent"}, seq ${seq ?? "?"} (want aws, ${c.data.finalSeq})`;
          } catch (e) {
            last = `request failed: ${e instanceof Error ? e.message : String(e)}`; // the gap between removing the Worker's domain and the new record
          }
          consecutive = ok ? consecutive + 1 : 0;
          if (consecutive >= o.dnsConsecutive) break;
          need(c.ports.clock.now() - started < o.dnsTimeoutMs, `${o.publicUrl} still does not answer from AWS after ${Math.round((c.ports.clock.now() - started) / 1000)} s and ${polls} polls (last: ${last}). Has the Worker's custom domain been removed and the proxied CNAME to ${c.data.stack.ApiDomainTarget} added? Re-run with --from dns once it is. The write pause is still running: AWS stays read_only, D1 stays frozen`);
          await c.ports.clock.sleep(o.dnsPollMs);
        }
        c.data.dnsAt = c.ports.clock.now();
        return { message: `${o.publicUrl} answers from AWS after ${Math.round((c.data.dnsAt - started) / 1000)} s (${polls} polls, last: ${last})`, proof: { polls, waitedMs: c.data.dnsAt - started, consecutive, last } };
      },
    },
    {
      id: "open",
      title: "clear cutover.mode on AWS: a unit appended through the prod log as the operator (never the public API)",
      commands: () => [`node:operator  Replica(DynamoDB log akldb-prod-log, operator credentials).runUnit("${CLEAR_MODE_SQL}")`, `curl -si -X POST ${o.publicUrl}/v1/layouts   # no longer 503`],
      async precondition(c) {
        // CV16: writes open only after counts, checksums and meta.seq were proven equal, for THE image that is in the log, and after the name points at AWS.
        const v = c.state.steps.verify;
        need(v?.status === "done" && v.proof?.ok === true, "CV16: writes open only after verify passed (counts, checksums, meta.seq equal)");
        for (const id of ["image", "serve", "dns"]) need(c.state.steps[id]?.status === "done", `CV16: writes open only after ${id} is done`);
        const first = await c.ports.aws.firstEntry();
        need(first?.kind === "image" && first.hash === c.data.imageSha, "CV16: the image in the AWS log is not the one verify proved");
      },
      async run(c) {
        const flag = await c.ports.aws.operator.readFlag();
        let seq = await c.ports.aws.logHead();
        if (flag !== null) {
          const r = await c.ports.aws.operator.runUnit(CLEAR_MODE_SQL);
          seq = r.seq;
        }
        need((await c.ports.aws.operator.readFlag()) === null, "AWS still has cutover.mode set after the unit");
        c.data.openedAt = c.ports.clock.now();
        c.data.openSeq = seq;
        await c.ports.clock.sleep(o.cacheWaitMs);
        const probe = await writeProbe(c.ports, o.publicUrl);
        need(probe.open, `writes are not open after the flag was cleared: the signed probe answered ${probe.status} (${probe.reason}), expected 400.${probe.frozen ? " The AWS flag cache, or the name is not the stack." : inconclusive(probe)}`);
        need(probe.backend === "aws", `the write probe was answered by ${probe.backend ?? "the Worker"}, not AWS`);
        const pauseMs = c.data.openedAt - c.data.freezeAt;
        c.data.pauseMs = pauseMs;
        return { message: `writes open at AWS seq ${seq}; write pause ${pauseMs} ms (freeze -> open)`, proof: { openSeq: seq, pauseMs, probe, wasAlreadyOpen: flag === null } };
      },
    },
    {
      id: "post-smoke",
      title: "a signed write with the ops client, If-Match 409 stale on a stale rev, feed contiguity and ETag 304 through api.akldb.org",
      commands: () => [`node scripts/client-sign.mjs ${o.writeMethod} ${o.writePath}   # the signed write (default: the manual nightly tick, a harmless event)`, `curl -s -X PATCH -H 'If-Match: "<stale>"' ${o.publicUrl}/v1/layouts/<id>   # 409 stale`, `curl -s '${o.publicUrl}/v1/changes?since=<D1 last seq>'   # starts at last+1`, `curl -si -H 'If-None-Match: <etag>' ${o.publicUrl}/v1/meta   # 304`],
      async precondition(c) {
        need(c.state.steps.open?.status === "done", "writes are not open yet");
      },
      async run(c) {
        const checks = {};
        const write = await c.ports.http.signed(o.writeMethod, `${o.publicUrl}${o.writePath}`, { body: o.writeBody });
        need(write.status >= 200 && write.status < 300, `the signed write ${o.writeMethod} ${o.writePath} answered ${write.status}: ${write.body.slice(0, 200)}`);
        checks.signedWrite = { status: write.status, backend: lc(write.headers)[AWS_HEADER] ?? null };
        // a layout the ops actor owns (so the rename passes the owner check and reaches the If-Match), its layout_rev from the list body (a single
        // layout's GET carries no ETag); a rename to its own name under a stale "layout:<rev>" must be refused 409 stale (akldb's answer to a same-scope mismatch, docs/adoption.md) before anything is written
        need(o.opsActor, "OPS_ACTOR is not set (db.env.ops): the If-Match probe renames a layout the ops actor owns");
        const list = JSON.parse((await c.ports.http.request(`${o.publicUrl}/v1/layouts?owner=${encodeURIComponent(o.opsActor)}&limit=1&format=${LIST_FORMAT}`, { method: "GET" })).body);
        const mine = list.items?.[0];
        need(mine?.id !== undefined && Number.isInteger(mine.layout_rev), `the ops actor owns no layout to run the If-Match probe against (${JSON.stringify(list).slice(0, 200)})`);
        const id = mine.id;
        const stale = `"layout:${mine.layout_rev + 1000}"`;
        const patch = await c.ports.http.signed("PATCH", `${o.publicUrl}/v1/layouts/${id}`, { body: JSON.stringify({ name: mine.name }), headers: { "if-match": stale } });
        let patchError = null;
        try {
          patchError = JSON.parse(patch.body)?.error ?? null;
        } catch {
          patchError = null;
        }
        need(patch.status === 409 && patchError === "stale", `PATCH with a stale If-Match answered ${patch.status} ${patchError ?? patch.body.slice(0, 120)}, expected 409 stale`);
        checks.ifMatch = { id, sent: stale, status: patch.status };
        const feed = await c.ports.http.request(`${o.publicUrl}/v1/changes?since=${c.data.finalSeq}&limit=50`, { method: "GET" });
        need(feed.status === 200, `GET /v1/changes?since=${c.data.finalSeq} answered ${feed.status}`);
        const items = JSON.parse(feed.body).items ?? [];
        need(items.length > 0, `the feed after seq ${c.data.finalSeq} is empty although a signed write just happened: the write produced no event, pick another --write-route`);
        const seqs = items.map((x) => x.seq);
        // The next event is D1's AUTOINCREMENT counter + 1 (which is last + 1 unless events were deleted from the tail: then the counter,
        // not MAX(seq), is what clients saw as "next" on D1 and what the image carried over).
        const expectFirst = (c.data.eventsCounter ?? c.data.finalSeq) + 1;
        need(seqs[0] === expectFirst && seqs.every((s, i) => i === 0 || s === seqs[i - 1] + 1), `feed contiguity (CV17): D1's last seq was ${c.data.finalSeq} and its counter ${c.data.eventsCounter}, so the feed must continue with ${expectFirst}, it continues with ${seqs.slice(0, 5).join(", ")}`);
        checks.feed = { since: c.data.finalSeq, expectedFirst: expectFirst, first: seqs[0], count: seqs.length };
        const meta = await c.ports.http.request(`${o.publicUrl}/v1/meta`, { method: "GET" });
        const etag = lc(meta.headers).etag;
        need(etag, "GET /v1/meta carries no ETag");
        const cond = await c.ports.http.request(`${o.publicUrl}/v1/meta`, { method: "GET", headers: { "if-none-match": etag } });
        need(cond.status === 304, `If-None-Match answered ${cond.status}, expected 304`);
        checks.etag304 = { etag, status: cond.status };
        return { message: "signed write, If-Match 409 stale, feed contiguous from last+1, ETag 304", proof: checks };
      },
    },
    {
      id: "report",
      title: "write the report (timings per step, the write pause, every proof)",
      commands: () => [`write ${o.report}`],
      async run(c) {
        const md = renderReport(c.state, o);
        fs.mkdirSync(path.dirname(o.report), { recursive: true });
        fs.writeFileSync(o.report, md);
        return { message: `${o.report}` };
      },
    },
  ];
}

/** Steps that undo the freeze when nothing reached AWS yet (`run.mjs --abort`). */
export function abortSteps(o) {
  return [
    {
      id: "abort",
      title: "clear cutover.mode on D1 (nothing is in the AWS log yet) and prove writes are accepted again",
      commands: () => [`aws dynamodb get-item ... HEAD   # must be empty`, `wrangler d1 execute ${o.d1Name} --remote --command "${CLEAR_MODE_SQL}"`, `curl -s -X POST ${o.workerUrl}/v1/layouts   # not 503`],
      async precondition(c) {
        const head = await c.ports.aws.logHead();
        need(head === 0, `the AWS log already holds the image (head ${head}): this is a rollback, use scripts/cutover/rollback.mjs`);
      },
      async run(c) {
        await c.ports.d1.write(CLEAR_MODE_SQL, o.d1Name);
        need((await d1Mode(c.ports, o.d1Name)) === null, "D1 still has cutover.mode set");
        await c.ports.clock.sleep(o.cacheWaitMs);
        const probe = await writeProbe(c.ports, o.workerUrl);
        need(probe.open, `writes are not accepted again: the signed probe answered ${probe.status} (${probe.reason}), expected 400.${inconclusive(probe)}`);
        const pauseMs = c.data.freezeAt === undefined ? null : c.ports.clock.now() - c.data.freezeAt;
        return { message: `D1 writable again${pauseMs === null ? "" : ` after ${pauseMs} ms`}`, proof: { probe, pauseMs } };
      },
    },
  ];
}

/** The markdown report: timings per step, the write pause, and every proof, from the state file alone. */
export function renderReport(state, o) {
  const lines = [`# akldb cutover report`, "", `State created ${state.createdAt}. D1 \`${o.d1Name}\`, stack \`${o.stack}\`, Worker ${o.workerUrl}, public name ${o.publicUrl}.`, ""];
  const s = state.steps;
  const pause = state.data.pauseMs;
  lines.push("## Write pause", "", pause === undefined ? "Not measured (the run never reached `open`)." : `**${pause} ms** (${(pause / 1000).toFixed(1)} s) from the freeze write to the unit that cleared \`cutover.mode\` on AWS. Gate: at most 300000 ms.`, "");
  lines.push("## Steps", "", "| step | status | ms | result |", "|---|---|---|---|");
  for (const [id, st] of Object.entries(s)) lines.push(`| ${id} | ${st.status === "running" && id === "report" ? "this report" : st.status} | ${st.ms ?? ""} | ${(st.message ?? "").replaceAll("|", "\\|")} |`);
  lines.push("", "## Proofs", "");
  const proofOf = (id) => s[id]?.proof;
  const v = proofOf("verify");
  if (v) {
    const lostRows = Object.entries(v.lostOnAws ?? {});
    lines.push("### verify (CV16, CV17, CV26)", "", `The image equals the export file on ${v.fidelity?.tables} tables (${v.fidelity?.rows} rows) and live D1 on every table outside the read-path drift set. meta.seq ${v.metaSeq}; sqlite_sequence for events ${v.eventsCounter} (the next event is seq ${v.eventsCounter + 1}). Verify took ${v.verifyMs} ms${v.d1Calls ? ` and ${v.d1Calls} D1 calls` : ""}.`, "", lostRows.length === 0 ? "**Lost on AWS: read-path bookkeeping since the export: none.**" : `**Lost on AWS: read-path bookkeeping (nonces / auth_cache / authors.last_seen_at and renames) since the export, not a failure:** ${lostRows.map(([t, n]) => `${t} +${n} row(s)`).join(", ")}; drift columns that differed: ${Object.entries(v.drift ?? {}).filter(([, d]) => Object.keys(d.columnsDiffering).length > 0).map(([t, d]) => `${t}.${Object.keys(d.columnsDiffering).join("/")}`).join(", ") || "none"}.`, "", "| table | rows | checksum |", "|---|---|---|");
    for (const [t, p] of Object.entries(v.perTable ?? {})) lines.push(`| ${t} | ${p.count} | \`${p.checksum.slice(0, 16)}\` |`);
    lines.push("");
  }
  for (const id of ["preflight", "copy-dumps", "freeze", "export", "load", "image", "serve", "dns", "open", "post-smoke"]) {
    const p = proofOf(id);
    if (p) lines.push(`### ${id}`, "", "```json", JSON.stringify(p, null, 2).slice(0, 4000), "```", "");
  }
  lines.push("## Data", "", "```json", JSON.stringify({ bookmark: state.data.bookmark, freezeSeq: state.data.freezeSeq, finalSeq: state.data.finalSeq, imageSha: state.data.imageSha, imageBytes: state.data.imageBytes, imageUnit: state.data.imageUnit, openSeq: state.data.openSeq }, null, 2), "```", "");
  return lines.join("\n");
}
