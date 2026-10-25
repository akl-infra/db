// Key builders and small helpers for lane K's areas (design/aws-port.md §2.3):
// the modqueue notifications and delivery gate, the Discord interaction
// tables with their cross-table receipt claim, and the DM outbox. Lane J
// builds the outbox and dirty-mark items with `outboxInsertItems` and
// `mqnDirtyKey` below; the pinned shapes are
//   DMO#<delivery_key>/ROW, claims DMO#seq#<event_seq>/CLAIM and
//   DMO#nonce#<nonce>/CLAIM, dirty mark IX#mqn#dirty/<kind>#<submission_id>.
import { BatchGetCommand, GetCommand, QueryCommand, type UpdateCommandInput } from "@aws-sdk/lib-dynamodb";
import type { ActionTable } from "../port";
import type { DdbContext, Item, TxItem } from "./contracts";
import { txTuning } from "./tx";
import type { Key } from "./keys";

export type SubKind = "link" | "wpm" | "comment";
export type OutboxStatus = "pending" | "leased" | "sent" | "blocked" | "uncertain" | "failed" | "expired";

// --- modqueue --------------------------------------------------------------

/** `modqueue_notifications` (PK kind, submission_id). */
export function mqnKey(kind: SubKind, submissionId: string): Key {
  return { pk: `MQN#${kind}#${submissionId}`, sk: "ROW" };
}

export const MQN_DIRTY_PK = "IX#mqn#dirty";

/**
 * The dirty set: a notification whose card may disagree with its source.
 * Lane J puts one in every transaction that changes a submission; the
 * reconciler reads only this partition. Replaces the join that
 * `modqueue_notifications_status` served in D1.
 */
export function mqnDirtyKey(kind: SubKind, submissionId: string): Key {
  return { pk: MQN_DIRTY_PK, sk: `${kind}#${submissionId}` };
}

/** `modqueue_delivery_gate` (the one row, id = 1). */
export const MQGATE_KEY: Key = { pk: "META", sk: "MQGATE" };

// --- Discord interactions --------------------------------------------------

/** `discord_pending_actions` / `discord_reopen_actions`: one small partition per table, read whole. */
export function actionKey(table: ActionTable, interactionId: string): Key {
  return { pk: `DPA#${table}`, sk: interactionId };
}
export function actionPartition(table: ActionTable): string {
  return `DPA#${table}`;
}

/** `discord_deny_modals`. */
export function denyModalKey(modalId: string): Key {
  return { pk: "DMOD", sk: modalId };
}
export const DMOD_PK = "DMOD";

/** `discord_reopen_confirmations`. */
export function reopenConfKey(confirmationId: string): Key {
  return { pk: "DCONF", sk: confirmationId };
}
export const DCONF_PK = "DCONF";

/**
 * The receipt claim across the four interaction tables (replaces the
 * `UNION ALL` of `hasReceipt` and the per-table UNIQUE constraints): one
 * claim per interaction id, held by the row that was created for it.
 */
export function interactionClaimKey(interactionId: string): Key {
  return { pk: `DINT#${interactionId}`, sk: "CLAIM" };
}

// --- DM outbox ---------------------------------------------------------------

export function outboxKey(deliveryKey: string): Key {
  return { pk: `DMO#${deliveryKey}`, sk: "ROW" };
}
/** `event_seq INTEGER NOT NULL UNIQUE`. */
export function outboxSeqClaimKey(eventSeq: number): Key {
  return { pk: `DMO#seq#${eventSeq}`, sk: "CLAIM" };
}
/** `nonce TEXT NOT NULL UNIQUE`. */
export function outboxNonceClaimKey(nonce: string): Key {
  return { pk: `DMO#nonce#${nonce}`, sk: "CLAIM" };
}
export const DMO_DUE_PK = "IX#dmo#due";
/** Replaces `discord_rejection_dm_due` and `_lease`: only pending and leased rows have one. */
export function outboxDueKey(status: "pending" | "leased", nextAttemptAt: string, deliveryKey: string): Key {
  return { pk: DMO_DUE_PK, sk: `${status}#${nextAttemptAt}#${deliveryKey}` };
}

export interface OutboxInsert {
  delivery_key: string;
  event_seq: number;
  kind: SubKind;
  submission_id: string;
  layout_id: string;
  recipient_id: string;
  nonce: string;
  next_attempt_at: string;
  created_at: string;
  updated_at: string;
  review_version: number;
  decision: "rejection" | "approval";
}

