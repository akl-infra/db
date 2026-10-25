// Reseed and the daily proof (design/aws-port.md §5.2 "Recovery", "Daily proof"; lane Z). Plain functions over a DynamoDB context
// and a queue, so tests call them directly and the CLI wrappers (reseed.mjs, daily-proof.mjs) only parse arguments.
import { ScanCommand } from "@aws-sdk/lib-dynamodb";
import { batchWrite, exportRows, importRows, type CodecContext } from "../../src/store/ddb/codec";
import { runApplier, type ApplyDeps, type ApplyReport } from "../../src/mirror/apply";
import { updateState, type MirrorQueue } from "../../src/mirror/queue";
import { compareTables, EPHEMERAL_TABLES, type RowsByTable, type TableDiff } from "../../src/mirror/verify";


type Item = Record<string, unknown>;

async function scanKeys(ctx: CodecContext, table: string): Promise<Item[]> {
  const out: Item[] = [];
  let start: Record<string, unknown> | undefined;
  do {
    const r = (await (ctx.doc as unknown as { send(c: unknown): Promise<{ Items?: Item[]; LastEvaluatedKey?: Record<string, unknown> }> }).send(
      new ScanCommand({ TableName: table, ConsistentRead: true, ProjectionExpression: "pk, sk", ExclusiveStartKey: start }),
    ));
    out.push(...(r.Items ?? []));
    start = r.LastEvaluatedKey;
  } while (start !== undefined);
  return out;
}

/** Delete every item of both tables except the mirror queue (`MQ#...`). */
export async function wipeAll(ctx: CodecContext): Promise<number> {
  let n = 0;
  for (const table of [ctx.tables.main, ctx.tables.ephemeral]) {
    const doomed = (await scanKeys(ctx, table)).filter((i) => !String(i.pk).startsWith("MQ#"));
    await batchWrite(ctx, table, doomed.map((i) => ({ DeleteRequest: { Key: { pk: i.pk, sk: i.sk } } })));
    n += doomed.length;
  }
  return n;
}

/** Drop the tables that are copied at the cutover, not mirrored. */
export function mirroredRows(rows: RowsByTable): RowsByTable {
  return Object.fromEntries(Object.entries(rows).filter(([t]) => !EPHEMERAL_TABLES.includes(t) && !/^(sqlite_|_cf_|d1_migrations$|mirror_queue$)/.test(t)));
}

export function maxSeqOf(rows: RowsByTable): number {
  return Math.max(0, ...(rows.events ?? []).map((e) => Number(e.seq)));
}

export interface ReseedOptions {
  ctx: CodecContext;
  queue: MirrorQueue;
  /** A fresh full private D1 export, D1-shaped rows by table. */
  rows: RowsByTable;
  /** When the export's snapshot was taken (ms): queued non-event calls returned at or before it are already in. */
  exportAtMs: number;
  /** Replay the queue from S+1 with this applier (omit to leave that to the Lambda). */
  applyDeps?: ApplyDeps;
  nowMs?(): number;
  /** How long to wait for a running applier to let go of its lease. */
  leaseWaitMs?: number;
  log?(m: string): void;
}

export interface ReseedResult {
  seedSeq: number;
  wiped: number;
  verified: TableDiff[];
  replay: ApplyReport | null;
  replayVerified: boolean;
}

