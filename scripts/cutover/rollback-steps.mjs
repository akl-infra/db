// The rollback plan (LDB-CV18, CV11): AWS back to the Worker. Pure orchestration over the same ports as the cutover.
//
// The mirror image of the cutover: the DNS record api.akldb.org goes back from the stack to the Worker's custom domain (saltorbit), then the D1
// flag is cleared. Two variants, decided by the first step from the AWS log:
//   original-d1  AWS has taken no write past the image (its log is the image, plus at most the operator's cutover.mode flag units): the ORIGINAL D1
//                is still exactly the freeze state. It is proven equal to the image (every table's count and checksum recorded in the log entry),
//                the record goes back to the Worker, and the flag is cleared. AWS stays read_only. No new database, no PR.
//   fresh-d1     AWS took writes. Freeze AWS, take its database at the head, import it into a FRESH D1, prove it equal, point the Worker at it (a PR:
//                manual), put the record back, clear the flag there. The old D1 is not touched.
//
//  decide -> aws-readonly -> capture -> [original-d1: d1-prove] [fresh-d1: create-d1 -> import -> verify -> point-worker] -> dns-back -> reopen -> report
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import crypto from "node:crypto";
import { compareProofs, feedPosition, localSelect, proveAll, proveAllBatched } from "./checksum.mjs";
import { AWS_HEADER, CLEAR_MODE_SQL, STACK, d1Mode, setModeSql, writeProbe } from "./cutover-steps.mjs";
import { need } from "./machine.mjs";
import { dumpToSql } from "./sqlfile.mjs";

const sha256 = (b) => crypto.createHash("sha256").update(b).digest("hex");
const lc = (h) => Object.fromEntries(Object.entries(h ?? {}).map(([k, v]) => [k.toLowerCase(), v]));
const FLAG_UNIT = /^(DELETE FROM import_state WHERE key = 'cutover\.mode'|INSERT INTO import_state \(key, value\) VALUES \('cutover\.mode', '[a-z_]+'\) ON CONFLICT\(key\) DO UPDATE SET value = excluded\.value)$/;

/** What saltorbit does to put the record back (mirror of the cutover's dns step). */
export function dnsBackInstructions(o) {
  const host = new URL(o.publicUrl).host;
  return [
    `1. Cloudflare dashboard > akldb.org > DNS: delete the proxied CNAME ${host.split(".")[0]} (the one pointing at the stack's ApiDomainTarget).`,
    `2. Cloudflare dashboard > Workers & Pages > akl-db > Settings > Domains & Routes: add the custom domain ${host} back.`,
  ];
}

