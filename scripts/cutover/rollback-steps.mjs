// The rollback plan (LDB-CV18, CV11): AWS back to Cloudflare. Pure orchestration over the same ports as the cutover.
//
// Two variants, decided by the first step from the AWS log:
//   original-d1  AWS head is 1: the image is the only entry, no write reached AWS (the `open` step never ran). The ORIGINAL D1 is
//                still exactly the freeze state: put it back to read_only, prove it equals the image, clear its flag. AWS stays read_only.
//   fresh-d1     any later head: AWS took writes (even just the open unit). Freeze AWS, take its database at the head, import it into
//                a FRESH D1, prove it equal, point the Worker at it (a PR in practice), clear the flag there. The old D1 is not touched.
//
//  decide -> aws-readonly -> capture -> [original-d1: d1-refreeze -> d1-prove]  [fresh-d1: create-d1 -> import -> verify -> point-worker]
//         -> reopen -> report
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import crypto from "node:crypto";
import { compareProofs, feedPosition, localSelect, proveAll } from "./checksum.mjs";
import { CLEAR_MODE_SQL, d1Mode, setModeSql, writeProbe } from "./cutover-steps.mjs";
import { fail, need } from "./machine.mjs";
import { dumpToSql } from "./sqlfile.mjs";

const sha256 = (b) => crypto.createHash("sha256").update(b).digest("hex");

