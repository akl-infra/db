// [LDB-MIR30..] Reseed and the daily proof (lane Z) on DynamoDB Local.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { env } from "../harness";
import { ddbHarness } from "../harness/ddb";
import { compareMirrored, dailyProof, mirroredRows, reseed, wipeAll } from "../../scripts/mirror/ops";
import { runApplier, type ApplyDeps } from "../../src/mirror/apply";
import { signTee } from "../../src/mirror/ingest";
import { handleIngest } from "../../src/mirror/ingest";
import { createKvQueue, memoryKv, updateState } from "../../src/mirror/queue";
import { TEE_SIG_HEADER, TEE_TS_HEADER, type TeeBatch, type TeeCall } from "../../src/mirror/record";
import { type RowsByTable } from "../../src/mirror/verify";
import { exportRows } from "../../src/store/ddb/codec";
import { batchesOf, fuzzDriver, startSource, type Source } from "./support";

const SECRET = "reseed-secret";
const ctx = () => ({ doc: ddbHarness.doc, tables: ddbHarness.tables, blobs: ddbHarness.blobs });
const rowsOf = async (c: { doc: unknown; tables: unknown; blobs: unknown }) => (await exportRows(c as never)) as unknown as RowsByTable;

async function post(queue: ReturnType<typeof createKvQueue>, batch: TeeBatch) {
  const body = JSON.stringify(batch);
  const ts = String(Math.floor(Date.now() / 1000));
  const h: Record<string, string> = { [TEE_TS_HEADER.toLowerCase()]: ts, [TEE_SIG_HEADER.toLowerCase()]: await signTee(SECRET, ts, body) };
  const r = await handleIngest({ header: (n) => h[n.toLowerCase()] ?? null, body }, { secret: SECRET, queue, nowMs: () => Date.now(), log: () => {} });
  expect(r.status).toBe(202);
}

const deps = (queue: ReturnType<typeof createKvQueue>): ApplyDeps => ({ store: ddbHarness.store, queue, nowMs: () => Date.now(), settleMs: 0, sleep: async () => {}, log: () => {} });
const settle = () => new Promise((r) => setTimeout(r, 15));