export function steps(o) {
  const imageFile = () => path.join(o.work, "rollback-image.sqlite");
  const sqlFile = () => path.join(o.work, "rollback-import.sql");
  const original = (c) => c.data.variant === "original-d1";
  const onlyFresh = (c) => (original(c) ? "variant original-d1: the original D1 is reused" : null);
  const onlyOriginal = (c) => (original(c) ? null : "variant fresh-d1: a new D1 is built");
  const target = (c) => (original(c) ? o.d1Name : c.data.newD1?.name);
  const sameName = () => new URL(o.publicUrl).host === new URL(o.workerUrl).host;
  const withImage = async (c, fn) => {
    const db = new DatabaseSync(":memory:");
    db.deserialize(fs.readFileSync(imageFile()));
    try {
      return await fn(db);
    } finally {
      db.close();
    }
  };
  const remoteProof = (c, db, name) =>
    proveAllBatched({ select: (sql) => c.ports.d1.select(sql, name), ...(c.ports.d1.selectMany ? { selectMany: (sqls) => c.ports.d1.selectMany(sqls, name) } : {}), db, pageRows: o.pageRows, concurrency: o.concurrency });

  return [
    {
      id: "decide",
      title: "read the AWS log and choose the variant (no write past the image: the original D1)",
      commands: () => [`aws dynamodb query ... LOG#000000000001..   # the image, then only flag units -> original-d1, anything else -> fresh-d1`],
      async run(c) {
        const first = await c.ports.aws.firstEntry();
        need(first?.kind === "image", "this AWS log has no image as seq 1: it never took the cutover, there is nothing to roll back from");
        const head = await c.ports.aws.logHead();
        const tail = await c.ports.aws.operator.tail();
        const flagOnly = tail !== null && tail.every((e) => e.kind === "unit" && e.sqls.length === 1 && FLAG_UNIT.test(e.sqls[0]));
        const auto = flagOnly ? "original-d1" : "fresh-d1";
        if (o.variant !== undefined) {
          need(["original-d1", "fresh-d1"].includes(o.variant), "--variant is original-d1 or fresh-d1");
          need(!(o.variant === "original-d1" && !flagOnly), `--variant original-d1 is impossible: AWS took writes past the image (log head ${head}); the original D1 no longer equals AWS`);
        }
        c.data.variant = o.variant ?? auto;
        c.data.awsHead = head;
        c.data.imageTables = first.image?.tables ?? null;
        c.data.imageFreezeSeq = first.image?.source?.freezeSeq ?? null;
        const mode = await d1Mode(c.ports, o.d1Name).catch(() => "unreadable");
        return { message: `AWS log head ${head}${flagOnly ? " (the image and operator flag units only)" : ""}: variant ${c.data.variant} (the original D1's cutover.mode is ${mode ?? "unset"})`, proof: { head, flagOnly, variant: c.data.variant, originalD1Mode: mode } };
      },
    },
    {
      id: "aws-readonly",
      title: "AWS read_only: append cutover.mode='read_only' to the AWS log as the operator (unless it is) and prove writes are refused",
      commands: () => [`node:operator  runUnit("${setModeSql("read_only")}")   # skipped when the flag is already read_only`, `curl --resolve ... ${o.publicUrl}/v1/layouts (the stack directly)   # 503 read_only`],
      async precondition(c) {
        need(c.data.variant !== undefined, "decide has not run");
      },
      async run(c) {
        const flag = await c.ports.aws.operator.readFlag();
        let appended = false;
        if (flag !== "read_only") {
          await c.ports.aws.operator.runUnit(setModeSql("read_only"));
          appended = true;
        }
        need((await c.ports.aws.operator.readFlag()) === "read_only", "AWS did not take cutover.mode=read_only");
        c.data.awsFrozenAt ??= c.ports.clock.now();
        await c.ports.clock.sleep(o.cacheWaitMs);
        const probe = await writeProbe(c.ports, STACK);
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
        c.data.captureTables = await withImage(c, (db) => proveAll({ select: localSelect(db), db, pageRows: o.pageRows }));
        c.data.captureFeed = await withImage(c, (db) => feedPosition(localSelect(db)));
        return { message: `AWS log seq ${cap.seq}, ${cap.bytes.byteLength} bytes, events seq ${c.data.captureFeed.metaSeq}, sha256 ${c.data.captureSha.slice(0, 12)}`, proof: { seq: cap.seq, sha256: c.data.captureSha, feed: c.data.captureFeed } };
      },
    },
    // ---- variant original-d1 ----
    {
      id: "d1-prove",
      title: "[original-d1] prove the original D1 still equals the image the cutover loaded (CV18): every table's count and checksum, meta.seq",
      commands: () => [`wrangler d1 execute ${o.d1Name} --remote --json --command "SELECT rowid AS __rid, * FROM <table> ..."   # or the REST API; compared with the checksums stored in the image entry`],
      skip: onlyOriginal,
      async run(c) {
        need(c.data.imageTables !== null, "the image entry carries no table proofs to compare with");
        const remote = await withImage(c, (db) => remoteProof(c, db, o.d1Name));
        const cmp = compareProofs(c.data.imageTables, remote, { left: "image", right: "d1" });
        const pos = await feedPosition((sql) => c.ports.d1.select(sql, o.d1Name));
        const problems = cmp.diffs.map((d) => `${d.table}: ${d.field} image ${d.image} != d1 ${d.d1}`);
        if (c.data.imageFreezeSeq !== null && pos.metaSeq !== c.data.imageFreezeSeq) problems.push(`meta.seq: image ${c.data.imageFreezeSeq} != d1 ${pos.metaSeq}`);
        if (problems.length > 0) {
          const e = new Error(`the original D1 no longer equals the image (something wrote to it after the freeze, or its flag moved): ${problems.slice(0, 6).join(" | ")}. Use --variant fresh-d1`);
          e.proof = { ok: false, problems };
          throw e;
        }
        return { message: `${cmp.tables} tables, ${cmp.rows} rows equal to the image, events seq ${pos.metaSeq}`, proof: { ok: true, tables: cmp.tables, rows: cmp.rows, feed: pos } };
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
      commands: () => [`wrangler d1 execute ${o.newD1Name} --remote --json --command "SELECT rowid AS __rid, * FROM <table> ..."   # or the REST API`],
      skip: onlyFresh,
      async run(c) {
        const name = c.data.newD1.name;
        const remote = await withImage(c, (db) => remoteProof(c, db, name));
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
        `curl -s ${o.workerDirectUrl}/v1/meta   # the Worker itself (not the DNS name): meta.seq == the fresh D1's, no x-akldb-backend header`,
      ],
      skip: onlyFresh,
      async run(c) {
        need(o.workerPointed, `MANUAL STEP. Change wrangler.toml's database_name/database_id to ${c.data.newD1.name}/${c.data.newD1.id}, merge the PR, deploy, then re-run with --worker-pointed`, { hint: "the Worker cannot be repointed from here: a D1 binding is deploy-time configuration" });
        const meta = await c.ports.http.request(`${o.workerDirectUrl}/v1/meta`, { method: "GET" });
        need(meta.status === 200, `GET ${o.workerDirectUrl}/v1/meta answered ${meta.status}`);
        need(JSON.parse(meta.body).seq === c.data.captureFeed.metaSeq, `the Worker's meta.seq is ${JSON.parse(meta.body).seq}, the fresh D1's is ${c.data.captureFeed.metaSeq}: it is not serving from the fresh D1 yet`);
        const probe = await writeProbe(c.ports, o.workerDirectUrl);
        need(probe.readOnly && probe.backend !== "aws", `the Worker answered a write with ${probe.status} (${probe.reason}) from ${probe.backend ?? "the Worker"}: expected its own 503 read_only (the fresh D1 carries the AWS flag)`);
        return { message: "the Worker serves reads from the fresh D1 and refuses writes itself", proof: { metaSeq: c.data.captureFeed.metaSeq, probe } };
      },
    },
    {
      id: "dns-back",
      title: `saltorbit puts the DNS record ${new URL(o.publicUrl).host} back on the Worker; poll until it answers from the Worker (no ${AWS_HEADER}), ${o.dnsConsecutive} times in a row on fresh connections`,
      commands: () => [...dnsBackInstructions(o), `curl -s ${o.publicUrl}/v1/meta   # no ${AWS_HEADER} header, seq == the database's, ${o.dnsConsecutive} fresh connections in a row`],
      async precondition(c) {
        const prove = original(c) ? "d1-prove" : "point-worker";
        const p = c.state.steps[prove];
        need(p?.status === "done", `CV18: the record goes back only after ${prove} proved the Worker's database is AWS's`);
        if (original(c)) need(p.proof?.ok === true, "CV18: d1-prove did not pass");
      },
      async run(c) {
        const wantSeq = original(c) ? (c.data.imageFreezeSeq ?? c.data.captureFeed.metaSeq) : c.data.captureFeed.metaSeq;
        // in a rehearsal the public name is not the Worker's: ask the Worker itself
        const where = sameName() ? o.publicUrl : o.workerDirectUrl;
        if (sameName()) {
          c.out("      ---- ACTION FOR SALTORBIT (Cloudflare dashboard, akl account) ----");
          for (const line of dnsBackInstructions(o)) c.out(`      ${line}`);
          c.out("      ------------------------------------------------------------------");
        } else c.out(`      (rehearsal: ${o.publicUrl} is not the Worker's name; checking the Worker at ${where})`);
        const started = c.ports.clock.now();
        let consecutive = 0;
        let polls = 0;
        let last = "no answer yet";
        for (;;) {
          polls++;
          let ok = false;
          try {
            const r = await c.ports.http.fresh(`${where}/v1/meta`, { method: "GET" });
            const backend = lc(r.headers)[AWS_HEADER] ?? null;
            let seq = null;
            try {
              seq = JSON.parse(r.body).seq;
            } catch {
              seq = null;
            }
            ok = r.status === 200 && backend === null && seq === wantSeq;
            last = `status ${r.status}, ${AWS_HEADER} ${backend ?? "absent"}, seq ${seq ?? "?"} (want the Worker's, ${wantSeq})`;
          } catch (e) {
            last = `request failed: ${e instanceof Error ? e.message : String(e)}`;
          }
          consecutive = ok ? consecutive + 1 : 0;
          if (consecutive >= o.dnsConsecutive) break;
          need(c.ports.clock.now() - started < o.dnsTimeoutMs, `${where} still does not answer from the Worker after ${Math.round((c.ports.clock.now() - started) / 1000)} s and ${polls} polls (last: ${last}). Re-run with --from dns-back once the record is back`);
          await c.ports.clock.sleep(o.dnsPollMs);
        }
        return { message: `${where} answers from the Worker after ${Math.round((c.ports.clock.now() - started) / 1000)} s (${polls} polls)`, proof: { polls, consecutive, last } };
      },
    },
    {
      id: "reopen",
      title: "clear cutover.mode on the D1 the Worker serves from and prove writes are accepted",
      commands: (c) => [`wrangler d1 execute ${c?.data?.variant === "fresh-d1" ? o.newD1Name : o.d1Name} --remote --command "${CLEAR_MODE_SQL}"`, `curl -s -X POST ${o.publicUrl}/v1/layouts   # not 503, no ${AWS_HEADER}`],
      async precondition(c) {
        const prove = original(c) ? "d1-prove" : "verify";
        const p = c.state.steps[prove];
        need(p?.status === "done" && p.proof?.ok === true, `CV18: writes reopen on D1 only after ${prove} proved it equal to AWS`);
        need(c.state.steps["dns-back"]?.status === "done", "CV18: writes reopen only after the record is back on the Worker (dns-back)");
      },
      async run(c) {
        const db = target(c);
        await c.ports.d1.write(CLEAR_MODE_SQL, db);
        need((await d1Mode(c.ports, db)) === null, `${db} still has cutover.mode set`);
        await c.ports.clock.sleep(o.cacheWaitMs);
        const probe = await writeProbe(c.ports, sameName() ? o.publicUrl : o.workerUrl);
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
  const lines = ["# akldb rollback report", "", `Variant: **${d.variant ?? "undecided"}**${d.variant === "original-d1" ? ` (AWS log head ${d.awsHead}: no write reached AWS past the image, so the original D1 \`${o.d1Name}\` was proven equal to the image and reused)` : d.variant === "fresh-d1" ? ` (AWS log head ${d.awsHead}: AWS took writes; a fresh D1 \`${d.newD1?.name}\` ${d.newD1?.id ?? ""} was built from AWS's state at seq ${d.captureSeq})` : ""}.`, ""];
  lines.push("## Steps", "", "| step | status | ms | result |", "|---|---|---|---|");
  for (const [id, st] of Object.entries(state.steps)) lines.push(`| ${id} | ${st.status === "running" && id === "report" ? "this report" : st.status} | ${st.ms ?? ""} | ${(st.message ?? "").replaceAll("|", "\\|")} |`);
  lines.push("", "## Proofs", "");
  for (const id of ["decide", "aws-readonly", "capture", "d1-prove", "create-d1", "import", "verify", "point-worker", "dns-back", "reopen"]) {
    const p = state.steps[id]?.proof;
    if (p) lines.push(`### ${id}`, "", "```json", JSON.stringify(p, null, 2).slice(0, 3000), "```", "");
  }
  return lines.join("\n");
}