export function steps(o) {
  const imageFile = () => path.join(o.work, "rollback-image.sqlite");
  const sqlFile = () => path.join(o.work, "rollback-import.sql");
  const original = (c) => c.data.variant === "original-d1";
  const onlyFresh = (c) => (original(c) ? "variant original-d1: the original D1 is reused" : null);
  const onlyOriginal = (c) => (original(c) ? null : "variant fresh-d1: a new D1 is built");
  const target = (c) => (original(c) ? o.d1Name : c.data.newD1?.name);
  const withImage = async (c, fn) => {
    const db = new DatabaseSync(":memory:");
    db.deserialize(fs.readFileSync(imageFile()));
    try {
      return await fn(db);
    } finally {
      db.close();
    }
  };

  return [
    {
      id: "decide",
      title: "read the AWS log and choose the variant (head 1 = no write since the image: the original D1)",
      commands: () => [`aws dynamodb get-item --table-name <LogTable> --key '{"pk":{"S":"HEAD"},"sk":{"S":"HEAD"}}' --consistent-read   # head 1 -> original-d1, else fresh-d1`],
      async run(c) {
        const first = await c.ports.aws.firstEntry();
        need(first?.kind === "image", "this AWS log has no image as seq 1: it never took the cutover, there is nothing to roll back from");
        const head = await c.ports.aws.logHead();
        const auto = head === 1 ? "original-d1" : "fresh-d1";
        if (o.variant !== undefined) {
          need(["original-d1", "fresh-d1"].includes(o.variant), "--variant is original-d1 or fresh-d1");
          need(!(o.variant === "original-d1" && head !== 1), `--variant original-d1 is impossible: AWS took ${head - 1} entries after the image, the original D1 no longer equals AWS`);
        }
        c.data.variant = o.variant ?? auto;
        c.data.awsHead = head;
        c.data.imageTables = first.image?.tables ?? null;
        const mode = await d1Mode(c.ports, o.d1Name).catch(() => "unreadable");
        return { message: `AWS head ${head}: variant ${c.data.variant} (the original D1's cutover.mode is ${mode ?? "unset"})`, proof: { head, variant: c.data.variant, originalD1Mode: mode } };
      },
    },
    {
      id: "aws-readonly",
      title: "AWS read_only: append cutover.mode='read_only' to the AWS log as the operator and prove writes are refused",
      commands: () => [`node:operator  runUnit("${setModeSql("read_only")}")`, `curl -s -X POST ${o.awsUrl}/v1/layouts   # 503 read_only`],
      async precondition(c) {
        need(c.data.variant !== undefined, "decide has not run");
      },
      async run(c) {
        const flag = await c.ports.aws.operator.readFlag();
        let appended = false;
        if (flag !== "read_only") {
          need(!original(c), `variant original-d1 expects the image's cutover.mode=read_only on AWS, found ${flag}`);
          await c.ports.aws.operator.runUnit(setModeSql("read_only"));
          appended = true;
        }
        need((await c.ports.aws.operator.readFlag()) === "read_only", "AWS did not take cutover.mode=read_only");
        c.data.awsFrozenAt ??= c.ports.clock.now();
        await c.ports.clock.sleep(o.cacheWaitMs);
        const probe = await writeProbe(c.ports, o.awsUrl);
        need(probe.readOnly, `AWS still accepts writes: POST /v1/layouts answered ${probe.status} (${probe.reason})`);
        return { message: `AWS is read_only${appended ? " (flag appended)" : " (already)"}`, proof: { probe, appended } };
      },
    },
    {
      id: "capture",
      title: "boot a local replica to the AWS head, serialize its database",
      commands: () => [`node:operator  bootReplica(log).capture() -> ${imageFile()}`],
      async precondition(c) {
        need(c.state.steps["aws-readonly"]?.status === "done", "AWS has not been frozen");
      },
      async run(c) {
        const head = await c.ports.aws.logHead();
        const cap = await c.ports.aws.operator.capture();
        const after = await c.ports.aws.logHead();
        need(cap.seq === head && after === head, `the AWS log moved during the capture (head ${head} -> ${after}, captured ${cap.seq}): it is not frozen. Re-run capture`);
        fs.mkdirSync(o.work, { recursive: true });
        fs.writeFileSync(imageFile(), cap.bytes);
        c.data.captureSeq = cap.seq;
        c.data.captureSha = sha256(cap.bytes);
        const tables = await withImage(c, (db) => proveAll({ select: localSelect(db), db, pageRows: o.pageRows }));
        c.data.captureTables = tables;
        const pos = await withImage(c, (db) => feedPosition(localSelect(db)));
        c.data.captureFeed = pos;
        return { message: `AWS log seq ${cap.seq}, ${cap.bytes.byteLength} bytes, events seq ${pos.metaSeq}, sha256 ${c.data.captureSha.slice(0, 12)}`, proof: { seq: cap.seq, sha256: c.data.captureSha, feed: pos } };
      },
    },
    // ---- variant original-d1 ----
    {
      id: "d1-refreeze",
      title: "[original-d1] put the original D1 back to read_only (the freeze state) and prove the Worker answers from it again",
      commands: () => [`wrangler d1 execute ${o.d1Name} --remote --command "${setModeSql("read_only")}"`, `curl -s -X POST ${o.workerUrl}/v1/layouts   # 503 read_only, from the Worker (no ${"x-akldb-backend"})`],
      skip: onlyOriginal,
      async precondition(c) {
        need(c.state.steps.capture?.status === "done", "capture has not run");
      },
      async run(c) {
        await c.ports.d1.write(setModeSql("read_only"), o.d1Name);
        need((await d1Mode(c.ports, o.d1Name)) === "read_only", "D1 did not take cutover.mode=read_only");
        await c.ports.clock.sleep(o.cacheWaitMs);
        const probe = await writeProbe(c.ports, o.workerUrl);
        need(probe.readOnly && probe.backend !== "aws", `the Worker still proxies or accepts writes: ${probe.status} ${probe.reason} from ${probe.backend ?? "the Worker"}`);
        return { message: "the Worker serves from the original D1 again, frozen", proof: { probe } };
      },
    },
    {
      id: "d1-prove",
      title: "[original-d1] prove the original D1 still equals the image (CV18): every table's count and checksum, meta.seq, the events counter",
      commands: () => [`wrangler d1 execute ${o.d1Name} --remote --json --command "SELECT rowid AS __rid, * FROM <table> ..."   # per table, paged`],
      skip: onlyOriginal,
      async run(c) {
        const remote = await withImage(c, (db) => proveAll({ select: (sql) => c.ports.d1.select(sql, o.d1Name), db, pageRows: o.pageRows, concurrency: o.concurrency }));
        const cmp = compareProofs(c.data.captureTables, remote, { left: "aws", right: "d1" });
        const cmpImage = c.data.imageTables === null ? { ok: true, diffs: [] } : compareProofs(c.data.imageTables, remote, { left: "image", right: "d1" });
        const pos = await feedPosition((sql) => c.ports.d1.select(sql, o.d1Name));
        const problems = [...cmp.diffs.map((d) => `${d.table}: ${d.field} aws ${d.aws} != d1 ${d.d1}`), ...cmpImage.diffs.map((d) => `${d.table}: ${d.field} (vs the cutover image) image ${d.image} != d1 ${d.d1}`)];
        if (pos.metaSeq !== c.data.captureFeed.metaSeq || pos.eventsCounter !== c.data.captureFeed.eventsCounter) problems.push(`feed position: d1 ${JSON.stringify(pos)} != aws ${JSON.stringify(c.data.captureFeed)}`);
        if (problems.length > 0) {
          const e = new Error(`the original D1 no longer equals the image (something wrote to it after the freeze): ${problems.slice(0, 6).join(" | ")}. Use --variant fresh-d1`);
          e.proof = { ok: false, problems };
          throw e;
        }
        return { message: `${cmp.tables} tables, ${cmp.rows} rows equal, events seq ${pos.metaSeq}`, proof: { ok: true, tables: cmp.tables, rows: cmp.rows, feed: pos } };
      },
    },
    // ---- variant fresh-d1 ----
    {
      id: "create-d1",
      title: `[fresh-d1] create ${o.newD1Name}`,
      commands: () => [`wrangler d1 create ${o.newD1Name}`],
      skip: onlyFresh,
      async run(c) {
        // Idempotent without the state: a crash between `wrangler d1 create` and the state write leaves a database that exists
        let found = null;
        try {
          found = await c.ports.d1.info(o.newD1Name);
        } catch {
          found = null;
        }
        const made = found ?? (await c.ports.d1.create(o.newD1Name));
        c.data.newD1 = { name: made.name, id: made.id };
        return { message: `${made.name} ${made.id}${found ? " (already existed)" : ""}`, proof: c.data.newD1 };
      },
    },
    {
      id: "import",
      title: "[fresh-d1] write the captured database as SQL (CREATE + INSERT, sqlite_sequence included) and import it",
      commands: () => [`node:sqlite  dump ${imageFile()} -> ${sqlFile()}`, `wrangler d1 execute ${o.newD1Name} --remote --file ${sqlFile()}`],
      skip: onlyFresh,
      async precondition(c) {
        need(c.data.newD1 !== undefined, "no fresh D1 was created");
      },
      async run(c) {
        const sql = await withImage(c, (db) => dumpToSql(db));
        fs.writeFileSync(sqlFile(), sql);
        const have = await c.ports.d1.select("SELECT count(*) AS n FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%'", c.data.newD1.name);
        let note = "";
        if (Number(have[0].n) > 0) {
          // an earlier run imported (or started to) and died before saving its state: importing again would collide with itself; verify judges what is there
          note = ` (the fresh D1 already has ${have[0].n} tables from an earlier run: not imported again, verify decides)`;
        } else {
          const t0 = c.ports.clock.now();
          await c.ports.d1.importFile(c.data.newD1.name, sqlFile());
          c.data.importMs = c.ports.clock.now() - t0;
        }
        return { message: `${fs.statSync(sqlFile()).size} bytes of SQL${c.data.importMs !== undefined ? ` imported in ${c.data.importMs} ms` : ""}${note}`, proof: { sqlBytes: fs.statSync(sqlFile()).size, importMs: c.data.importMs ?? null, note } };
      },
    },
    {
      id: "verify",
      title: "[fresh-d1] prove the fresh D1 equals the captured database (CV18): counts, checksums, meta.seq, the events counter",
      commands: () => [`wrangler d1 execute ${o.newD1Name} --remote --json --command "SELECT rowid AS __rid, * FROM <table> ..."   # per table, paged`],
      skip: onlyFresh,
      async run(c) {
        const name = c.data.newD1.name;
        const remote = await withImage(c, (db) => proveAll({ select: (sql) => c.ports.d1.select(sql, name), db, pageRows: o.pageRows, concurrency: o.concurrency }));
        const cmp = compareProofs(c.data.captureTables, remote, { left: "aws", right: "d1" });
        const pos = await feedPosition((sql) => c.ports.d1.select(sql, name));
        const problems = cmp.diffs.map((d) => `${d.table}: ${d.field} aws ${d.aws} != d1 ${d.d1}`);
        if (pos.metaSeq !== c.data.captureFeed.metaSeq) problems.push(`meta.seq: aws ${c.data.captureFeed.metaSeq} != fresh d1 ${pos.metaSeq}`);
        if (pos.eventsCounter !== c.data.captureFeed.eventsCounter) problems.push(`next-seq rule (CV17): sqlite_sequence for events aws ${c.data.captureFeed.eventsCounter} != fresh d1 ${pos.eventsCounter}`);
        if (problems.length > 0) {
          const e = new Error(`the fresh D1 does not equal AWS: ${problems.slice(0, 6).join(" | ")}. If the import was interrupted, delete it (wrangler d1 delete ${name}) and re-run from create-d1`);
          e.proof = { ok: false, problems };
          throw e;
        }
        return { message: `${cmp.tables} tables, ${cmp.rows} rows equal, events seq ${pos.metaSeq}`, proof: { ok: true, tables: cmp.tables, rows: cmp.rows, feed: pos } };
      },
    },
    {
      id: "point-worker",
      title: "[fresh-d1] point the Worker at the fresh D1 (a PR + deploy: manual) and prove it serves from it",
      commands: (c) => [
        `# 1. in wrangler.toml [[d1_databases]] (binding "DB"): database_name = "${o.newD1Name}"; database_id = "${c?.data?.newD1?.id ?? "<new id>"}"   # was akl-db / 53f596d5-9cb5-43b0-9026-17518d18052f`,
        `# 2. open a PR on akl-infra/db with that change, merge it, let the deploy job run (or: wrangler deploy --config wrangler.toml from the merged main)`,
        `# 3. then re-run this step with --worker-pointed:  node scripts/cutover/rollback.mjs --execute --from point-worker --worker-pointed`,
        `curl -s ${o.workerUrl}/v1/meta   # meta.seq == the fresh D1's, no x-akldb-backend header`,
      ],
      skip: onlyFresh,
      async run(c) {
        need(o.workerPointed, `MANUAL STEP. Change wrangler.toml's database_name/database_id to ${c.data.newD1.name}/${c.data.newD1.id}, merge the PR, deploy, then re-run with --worker-pointed`, { hint: "the Worker cannot be repointed from here: a D1 binding is deploy-time configuration" });
        const meta = await c.ports.http.request(`${o.workerUrl}/v1/meta`, { method: "GET" });
        need(meta.status === 200, `GET ${o.workerUrl}/v1/meta answered ${meta.status}`);
        need(JSON.parse(meta.body).seq === c.data.captureFeed.metaSeq, `the Worker's meta.seq is ${JSON.parse(meta.body).seq}, the fresh D1's is ${c.data.captureFeed.metaSeq}: it is not serving from the fresh D1 yet`);
        need((meta.headers["x-akldb-backend"] ?? null) !== "aws", "the Worker still proxies to AWS: its D1 flag is not read_only/direct");
        const probe = await writeProbe(c.ports, o.workerUrl);
        need(probe.readOnly && probe.backend !== "aws", `the Worker answered a write with ${probe.status} (${probe.reason}) from ${probe.backend ?? "the Worker"}: expected its own 503 read_only (the fresh D1 carries the AWS flag)`);
        return { message: "the Worker serves reads from the fresh D1 and refuses writes itself", proof: { metaSeq: c.data.captureFeed.metaSeq, probe } };
      },
    },
    {
      id: "reopen",
      title: "clear cutover.mode on the D1 the Worker serves from (direct mode) and prove writes are accepted",
      commands: (c) => [`wrangler d1 execute ${c?.data?.variant === "fresh-d1" ? o.newD1Name : o.d1Name} --remote --command "${CLEAR_MODE_SQL}"`, `curl -s -X POST ${o.workerUrl}/v1/layouts   # not 503`],
      async precondition(c) {
        const prove = original(c) ? "d1-prove" : "verify";
        const p = c.state.steps[prove];
        need(p?.status === "done" && p.proof?.ok === true, `CV18: writes reopen on D1 only after ${prove} proved it equal to AWS`);
        if (!original(c)) need(c.state.steps["point-worker"]?.status === "done", "the Worker has not been pointed at the fresh D1");
      },
      async run(c) {
        const db = target(c);
        await c.ports.d1.write(CLEAR_MODE_SQL, db);
        need((await d1Mode(c.ports, db)) === null, `${db} still has cutover.mode set`);
        await c.ports.clock.sleep(o.cacheWaitMs);
        const probe = await writeProbe(c.ports, o.workerUrl);
        need(!probe.frozen && probe.backend !== "aws", `writes are not accepted by the Worker yet: ${probe.status} ${probe.reason} from ${probe.backend ?? "the Worker"}`);
        c.data.reopenedAt = c.ports.clock.now();
        const pauseMs = c.data.reopenedAt - (c.data.awsFrozenAt ?? c.data.reopenedAt);
        return { message: `${db} accepts writes (direct mode); AWS stays read_only; writes were refused ${pauseMs} ms from the AWS freeze`, proof: { db, probe, pauseMs } };
      },
    },
    {
      id: "report",
      title: "write the rollback report",
      commands: () => [`write ${o.report}`],
      async run(c) {
        fs.mkdirSync(path.dirname(o.report), { recursive: true });
        fs.writeFileSync(o.report, renderReport(c.state, o));
        return { message: o.report };
      },
    },
  ];
}

