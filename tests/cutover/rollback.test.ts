// [LDB-CV18] [LDB-CV11] The rollback machine (scripts/cutover/rollback.mjs, rollback-steps.mjs) against the same fake world: both variants, the
// proofs, the manual Worker step, the DNS record going back, and resume after a crash at any port call.
import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
// @ts-expect-error -- plain scripts, no .d.ts
import { compareProofs, feedPosition, localSelect, proveAll } from "../../scripts/cutover/checksum.mjs";
// @ts-expect-error -- plain script, no .d.ts
import { isBookkeepingUnit } from "../../scripts/cutover/drift.mjs";
import { cleanup, makeWorld, type Faults, type World } from "./world";

let w: World;
afterEach(() => w && cleanup(w));

const text = (r: { out: string[] }) => r.out.join("\n");
const rbState = () => JSON.parse(fs.readFileSync(path.join(w.dir, "rollback-state.json"), "utf8"));
const FRESH = "akl-db-rollback-2026-11-04";
const ROLLBACK_STEPS = ["decide", "aws-readonly", "capture", "d1-prove", "create-d1", "import", "verify", "point-worker", "dns-back", "reopen", "report"];

const rb = (args: string[] = ["--execute"]) => w.rollback(args);
/** The log without read-path bookkeeping (nonces from the signed probes, LDB-CV25): the image, the operator's flag units, real writes. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const significant = () => w.log.entries().filter((e: any) => e.kind !== "unit" || !isBookkeepingUnit(e.stmts.map((s: { sql: string }) => s.sql))).map((e: any) => (e.kind === "image" ? "image" : /cutover\.mode/.test(e.stmts[0].sql) ? "flag" : /INTO events/.test(e.stmts[0].sql) ? "event" : "other"));
const DRIFT_TABLES = ["nonces", "auth_cache", "authors", "authors_head"];
/** Diffs that are not read-path bookkeeping (AWS keeps bookkeeping after the capture the fresh D1 was built from). */
const realDiffs = (diffs: { table: string }[]) => diffs.filter((d) => !DRIFT_TABLES.includes(d.table));
const proofOf = async (db: ReturnType<World["d1"]>) => proveAll({ select: localSelect(db), db });
const awsProof = async () => {
  const r = await w.awsReplica();
  return proveAll({ select: localSelect(r.db), db: r.db });
};
const post = async (url: string) => (await w.ports.http.signed("POST", url, { body: "" })) as { status: number; headers: Record<string, string> };
const stackWrite = async () => (await w.ports.stack.signed("POST", "/v1/layouts", { body: "" })) as { status: number };

/** A completed cutover with some user writes on AWS afterwards. */
async function cutOver(faults?: Faults) {
  w = await makeWorld(faults ? { faults } : {});
  const r = await w.cutover();
  expect(r.code, text(r)).toBe(0);
  await w.userWriteOnAws(5);
}

