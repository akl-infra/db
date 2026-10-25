// [LDB-MIR20..] The mirror's applier (lane Z) on DynamoDB Local: the recorded writes of the fuzzer's request sequences, sent
// through ingest (HMAC) into the queue and replayed by the applier into a second store, give byte-identical rows.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { env } from "../harness";
import { ddbHarness } from "../harness/ddb";
import { exportRows } from "../../src/store/ddb/codec";
import { runApplier, type ApplyDeps } from "../../src/mirror/apply";
import { handleIngest } from "../../src/mirror/ingest";
import { signTee } from "../../src/mirror/ingest";
import { createKvQueue, memoryKv, updateState, type MirrorQueue } from "../../src/mirror/queue";
import { ddbKv } from "../../src/mirror/kv-ddb";
import { TEE_SIG_HEADER, TEE_TS_HEADER, type TeeBatch, type TeeCall } from "../../src/mirror/record";
import { type RowsByTable } from "../../src/mirror/verify";
import { compareMirrored } from "../../scripts/mirror/ops";
import { batchesOf, fuzzDriver, startSource, type Source } from "./support";

const SECRET = "test-secret";
const NOW = Date.parse("2030-01-01T00:00:00Z"); // far after every recorded atMs: everything is settled

const targetCtx = () => ({ doc: ddbHarness.doc, tables: ddbHarness.tables, blobs: ddbHarness.blobs });
const rowsOf = async (ctx: { doc: unknown; tables: unknown; blobs: unknown }) => (await exportRows(ctx as never)) as unknown as RowsByTable;

function depsFor(queue: MirrorQueue, over: Partial<ApplyDeps> = {}): ApplyDeps {
  return { store: ddbHarness.store, queue, nowMs: () => NOW, settleMs: 0, sleep: async () => {}, log: () => {}, ...over };
}

async function post(queue: MirrorQueue, batch: TeeBatch, secret = SECRET, tsOffsetSec = 0) {
  const body = JSON.stringify(batch);
  const ts = String(Math.floor(NOW / 1000) + tsOffsetSec);
  const sig = await signTee(secret, ts, body);
  const headers: Record<string, string> = { [TEE_TS_HEADER.toLowerCase()]: ts, [TEE_SIG_HEADER.toLowerCase()]: sig };
  return handleIngest({ header: (n) => headers[n.toLowerCase()] ?? null, body }, { secret: SECRET, queue, nowMs: () => NOW, log: () => {} });
}

async function drain(deps: ApplyDeps, max = 200) {
  let last = await runApplier(deps);
  for (let i = 0; i < max && last.applied + last.skipped > 0; i++) last = await runApplier(deps);
  return last;
}