export function renderReport(state, o) {
  const d = state.data;
  const lines = ["# akldb rollback report", "", `Variant: **${d.variant ?? "undecided"}**${d.variant === "original-d1" ? ` (AWS head ${d.awsHead}: no write reached AWS after the image, so the original D1 \`${o.d1Name}\` was reused)` : d.variant === "fresh-d1" ? ` (AWS head ${d.awsHead}: AWS took writes; a fresh D1 \`${d.newD1?.name}\` ${d.newD1?.id ?? ""} was built from AWS's state at seq ${d.captureSeq})` : ""}.`, ""];
  lines.push("## Steps", "", "| step | status | ms | result |", "|---|---|---|---|");
  for (const [id, st] of Object.entries(state.steps)) lines.push(`| ${id} | ${st.status} | ${st.ms ?? ""} | ${(st.message ?? "").replaceAll("|", "\\|")} |`);
  lines.push("", "## Proofs", "");
  for (const id of ["decide", "aws-readonly", "capture", "d1-refreeze", "d1-prove", "create-d1", "import", "verify", "point-worker", "reopen"]) {
    const p = state.steps[id]?.proof;
    if (p) lines.push(`### ${id}`, "", "```json", JSON.stringify(p, null, 2).slice(0, 3000), "```", "");
  }
  return lines.join("\n");
}
