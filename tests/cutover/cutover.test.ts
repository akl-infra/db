// [LDB-CV16] [LDB-CV17] [LDB-CV11] The cutover machine (scripts/cutover/run.mjs, cutover-steps.mjs, machine.mjs) against a fake world: D1 and a
// Worker with the cutover modes, the AWS stack on the REAL replica, memory log and the REAL Lambda handler. No network, no process.
import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
// @ts-expect-error -- plain scripts, no .d.ts
import { proveAll, localSelect } from "../../scripts/cutover/checksum.mjs";
// @ts-expect-error -- plain scripts, no .d.ts
import { buildOptions, defaultMinMinor, parseArgs } from "../../scripts/cutover/cli.mjs";
// @ts-expect-error -- plain scripts, no .d.ts
import { main as runMain } from "../../scripts/cutover/run.mjs";
import { Replica, imageDigest } from "../../src/replica/replica";
import { FAST } from "../replica/support";
import { STEP_IDS, cleanup, makeWorld, type Faults, type World } from "./world";

let w: World;
afterEach(() => w && cleanup(w));

const status = (id: string) => w.state().steps[id]?.status;
const text = (r: { out: string[] }) => r.out.join("\n");
const entries = () => w.log.entries();
/** Run steps one by one up to `id`, then apply `mutate`, then run `--from next`. */
async function until(id: string, faults?: Faults): Promise<void> {
  w = await makeWorld(faults ? { faults } : {});
  await w.cutoverUntil(id);
}