/** wipe, importRows, replay the queue from S+1, verify (§5.2 "Recovery"). */
export async function reseed(o: ReseedOptions): Promise<ReseedResult> {
  const now = o.nowMs ?? (() => Date.now());
  const log = o.log ?? (() => {});
  const rows = mirroredRows(o.rows);
  const seedSeq = maxSeqOf(rows);

  // 1. Stop the applier (a RESEEDING halt) and wait for a running one to let go.
  await updateState(o.queue, (s) => {
    s.halted = { code: "RESEEDING", reason: "reseed in progress", atMs: now(), callKey: null };
  });
  const deadline = now() + (o.leaseWaitMs ?? 120_000);
  for (;;) {
    const s = await o.queue.readState();
    if (s.lease === null || s.lease.untilMs <= now()) break;
    if (now() > deadline) throw new Error("reseed: an applier still holds the lease");
    await new Promise((r) => setTimeout(r, 250));
  }
  // 2-3. Wipe and load.
  const wiped = await wipeAll(o.ctx);
  log(`wiped ${wiped} items`);
  await importRows(o.ctx, rows, { allowNonEmpty: true });
  // 4. Verify the load row for row before anything is replayed on top.
  const verified = compareTables(rows, (await exportRows(o.ctx)) as unknown as RowsByTable);
  if (verified.length > 0) return { seedSeq, wiped, verified, replay: null, replayVerified: false };
  // 5. Open the queue from S+1.
  await o.queue.clearDivergent();
  await updateState(o.queue, (s) => {
    s.halted = null;
    s.appliedSeq = seedSeq;
    s.seedSeq = seedSeq;
    s.seedAtMs = o.exportAtMs;
    s.gapSinceMs = null;
    s.gapSeq = null;
    s.inflight = null;
    s.lastApplied = null;
    s.lastAppliedAtMs = null;
    s.lease = null;
    s.pause = null;
  });
  if (o.applyDeps === undefined) return { seedSeq, wiped, verified, replay: null, replayVerified: true };
  let replay = await runApplier(o.applyDeps);
  for (let i = 0; i < 1000 && replay.applied + replay.skipped > 0 && replay.halted === null; i++) replay = await runApplier(o.applyDeps);
  return { seedSeq, wiped, verified, replay, replayVerified: replay.halted === null };
}

export interface ProofOptions {
  ctx: CodecContext;
  queue: MirrorQueue;
  /** The D1 export taken at the proof point. */
  rows: RowsByTable;
  /** The export snapshot time (ms). The applier pauses at (maxSeq(rows), atMs). */
  atMs: number;
  /** After the pause is reached, wait until `atMs + quietMs` has passed on the clock so late batches (sender retries) have arrived. */
  quietMs?: number;
  applyDeps: ApplyDeps;
  timeoutMs?: number;
  nowMs?(): number;
  log?(m: string): void;
}

export interface ProofResult {
  ok: boolean;
  seq: number;
  atMs: number;
  appliedSeq: number;
  diffs: TableDiff[];
  reason: string | null;
}

/** Pause the applier at the export's (seq, time), compare both sides row for row over every non-ephemeral table, resume. */
export async function dailyProof(o: ProofOptions): Promise<ProofResult> {
  const now = o.nowMs ?? (() => Date.now());
  const rows = mirroredRows(o.rows);
  const seq = maxSeqOf(rows);
  const quietMs = o.quietMs ?? 30_000;
  const deadline = now() + (o.timeoutMs ?? 10 * 60_000);
  await updateState(o.queue, (s) => {
    s.pause = { seq, atMs: o.atMs };
  });
  try {
    for (;;) {
      const r = await runApplier(o.applyDeps);
      if (r.halted !== null) return { ok: false, seq, atMs: o.atMs, appliedSeq: r.appliedSeq, diffs: [], reason: `applier halted: ${r.halted.code}: ${r.halted.reason}` };
      if (r.paused && now() >= o.atMs + quietMs) break;
      if (now() > deadline) return { ok: false, seq, atMs: o.atMs, appliedSeq: r.appliedSeq, diffs: [], reason: `pause point not reached (applied ${r.appliedSeq}, want ${seq})` };
      if (r.applied + r.skipped === 0) await new Promise((res) => setTimeout(res, 500));
    }
    const state = await o.queue.readState();
    const diffs = compareTables(rows, (await exportRows(o.ctx)) as unknown as RowsByTable);
    return { ok: diffs.length === 0, seq, atMs: o.atMs, appliedSeq: state.appliedSeq, diffs, reason: diffs.length === 0 ? null : "rows differ" };
  } finally {
    await updateState(o.queue, (s) => {
      s.pause = null;
    });
  }
}