/** The pending outbox row exactly as `gatedOutboxStatement` inserts it (status 'pending', attempts 0, everything else NULL). */
export function newOutboxRow(o: OutboxInsert): Item {
  return {
    delivery_key: o.delivery_key, event_seq: o.event_seq, kind: o.kind, submission_id: o.submission_id, layout_id: o.layout_id,
    recipient_id: o.recipient_id, nonce: o.nonce, status: "pending", attempts: 0, next_attempt_at: o.next_attempt_at,
    lease_token: null, lease_until: null, ambiguous_message_attempt_at: null, dm_channel_id: null, discord_message_id: null,
    last_error_class: null, created_at: o.created_at, updated_at: o.updated_at, sent_at: null,
    review_version: o.review_version, decision: o.decision,
  };
}

/**
 * Every item a new outbox row needs, for lane J's decision transaction: the
 * row, both claims (a taken `event_seq`/`nonce`/key fails the transaction,
 * as the UNIQUE constraints do) and the due-index item. Tags: dmo:row,
 * dmo:seq, dmo:nonce, dmo:due.
 */
export function outboxInsertItems(table: string, o: OutboxInsert): { tag: string; item: TxItem }[] {
  const row = newOutboxRow(o);
  const put = (k: Key, extra: Item, cond: boolean): TxItem => ({
    Put: { TableName: table, Item: { ...k, ...extra }, ...(cond ? { ConditionExpression: "attribute_not_exists(pk)" } : {}) },
  });
  return [
    { tag: "dmo:row", item: put(outboxKey(o.delivery_key), row, true) },
    { tag: "dmo:seq", item: put(outboxSeqClaimKey(o.event_seq), { delivery_key: o.delivery_key }, true) },
    { tag: "dmo:nonce", item: put(outboxNonceClaimKey(o.nonce), { delivery_key: o.delivery_key }, true) },
    { tag: "dmo:due", item: put(outboxDueKey("pending", o.next_attempt_at, o.delivery_key), {}, false) },
  ];
}

// --- keys of other lanes that lane K reads (design §2.3; lane J / G / I own them) ---------------

/** `link_submissions` / `wpm_submissions` / `layout_comments`: the row, every D1 column flat on the item. */
export function submissionKey(kind: SubKind, id: string): Key {
  return { pk: `SUB#${kind}#${id}`, sk: "ROW" };
}
/** Status queue partitions, `<submitted_at>#<id>` ascending: replace `link_submissions_status` and its wpm twin. */
export function submissionStatusPartition(kind: "link" | "wpm", status: string): string {
  return `IX#${kind}#st#${status}`;
}
/** Every comment of one (layout, user) pair, `<submitted_at>#<id>` ascending. */
export function commentPairPartition(layoutId: string, userId: string): string {
  return `IX#cmt#pair#${layoutId}#${userId}`;
}
export function catalogItemKey(layoutId: string): Key {
  return { pk: "CAT", sk: layoutId };
}
export function authorItemKey(userId: string): Key {
  return { pk: "AUTHORS", sk: userId };
}

/** The id at the end of an index sort key `<...>#<id>`. Ids are ULIDs/snowflakes and never contain '#'. */
export function idOfIndexSk(sk: string): string {
  return sk.slice(sk.lastIndexOf("#") + 1);
}

// --- helpers --------------------------------------------------------------

const TRANSIENT = new Set([
  "TransactionConflictException",
  "TransactionInProgressException",
  "ThrottlingException",
  "ProvisionedThroughputExceededException",
  "RequestLimitExceeded",
  "InternalServerError",
  "ServiceUnavailable",
]);

const MAX_ATTEMPTS = 8;

/** Retry a single-item write on conflicts and throttles (runTx does this for transactions). Never retries a failed condition. */
export async function retrying<T>(fn: () => Promise<T>): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await fn();
    } catch (e) {
      const name = (e as { name?: string } | null)?.name ?? "";
      if (!TRANSIENT.has(name) || attempt >= MAX_ATTEMPTS - 1) throw e;
      await txTuning.sleep(15 * 2 ** attempt * (0.5 + txTuning.random()));
    }
  }
}

export function isConditionFailed(e: unknown): boolean {
  return (e as { name?: string } | null)?.name === "ConditionalCheckFailedException";
}

/** A D1-shaped row from an item: the key attributes dropped. */
export function rowOf<T = Item>(item: Item): T {
  const { pk: _pk, sk: _sk, ...row } = item;
  return row as T;
}

/** `attr` is NULL in D1 terms: missing or stored as a NULL. Registers `:nullT`. */
export function isNull(attr: string, values: Record<string, unknown>): string {
  values[":nullT"] = "NULL";
  return `(attribute_not_exists(#${attr}) OR attribute_type(#${attr}, :nullT))`;
}