describe("the machine (CV11)", () => {
  it("[LDB-CV11] without --execute every step prints the commands it would run, nothing runs, nothing is written", async () => {
    w = await makeWorld();
    const r = await w.cutover([]);
    expect(r.code).toBe(0);
    const t = text(r);
    expect(t).toContain("DRY RUN");
    let at = 0;
    for (const id of STEP_IDS) {
      const i = t.indexOf(`[${id}] `, at);
      expect(i, `step ${id} is printed in order`).toBeGreaterThanOrEqual(at);
      at = i;
    }
    expect(t).toContain("wrangler d1 export akl-db --remote --output");
    expect(t).toContain("wrangler d1 time-travel info akl-db");
    expect(t).toMatch(/aws lambda invoke .*"akldb":"warm","k":4/);
    expect(w.calls).toEqual([]); // no port was touched
    expect(fs.existsSync(w.stateFile)).toBe(false);
    expect(entries()).toHaveLength(0);
    // --only prints one step only
    const one = await w.cutover(["--only", "freeze"]);
    expect(text(one)).toContain("[freeze]");
    expect(text(one)).not.toContain("[export]");
  });

  it("[LDB-CV11] usage: unknown steps, --from with --only, and a rehearsal that could name production are refused", async () => {
    w = await makeWorld();
    expect((await w.cutover(["--execute", "--from", "nope"])).code).toBe(2);
    expect((await w.cutover(["--execute", "--from", "freeze", "--only", "export"])).code).toBe(2);
    expect((await w.cutover(["--execute", "--abort", "--only", "export"])).code).toBe(2);
    expect(w.calls).toEqual([]);
    const out: string[] = [];
    for (const argv of [["--stage", "staging"], ["--stage", "staging", "--d1", "akl-db", "--worker-url", "https://rehearsal.example"], ["--stage", "staging", "--d1", "scratch", "--worker-url", "https://api.akldb.org"], ["--stage", "staging", "--d1", "scratch", "--worker-url", "https://rehearsal.example", "--public-url", "https://api.akldb.org"], ["--stage", "mars"], ["--bogus"]]) {
      expect(await runMain(argv, { out: (l: string) => out.push(l), env: {} }), argv.join(" ")).toBe(2);
    }
    expect(out.join("\n")).toMatch(/needs --d1.*refuses the production D1.*refuses https:\/\/api\.akldb\.org as the Worker.*refuses https:\/\/api\.akldb\.org as the public name/s);
    // a valid rehearsal targets the staging stack and URL
    const o = buildOptions(parseArgs(["--stage", "staging", "--d1", "scratch", "--worker-url", "https://rehearsal.example/"]).flags);
    expect(o).toMatchObject({ stack: "akldb-staging", publicUrl: "https://staging-api.akldb.org", d1Name: "scratch", workerUrl: "https://rehearsal.example", workerDirectUrl: "https://rehearsal.example" });
    expect(o.originEnv).toMatch(/akldb-origin-staging\.env$/);
    const prod = buildOptions(parseArgs([]).flags);
    expect(prod).toMatchObject({ publicUrl: "https://api.akldb.org", workerUrl: "https://api.akldb.org", workerDirectUrl: "https://akl-db.akl-58a.workers.dev", dnsConsecutive: 5, dnsTimeoutMs: 900_000 });
    expect(prod.originEnv).toMatch(/akldb-origin-prod\.env$/);
    expect(prod.r2Env).toMatch(/akldb-r2-dumps-read\.env$/);
    expect(defaultMinMinor()).toBe(34); // this tree's WIRE_VERSION: the modes shipped in 1.34 (#45)
  });

  it("[LDB-CV11] the happy path: every step passes, in order, and the log holds the image, the open unit and the post-smoke write", async () => {
    w = await makeWorld();
    const r = await w.cutover();
    expect(r.code, text(r)).toBe(0);
    for (const id of STEP_IDS) expect(status(id), id).toBe("done");

    // order of the effects
    const first = (name: string, from = 0) => w.calls.indexOf(name, from);
    const freeze = first("d1.write");
    const exp = first("d1.exportTo");
    const img = first("aws.operator.appendImage");
    const migrate = first("aws.invoke");
    const open = first("aws.operator.runUnit");
    const dns = first("http.fresh");
    const signed = first("http.signed");
    expect([freeze, exp, img, migrate, dns, open, signed].every((n) => n >= 0)).toBe(true);
    expect(w.calls.filter((c) => c === "d1.write")).toHaveLength(1); // the freeze is the only write to D1: there is no proxy mode
    expect(freeze).toBeLessThan(exp);
    expect(exp).toBeLessThan(img);
    expect(img).toBeLessThan(migrate);
    expect(migrate).toBeLessThan(dns);
    expect(dns).toBeLessThan(open);
    expect(open).toBeLessThan(signed);

    // the log: the image is seq 1, then exactly the operator's flag unit and the post-smoke event; no migration ever entered it
    const log = entries();
    expect(log.map((e) => e.kind)).toEqual(["image", "unit", "unit"]);
    expect(log[1]!.stmts[0]!.sql).toBe("DELETE FROM import_state WHERE key = 'cutover.mode'");
    expect(log[2]!.stmts[0]!.sql).toMatch(/INSERT INTO events/);
    expect(log[0]!.hash).toBe(w.state().data.imageSha);

    // the flag: D1 stays frozen for good (the Worker is read_only wherever it still answers), AWS is open, the name points at AWS
    expect(w.d1().prepare("SELECT value FROM import_state WHERE key = 'cutover.mode'").get()).toEqual({ value: "read_only" });
    expect(w.dns).toBe("aws");
    const aws = await w.awsReplica();
    expect(aws.db.prepare("SELECT count(*) AS n FROM import_state WHERE key = 'cutover.mode'").get()).toEqual({ n: 0 });

    // the AWS database is D1's at the freeze, bar the flag row and what happened since: replay from 0 equals the live replica
    const fresh = new Replica(w.log, FAST);
    await fresh.catchUp();
    expect(imageDigest(fresh.serialize())).toBe(imageDigest(aws.serialize()));
    const d1Proof = await proveAll({ select: localSelect(w.d1()), db: w.d1() });
    const imageTables = log[0]!.image!.tables;
    for (const t of Object.keys(imageTables)) if (!["import_state", "events", "sqlite_sequence"].includes(t)) expect(imageTables[t], t).toEqual(d1Proof[t]);
    expect(imageTables.import_state).toEqual(d1Proof.import_state); // D1 still holds exactly the frozen state the image was loaded from
    expect(log[0]!.image!.source).toMatchObject({ bookmark: expect.stringMatching(/^00000085-/), freezeSeq: 12 });

    // the snapshot pointer sits at seq 1
    expect((await w.snapshots.pointer())?.seq).toBe(1);
  });

  it("[LDB-CV11] the report has timings per step, the write pause and every proof", async () => {
    w = await makeWorld();
    expect((await w.cutover()).code).toBe(0);
    const md = fs.readFileSync(path.join(w.dir, "report.md"), "utf8");
    expect(md).toContain("# akldb cutover report");
    expect(md).toMatch(/\*\*\d+ ms\*\* \(\d+\.\d s\) from the freeze write to the unit that cleared/);
    for (const id of STEP_IDS.slice(0, -1)) expect(md, id).toMatch(new RegExp(`\\| ${id} \\| done \\| \\d+ \\|`));
    expect(md).toContain("### verify (CV16, CV17)");
    expect(md).toMatch(/\| churn \| \d+ \| `[0-9a-f]{16}` \|/);
    expect(md).toContain("meta.seq 12; sqlite_sequence for events 14 (the next event is seq 15)");
    for (const id of ["preflight", "copy-dumps", "freeze", "export", "load", "image", "serve", "dns", "open", "post-smoke"]) expect(md, id).toContain(`### ${id}`);
    const st = w.state();
    expect(st.data.pauseMs).toBe(st.data.openedAt - st.data.freezeAt);
    expect(st.data.pauseMs).toBeLessThanOrEqual(300_000); // the gate: at most 5 minutes
  });

  it("[LDB-CV11] a finished run is idempotent: image and open re-run to the same state, and preflight re-checks what it needs", async () => {
    w = await makeWorld();
    expect((await w.cutover()).code).toBe(0);
    const before = entries().length;
    const again = await w.cutover(["--execute"]);
    expect(text(again)).toContain("already done");
    expect(again.code).toBe(0);
    for (const id of ["image", "open"]) {
      const r = await w.cutover(["--execute", "--only", id]);
      expect(r.code, `${id}: ${text(r)}`).toBe(0);
    }
    expect(entries()).toHaveLength(before); // no second image, no second open unit
    expect(w.state().steps.image.proof.outcome).toBe("already");
    expect(w.state().steps.open.proof.wasAlreadyOpen).toBe(true);
    // preflight on a log that has the image: refused (it re-checks its precondition); export on an unfrozen D1: refused
    const pre = await w.cutover(["--execute", "--only", "preflight"]);
    expect(pre.code).toBe(1);
    expect(text(pre)).toContain("the AWS log is not empty");
    // D1 stays frozen after the cutover (nothing ever clears its flag but a rollback), so an export is still allowed and gives the same bytes
    const sha = w.state().data.exportSha;
    expect((await w.cutover(["--execute", "--only", "export"])).code).toBe(0);
    expect(w.state().data.exportSha).toBe(sha);
  });
});