describe("reseed and daily proof", () => {
  let src: Source;
  beforeAll(async () => {
    src = await startSource("reseed");
  });
  afterAll(async () => {
    await src.stop();
  });

  it("[LDB-MIR30] reseed: wipe, import the export at seq S, drop the queued overlap, replay S+1.., end identical; clears a halt", async () => {
    const driver = await fuzzDriver(src, env, 3, 18533);
    await driver.run(60);
    await settle();
    const exportRowsAt = await rowsOf(src.ctx);
    const exportAtMs = Date.now();
    await settle();
    const callsBefore = src.calls.length;
    await driver.run(60);
    await driver.stop();
    expect(src.calls.length).toBeGreaterThan(callsBefore);
    expect(src.calls.slice(callsBefore).some((c) => c.seqs.length > 0)).toBe(true);

    // The queue holds EVERYTHING (the overlap too), and the target is a stale mirror that is also halted.
    const queue = createKvQueue(memoryKv(), "d1->ddb");
    for (const b of batchesOf(src.calls, 4, "d1->ddb", "rs")) await post(queue, b);
    await updateState(queue, (s) => {
      s.halted = { code: "MIRROR_DIVERGED", reason: "test", atMs: 1, callKey: null };
    });
    await ddbHarness.store.state.put("stale-junk", "x"); // the target holds something prod never had

    const seedSeq = Math.max(...(exportRowsAt.events ?? []).map((e) => Number(e.seq)));
    const r = await reseed({ ctx: ctx(), queue, rows: exportRowsAt, exportAtMs, applyDeps: deps(queue), nowMs: () => Date.now() });
    expect(r.seedSeq).toBe(seedSeq);
    expect(r.verified).toEqual([]);
    expect(r.replay?.halted).toBeNull();
    expect(r.replayVerified).toBe(true);
    expect(await ddbHarness.store.state.get("stale-junk")).toBeNull();
    const st = await queue.readState();
    expect(st.halted).toBeNull();
    expect(st.appliedSeq).toBe(Math.max(...src.calls.flatMap((c) => c.seqs)));
    expect(await queue.pending(5)).toEqual([]);
    expect(compareMirrored(await rowsOf(src.ctx), await rowsOf(ctx()))).toEqual([]);
  }, 300_000);

  it("[LDB-MIR31] daily proof: pauses at the export point (later calls wait), compares row for row, lifts the pause; a tampered mirror fails it", async () => {
    const queue = createKvQueue(memoryKv(), "d1->ddb");
    // Bring the queue state to the mirror's current head: nothing queued, applied = head.
    const head = await ddbHarness.store.head.headSeq();
    await updateState(queue, (s) => {
      s.appliedSeq = head;
    });
    const rows = await rowsOf(src.ctx);
    const atMs = Date.now();
    await settle();
    // A write that happens after the export instant is queued: it must NOT be applied while paused.
    const later: TeeCall = { v: 1, method: "state.put", args: ["after-export", "v"], outcome: { ok: { $u: 1 } }, seqs: [], atMs: atMs + 50 };
    await post(queue, { v: 1, direction: "d1->ddb", batchId: "later-1", calls: [later] });

    const ok = await dailyProof({ ctx: ctx(), queue, rows, atMs, quietMs: 0, applyDeps: deps(queue), timeoutMs: 20_000 });
    expect(ok.reason).toBeNull();
    expect(ok.ok).toBe(true);
    expect(ok.diffs).toEqual([]);
    expect(await ddbHarness.store.state.get("after-export")).toBeNull();
    expect((await queue.readState()).pause).toBeNull();
    // Resumed: the held-back call now applies (once its recorded time is in the past).
    await new Promise((r) => setTimeout(r, 150));
    expect((await runApplier(deps(queue))).applied).toBe(1);
    expect(await ddbHarness.store.state.get("after-export")).toBe("v");

    // Tamper: a row the source never had.
    await ddbHarness.store.state.put("tampered", "yes");
    const bad = await dailyProof({ ctx: ctx(), queue, rows, atMs, quietMs: 0, applyDeps: deps(queue), timeoutMs: 20_000 });
    expect(bad.ok).toBe(false);
    expect(bad.diffs.map((d) => d.table)).toContain("import_state");
    expect((await queue.readState()).pause).toBeNull();
  }, 120_000);

  it("[LDB-MIR32] wipeAll empties both tables but leaves the mirror queue; mirroredRows drops the ephemeral tables", async () => {
    const queue = createKvQueue((await import("../../src/mirror/kv-ddb")).ddbKv({ doc: ddbHarness.doc, table: ddbHarness.tables.ephemeral, direction: "d1->ddb", blobs: ddbHarness.blobs }), "d1->ddb");
    await post(queue, { v: 1, direction: "d1->ddb", batchId: "wipe-1", calls: [{ v: 1, method: "state.put", args: ["w", "v"], outcome: { ok: { $u: 1 } }, seqs: [], atMs: 1000 }] });
    const n = await wipeAll(ctx());
    expect(n).toBeGreaterThan(0);
    expect((await queue.pending(5)).length).toBe(1);
    const rows = await rowsOf(ctx());
    expect(Object.values(rows).flat().filter((r) => typeof r === "object").length).toBeLessThanOrEqual(3); // only the head tables' defaults (layouts_head, authors_head, discord_users_head)
    expect(mirroredRows({ nonces: [{ a: 1 }], auth_cache: [], ratelimit: [{ key: "destructive:c", n: 2 }, { key: "write:u", n: 5 }], layouts: [{ id: "x" }] })).toEqual({ ratelimit: [{ key: "destructive:c", n: 2 }], layouts: [{ id: "x" }] });
  });
});