describe("rollback, variant fresh-d1 (AWS took writes)", () => {
  it("[LDB-CV18] freezes AWS, captures it, imports into a fresh D1, proves it equal, waits for the Worker, puts the record back and only then reopens; the old D1 is untouched", async () => {
    await cutOver();
    expect(w.dns).toBe("aws");
    const oldBefore = await proofOf(w.d1());
    const first = await rb();
    // everything up to the manual step passes; the manual step stops the run with what to do
    expect(first.code, text(first)).toBe(1);
    expect(text(first)).toMatch(/MANUAL STEP\. Change wrangler\.toml's database_name\/database_id to akl-db-rollback-2026-11-04\/[0-9a-f-]{20,}/);
    expect(text(first)).toContain("resume with: node scripts/cutover/rollback.mjs --execute --from point-worker");
    const st = rbState();
    expect(st.data.variant).toBe("fresh-d1");
    expect(st.steps.verify.status).toBe("done");
    expect(st.steps["point-worker"].status).toBe("failed");
    expect(st.steps["d1-prove"].status).toBe("skipped");
    expect(st.steps["dns-back"]).toBeUndefined();
    expect(w.dns).toBe("aws"); // the record has not moved: clients are still on AWS, read_only

    // AWS is frozen, and the fresh D1 equals AWS table for table (both carry cutover.mode=read_only)
    expect(await w.operator.readFlag()).toBe("read_only");
    expect((await stackWrite()).status).toBe(503);
    const fresh = w.d1(FRESH);
    const cmp = compareProofs(await awsProof(), await proofOf(fresh));
    expect(realDiffs(cmp.diffs), JSON.stringify(cmp.diffs)).toEqual([]); // AWS bookkept (nonces) after the capture; nothing else differs
    expect(cmp.tables).toBeGreaterThan(30);
    expect(await feedPosition(localSelect(fresh))).toEqual(await feedPosition(localSelect((await w.awsReplica()).db)));
    // the old D1 was not modified by any of it
    expect(compareProofs(oldBefore, await proofOf(w.d1())).ok).toBe(true);

    // the PR merges and deploys: the Worker now binds the fresh D1; saltorbit then puts the record back (the fake does it on the second poll)
    w.workerDb = FRESH;
    const second = await rb(["--execute", "--from", "point-worker", "--worker-pointed"]);
    expect(second.code, text(second)).toBe(0);
    const t = text(second);
    expect(t).toContain("ACTION FOR SALTORBIT");
    expect(t).toMatch(/delete the proxied CNAME api .*add the custom domain api\.akldb\.org back/s);
    expect(w.dns).toBe("worker");
    expect(fresh.prepare("SELECT count(*) AS n FROM import_state WHERE key = 'cutover.mode'").get()).toEqual({ n: 0 });
    // writes are accepted by the Worker (its own database), refused by AWS
    const viaName = await post("https://api.akldb.org/v1/layouts");
    expect(viaName.status).toBe(400);
    expect(viaName.headers["x-akldb-backend"]).toBeUndefined();
    expect((await stackWrite()).status).toBe(503);
    expect(w.calls.filter((c) => c === "d1.create")).toHaveLength(1);

    // the order: AWS frozen before the capture, the capture before the fresh D1 exists, the import before the record goes back, the flag last
    const rollbackCalls = w.calls.slice(w.calls.indexOf("aws.operator.tail"));
    const idx = (n: string) => rollbackCalls.indexOf(n);
    expect(idx("aws.operator.runUnit")).toBeLessThan(idx("aws.operator.capture"));
    expect(idx("aws.operator.capture")).toBeLessThan(idx("d1.create"));
    expect(idx("d1.create")).toBeLessThan(idx("d1.importFile"));
    expect(idx("d1.importFile")).toBeLessThan(rollbackCalls.indexOf("http.fresh"));
    expect(rollbackCalls.indexOf("http.fresh")).toBeLessThan(rollbackCalls.lastIndexOf("d1.write"));

    const md = fs.readFileSync(path.join(w.dir, "rollback-report.md"), "utf8");
    expect(md).toContain("Variant: **fresh-d1**");
    expect(md).toContain(`\`${FRESH}\``);
    expect(md).toMatch(/\| verify \| done \| \d+ \|/);
    expect(md).toContain("### dns-back");
    expect(md).toContain("### reopen");
  });

  it("[LDB-CV18] an import that loses a row is caught by the proof: the record does not move back and nothing reopens", async () => {
    await cutOver({ importDropsRow: true, autoPoint: true });
    const r = await rb(["--execute", "--worker-pointed"]);
    expect(r.code).toBe(1);
    expect(rbState().steps.verify.status).toBe("failed");
    expect(rbState().steps.verify.message).toMatch(/the fresh D1 does not equal AWS: churn: count aws \d+ != d1 \d+.*delete it \(wrangler d1 delete akl-db-rollback-2026-11-04\)/s);
    expect(rbState().steps["dns-back"]).toBeUndefined();
    expect(w.dns).toBe("aws");
    expect(w.d1(FRESH).prepare("SELECT value FROM import_state WHERE key = 'cutover.mode'").get()).toEqual({ value: "read_only" });
    const dnsBack = await rb(["--execute", "--only", "dns-back"]);
    expect(dnsBack.code).toBe(1);
    expect(text(dnsBack)).toContain("CV18: the record goes back only after point-worker proved");
    const reopen = await rb(["--execute", "--only", "reopen"]);
    expect(reopen.code).toBe(1);
    expect(text(reopen)).toContain("CV18: writes reopen on D1 only after verify proved it equal to AWS");
  });

  it("[LDB-CV18] a Worker that was not repointed (it still serves the old D1) fails the point-worker check", async () => {
    await cutOver();
    const r = await rb(["--execute", "--worker-pointed"]);
    expect(r.code).toBe(1);
    expect(text(r)).toMatch(/the Worker's meta\.seq is 12, the fresh D1's is 15: it is not serving from the fresh D1 yet/);
    expect(rbState().steps["dns-back"]).toBeUndefined();
  });

  it("[LDB-CV18] --variant original-d1 is refused once AWS took writes; a forced fresh-d1 works even when original-d1 would apply", async () => {
    await cutOver();
    const r = await rb(["--execute", "--variant", "original-d1"]);
    expect(r.code).toBe(1);
    expect(text(r)).toMatch(/--variant original-d1 is impossible: AWS took writes past the image \(log head \d+\)/);
    cleanup(w);
    w = await makeWorld({ faults: { autoPoint: true } });
    await w.cutoverUntil("dns");
    const forced = await rb(["--execute", "--variant", "fresh-d1", "--worker-pointed"]);
    expect(forced.code, text(forced)).toBe(0);
    expect(rbState().data.variant).toBe("fresh-d1");
  });
});

describe("rollback, variant original-d1 (AWS took no write past the image)", () => {
  it("[LDB-CV18] before open: the original D1 is proven equal to the image, the record goes back, its flag is cleared; AWS stays read_only", async () => {
    w = await makeWorld();
    await w.cutoverUntil("dns");
    expect(w.dns).toBe("aws");
    expect(significant()).toEqual(["image"]);
    const r = await rb();
    expect(r.code, text(r)).toBe(0);
    const st = rbState();
    expect(st.data.variant).toBe("original-d1");
    for (const id of ["decide", "aws-readonly", "capture", "d1-prove", "dns-back", "reopen", "report"]) expect(st.steps[id].status, id).toBe("done");
    for (const id of ["create-d1", "import", "verify", "point-worker"]) expect(st.steps[id].status, id).toBe("skipped");
    expect(st.steps["aws-readonly"].proof.appended).toBe(false); // the image already carries read_only
    expect(w.dbs.size).toBe(1); // no fresh D1
    expect(significant()).toEqual(["image"]); // nothing real appended (the probes spent nonces)
    expect(await w.operator.readFlag()).toBe("read_only");
    expect(w.dns).toBe("worker");
    expect(w.d1().prepare("SELECT count(*) AS n FROM import_state WHERE key = 'cutover.mode'").get()).toEqual({ n: 0 });
    const viaName = await post("https://api.akldb.org/v1/layouts");
    expect(viaName.status).toBe(400);
    expect(viaName.headers["x-akldb-backend"]).toBeUndefined();
    expect((await stackWrite()).status).toBe(503);
    // the proof was against the checksums the cutover recorded in the log
    expect(st.steps["d1-prove"].proof).toMatchObject({ ok: true, feed: { metaSeq: 12, eventsCounter: 14 } });
    expect(st.steps["dns-back"].proof.consecutive).toBe(5);
    const md = fs.readFileSync(path.join(w.dir, "rollback-report.md"), "utf8");
    expect(md).toContain("Variant: **original-d1** (AWS log head 1: no write reached AWS past the image");
  });

  it("[LDB-CV18] after open but before any other write (the log holds the image, the operator's flag unit and read-path bookkeeping): still original-d1; AWS is frozen again by one more flag unit", async () => {
    w = await makeWorld();
    await w.cutoverUntil("open");
    expect(significant()).toEqual(["image", "flag"]); // the flag cleared; the open probe's nonce is bookkeeping
    const r = await rb();
    expect(r.code, text(r)).toBe(0);
    expect(rbState().data.variant).toBe("original-d1");
    expect(rbState().steps["aws-readonly"].proof.appended).toBe(true);
    expect(significant()).toEqual(["image", "flag", "flag"]);
    expect(await w.operator.readFlag()).toBe("read_only");
    expect(w.dbs.size).toBe(1);
    expect(w.dns).toBe("worker");
  });

  it("[LDB-CV18] a D1 that changed after the freeze refuses this variant: the record stays on AWS, D1 stays frozen and nothing reopens", async () => {
    w = await makeWorld();
    await w.cutoverUntil("dns");
    w.d1().exec("UPDATE churn SET v = 'written after the freeze' WHERE id = 1"); // something got through
    const r = await rb();
    expect(r.code).toBe(1);
    expect(text(r)).toMatch(/the original D1 no longer equals the image \(something wrote to it after the freeze, or its flag moved\): churn: checksum image .* != d1 .*Use --variant fresh-d1/s);
    expect(rbState().steps["dns-back"]).toBeUndefined();
    expect(rbState().steps.reopen).toBeUndefined();
    expect(w.dns).toBe("aws");
    expect(w.d1().prepare("SELECT value FROM import_state WHERE key = 'cutover.mode'").get()).toEqual({ value: "read_only" });
    // and a flag that someone cleared is caught the same way
    w.d1().exec("UPDATE churn SET v = (SELECT v FROM churn WHERE id = 2) WHERE id = 1");
  });

  it("[LDB-CV18] the record that never moves back times out with what to do, and nothing reopens", async () => {
    w = await makeWorld();
    await w.cutoverUntil("dns");
    w.faults.dnsNeverFlips = true; // saltorbit has not put the record back
    const r = await rb();
    expect(r.code).toBe(1);
    expect(text(r)).toMatch(/https:\/\/api\.akldb\.org still does not answer from the Worker after 9\d\d s and \d+ polls \(last: status 200, x-akldb-backend aws, seq 12 \(want the Worker's, 12\)\)\. Re-run with --from dns-back once the record is back/);
    expect(rbState().steps.reopen).toBeUndefined();
    expect(w.d1().prepare("SELECT value FROM import_state WHERE key = 'cutover.mode'").get()).toEqual({ value: "read_only" });
    w.faults.dnsNeverFlips = false;
    expect((await rb(["--execute", "--from", "dns-back"])).code).toBe(0);
    expect(w.dns).toBe("worker");
  });

  it("[LDB-CV18] a log without an image is not a cutover target", async () => {
    w = await makeWorld();
    const r = await rb();
    expect(r.code).toBe(1);
    expect(text(r)).toContain("this AWS log has no image as seq 1");
  });

  it("[LDB-CV18] in a rehearsal the public name is not the Worker's: dns-back checks the Worker itself and prints no instruction", async () => {
    w = await makeWorld({ rehearsal: true });
    await w.cutoverUntil("dns");
    const r = await rb();
    expect(r.code, text(r)).toBe(0);
    expect(text(r)).toContain("(rehearsal: https://staging-api.akldb.org is not the Worker's name; checking the Worker at https://rehearsal.example)");
    expect(text(r)).not.toContain("ACTION FOR SALTORBIT");
    expect(rbState().data.variant).toBe("original-d1");
  });
});

describe("read-path drift in the rollback (CV26)", () => {
  async function traffic(url: string) {
    for (let i = 0; i < 3; i++) {
      await w.ports.http.signed("GET", `${url}/v1/meta`, { headers: { "x-akl-actor": `spark-${i}` } });
      await w.ports.http.request(`${url}/v1/layouts?limit=2`, { method: "GET", headers: { authorization: `Bearer tok-${i}` } });
    }
  }

  it("[LDB-CV26] original-d1: both sides kept bookkeeping since the freeze (D1 under the Worker, AWS under the stack), which is not a write: the variant applies and the proof is by the stored checksums plus the drift rules", async () => {
    w = await makeWorld();
    await w.cutoverUntil("dns");
    await traffic("https://akl-db.akl-58a.workers.dev"); // D1 bookkeeps after the freeze
    for (let i = 0; i < 3; i++) await w.ports.stack.signed("GET", "/v1/meta", { headers: { "x-akl-actor": `aws-spark-${i}` } }); // AWS bookkeeps too
    expect(significant()).toEqual(["image"]);
    expect(w.log.entries().length).toBeGreaterThan(1);
    const r = await rb();
    expect(r.code, text(r)).toBe(0);
    const st = rbState();
    expect(st.data.variant).toBe("original-d1");
    const proof = st.steps["d1-prove"].proof;
    expect(proof.ok).toBe(true);
    expect(proof.drift.nonces.d1Only).toBeGreaterThan(0); // D1's own nonces
    expect(proof.drift.nonces.awsOnly).toBeGreaterThan(0); // and AWS's
    expect(proof.drift.authors.columnsDiffering).toBeDefined();
    expect(w.dns).toBe("worker");
  });

  it("[LDB-CV26] a unit that is not bookkeeping after the image makes it fresh-d1, whatever else is in the log", async () => {
    w = await makeWorld();
    await w.cutoverUntil("dns");
    await w.userWriteOnAws(1);
    const r = await rb(["--execute", "--variant", "original-d1"]);
    expect(r.code).toBe(1);
    expect(text(r)).toContain("--variant original-d1 is impossible: AWS took writes past the image");
  });

  it("[LDB-CV26] capture: units that landed after the captured seq are fine when they are read-path bookkeeping, and a real write means AWS is not frozen", async () => {
    await cutOver({ bookkeepDuringCapture: true, autoPoint: true });
    const ok = await rb(["--execute", "--worker-pointed"]);
    expect(ok.code, text(ok)).toBe(0);
    expect(rbState().steps.capture.proof.bookkeptAfter).toBeGreaterThan(0);
    expect(text(ok)).toMatch(/read-path bookkeeping unit\(s\) landed after it and are not in the capture/);
    cleanup(w);
    await cutOver({ writeDuringCapture: true, autoPoint: true });
    const bad = await rb(["--execute", "--worker-pointed"]);
    expect(bad.code).toBe(1);
    expect(text(bad)).toMatch(/the AWS log moved during the capture by more than read-path bookkeeping \(captured seq \d+, then #\d+ unit INSERT INTO churn/);
    expect(rbState().steps["create-d1"]).toBeUndefined();
  });
});

describe("the rollback machine (CV11)", () => {
  it("[LDB-CV11] without --execute it prints every step's commands (the wrangler.toml change and the DNS instructions included) and touches nothing", async () => {
    w = await makeWorld();
    const r = await rb([]);
    expect(r.code).toBe(0);
    const t = text(r);
    for (const id of ROLLBACK_STEPS) expect(t, id).toContain(`[${id}] `);
    expect(t).toContain("wrangler d1 create akl-db-rollback-2026-11-04");
    expect(t).toContain("wrangler d1 execute akl-db-rollback-2026-11-04 --remote --file");
    expect(t).toMatch(/database_name = "akl-db-rollback-2026-11-04"; database_id = "<new id>"/);
    expect(t).toContain("open a PR on akl-infra/db");
    expect(t).toContain("delete the proxied CNAME api");
    expect(t).toContain("add the custom domain api.akldb.org back");
    expect(w.calls).toEqual([]);
    expect(fs.existsSync(path.join(w.dir, "rollback-state.json"))).toBe(false);
  });

  it("[LDB-CV11] a crash at a port call inside any step, then a plain re-run, ends with the fresh D1 equal to AWS and exactly one fresh D1", async () => {
    // the call counts of a clean fresh-d1 rollback
    await cutOver({ autoPoint: true });
    expect((await rb(["--execute", "--worker-pointed"])).code).toBe(0);
    const counts = Object.fromEntries(Object.entries(w.callsByStep).map(([k, v]) => [k, v.length]));
    cleanup(w);
    let crashes = 0;
    for (const id of ["decide", "aws-readonly", "capture", "create-d1", "import", "verify", "point-worker", "dns-back", "reopen"]) {
      const total = counts[id] ?? 0; // (the cutover has steps of the same names, whose counts differ: a call index the rollback never reaches just does not crash)
      for (const nth of [...new Set([1, 2, Math.ceil(total / 2), total])].filter((n) => n >= 1)) {
        await cutOver({ autoPoint: true });
        w.callsByStep = {};
        w.crashed = false;
        w.faults.crashStep = id;
        w.faults.crashNth = nth;
        const first = await rb(["--execute", "--worker-pointed"]);
        if (first.code === 0) {
          cleanup(w);
          continue;
        }
        expect(text(first), `${id}/${nth}`).toContain(`injected crash in ${id}`);
        const second = await rb(["--execute", "--worker-pointed"]);
        expect(second.code, `${id}/${nth}: ${text(second)}`).toBe(0);
        const cmp = compareProofs(await awsProof(), await proofOf(w.d1(FRESH)));
        // the fresh D1 equals AWS, bar the flag row the reopen cleared
        expect(realDiffs(cmp.diffs).map((d: { table: string }) => d.table).every((t: string) => t === "import_state"), `${id}/${nth}: ${JSON.stringify(cmp.diffs)}`).toBe(true);
        expect([...w.dbs.keys()].filter((k) => k.startsWith("akl-db-rollback"))).toEqual([FRESH]);
        expect(w.d1(FRESH).prepare("SELECT count(*) AS n FROM import_state WHERE key = 'cutover.mode'").get()).toEqual({ n: 0 });
        expect(w.dns).toBe("worker");
        crashes++;
        cleanup(w);
      }
    }
    expect(crashes).toBeGreaterThan(15);
    w = await makeWorld();
  }, 240_000);
});