describe("each step's precondition stops the run with a clear message (CV11)", () => {
  const fails = async (r: { code: number; out: string[] }, re: RegExp, step: string) => {
    expect(r.code, text(r)).toBe(1);
    expect(text(r)).toMatch(re);
    expect(text(r)).toContain(`resume with: node scripts/cutover/run.mjs --execute --from ${step}`);
    expect(status(step)).toBe("failed");
  };

  it("[LDB-CV11] preflight: a stack without an output, a function that does not await its image, a non-empty log, a Worker without the modes, a D1 already frozen", async () => {
    w = await makeWorld({ faults: { missingOutput: "LogTable" } });
    await fails(await w.cutover(), /has no output LogTable/, "preflight");
    cleanup(w);
    w = await makeWorld({ faults: { awaitImage: "0" } });
    await fails(await w.cutover(), /does not await its image \(AKLDB_AWAIT_IMAGE=0\).*CV12/, "preflight");
    expect(w.state().steps.freeze).toBeUndefined();
    cleanup(w);
    w = await makeWorld();
    await w.operator.appendImage({ raw: w.d1().serialize(), tables: {}, source: {} });
    await fails(await w.cutover(), /the AWS log is not empty \(head 1\)/, "preflight");
    cleanup(w);
    w = await makeWorld();
    await fails(await w.cutover(["--execute", "--min-api-minor", "35"]), /serves api\.minor 34, the modes shipped in 35/, "preflight");
    cleanup(w);
    w = await makeWorld();
    w.d1().exec("INSERT INTO import_state (key, value) VALUES ('cutover.mode', 'read_only')");
    await fails(await w.cutover(), /already has cutover\.mode=read_only/, "preflight");
    expect(w.calls.filter((c) => c === "d1.write")).toHaveLength(0); // nothing was frozen by a failed preflight
  });

  it("[LDB-CV11] freeze: a Worker that does not refuse writes (the build lacks the modes) stops the run, and --abort clears the flag", async () => {
    w = await makeWorld({ faults: { noModes: true } });
    await fails(await w.cutover(), /did not refuse writes after the freeze: POST \/v1\/layouts with an empty body answered 400/, "freeze");
    expect(w.d1().prepare("SELECT value FROM import_state WHERE key = 'cutover.mode'").get()).toEqual({ value: "read_only" });
    w.faults.noModes = false;
    const abort = await w.cutover(["--execute", "--abort"]);
    expect(abort.code, text(abort)).toBe(0);
    expect(w.d1().prepare("SELECT count(*) AS n FROM import_state WHERE key = 'cutover.mode'").get()).toEqual({ n: 0 });
    expect(entries()).toHaveLength(0);
    // and without a preflight there is no freeze
    cleanup(w);
    w = await makeWorld();
    await fails(await w.cutover(["--execute", "--only", "freeze"]), /preflight has not passed/, "freeze");
  });

  it("[LDB-CV11] export, load and verify each refuse to start from a state they did not expect", async () => {
    await until("freeze");
    w.d1().exec("DELETE FROM import_state WHERE key = 'cutover.mode'");
    await fails(await w.cutover(["--execute", "--only", "export"]), /D1 is not frozen any more/, "export");
    cleanup(w);
    await until("preflight");
    await fails(await w.cutover(["--execute", "--only", "load"]), /the export has not run/, "load");
    cleanup(w);
    await until("export");
    fs.appendFileSync(path.join(w.dir, "work", "export.sql"), "-- tampered\n");
    await fails(await w.cutover(["--execute", "--only", "load"]), /export file changed since the export step recorded it/, "load");
    cleanup(w);
    await until("load");
    fs.appendFileSync(path.join(w.dir, "work", "image.sqlite"), "x");
    await fails(await w.cutover(["--execute", "--only", "verify"]), /image file changed since the load step recorded it/, "verify");
    cleanup(w);
    await until("load");
    w.d1().exec("DELETE FROM import_state WHERE key = 'cutover.mode'");
    await fails(await w.cutover(["--execute", "--only", "verify"]), /D1 is not frozen any more: its data may have moved/, "verify");
  });

  it("[LDB-CV11] load: a D1 whose d1_migrations lags the bundle, or a missing table, fails the sanity checks by name", async () => {
    await until("freeze");
    w.d1().exec("DELETE FROM d1_migrations WHERE name = (SELECT name FROM d1_migrations ORDER BY id DESC LIMIT 1)");
    w.d1().exec("DROP TABLE discord_deny_modals");
    const r = await w.cutover(["--execute", "--from", "export"]);
    await fails(r, /failed its sanity checks: .*tables_present: missing: discord_deny_modals.*d1_migrations_complete: .*pending \[0037_read_indexes\.sql\]/s, "load");
    // --allow-pending forgives only the migrations, never the table
    const lenient = await w.cutover(["--execute", "--from", "load", "--allow-pending"]);
    expect(text(lenient)).toMatch(/tables_present: missing: discord_deny_modals/);
    expect(text(lenient)).not.toMatch(/d1_migrations_complete: /);
    expect(entries()).toHaveLength(0);
  });

  it("[LDB-CV11] image, serve, dns and open refuse to run before what they depend on", async () => {
    await until("export");
    await fails(await w.cutover(["--execute", "--only", "image"]), /CV16: the image is appended only after verify passed/, "image");
    cleanup(w);
    await until("verify");
    // another image already at seq 1
    await w.operator.appendImage({ raw: Uint8Array.from([1, 2, 3]), tables: {}, source: {} });
    await fails(await w.cutover(["--execute", "--only", "image"]), /seq 1 is not this image: refusing \(CV10\)/, "image");
    cleanup(w);
    await until("verify");
    await fails(await w.cutover(["--execute", "--only", "serve"]), /the image has not been appended/, "serve");
    cleanup(w);
    await until("image");
    await fails(await w.cutover(["--execute", "--only", "dns"]), /the prod stack has not been proven to serve/, "dns");
    await fails(await w.cutover(["--execute", "--only", "open"]), /CV16: writes open only after serve is done/, "open");
    expect(entries()).toHaveLength(1); // still only the image
  });

  it("[LDB-CV11] serve: reads that differ from D1's, or an answer without x-akldb-backend, fail", async () => {
    await until("image", { awsListDiffers: true });
    await fails(await w.cutover(["--execute", "--only", "serve"]), /reads differ between D1 and the prod stack: \/v1\/layouts\?limit=20 status 200,200 body != etag =/, "serve");
    cleanup(w);
    await until("image", { awsNoBackendHeader: true });
    await fails(await w.cutover(["--execute", "--only", "serve"]), /answers without x-akldb-backend: aws \(CV13\)/, "serve");
  });

  it("[LDB-CV23] serve needs the origin secret file, and open refuses until the name points at AWS", async () => {
    w = await makeWorld({ faults: { noOriginFile: true } });
    await fails(await w.cutover(), /the direct read of the stack \(serve\) is not possible: the origin secret file .* is unusable/, "preflight");
    expect(w.calls).not.toContain("d1.write");
    cleanup(w);
    await until("serve");
    await fails(await w.cutover(["--execute", "--only", "open"]), /CV16: writes open only after dns is done/, "open");
    expect(await w.operator.readFlag()).toBe("read_only"); // AWS is still frozen
    expect(entries()).toHaveLength(1);
  });

  it("[LDB-CV11] post-smoke: a signed write that makes no feed event fails the feed check", async () => {
    await until("open", { signedWriteMakesNoEvent: true });
    await fails(await w.cutover(["--execute", "--only", "post-smoke"]), /the feed after seq 12 is empty/, "post-smoke");
    await fails(await w.cutover(["--execute", "--only", "report"]).then(() => w.cutover(["--execute", "--only", "post-smoke"])), /the feed after seq 12 is empty/, "post-smoke");
  });
});

