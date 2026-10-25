// runEventTx and runTx (design/aws-port.md §2.4, contracts in ./contracts.ts).
// Every event-appending write goes through runEventTx; nothing else writes
// META/HEAD, so the gap-free `seq` invariant lives in this file.
import { GetCommand, TransactWriteCommand } from "@aws-sdk/lib-dynamodb";
import { internal } from "../../core/errors";
import {
  TxConditionFailed,
  type DdbContext,
  type EventInput,
  type EventTxBuilder,
  type RunEventTx,
  type RunTx,
  type TxItem,
} from "./contracts";
import { eventActorKey, eventKey, eventKindKey, eventLayoutKey, HEAD_KEY } from "./keys";

const MAX_ATTEMPTS = 8;
const BACKOFF_MS = [15, 40, 90, 180, 350, 700];
const MAX_TX_ITEMS = 100;

/** Time and randomness, replaceable by tests so retries run instantly. */
export const txTuning = {
  sleep: (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms)),
  random: (): number => Math.random(),
};

function backoffMs(attempt: number): number {
  const base = BACKOFF_MS[Math.min(attempt, BACKOFF_MS.length - 1)]!;
  return base * (0.5 + txTuning.random());
}

const RETRYABLE_CODES = new Set(["TransactionConflict", "ThrottlingError", "ProvisionedThroughputExceeded", "RequestLimitExceeded"]);
const RETRYABLE_ERRORS = new Set([
  "TransactionConflictException",
  "TransactionInProgressException",
  "ThrottlingException",
  "ProvisionedThroughputExceededException",
  "RequestLimitExceeded",
  "InternalServerError",
  "ServiceUnavailable",
]);

interface CancelReason {
  Code?: string;
}

type Outcome = { kind: "ok" } | { kind: "retry" } | { kind: "condition"; indexes: number[] };

/** Decides what a failed TransactWriteItems means; rethrows what is neither. */
function classify(e: unknown): Outcome {
  const err = e as { name?: string; CancellationReasons?: CancelReason[] };
  if (err?.name === "TransactionCanceledException") {
    const reasons = err.CancellationReasons;
    if (!reasons) throw e;
    const failed: number[] = [];
    let transient = false;
    reasons.forEach((r, i) => {
      if (r.Code === "ConditionalCheckFailed") failed.push(i);
      else if (r.Code && RETRYABLE_CODES.has(r.Code)) transient = true;
      else if (r.Code && r.Code !== "None") throw e;
    });
    if (failed.length > 0) return { kind: "condition", indexes: failed };
    if (transient) return { kind: "retry" };
    throw e;
  }
  if (err?.name && RETRYABLE_ERRORS.has(err.name)) return { kind: "retry" };
  throw e;
}

function exhausted(what: string): never {
  console.error(`EVENTTX_EXHAUSTED ${what}: gave up after ${MAX_ATTEMPTS} attempts`);
  throw internal();
}

// ---------------------------------------------------------------------------

/** Tags of the items runEventTx itself adds; a failure on only these means "another append won". */
const HEAD_TAG = "head";
const EVENT_TAG_PREFIX = "event:";

interface Planned {
  tag: string;
  item: TxItem;
}

function eventItems(ctx: DdbContext, seq: number, e: EventInput): Planned[] {
  const table = ctx.tables.main;
  const row = { ...e, seq };
  const out: Planned[] = [
    {
      tag: `${EVENT_TAG_PREFIX}${seq}`,
      item: { Put: { TableName: table, Item: { ...eventKey(seq), ...row }, ConditionExpression: "attribute_not_exists(pk)" } },
    },
  ];
  const mirrors = [
    ...(e.layout_id === null ? [] : [eventLayoutKey(e.layout_id, seq)]),
    eventKindKey(e.kind, seq),
    eventActorKey(e.actor, seq),
  ];
  for (const k of mirrors) {
    out.push({ tag: `${EVENT_TAG_PREFIX}${seq}:mirror`, item: { Put: { TableName: table, Item: { ...k, ...row } } } });
  }
  return out;
}

function maxAt(a: string | null, b: string): string {
  return a !== null && a > b ? a : b;
}

export const runEventTx: RunEventTx = async (ctx, build) => {
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    if (attempt > 0) await txTuning.sleep(backoffMs(attempt - 1));
    const got = await ctx.doc.send(new GetCommand({ TableName: ctx.tables.main, Key: HEAD_KEY, ConsistentRead: true }));
    const s = (got.Item?.seq as number | undefined) ?? 0;
    const live = (got.Item?.live as number | undefined) ?? 0;
    const headMax = (got.Item?.max_at as string | undefined) ?? null;

    const events: EventInput[] = [];
    const extra: Planned[] = [];
    let dlive = 0;
    const builder: EventTxBuilder = {
      head: { seq: s, live, maxAt: headMax },
      event(e) {
        events.push(e);
        return s + events.length;
      },
      item(tag, i) {
        extra.push({ tag, item: i });
      },
      addLive(delta) {
        dlive += delta;
      },
    };
    await build(builder);

    const seqs = events.map((_, i) => s + i + 1);
    let newMax = headMax;
    for (const e of events) newMax = maxAt(newMax, e.at);
    const values: Record<string, unknown> = { ":s": s, ":ns": s + events.length, ":nl": live + dlive };
    let set = "SET seq = :ns, live = :nl";
    if (newMax !== null) {
      set += ", max_at = :m";
      values[":m"] = newMax;
    }
    const plan: Planned[] = [
      {
        tag: HEAD_TAG,
        item: {
          Update: {
            TableName: ctx.tables.main,
            Key: HEAD_KEY,
            UpdateExpression: set,
            ConditionExpression: "attribute_not_exists(seq) OR seq = :s",
            ExpressionAttributeValues: values,
          },
        },
      },
      ...events.flatMap((e, i) => eventItems(ctx, seqs[i]!, e)),
      ...extra,
    ];
    if (plan.length > MAX_TX_ITEMS) throw new Error(`event transaction has ${plan.length} items (limit ${MAX_TX_ITEMS})`);

    try {
      await ctx.doc.send(new TransactWriteCommand({ TransactItems: plan.map((p) => p.item) }));
      return { seqs };
    } catch (e) {
      const out = classify(e);
      if (out.kind === "retry") continue;
      if (out.kind === "condition") {
        const domain = out.indexes.map((i) => plan[i]!.tag).filter((t) => t !== HEAD_TAG && !t.startsWith(EVENT_TAG_PREFIX));
        if (domain.length > 0) throw new TxConditionFailed(domain);
        continue; // HEAD (and the event puts it implies) alone: another append won.
      }
      throw e;
    }
  }
  return exhausted("runEventTx");
};

export const runTx: RunTx = async (ctx, items) => {
  if (items.length > MAX_TX_ITEMS) throw new Error(`transaction has ${items.length} items (limit ${MAX_TX_ITEMS})`);
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    if (attempt > 0) await txTuning.sleep(backoffMs(attempt - 1));
    try {
      await ctx.doc.send(new TransactWriteCommand({ TransactItems: items.map((p) => p.item) }));
      return;
    } catch (e) {
      const out = classify(e);
      if (out.kind === "retry") continue;
      if (out.kind === "condition") throw new TxConditionFailed(out.indexes.map((i) => items[i]!.tag));
      throw e;
    }
  }
  return exhausted("runTx");
};