describe("mirror applier", () => {
  let src: Source;
  beforeAll(async () => {
    src = await startSource("apply");
  });
  afterAll(async () => {
    await src.stop();
  });

  const freshQueue = (dir: "d1->ddb" | "ddb->d1" = "d1->ddb") => createKvQueue(memoryKv(), dir);
  /** A queue whose applied seq is the target's current head (the target already holds the earlier tests' events). */
  const queueAtHead = async () => {
    const q = freshQueue();
    const head = await ddbHarness.store.head.headSeq();
    await updateState(q, (st) => {
      st.appliedSeq = head;
    });
    return q;
  };

  it("[LDB-MIR20] fuzzer sequences recorded on the source apply through ingest to byte-identical rows", async () => {
    const driver = await fuzzDriver(src, env, 1, 18532);
    const { statuses } = await driver.run(160);
    await driver.stop();
    expect(src.calls.length).toBeGreaterThan(20);
    expect(src.calls.some((c) => c.seqs.length > 0)).toBe(true);
    expect(Object.keys(statuses).length).toBeGreaterThan(1);

    const queue = createKvQueue(ddbKv({ doc: ddbHarness.doc, table: ddbHarness.tables.ephemeral, direction: "d1->ddb", blobs: ddbHarness.blobs }), "d1->ddb");
    const batches = batchesOf(src.calls, 3);
    // Arrive out of order, one twice.
    for (const b of [...batches].reverse()) expect((await post(queue, b)).status).toBe(202);
    expect((await post(queue, batches[0]!)).body.duplicate).toBe(true);

    const report = await drain(depsFor(queue));
    if (report.halted !== null) {
      const { ScanCommand } = await import("@aws-sdk/lib-dynamodb");
      const rl = async (doc: any, table: string) => ((await doc.send(new ScanCommand({ TableName: table, ConsistentRead: true }))).Items ?? []).filter((i: any) => String(i.pk).startsWith("RL#")).map((i: any) => `${i.pk}|${i.sk}|${i.n}`);
      console.log("RL source", await rl(src.ctx.doc, src.ctx.tables.ephemeral), "RL target", await rl(ddbHarness.doc, ddbHarness.tables.ephemeral));
      console.log("calls with budget", src.calls.filter((c) => JSON.stringify(c.args).includes("destructiveBudget")).map((c) => `${c.method}#${c.seqs}`));
    }
    expect(report.halted, JSON.stringify(((await queue.readDivergent()) as { mismatch?: unknown } | null)?.mismatch)?.slice(0, 4000)).toBeNull();
    const st = await queue.readState();
    expect(st.appliedSeq).toBe(Math.max(...src.calls.flatMap((c) => c.seqs)));
    expect(await queue.pending(5)).toEqual([]);

    const diffs = compareMirrored(await rowsOf(src.ctx), await rowsOf(targetCtx()));
    expect(diffs).toEqual([]);

    // GEN_REVERSE_FIXTURE=1 regenerates the fixture tests/mirror/reverse.test.ts replays into D1 (records from the DynamoDB side).
    if (process.env.GEN_REVERSE_FIXTURE === "1") {
      const { mirroredRows } = await import("../../scripts/mirror/ops");
      const fs = await import("node:fs");
      fs.mkdirSync(`${import.meta.dirname}/fixtures`, { recursive: true });
      fs.writeFileSync(`${import.meta.dirname}/fixtures/reverse.json`, JSON.stringify({ calls: src.calls, rows: mirroredRows(await rowsOf(src.ctx)) }));
    }
  }, 300_000);

  it("[LDB-MIR25] ingest refuses a bad signature, a stale timestamp, the wrong direction, an unknown method and a dormant secret", async () => {
    const q = freshQueue();
    const call: TeeCall = { v: 1, method: "state.put", args: ["k", "v"], outcome: { ok: { $u: 1 } }, seqs: [], atMs: 1000 };
    const batch: TeeBatch = { v: 1, direction: "d1->ddb", batchId: "ingest-1", calls: [call] };
    expect((await post(q, batch, "other-secret")).status).toBe(401);
    expect((await post(q, batch, SECRET, 3600)).status).toBe(401);
    expect((await post(q, { ...batch, direction: "ddb->d1" })).status).toBe(409);
    expect((await post(q, { ...batch, calls: [{ ...call, method: "events.feed" }] })).status).toBe(422);
    expect((await post(q, { ...batch, calls: [{ ...call, method: "auth.hitWindow" }] })).status).toBe(422);
    expect((await post(q, { ...batch, calls: [{ ...call, seqs: [3, 5] }] })).status).toBe(400);
    expect(await q.pending(10)).toEqual([]);
    const body = JSON.stringify(batch);
    const off = await handleIngest({ header: () => "1", body }, { secret: "", queue: q, nowMs: () => NOW });
    expect(off.status).toBe(404);
    expect((await post(q, batch)).status).toBe(202);
    expect((await q.pending(10)).length).toBe(1);
  });

  it("[LDB-MIR26] a corrupted record halts the applier with MIRROR_DIVERGED, keeps the record, and nothing is applied past it", async () => {
    const q = await queueAtHead();
    const bad: TeeCall = { v: 1, method: "state.put", args: ["corrupt-k", "v"], outcome: { ok: { not: "null" } }, seqs: [], atMs: 1000 };
    const good: TeeCall = { v: 1, method: "state.put", args: ["after-k", "v"], outcome: { ok: { $u: 1 } }, seqs: [], atMs: 2000 };
    await post(q, { v: 1, direction: "d1->ddb", batchId: "bad-1", calls: [bad, good] });
    const lines: Record<string, unknown>[] = [];
    const r = await runApplier(depsFor(q, { log: (l) => lines.push(l) }));
    expect(r.halted?.code).toBe("MIRROR_DIVERGED");
    expect(lines.some((l) => l.code === "MIRROR_DIVERGED")).toBe(true);
    expect(await q.readDivergent()).not.toBeNull();
    const r2 = await runApplier(depsFor(q));
    expect(r2.applied).toBe(0);
    expect(r2.halted?.code).toBe("MIRROR_DIVERGED");
    expect(await ddbHarness.store.state.get("after-k")).toBeNull(); // never applied past the divergence
    expect((await q.pending(5)).length).toBe(2);
  });

  it("[LDB-MIR27] a gap waits, then times out into a MIRROR_GAP halt that asks for a reseed", async () => {
    const q = await queueAtHead();
    const head = await ddbHarness.store.head.headSeq();
    const call: TeeCall = { v: 1, method: "state.put", args: ["gap-k", "v"], outcome: { ok: { $u: 1 } }, seqs: [head + 5], atMs: 1000 };
    await post(q, { v: 1, direction: "d1->ddb", batchId: "gap-1", calls: [call] });
    let now = NOW;
    const deps = depsFor(q, { nowMs: () => now, gapTimeoutMs: 600_000 });
    const r1 = await runApplier(deps);
    expect(r1.applied).toBe(0);
    expect(r1.gap?.seq).toBe(head + 1);
    expect(r1.halted).toBeNull();
    now += 599_000;
    expect((await runApplier(deps)).halted).toBeNull();
    now += 2_000;
    const r3 = await runApplier(deps);
    expect(r3.halted?.code).toBe("MIRROR_GAP");
    expect(r3.halted?.reason).toMatch(/reseed/);
  });

  it("[LDB-MIR28] a call whose prod outcome was an infrastructure error is skipped, not replayed", async () => {
    const q = await queueAtHead();
    const call: TeeCall = { v: 1, method: "state.put", args: ["skip-k", "v"], outcome: { error: { name: "Error", message: "D1_ERROR: boom" } }, seqs: [], atMs: 1000 };
    await post(q, { v: 1, direction: "d1->ddb", batchId: "skip-1", calls: [call] });
    const r = await runApplier(depsFor(q));
    expect(r.skipped).toBe(1);
    expect(r.halted).toBeNull();
    expect(await ddbHarness.store.state.get("skip-k")).toBeNull();
    const seq = await post(q, { v: 1, direction: "d1->ddb", batchId: "skip-2", calls: [{ ...call, method: "auth.touchClientAuthor", args: [] }] });
    expect(seq.status).toBe(202);
    expect((await runApplier(depsFor(q))).halted?.code).toBe("MIRROR_UNREPLAYABLE"); // a sequence method may have left a prefix in prod
  });

  it("[LDB-MIR29] two applier invocations never apply the same call (lease)", async () => {
    const q = await queueAtHead();
    const calls: TeeCall[] = [1, 2, 3].map((i) => ({ v: 1, method: "state.put", args: [`lease-${i}`, "v"], outcome: { ok: { $u: 1 } }, seqs: [], atMs: 1000 + i }));
    await post(q, { v: 1, direction: "d1->ddb", batchId: "lease-1", calls });
    const [a, b] = await Promise.all([runApplier(depsFor(q)), runApplier(depsFor(q))]);
    expect(a.applied + b.applied).toBe(3);
    expect(a.halted ?? b.halted).toBeNull();
  });

  it("[LDB-MIR34] a Clock recorded with no values that the store reads halts; reads past the recording repeat the last value", async () => {
    // A real recorded call: appendAdmin on the source with a stepping clock (the recorder logs every value it returned).
    const before = src.calls.length;
    let t = Date.parse("2026-10-25T10:00:00.000Z");
    await src.recorded.events.appendAdmin(() => new Date((t += 1000)).toISOString(), { kind: "admin.added", actor: "100000000000000001", detail: { user_id: "100000000000000009" } } as never);
    const real = src.calls.slice(before).find((c) => c.method === "events.appendAdmin")!;
    expect((real.args[0] as { $clock: string[] }).$clock.length).toBeGreaterThanOrEqual(1);

    const head = await ddbHarness.store.head.headSeq();
    const forTarget = (clock: string[]): TeeCall => ({ ...real, args: [{ $clock: clock }, real.args[1]], seqs: [head + 1], outcome: { ok: { seq: head + 1 } } });

    const q = await queueAtHead();
    await post(q, { v: 1, direction: "d1->ddb", batchId: "clk-1", calls: [forTarget([])] }); // the clock list truncated to nothing
    const r = await runApplier(depsFor(q));
    expect(r.halted?.code).toBe("MIRROR_DIVERGED");
    expect(r.halted?.reason).toMatch(/clock/);

    const q2 = await queueAtHead(); // recorded with two reads (D1 style) while the DynamoDB store reads once
    await post(q2, { v: 1, direction: "d1->ddb", batchId: "clk-2", calls: [forTarget(["2026-10-25T10:00:00.000Z", "2026-10-25T10:00:00.001Z"])] });
    const r2 = await runApplier(depsFor(q2));
    expect(r2.halted).toBeNull();
    expect(r2.applied).toBe(1);
    expect((await q2.readState()).clockDrift).toBe(1);
  });
});