describe("the dns step (CV23)", () => {
  it("[LDB-CV23] it prints saltorbit's instructions, then waits until the name answers from AWS with the image's seq, five times in a row on fresh connections", async () => {
    w = await makeWorld();
    await w.cutoverUntil("serve");
    const r = await w.cutover(["--execute", "--only", "dns"]);
    expect(r.code, text(r)).toBe(0);
    const t = text(r);
    expect(t).toContain("ACTION FOR SALTORBIT");
    expect(t).toMatch(/Workers & Pages > akl-db > Settings > Domains & Routes: remove the custom domain api\.akldb\.org .*reachable at https:\/\/akl-db\.akl-58a\.workers\.dev/);
    expect(t).toMatch(/add CNAME  api  ->  d-abc\.execute-api\.us-east-2\.amazonaws\.com   Proxied/);
    expect(t).not.toMatch(/x-akldb-origin: [0-9a-f]{16}/); // no secret anywhere
    const proof = w.state().steps.dns.proof;
    expect(proof.consecutive).toBe(5);
    expect(proof.polls).toBe(2 + 5); // two polls still answered by the Worker, then five from AWS
    expect(w.dns).toBe("aws");
    expect(entries()).toHaveLength(1); // writes did not open
    expect(await w.operator.readFlag()).toBe("read_only");
  });

  it("[LDB-CV23] a gap, then a stale answer in the middle, restart the count; a name that never moves times out with what to do, and writes stay closed", async () => {
    w = await makeWorld({ faults: { dnsErrorFirst: true, dnsFlap: true } });
    await w.cutoverUntil("serve");
    const r = await w.cutover(["--execute", "--only", "dns"]);
    expect(r.code, text(r)).toBe(0);
    expect(w.state().steps.dns.proof.polls).toBeGreaterThan(2 + 5 + 1); // the flap forced more than the minimum
    cleanup(w);
    w = await makeWorld({ faults: { dnsNeverFlips: true } });
    await w.cutoverUntil("serve");
    const t0 = w.now;
    const never = await w.cutover(["--execute", "--only", "dns"]);
    expect(never.code).toBe(1);
    expect(text(never)).toMatch(/https:\/\/api\.akldb\.org still does not answer from AWS after 9\d\d s and \d+ polls \(last: status 200, x-akldb-backend absent, seq 12 \(want aws, 12\)\)\. Has the Worker's custom domain been removed and the proxied CNAME to d-abc\.execute-api\.us-east-2\.amazonaws\.com added\? Re-run with --from dns/);
    expect(w.now - t0).toBeGreaterThanOrEqual(900_000);
    expect(await w.operator.readFlag()).toBe("read_only");
    expect(entries()).toHaveLength(1);
    // saltorbit does it later: the same step, re-run, passes
    w.faults.dnsNeverFlips = false;
    expect((await w.cutover(["--execute", "--from", "dns"])).code).toBe(0);
    expect(status("open")).toBe("done");
  });

  it("[LDB-CV23] a name that answers from AWS with the wrong seq does not pass", async () => {
    w = await makeWorld({ faults: { dnsFlipAfter: 0 } });
    await w.cutoverUntil("serve");
    w.d1(); // D1 untouched; make AWS answer another seq: an event appended behind the image's back
    await w.operator.runUnit("INSERT INTO events (at, kind, actor, via) VALUES ('x', 'k', 'a', 'v')");
    const r = await w.cutover(["--execute", "--only", "dns"]);
    expect(r.code).toBe(1);
    expect(text(r)).toMatch(/last: status 200, x-akldb-backend aws, seq 15 \(want aws, 12\)/);
  });

  it("[LDB-CV23] in a rehearsal the public name is not the Worker's: nothing to move, and the poll passes at once", async () => {
    w = await makeWorld({ rehearsal: true });
    const r = await w.cutover();
    expect(r.code, text(r)).toBe(0);
    expect(text(r)).toContain("(rehearsal: https://staging-api.akldb.org is not the Worker's name, nothing to move; polling it anyway)");
    expect(text(r)).not.toContain("ACTION FOR SALTORBIT");
    expect(w.state().steps.dns.proof.polls).toBe(5);
    expect(w.state().params.d1Name).toBe("scratch");
  });
});

describe("resume from every step (CV11)", () => {
  it("[LDB-CV11] a crash at a port call inside any step, then a plain re-run, ends in the happy path's state with nothing done twice", async () => {
    // how many port calls each step makes on a clean run
    w = await makeWorld();
    expect((await w.cutover()).code).toBe(0);
    const counts = Object.fromEntries(Object.entries(w.callsByStep).map(([k, v]) => [k, v.length]));
    const happyKinds = entries().map((e) => e.kind);
    const happyHead = entries().length;
    cleanup(w);
    let crashes = 0;
    for (const id of STEP_IDS.slice(0, -1)) {
      const total = counts[id] ?? 0;
      for (const nth of [...new Set([1, 2, 3, Math.ceil(total / 2), total - 1, total])].filter((n) => n >= 1 && n <= total)) {
        w = await makeWorld({ faults: { crashStep: id, crashNth: nth } });
        const first = await w.cutover();
        expect(first.code, `${id} call ${nth}`).toBe(1);
        expect(text(first), `${id} call ${nth}`).toContain(`injected crash in ${id}`);
        expect(status(id)).toBe("failed");
        const second = await w.cutover(); // the plain resume: done steps are skipped, the failed one re-runs
        expect(second.code, `${id} call ${nth}: ${text(second)}`).toBe(0);
        for (const s of STEP_IDS) expect(status(s), `${id}/${nth}: ${s}`).toBe("done");
        // post-smoke's signed write is a real write: a crash after it and before the step finished repeats it, once (one more event)
        const extra = id === "post-smoke" ? entries().length - happyHead : 0;
        expect(extra, `${id}/${nth}`).toBeGreaterThanOrEqual(0);
        expect(extra, `${id}/${nth}`).toBeLessThanOrEqual(1);
        expect(entries().map((e) => e.kind), `${id}/${nth}`).toEqual([...happyKinds, ...Array(extra).fill("unit")]);
        expect(w.dns).toBe("aws");
        crashes++;
        cleanup(w);
      }
    }
    expect(crashes).toBeGreaterThan(30);
    w = await makeWorld(); // so afterEach has something to clean
  }, 180_000);

  it("[LDB-CV11] --from re-runs a step and everything after it; --only runs one", async () => {
    w = await makeWorld();
    await w.cutoverUntil("verify");
    const before = status("verify");
    const r = await w.cutover(["--execute", "--from", "verify"]);
    expect(r.code, text(r)).toBe(0);
    expect(before).toBe("done");
    expect(text(r)).not.toContain("[freeze]");
    expect(text(r)).not.toContain("[export]");
    for (const id of ["verify", "image", "serve", "dns", "open", "post-smoke", "report"]) expect(status(id)).toBe("done");
  });
});

describe("CV16: writes open only after the proof", () => {
  it("[LDB-CV16] a failed verify keeps AWS empty and frozen: image and open refuse, whatever the state file says", async () => {
    w = await makeWorld();
    await w.cutoverUntil("load");
    w.d1().exec("UPDATE churn SET v = 'changed after the export' WHERE id = 1");
    const v = await w.cutover(["--execute", "--only", "verify"]);
    expect(v.code).toBe(1);
    expect(status("verify")).toBe("failed");
    expect(w.state().steps.verify.proof.ok).toBe(false);
    for (const id of ["image", "open"]) {
      const r = await w.cutover(["--execute", "--only", id]);
      expect(r.code, id).toBe(1);
      expect(text(r)).toMatch(/CV16/);
    }
    expect(entries()).toHaveLength(0);
    // forging the state (verify "done" but not ok) does not help
    const st = w.state();
    st.steps.verify.status = "done";
    fs.writeFileSync(w.stateFile, JSON.stringify(st));
    const forged = await w.cutover(["--execute", "--only", "image"]);
    expect(forged.code).toBe(1);
    expect(text(forged)).toMatch(/CV16/);
    expect(entries()).toHaveLength(0);
    expect(w.calls.includes("aws.operator.appendImage")).toBe(false);
    expect(w.calls.includes("aws.operator.runUnit")).toBe(false);
  });

  it("[LDB-CV16] open refuses when the image in the log is not the one verify proved", async () => {
    await until("dns");
    const st = w.state();
    st.data.imageSha = "0".repeat(64);
    fs.writeFileSync(w.stateFile, JSON.stringify(st));
    const r = await w.cutover(["--execute", "--only", "open"]);
    expect(r.code).toBe(1);
    expect(text(r)).toContain("CV16: the image in the AWS log is not the one verify proved");
    expect(await w.operator.readFlag()).toBe("read_only");
    expect(entries()).toHaveLength(1);
  });

  it("[LDB-CV16] the writes were refused from the freeze to the open, on the Worker and on the stack, and accepted after", async () => {
    await until("export");
    const probe = async (url: string) => (await w.ports.http.request(`${url}/v1/layouts`, { method: "POST", body: "" })).status;
    expect(await probe("https://api.akldb.org")).toBe(503); // frozen D1
    await w.cutover(["--execute", "--from", "load"]);
    expect(await probe("https://api.akldb.org")).not.toBe(503); // open
    expect((await w.ports.stack.request("/v1/layouts", { method: "POST", body: "" })).status).not.toBe(503);
    const pause = w.state().data.pauseMs;
    expect(pause).toBeGreaterThanOrEqual(3000); // at least the cache waits
  });
});

describe("CV17: verify catches every kind of difference", () => {
  const verifyAfter = async (mutate: (w: World) => void, fromLoad = false) => {
    w = await makeWorld();
    await w.cutoverUntil(fromLoad ? "load" : "export");
    mutate(w);
    const r = await w.cutover(["--execute", "--from", fromLoad ? "verify" : "load"]);
    expect(r.code, text(r)).toBe(1);
    expect(status("verify"), "the failure is the verify step").toBe("failed");
    expect(entries(), "nothing reached AWS").toHaveLength(0);
    return w.state().steps.verify.message as string;
  };

  it("[LDB-CV17] a count mismatch (a row D1 gained after the export)", async () => {
    let n = 0;
    const m = await verifyAfter((w) => {
      n = Number((w.d1().prepare("SELECT count(*) AS n FROM churn").get() as { n: number }).n);
      w.d1().exec("INSERT INTO churn (v) VALUES ('late')");
    });
    expect(m).toContain(`churn: count sqlite ${n} != d1 ${n + 1}`);
  });

  it("[LDB-CV17] a checksum mismatch (the same count, one value different)", async () => {
    const m = await verifyAfter((w) => w.d1().exec("UPDATE authors SET name = 'Ada' WHERE user_id = 'u0'"));
    expect(m).toMatch(/authors: checksum sqlite [0-9a-f]{64} != d1 [0-9a-f]{64}/);
    expect(m).not.toContain("count");
  });

  it("[LDB-CV17] a meta.seq mismatch (an event D1 gained after the export)", async () => {
    const m = await verifyAfter((w) => w.d1().exec("INSERT INTO events (at, kind, actor, via) VALUES ('2026-11-04T09:00:00Z', 'layout.created', 'u', 'api')"));
    expect(m).toContain("meta.seq: sqlite 12 != d1 15"); // the new event took the counter's next value, 15
  });

  it("[LDB-CV17] a next-seq mismatch (D1's AUTOINCREMENT counter moved: an event inserted and deleted again)", async () => {
    const m = await verifyAfter((w) => w.d1().exec("INSERT INTO events (at, kind, actor, via) VALUES ('x', 'k', 'a', 'v'); DELETE FROM events WHERE kind = 'k'"), true);
    expect(m).toContain("next-seq rule (CV17): sqlite_sequence for events is 14, D1's is 15");
    expect(m).toContain("sqlite_sequence: checksum");
    expect(m).not.toContain("meta.seq");
  });

  it("[LDB-CV17] a schema difference (an index D1 has and the export lacks)", async () => {
    const m = await verifyAfter((w) => w.d1().exec("CREATE INDEX stray ON churn(n)"), true);
    expect(m).toContain("schema: index stray is on D1 but not in the export");
  });

  it("[LDB-CV17] an export without sqlite_sequence: the load step raises the counters from D1 (only ever up) and says so; verify passes and the next event is last+gap+1", async () => {
    w = await makeWorld({ faults: { exportDropsSequence: true } });
    const r = await w.cutover();
    expect(r.code, text(r)).toBe(0);
    expect(w.state().steps.load.proof.sequenceRepairs).toEqual(expect.arrayContaining([{ name: "events", from: 12, to: 14 }]));
    const v = w.state().steps.verify.proof;
    expect(v).toMatchObject({ ok: true, metaSeq: 12, eventsCounter: 14 });
    // the first event AWS writes after the cutover is D1's counter + 1 = 15, not MAX(seq) + 1 = 13
    expect(w.state().steps["post-smoke"].proof.feed).toMatchObject({ since: 12, expectedFirst: 15, first: 15 });
  });

  it("[LDB-CV21] an export that lists the triggers before the rows loads to D1's exact values: verify passes, the head counters are not doubled", async () => {
    w = await makeWorld({ faults: { exportTriggersFirst: true } });
    const r = await w.cutover();
    expect(r.code, text(r)).toBe(0);
    const exported = fs.readFileSync(path.join(w.dir, "work", "export.sql"), "utf8");
    expect(exported.indexOf("CREATE TRIGGER")).toBeLessThan(exported.indexOf("INSERT INTO")); // the export really is in the naive order
    const aws = await w.awsReplica();
    expect(aws.db.prepare("SELECT version FROM authors_head").get()).toEqual(w.d1().prepare("SELECT version FROM authors_head").get());
  });

  it("[LDB-CV17] feed contiguity is checked against D1's counter after the flip", async () => {
    w = await makeWorld();
    expect((await w.cutover()).code).toBe(0);
    const aws = await w.awsReplica();
    expect(aws.db.prepare("SELECT MIN(seq) AS s FROM events WHERE seq > 12").get()).toEqual({ s: 15 });
    expect(aws.db.prepare("SELECT seq FROM sqlite_sequence WHERE name = 'events'").get()).toEqual({ seq: 15 });
  });
});
