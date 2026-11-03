// The cutover plan (LDB-CV2, CV3, CV11): D1 + Worker -> AWS design A. Pure orchestration over injected `ports` (see ports-real.mjs for
// the real ones and tests/cutover/world.ts for the fakes), so every step is testable without a network.
//
// Write pause: from the freeze (the first D1 write of `cutover.mode`) until `open` clears the flag on AWS. Everything between is
// read-only for clients: reads keep working (D1 until `proxy`, AWS after it).
//
//  preflight -> freeze -> export -> load -> verify -> image -> serve -> proxy -> open -> post-smoke -> report
//
// Failure policy: before `image` nothing on AWS changed; `--abort` clears D1's flag. After `image`, `open` has not happened yet:
// rollback.mjs variant A. After `open`: rollback.mjs variant B. Nothing is undone automatically.
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { SEQUENCE_TABLE, compareProofs, feedPosition, localSelect, proveAll, provenTables } from "./checksum.mjs";
import { fail, need } from "./machine.mjs";
import { loadExportSql, sanityChecks, tablesCreatedBy } from "./sqlfile.mjs";

export const MODE_KEY = "cutover.mode";
export const setModeSql = (mode) => `INSERT INTO import_state (key, value) VALUES ('${MODE_KEY}', '${mode}') ON CONFLICT(key) DO UPDATE SET value = excluded.value`;
export const CLEAR_MODE_SQL = `DELETE FROM import_state WHERE key = '${MODE_KEY}'`;
const readModeSql = `SELECT value FROM import_state WHERE key = '${MODE_KEY}'`;

/** The caches of the mode flag are 1 s; waiting this long makes the flip visible everywhere (saltorbit's 3 s). */
export const CACHE_WAIT_MS = 3000;
export const AWS_HEADER = "x-akldb-backend";

const sha256File = (file) => crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
const sha256 = (b) => crypto.createHash("sha256").update(b).digest("hex");
const lc = (h) => Object.fromEntries(Object.entries(h ?? {}).map(([k, v]) => [k.toLowerCase(), v]));

/** A harmless probe: an empty POST /v1/layouts is a 400/401/403 when writes are open and a 503 read_only when they are frozen. */
export async function writeProbe(ports, base) {
  const r = await ports.http.request(`${base}/v1/layouts`, { method: "POST", headers: { "content-type": "application/json" }, body: "" });
  const frozen = r.status === 503;
  let reason = null;
  try {
    reason = JSON.parse(r.body)?.error ?? null;
  } catch {
    reason = null;
  }
  return { status: r.status, frozen, readOnly: frozen && (reason === "read_only" || /read_only/.test(r.body)), retryAfter: lc(r.headers)["retry-after"] ?? null, backend: lc(r.headers)[AWS_HEADER] ?? null, reason };
}

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