/** `#name` placeholders found in the expressions, mapped to their attribute names. */
export function namesIn(...exprs: (string | undefined)[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const e of exprs) for (const m of e?.matchAll(/#([A-Za-z_][A-Za-z0-9_]*)/g) ?? []) out[`#${m[1]}`] = m[1]!;
  return out;
}

/** `UpdateCommandInput` pieces from an update expression and a condition that use `#attr` and `:val` placeholders. */
export function exprInput(update: string | undefined, cond: string | undefined, values: Record<string, unknown>): Pick<UpdateCommandInput, "UpdateExpression" | "ConditionExpression" | "ExpressionAttributeNames" | "ExpressionAttributeValues"> {
  const names = namesIn(update, cond);
  return {
    ...(update === undefined ? {} : { UpdateExpression: update }),
    ...(cond === undefined ? {} : { ConditionExpression: cond }),
    ...(Object.keys(names).length === 0 ? {} : { ExpressionAttributeNames: names }),
    ...(Object.keys(values).length === 0 ? {} : { ExpressionAttributeValues: values }),
  };
}

/** `SET #a = :s_a, ...` for every field; values go into `values`. */
export function setClause(fields: Record<string, unknown>, values: Record<string, unknown>): string {
  return "SET " + Object.entries(fields).map(([k, v]) => { values[`:s_${k}`] = v; return `#${k} = :s_${k}`; }).join(", ");
}

/** A consistent read of one item (null if absent). */
export async function getItem(ctx: DdbContext, table: string, key: Key, consistent = true): Promise<Item | null> {
  const got = await ctx.doc.send(new GetCommand({ TableName: table, Key: key, ConsistentRead: consistent }));
  return (got.Item as Item | undefined) ?? null;
}

/** A consistent Query of a whole partition (optionally a sort-key range), following pages. */
export async function queryPartition(
  ctx: DdbContext,
  pk: string,
  opts: { sk?: { between: [string, string] } | { beginsWith: string }; forward?: boolean; pageLimit?: number; stopAfter?: number } = {},
): Promise<Item[]> {
  const out: Item[] = [];
  let start: Record<string, unknown> | undefined;
  for (;;) {
    const values: Record<string, unknown> = { ":pk": pk };
    let cond = "pk = :pk";
    if (opts.sk !== undefined) {
      if ("between" in opts.sk) {
        cond += " AND sk BETWEEN :lo AND :hi";
        values[":lo"] = opts.sk.between[0];
        values[":hi"] = opts.sk.between[1];
      } else {
        cond += " AND begins_with(sk, :p)";
        values[":p"] = opts.sk.beginsWith;
      }
    }
    const res = await ctx.doc.send(
      new QueryCommand({
        TableName: ctx.tables.main,
        KeyConditionExpression: cond,
        ExpressionAttributeValues: values,
        ConsistentRead: true,
        ScanIndexForward: opts.forward ?? true,
        ...(start === undefined ? {} : { ExclusiveStartKey: start }),
        ...(opts.pageLimit === undefined ? {} : { Limit: opts.pageLimit }),
      }),
    );
    out.push(...((res.Items ?? []) as Item[]));
    start = res.LastEvaluatedKey;
    if (start === undefined || (opts.stopAfter !== undefined && out.length >= opts.stopAfter)) return out;
  }
}

/** Consistent `BatchGetItem` of keys in `table`; the result is keyed `pk|sk`. Chunks of 100, unprocessed keys retried. */
export async function batchGet(ctx: DdbContext, table: string, keys: readonly Key[]): Promise<Map<string, Item>> {
  const out = new Map<string, Item>();
  const unique = [...new Map(keys.map((k) => [`${k.pk}|${k.sk}`, k])).values()];
  for (let i = 0; i < unique.length; i += 100) {
    let pending: Key[] | undefined = unique.slice(i, i + 100);
    for (let attempt = 0; pending !== undefined && pending.length > 0; attempt++) {
      const res: Awaited<ReturnType<DdbContext["doc"]["send"]>> & { Responses?: Record<string, Item[]>; UnprocessedKeys?: Record<string, { Keys?: Key[] }> } =
        await retrying(() => ctx.doc.send(new BatchGetCommand({ RequestItems: { [table]: { Keys: pending!, ConsistentRead: true } } })) as never);
      for (const it of res.Responses?.[table] ?? []) out.set(`${it.pk as string}|${it.sk as string}`, it);
      pending = res.UnprocessedKeys?.[table]?.Keys;
      if (pending !== undefined && pending.length > 0) await txTuning.sleep(10 * 2 ** Math.min(attempt, 6));
    }
  }
  return out;
}

export function mapKey(k: Key): string {
  return `${k.pk}|${k.sk}`;
}
