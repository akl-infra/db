// [LDB-MIR20..] The mirror's applier (lane Z) on DynamoDB Local: the recorded writes of the fuzzer's request sequences, sent
// through ingest (HMAC) into the queue and replayed by the applier into a second store, give byte-identical rows.
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
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
import { compareTables, type RowsByTable } from "../../src/mirror/verify";
import { batchesOf, sourceApp, startSource, type AppEnv, type Source } from "./support";

const SECRET = "test-secret";
const NOW = Date.parse("2030-01-01T00:00:00Z"); // far after every recorded atMs: everything is settled
const REPO = path.resolve(import.meta.dirname, "..", "..");
const CRAWL = "../../scripts/lab/p1-crawl-diff.mjs";
const GENERATOR = "../../scripts/lab/fuzz/generator.mjs";

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

/** Drive the fuzzer's generator against the source app; returns the recorded calls. */
async function runFuzzerSequence(src: Source, seed: number, steps: number): Promise<{ statuses: Record<string, number> }> {
  const crawl = (await import(/* @vite-ignore */ CRAWL)) as any; // eslint-disable-line @typescript-eslint/no-explicit-any
  const { Generator } = (await import(/* @vite-ignore */ GENERATOR)) as { Generator: new (o: { seed: number; corpus: object[] }) => { next(): any; observe(s: unknown, r: unknown): void } };
  const discord = (await crawl.startFakeDiscord(18532)) as http.Server;
  try {
    const fixture = JSON.parse(fs.readFileSync(path.join(REPO, "tests/fixtures/seed-upstream-100.dump.json"), "utf8"));
    const corpus = fixture.layout_formats.filter((f: any) => f.lineage === "spark").map((f: any) => JSON.parse(f.payload_json));
    await src.recorded.admin.insertAdmin({ user_id: crawl.ADMIN, added_by: null, added_at: "2026-10-25T00:00:00.000Z", note: "mirror-test" } as never);
    await src.recorded.admin.insertClient({
      id: crawl.LAB_CLIENT, name: "mirror-test", pubkey: crawl.LAB_PUB_RAW, owner_user_id: crawl.ADMIN, caps: "act-as-user,feed:wait",
      discord_app_id: null, status: "active", created_at: "2026-10-25T00:00:00.000Z", revoked_at: null,
    } as never);
    const app = sourceApp(env as AppEnv, src, "http://127.0.0.1:18532/api");
    const gen = new Generator({ seed, corpus });
    const statuses: Record<string, number> = {};
    let n = 0;
    for (let i = 0; i < steps; i++) {
      const step = gen.next();
      if (step.restart) continue;
      const nowIso = new Date().toISOString();
      const body = step.json === undefined ? undefined : Buffer.from(JSON.stringify(step.json));
      const headers: Record<string, string> = { ...(step.headers ?? {}) };
      if (body !== undefined) headers["Content-Type"] = "application/json";
      if (step.badSignature) Object.assign(headers, { "X-Akl-Client": crawl.LAB_CLIENT, "X-Akl-Timestamp": "1", "X-Akl-Nonce": "AAAA", "X-Akl-Actor": step.actor, "X-Akl-Signature": "AAAA" });
      else if (step.actor !== undefined) Object.assign(headers, crawl.signedHeaders(step.method, step.path, body, step.actor, nowIso, `${seed}-${n++}`));
      if (step.bearer !== undefined) headers.Authorization = `Bearer lab-${step.bearer}`;
      const res = await app.fetch(new Request(`http://127.0.0.1:8787${step.path}`, { method: step.method, headers, body }));
      const text = await res.text();
      let json: unknown = null;
      try {
        json = JSON.parse(text);
      } catch {
        // not JSON
      }
      statuses[res.status] = (statuses[res.status] ?? 0) + 1;
      gen.observe(step, { status: res.status, json, etag: res.headers.get("etag") ?? undefined });
    }
    return { statuses };
  } finally {
    discord.close();
  }
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
    const { statuses } = await runFuzzerSequence(src, 1, 160);
    expect(src.calls.length).toBeGreaterThan(20);
    expect(src.calls.some((c) => c.seqs.length > 0)).toBe(true);
    expect(Object.keys(statuses).length).toBeGreaterThan(1);

    const queue = createKvQueue(ddbKv({ doc: ddbHarness.doc, table: ddbHarness.tables.ephemeral, direction: "d1->ddb", blobs: ddbHarness.blobs }), "d1->ddb");
    const batches = batchesOf(src.calls, 3);
    // Arrive out of order, one twice.
    for (const b of [...batches].reverse()) expect((await post(queue, b)).status).toBe(202);
    expect((await post(queue, batches[0]!)).body.duplicate).toBe(true);

    const report = await drain(depsFor(queue));
    expect(report.halted).toBeNull();
    const st = await queue.readState();
    expect(st.appliedSeq).toBe(Math.max(...src.calls.flatMap((c) => c.seqs)));
    expect(await queue.pending(5)).toEqual([]);

    const diffs = compareTables(await rowsOf(src.ctx), await rowsOf(targetCtx()));
    expect(diffs).toEqual([]);
  }, 300_000);

  it("[LDB-MIR25] ingest refuses a bad signature, a stale timestamp, the wrong direction, an unknown method and a dormant secret", async () => {
    const q = freshQueue();
    const call: TeeCall = { v: 1, method: "state.put", args: ["k", "v"], outcome: { ok: null }, seqs: [], atMs: 1000 };
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
    const good: TeeCall = { v: 1, method: "state.put", args: ["after-k", "v"], outcome: { ok: null }, seqs: [], atMs: 2000 };
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
    const call: TeeCall = { v: 1, method: "state.put", args: ["gap-k", "v"], outcome: { ok: null }, seqs: [head + 5], atMs: 1000 };
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
    const calls: TeeCall[] = [1, 2, 3].map((i) => ({ v: 1, method: "state.put", args: [`lease-${i}`, "v"], outcome: { ok: null }, seqs: [], atMs: 1000 + i }));
    await post(q, { v: 1, direction: "d1->ddb", batchId: "lease-1", calls });
    const [a, b] = await Promise.all([runApplier(depsFor(q)), runApplier(depsFor(q))]);
    expect(a.applied + b.applied).toBe(3);
    expect(a.halted ?? b.halted).toBeNull();
  });
});