async function readsEqual(ports, o, paths) {
  const checks = [];
  for (const p of paths) {
    const [a, b] = await Promise.all([ports.http.request(`${o.workerUrl}${p}`, { method: "GET" }), ports.http.request(`${o.awsUrl}${p}`, { method: "GET" })]);
    const norm = p.startsWith("/v1/meta") ? normalizeMeta : (x) => x;
    const ea = lc(a.headers).etag ?? null;
    const eb = lc(b.headers).etag ?? null;
    checks.push({ path: p, status: [a.status, b.status], bodyEqual: a.status === b.status && norm(a.body) === norm(b.body), etagEqual: ea === eb, etag: eb });
  }
  return checks;
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
        need(probe.readOnly, `the Worker did not refuse writes after the freeze: POST /v1/layouts with an empty body answered ${probe.status} (${probe.reason ?? "no reason"}), not 503 read_only. The Worker build lacks the modes or the flag is not read; clear it with --abort`);
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
      title: "prove every table (COUNT and checksum), meta.seq and the next-seq rule equal on SQLite and D1",
      commands: () => [`node:sqlite  SELECT rowid, * FROM <table> ORDER BY rowid LIMIT ${o.pageRows}   # per table, on ${imageFile()}`, R(`SELECT rowid AS __rid, * FROM <table> WHERE rowid > <n> ORDER BY rowid LIMIT ${o.pageRows}`) + "   # per table, paged", R("SELECT COALESCE(MAX(seq), 0) AS seq FROM events"), R("SELECT name, seq FROM sqlite_sequence")],
      async precondition(c) {
        need(c.state.steps.load?.status === "done", "the load has not run");
        need(fs.existsSync(imageFile()) && sha256File(imageFile()) === c.data.imageSha, "the image file changed since the load step recorded it");
        need((await d1Mode(c.ports, db)) === "read_only", "D1 is not frozen any more: its data may have moved after the export");
      },
      async run(c) {
        const local = new DatabaseSync(":memory:");
        local.deserialize(fs.readFileSync(imageFile())); // the bytes that will be the log's image, not the loader's handle
        try {
          const d1select = (sql) => c.ports.d1.select(sql, db);
          const t0 = c.ports.clock.now();
          const [localProof, remoteProof] = [await proveAll({ select: localSelect(local), db: local, pageRows: o.pageRows }), await proveAll({ select: d1select, db: local, pageRows: o.pageRows, concurrency: o.concurrency })];
          const cmp = compareProofs(localProof, remoteProof, { left: "sqlite", right: "d1" });
          const lp = await feedPosition(localSelect(local));
          const rp = await feedPosition(d1select);
          const problems = [];
          for (const d of cmp.diffs) problems.push(`${d.table}: ${d.field} sqlite ${d.sqlite} != d1 ${d.d1}`);
          if (lp.metaSeq !== rp.metaSeq) problems.push(`meta.seq: sqlite ${lp.metaSeq} != d1 ${rp.metaSeq}`);
          if (lp.eventsCounter !== rp.eventsCounter) problems.push(`next-seq rule (CV3): sqlite_sequence for events is ${lp.eventsCounter}, D1's is ${rp.eventsCounter}`);
          if (rp.eventsCounter !== null && rp.eventsCounter < rp.metaSeq) problems.push(`D1's own sqlite_sequence (${rp.eventsCounter}) is below MAX(seq) (${rp.metaSeq})`);
          const schemaSql = "SELECT type, name, tbl_name, sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%' ORDER BY type, name";
          const [ls, rs] = [localSelect(local)(schemaSql), await d1select(schemaSql)];
          const key = (r) => JSON.stringify([r.type, r.name, r.tbl_name, r.sql]);
          const lset = new Set(ls.map(key));
          const rset = new Set(rs.map(key));
          for (const k of lset) if (!rset.has(k)) problems.push(`schema: ${JSON.parse(k)[0]} ${JSON.parse(k)[1]} differs or is missing on D1`);
          for (const k of rset) if (!lset.has(k)) problems.push(`schema: ${JSON.parse(k)[0]} ${JSON.parse(k)[1]} is on D1 but not in the export`);
          const proof = { ok: problems.length === 0, tables: cmp.tables, rows: cmp.rows, metaSeq: rp.metaSeq, eventsCounter: rp.eventsCounter, verifyMs: c.ports.clock.now() - t0, problems, perTable: localProof };
          if (!proof.ok) {
            const e = new Error(`VERIFY FAILED, nothing was written to AWS: ${problems.slice(0, 8).join(" | ")}${problems.length > 8 ? ` (+${problems.length - 8} more)` : ""}`);
            e.proof = proof;
            throw e;
          }
          c.data.finalSeq = rp.metaSeq;
          c.data.eventsCounter = rp.eventsCounter;
          c.data.tables = localProof;
          return { message: `${cmp.tables} tables, ${cmp.rows} rows, meta.seq ${rp.metaSeq}, events counter ${rp.eventsCounter}: all equal`, proof };
        } finally {
          local.close();
        }
      },
    },
    {
      id: "image",
      title: "append the image to the prod log as seq 1 (S3 spill + conditional append), then write the snapshot pointer at seq 1",
      commands: () => [`aws s3api put-object --bucket <DataBucket> --key log/<unitId>.image.zst --body <zstd ${imageFile()}>   # via the replica kit`, `aws dynamodb transact-write-items   # Put LOG#000000000001 (kind image) if absent + Update HEAD seq=1 if absent`, `aws s3api put-object --bucket <DataBucket> --key snap/slot-0.sqlite.zst   # + the SNAP/POINTER item at seq 1`],
      async precondition(c) {
        const v = c.state.steps.verify;
        need(v?.status === "done" && v.proof?.ok === true, "CV2: the image is appended only after verify passed (counts, checksums and meta.seq equal)");
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
      title: "invoke migrate (a no-op: the image is complete) and warm k=4, then compare reads straight against the prod stack with D1's",
      commands: () => [
        `aws lambda invoke --function-name <FunctionName> --qualifier live --payload '{"akldb":"migrate"}' out.json   # applied: [], seq 1`,
        `aws lambda invoke --function-name <FunctionName> --qualifier live --payload '{"akldb":"warm","k":4}' out.json`,
        `for p in /v1/meta '/v1/layouts?limit=20' /v1/layouts/<id1> /v1/layouts/<id2> /v1/layouts/<id3>; do curl -si ${o.workerUrl}$p; curl -si ${o.awsUrl}$p; done   # equal bodies and ETags`,
      ],
      async precondition(c) {
        need(c.state.steps.image?.status === "done", "the image has not been appended");
        need((await c.ports.aws.logHead()) >= 1, "the AWS log is empty");
      },
      async run(c) {
        const mig = await c.ports.aws.invoke({ akldb: "migrate" });
        need(mig?.ok === true && mig.awaiting === undefined, `migrate answered ${JSON.stringify(mig)}: the image is not visible to the function`);
        need(Array.isArray(mig.applied) && mig.applied.length === 0, `migrate applied ${JSON.stringify(mig.applied)}: the bundle ships migrations the image lacks (the load step checks this; the deployed code differs from the repo?)`);
        need(mig.seq >= 1, `migrate saw seq ${mig.seq}`);
        const warm = await c.ports.aws.invoke({ akldb: "warm", k: 4 });
        need(warm?.ok === true, `warm answered ${JSON.stringify(warm)}`);
        need(warm.warmup === "ok", `warm: the warm-up read is ${warm.warmup}, not ok`);
        const list = await c.ports.http.request(`${o.awsUrl}/v1/layouts?limit=20`, { method: "GET" });
        need(list.status === 200, `GET ${o.awsUrl}/v1/layouts?limit=20 answered ${list.status}`);
        const ids = (JSON.parse(list.body).items ?? []).slice(0, 3).map((x) => x.id);
        need(ids.length === 3, `the list page has ${ids.length} layouts, the smoke needs 3`);
        const paths = ["/v1/meta", "/v1/layouts?limit=20", ...ids.map((id) => `/v1/layouts/${id}`)];
        const checks = await readsEqual(c.ports, o, paths);
        const bad = checks.filter((x) => !x.bodyEqual || !x.etagEqual || x.status[0] !== 200);
        need(bad.length === 0, `reads differ between D1 and the prod stack: ${bad.map((x) => `${x.path} status ${x.status} body ${x.bodyEqual ? "=" : "!="} etag ${x.etagEqual ? "=" : "!="}`).join("; ")}`);
        const head = await c.ports.http.request(`${o.awsUrl}/v1/meta`, { method: "GET" });
        need(lc(head.headers)[AWS_HEADER] === "aws", `${o.awsUrl} answers without ${AWS_HEADER}: aws (CV13): is the Transform Rule/CNAME for aws-api.akldb.org pointing at the prod stack?`);
        return { message: `migrate no-op at seq ${mig.seq}, warm ${warm.containers?.length ?? "?"} containers, ${checks.length} reads equal`, proof: { migrate: mig, warm: { containers: warm.containers, warmup: warm.warmup }, checks } };
      },
    },
    {
      id: "proxy",
      title: "set cutover.mode=proxy on D1 and prove api.akldb.org now answers from AWS",
      commands: () => [W(setModeSql("proxy")), `sleep ${o.cacheWaitMs / 1000}`, `curl -si ${o.workerUrl}/v1/meta   # ${AWS_HEADER}: aws`, `curl -si -X POST ${o.workerUrl}/v1/layouts   # 503 read_only, ${AWS_HEADER}: aws (AWS is still frozen)`],
      async precondition(c) {
        need(c.state.steps.serve?.status === "done", "the prod stack has not been proven to serve");
        need((await d1Mode(c.ports, db)) !== null, "D1 is not frozen (cutover.mode unset)");
      },
      async run(c) {
        await c.ports.d1.write(setModeSql("proxy"), db);
        need((await d1Mode(c.ports, db)) === "proxy", "D1 did not take cutover.mode=proxy");
        await c.ports.clock.sleep(o.cacheWaitMs);
        const meta = await c.ports.http.request(`${o.workerUrl}/v1/meta`, { method: "GET" });
        need(meta.status === 200, `GET ${o.workerUrl}/v1/meta answered ${meta.status} in proxy mode`);
        const h = lc(meta.headers);
        need(h[AWS_HEADER] === "aws", `through the Worker the answer has no ${AWS_HEADER}: aws (X-Akldb-Proxied: ${h["x-akldb-proxied"] ?? "absent"}): the Worker is not proxying, or the proxy strips the header`);
        // AWS answers: still frozen at D1's last seq, or (a re-run after `open`) already past it
        const awsFrozen = (await c.ports.aws.operator.readFlag()) === "read_only";
        const seq = JSON.parse(meta.body).seq;
        need(awsFrozen ? seq === c.data.finalSeq : seq >= c.data.finalSeq, `through the proxy meta.seq is ${seq}, expected ${awsFrozen ? "" : "at least "}${c.data.finalSeq}`);
        const probe = await writeProbe(c.ports, o.workerUrl);
        need(probe.backend === "aws" && probe.readOnly === awsFrozen, `a write through the proxy answered ${probe.status} (${probe.reason}) from ${probe.backend ?? "the Worker"}: expected ${awsFrozen ? "503 read_only" : "an open write path"} from AWS`);
        return { message: `api.akldb.org answers from AWS (${AWS_HEADER}: aws); writes ${awsFrozen ? "still 503 read_only" : "open"}, from AWS`, proof: { meta: { status: meta.status, headers: { [AWS_HEADER]: h[AWS_HEADER], "x-akldb-proxied": h["x-akldb-proxied"] ?? null } }, probe } };
      },
    },
    {
      id: "open",
      title: "clear cutover.mode on AWS: a unit appended through the prod log as the operator (never the public API)",
      commands: () => [`node:operator  Replica(DynamoDB log akldb-prod-log, operator credentials).runUnit("${CLEAR_MODE_SQL}")`, `curl -si -X POST ${o.workerUrl}/v1/layouts   # no longer 503`],
      async precondition(c) {
        // CV2: writes open only after counts, checksums and meta.seq were proven equal, for THE image that is in the log.
        const v = c.state.steps.verify;
        need(v?.status === "done" && v.proof?.ok === true, "CV2: writes open only after verify passed (counts, checksums, meta.seq equal)");
        for (const id of ["image", "serve", "proxy"]) need(c.state.steps[id]?.status === "done", `CV2: writes open only after ${id} is done`);
        const first = await c.ports.aws.firstEntry();
        need(first?.kind === "image" && first.hash === c.data.imageSha, "CV2: the image in the AWS log is not the one verify proved");
        need((await d1Mode(c.ports, db)) === "proxy", "D1 is not in proxy mode: the Worker would not send clients to AWS");
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
        const probe = await writeProbe(c.ports, o.workerUrl);
        need(!probe.frozen, `writes are still refused after the flag was cleared (${probe.status} ${probe.reason}): the AWS flag cache or the Worker`);
        need(probe.backend === "aws", `the write probe was answered by ${probe.backend ?? "the Worker"}, not AWS`);
        const pauseMs = c.data.openedAt - c.data.freezeAt;
        c.data.pauseMs = pauseMs;
        return { message: `writes open at AWS seq ${seq}; write pause ${pauseMs} ms (freeze -> open)`, proof: { openSeq: seq, pauseMs, probe, wasAlreadyOpen: flag === null } };
      },
    },
    {
      id: "post-smoke",
      title: "a signed write with the ops client, If-Match 412 on a stale rev, feed contiguity and ETag 304 through api.akldb.org",
      commands: () => [`node scripts/client-sign.mjs ${o.writeMethod} ${o.writePath}   # the signed write (default: the manual nightly tick, a harmless event)`, `curl -s -X PATCH -H 'If-Match: "<stale>"' ${o.workerUrl}/v1/layouts/<id>   # 412`, `curl -s '${o.workerUrl}/v1/changes?since=<D1 last seq>'   # starts at last+1`, `curl -si -H 'If-None-Match: <etag>' ${o.workerUrl}/v1/meta   # 304`],
      async precondition(c) {
        need(c.state.steps.open?.status === "done", "writes are not open yet");
      },
      async run(c) {
        const checks = {};
        const write = await c.ports.http.signed(o.writeMethod, `${o.workerUrl}${o.writePath}`, { body: o.writeBody });
        need(write.status >= 200 && write.status < 300, `the signed write ${o.writeMethod} ${o.writePath} answered ${write.status}: ${write.body.slice(0, 200)}`);
        checks.signedWrite = { status: write.status, backend: lc(write.headers)[AWS_HEADER] ?? null };
        const list = JSON.parse((await c.ports.http.request(`${o.workerUrl}/v1/layouts?limit=1`, { method: "GET" })).body);
        const id = list.items?.[0]?.id;
        need(id !== undefined, "no layout to run the If-Match probe against");
        const one = await c.ports.http.request(`${o.workerUrl}/v1/layouts/${id}`, { method: "GET" });
        const tag = lc(one.headers).etag ?? "";
        const m = /^"?(.*?):?(\d+)"?$/.exec(tag);
        need(m !== null, `layout ${id} carries no ETag of the form "<scope>:<rev>" (${tag})`);
        const stale = `"${m[1]}:${Number(m[2]) + 1000}"`;
        const patch = await c.ports.http.signed("PATCH", `${o.workerUrl}/v1/layouts/${id}`, { body: JSON.stringify({ name: JSON.parse(one.body).name }), headers: { "if-match": stale } });
        need(patch.status === 412, `PATCH with a stale If-Match answered ${patch.status}, expected 412`);
        checks.ifMatch = { id, sent: stale, status: patch.status };
        const feed = await c.ports.http.request(`${o.workerUrl}/v1/changes?since=${c.data.finalSeq}&limit=50`, { method: "GET" });
        need(feed.status === 200, `GET /v1/changes?since=${c.data.finalSeq} answered ${feed.status}`);
        const items = JSON.parse(feed.body).items ?? [];
        need(items.length > 0, `the feed after seq ${c.data.finalSeq} is empty although a signed write just happened: the write produced no event, pick another --write-route`);
        const seqs = items.map((x) => x.seq);
        // The next event is D1's AUTOINCREMENT counter + 1 (which is last + 1 unless events were deleted from the tail: then the counter,
        // not MAX(seq), is what clients saw as "next" on D1 and what the image carried over).
        const expectFirst = (c.data.eventsCounter ?? c.data.finalSeq) + 1;
        need(seqs[0] === expectFirst && seqs.every((s, i) => i === 0 || s === seqs[i - 1] + 1), `feed contiguity (CV3): D1's last seq was ${c.data.finalSeq} and its counter ${c.data.eventsCounter}, so the feed must continue with ${expectFirst}, it continues with ${seqs.slice(0, 5).join(", ")}`);
        checks.feed = { since: c.data.finalSeq, expectedFirst: expectFirst, first: seqs[0], count: seqs.length };
        const meta = await c.ports.http.request(`${o.workerUrl}/v1/meta`, { method: "GET" });
        const etag = lc(meta.headers).etag;
        need(etag, "GET /v1/meta carries no ETag");
        const cond = await c.ports.http.request(`${o.workerUrl}/v1/meta`, { method: "GET", headers: { "if-none-match": etag } });
        need(cond.status === 304, `If-None-Match answered ${cond.status}, expected 304`);
        checks.etag304 = { etag, status: cond.status };
        return { message: "signed write, If-Match 412, feed contiguous from last+1, ETag 304", proof: checks };
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
        need(!probe.frozen, `writes are still refused (${probe.status} ${probe.reason})`);
        const pauseMs = c.data.freezeAt === undefined ? null : c.ports.clock.now() - c.data.freezeAt;
        return { message: `D1 writable again${pauseMs === null ? "" : ` after ${pauseMs} ms`}`, proof: { probe, pauseMs } };
      },
    },
  ];
}

/** The markdown report: timings per step, the write pause, and every proof, from the state file alone. */
export function renderReport(state, o) {
  const lines = [`# akldb cutover report`, "", `State created ${state.createdAt}. D1 \`${o.d1Name}\`, stack \`${o.stack}\`, Worker ${o.workerUrl}, AWS ${o.awsUrl}.`, ""];
  const s = state.steps;
  const pause = state.data.pauseMs;
  lines.push("## Write pause", "", pause === undefined ? "Not measured (the run never reached `open`)." : `**${pause} ms** (${(pause / 1000).toFixed(1)} s) from the freeze write to the unit that cleared \`cutover.mode\` on AWS. Gate: at most 300000 ms.`, "");
  lines.push("## Steps", "", "| step | status | ms | result |", "|---|---|---|---|");
  for (const [id, st] of Object.entries(s)) lines.push(`| ${id} | ${st.status === "running" && id === "report" ? "this report" : st.status} | ${st.ms ?? ""} | ${(st.message ?? "").replaceAll("|", "\\|")} |`);
  lines.push("", "## Proofs", "");
  const proofOf = (id) => s[id]?.proof;
  const v = proofOf("verify");
  if (v) {
    lines.push("### verify (CV2, CV3)", "", `${v.tables} tables, ${v.rows} rows: counts and checksums equal on SQLite and D1. meta.seq ${v.metaSeq}; sqlite_sequence for events ${v.eventsCounter} (the next event is seq ${v.eventsCounter + 1}). Verify took ${v.verifyMs} ms.`, "", "| table | rows | checksum |", "|---|---|---|");
    for (const [t, p] of Object.entries(v.perTable ?? {})) lines.push(`| ${t} | ${p.count} | \`${p.checksum.slice(0, 16)}\` |`);
    lines.push("");
  }
  for (const id of ["preflight", "freeze", "export", "load", "image", "serve", "proxy", "open", "post-smoke"]) {
    const p = proofOf(id);
    if (p) lines.push(`### ${id}`, "", "```json", JSON.stringify(p, null, 2).slice(0, 4000), "```", "");
  }
  lines.push("## Data", "", "```json", JSON.stringify({ bookmark: state.data.bookmark, freezeSeq: state.data.freezeSeq, finalSeq: state.data.finalSeq, imageSha: state.data.imageSha, imageBytes: state.data.imageBytes, imageUnit: state.data.imageUnit, openSeq: state.data.openSeq }, null, 2), "```", "");
  return lines.join("\n");
}
