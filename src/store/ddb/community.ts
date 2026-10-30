// Shared machinery of lane J's four stores (links, WPM, comments, review
// history): the submission row <-> item mapping, the index items every row
// implies (R2), the transaction plan builder, guards (R5), history and outbox
// items, and the small reads they share. One file so the item model is defined
// once: `schema/community.ts` (the codec) and the stores both call it.
import { BatchGetCommand, GetCommand, QueryCommand } from "@aws-sdk/lib-dynamodb";
import { canonical } from "../../core/canonical";
import { internal } from "../../core/errors";
import type { EventInput, DdbContext, Item, TxItem } from "./contracts";
import { TxConditionFailed } from "./contracts";
import { catKey, fold, type Key } from "./keys";
import { mqnDirtyKey, mqnKey } from "./keys-discord";
import {
  commentCountKey,
  commentOkKey,
  commentPairKey,
  commentStatusKey,
  commentUserKey,
  historyClaimKey,
  historyKey,
  linkLayoutKey,
  linkStatusKey,
  outboxDueKey,
  outboxNonceClaimKey,
  outboxRowKey,
  outboxSeqClaimKey,
  subKey,
  wpmOkKey,
  wpmPairKey,
  wpmStatusKey,
  type SubmissionKind,
} from "./keys-community";
import { txTuning } from "./tx";
import type { GatedEvent, HistoryIntent, OutboxIntent } from "../port";

export type Row = Record<string, unknown>;
export type { SubmissionKind };

// ---------------------------------------------------------------------------
// Columns and rows
// ---------------------------------------------------------------------------

/** Every D1 column of the three submission tables, in migration order. */
export const COLUMNS: Record<SubmissionKind, readonly string[]> = {
  link: ["id", "layout_id", "url", "submitted_by", "submitted_at", "status", "decided_by", "decided_at", "reason", "notified_at"],
  wpm: [
    "id", "layout_id", "user_id", "wpm", "proof", "submitted_by", "via", "submitted_at", "status", "decided_by", "decided_at", "reason",
    "notified_at", "review_version", "source_message_url",
  ],
  comment: ["id", "layout_id", "user_id", "body", "via", "submitted_at", "status", "decided_by", "decided_at", "reason", "review_version"],
};

/** The columns the wire may see ([LDB-MD11], [LDB-WPM9], [LDB-CMT9]: never `notified_at`, never the private receipt URL). */
export const PUBLIC_COLUMNS: Record<SubmissionKind, readonly string[]> = {
  link: ["id", "layout_id", "url", "submitted_by", "submitted_at", "status", "decided_by", "decided_at", "reason"],
  wpm: ["id", "layout_id", "user_id", "wpm", "proof", "submitted_by", "via", "submitted_at", "status", "decided_by", "decided_at", "reason", "review_version"],
  comment: COLUMNS.comment,
};

export const TABLE_OF: Record<SubmissionKind, "link_submissions" | "wpm_submissions" | "layout_comments"> = {
  link: "link_submissions",
  wpm: "wpm_submissions",
  comment: "layout_comments",
};

export function hasReviewVersion(kind: SubmissionKind): boolean {
  return kind !== "link";
}

export function pick(row: Row, cols: readonly string[]): Row {
  const out: Row = {};
  for (const c of cols) out[c] = row[c] === undefined ? null : row[c];
  return out;
}

/** A complete row of `kind` with D1's column defaults filled in. */
export function normalizeRow(kind: SubmissionKind, row: Row): Row {
  const out = pick(row, COLUMNS[kind]);
  if (out.status === null) out.status = "pending";
  if (hasReviewVersion(kind) && out.review_version === null) out.review_version = 0;
  return out;
}

export function rowItem(kind: SubmissionKind, row: Row): Item {
  const r = normalizeRow(kind, row);
  return { ...subKey(kind, r.id as string), ...r };
}

export function itemRow(kind: SubmissionKind, item: Item): Row {
  return pick(item, COLUMNS[kind]);
}

export function publicRow(kind: SubmissionKind, item: Item): Row {
  return pick(item, PUBLIC_COLUMNS[kind]);
}

/** Whether a comment row holds the slot's live text (the `IX#cmt#ok` / `CC` membership). */
export function isLiveComment(row: Row): boolean {
  return row.status === "approved" && row.body !== null && row.body !== undefined;
}

// ---------------------------------------------------------------------------
// Index items (R2): everything a row implies besides itself, as full items
// ---------------------------------------------------------------------------

export function indexItems(kind: SubmissionKind, row: Row): Item[] {
  const r = normalizeRow(kind, row);
  const id = r.id as string;
  const layout = r.layout_id as string;
  const status = r.status as string;
  if (kind === "link") {
    return [
      { ...linkStatusKey(status, r.submitted_at as string, id), id },
      { ...linkLayoutKey(layout, status, r.submitted_at as string, id), id },
    ];
  }
  if (kind === "wpm") {
    const user = r.user_id as string;
    const out: Item[] = [
      { ...wpmStatusKey(status, r.submitted_at as string, id), id },
      { ...wpmPairKey(layout, user, status, id), id, submitted_at: r.submitted_at },
    ];
    if (status === "approved") {
      out.push({ ...wpmOkKey(layout, user, id), id, layout_id: layout, user_id: user, wpm: r.wpm, proof: r.proof, decided_at: r.decided_at });
    }
    return out;
  }
  const user = r.user_id as string;
  const out: Item[] = [
    { ...commentStatusKey(status, r.submitted_at as string, id), id },
    { ...commentPairKey(layout, user, r.submitted_at as string, id), id, status, decided_at: r.decided_at, has_body: r.body === null ? 0 : 1 },
    { ...commentUserKey(user, layout, r.submitted_at as string, id), id },
  ];
  if (isLiveComment(r)) {
    out.push({ ...commentOkKey(layout, r.decided_at as string, id), id, user_id: user, body: r.body, decided_at: r.decided_at });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

export const consistent = { ConsistentRead: true } as const;

export async function getItem(ctx: DdbContext, key: Key, opts: { consistent?: boolean } = {}): Promise<Item | null> {
  const out = await ctx.doc.send(new GetCommand({ TableName: ctx.tables.main, Key: key, ConsistentRead: opts.consistent ?? true }));
  return (out.Item as Item | undefined) ?? null;
}

export async function getRow(ctx: DdbContext, kind: SubmissionKind, id: string): Promise<Row | null> {
  const it = await getItem(ctx, subKey(kind, id));
  return it === null ? null : itemRow(kind, it);
}

/** Every item of one partition (optionally an sk prefix), consistent, in sk order. */
export async function queryPartition(
  ctx: DdbContext,
  pk: string,
  opts: { prefix?: string; forward?: boolean; limit?: number } = {},
): Promise<Item[]> {
  const out: Item[] = [];
  let start: Record<string, unknown> | undefined;
  do {
    const res = await ctx.doc.send(
      new QueryCommand({
        TableName: ctx.tables.main,
        KeyConditionExpression: opts.prefix === undefined ? "pk = :p" : "pk = :p AND begins_with(sk, :s)",
        ExpressionAttributeValues: opts.prefix === undefined ? { ":p": pk } : { ":p": pk, ":s": opts.prefix },
        ScanIndexForward: opts.forward ?? true,
        ConsistentRead: true,
        ...(opts.limit === undefined ? {} : { Limit: opts.limit - out.length }),
        ...(start === undefined ? {} : { ExclusiveStartKey: start }),
      }),
    );
    out.push(...((res.Items ?? []) as Item[]));
    start = res.LastEvaluatedKey as Record<string, unknown> | undefined;
    if (opts.limit !== undefined && out.length >= opts.limit) break;
  } while (start !== undefined);
  return opts.limit === undefined ? out : out.slice(0, opts.limit);
}

interface Projection {
  expr: string;
  names?: Record<string, string>;
}

/** BatchGet of distinct keys (chunks of 100, UnprocessedKeys retried). Strong unless `eventual`. */
export async function batchGet(ctx: DdbContext, keys: readonly Key[], opts: { projection?: Projection; eventual?: boolean } = {}): Promise<Item[]> {
  const seen = new Set<string>();
  const distinct = keys.filter((k) => {
    const s = `${k.pk}\u0000${k.sk}`;
    if (seen.has(s)) return false;
    seen.add(s);
    return true;
  });
  const out: Item[] = [];
  for (let i = 0; i < distinct.length; i += 100) {
    let pending: Record<string, unknown>[] = distinct.slice(i, i + 100).map((k) => ({ pk: k.pk, sk: k.sk }));
    for (let attempt = 0; pending.length > 0; attempt++) {
      if (attempt >= 8) throw internal();
      if (attempt > 0) await txTuning.sleep(10 * 2 ** attempt);
      const res = await ctx.doc.send(
        new BatchGetCommand({
          RequestItems: {
            [ctx.tables.main]: {
              Keys: pending,
              ...(opts.eventual === true ? {} : consistent),
              ...(opts.projection === undefined
                ? {}
                : { ProjectionExpression: opts.projection.expr, ...(opts.projection.names === undefined ? {} : { ExpressionAttributeNames: opts.projection.names }) }),
            },
          },
        }),
      );
      out.push(...((res.Responses?.[ctx.tables.main] ?? []) as Item[]));
      pending = (res.UnprocessedKeys?.[ctx.tables.main]?.Keys ?? []) as Record<string, unknown>[];
    }
  }
  return out;
}

export async function getRows(ctx: DdbContext, kind: SubmissionKind, ids: readonly string[]): Promise<Row[]> {
  const items = await batchGet(ctx, ids.map((id) => subKey(kind, id)));
  return items.map((i) => itemRow(kind, i));
}

export interface CatInfo {
  id: string;
  name: string;
  owner: string;
  deleted: number;
}

const CAT_PROJECTION: Projection = { expr: "#pk, #sk, #n, #o, #d", names: { "#pk": "pk", "#sk": "sk", "#n": "name", "#o": "owner", "#d": "deleted" } };

function catInfo(it: Item): CatInfo {
  return { id: it.sk as string, name: it.name as string, owner: it.owner as string, deleted: Number(it.deleted ?? 0) };
}

/** The layouts the joins need, from the base table (strong). */
export async function readCats(ctx: DdbContext, ids: readonly string[]): Promise<Map<string, CatInfo>> {
  const items = await batchGet(ctx, ids.map((id) => catKey(id)), { projection: CAT_PROJECTION });
  return new Map(items.map((i) => [i.sk as string, catInfo(i)]));
}

export async function readCat(ctx: DdbContext, id: string): Promise<CatInfo | null> {
  return (await readCats(ctx, [id])).get(id) ?? null;
}

/** AuthStore.authorName for display joins: eventual reads of `AUTHORS/<user>` (design §2.8). */
export async function authorNames(ctx: DdbContext, ids: readonly string[]): Promise<Map<string, string>> {
  const items = await batchGet(
    ctx,
    ids.map((id) => ({ pk: "AUTHORS", sk: id })),
    { projection: { expr: "#pk, #sk, #n", names: { "#pk": "pk", "#sk": "sk", "#n": "name" } }, eventual: true },
  );
  return new Map(items.filter((i) => typeof i.name === "string").map((i) => [i.sk as string, i.name as string]));
}

/** SQLite NOCASE order: ASCII-folded, compared as UTF-8 bytes. */
export function compareNocase(a: string, b: string): number {
  const enc = new TextEncoder();
  const x = enc.encode(fold(a));
  const y = enc.encode(fold(b));
  const n = Math.min(x.length, y.length);
  for (let i = 0; i < n; i++) if (x[i] !== y[i]) return x[i]! < y[i]! ? -1 : 1;
  return x.length === y.length ? 0 : x.length < y.length ? -1 : 1;
}

/** BINARY order of two strings as SQLite compares them (UTF-8 bytes). */
export function compareBinary(a: string, b: string): number {
  const enc = new TextEncoder();
  const x = enc.encode(a);
  const y = enc.encode(b);
  const n = Math.min(x.length, y.length);
  for (let i = 0; i < n; i++) if (x[i] !== y[i]) return x[i]! < y[i]! ? -1 : 1;
  return x.length === y.length ? 0 : x.length < y.length ? -1 : 1;
}

// ---------------------------------------------------------------------------
// The transaction plan
// ---------------------------------------------------------------------------

export interface TxOp {
  tag: string;
  item: TxItem;
}

function txItemKey(item: TxItem): string {
  const part = (item.Put?.Item ?? item.Update?.Key ?? item.Delete?.Key ?? item.ConditionCheck?.Key) as Record<string, unknown>;
  const table = (item.Put ?? item.Update ?? item.Delete ?? item.ConditionCheck)!.TableName;
  return `${table}\u0000${part.pk}\u0000${part.sk}`;
}

/** Collects one transaction's items. DynamoDB refuses two operations on one item, so a duplicate is a bug here, not there. */
export class Plan {
  readonly ops: TxOp[] = [];
  private readonly seen = new Set<string>();
  private readonly cc = new Map<string, number>();
  /** Set by `addHistory`: the review-history counter moves from `read` to `now` in this transaction. */
  historyCounter: { read: number; now: number } | null = null;

  constructor(readonly ctx: DdbContext) {}

  get table(): string {
    return this.ctx.tables.main;
  }

  add(tag: string, item: TxItem): void {
    const k = txItemKey(item);
    if (this.seen.has(k)) throw new Error(`transaction plan touches ${k.replace(/\u0000/g, "/")} twice (${tag})`);
    this.seen.add(k);
    this.ops.push({ tag, item });
  }

  /** Counter delta (R4) for `CC/<layout>`; folded into one Update per layout at `finish`. A zero delta still creates the item. */
  commentCount(layoutId: string, delta: number): void {
    this.cc.set(layoutId, (this.cc.get(layoutId) ?? 0) + delta);
  }

  private readonly dirty = new Set<string>();

  /** The mod-queue card of this submission may now disagree with it (the mark exists only beside a notification). */
  markDirty(kind: SubmissionKind, id: string): void {
    this.dirty.add(`${kind}\u0000${id}`);
  }

  async finish(): Promise<TxOp[]> {
    // The dirty set is a hint over notifications: put the mark where a card exists, and make sure none appears meanwhile where it does not.
    const marks = [...this.dirty].map((k) => k.split("\u0000") as [SubmissionKind, string]);
    this.dirty.clear();
    if (marks.length > 0) {
      const have = new Set((await batchGet(this.ctx, marks.map(([k, i]) => mqnKey(k, i)), { projection: { expr: "#pk, #sk", names: { "#pk": "pk", "#sk": "sk" } } })).map((i) => i.pk as string));
      for (const [k, i] of marks) {
        if (have.has(mqnKey(k, i).pk)) this.add("mqn", { Put: { TableName: this.table, Item: { ...mqnDirtyKey(k, i) } } });
        else this.add("mqnabsent", { ConditionCheck: { TableName: this.table, Key: mqnKey(k, i), ConditionExpression: "attribute_not_exists(pk)" } });
      }
    }
    for (const [layout, delta] of this.cc) {
      this.add(`cc:${layout}`, {
        Update: {
          TableName: this.table,
          Key: commentCountKey(layout),
          UpdateExpression: "ADD #c :d",
          ExpressionAttributeNames: { "#c": "count" },
          ExpressionAttributeValues: { ":d": delta },
        },
      });
    }
    this.cc.clear();
    if (this.historyCounter !== null) {
      const { read, now } = this.historyCounter;
      this.historyCounter = null;
      this.add("histcounter", {
        Update: {
          TableName: this.table,
          Key: REVIEW_HISTORY_COUNTER,
          UpdateExpression: "SET #l = :now",
          ConditionExpression: read === 0 ? "attribute_not_exists(#l)" : "#l = :read",
          ExpressionAttributeNames: { "#l": "last" },
          ExpressionAttributeValues: { ":now": now, ...(read === 0 ? {} : { ":read": read }) },
        },
      });
    }
    return this.ops;
  }

  /** Delete `key`; Put `item` when given. Skips nothing: callers diff first. */
  put(tag: string, item: Item, condition?: string): void {
    this.add(tag, { Put: { TableName: this.table, Item: item, ...(condition === undefined ? {} : { ConditionExpression: condition }) } });
  }

  delete(tag: string, key: Key, cond?: { expr: string; names?: Record<string, string>; values?: Record<string, unknown> }): void {
    this.add(tag, {
      Delete: {
        TableName: this.table,
        Key: key,
        ...(cond === undefined
          ? {}
          : {
              ConditionExpression: cond.expr,
              ...(cond.names === undefined ? {} : { ExpressionAttributeNames: cond.names }),
              ...(cond.values === undefined ? {} : { ExpressionAttributeValues: cond.values }),
            }),
      },
    });
  }
}

export interface Cond {
  expr: string;
  names?: Record<string, string>;
  values?: Record<string, unknown>;
}

function sameValue(a: unknown, b: unknown): boolean {
  return (a ?? null) === (b ?? null);
}

function sameItem(a: Item, b: Item): boolean {
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  for (const k of keys) if (!sameValue(a[k], b[k])) return false;
  return true;
}

/**
 * Move one submission row from `before` (null = a new row) to `after`: the row
 * write (a conditional Update of the changed columns, or a Put for a new row),
 * the index items that changed (R2), the comment counter (R4) and the
 * mod-queue dirty mark. `tag` names the row write in `TxConditionFailed`.
 * The row condition is the status (and review_version) the caller read, plus
 * `extra`; that is the claim CAS of design R6.
 */
export function transition(plan: Plan, kind: SubmissionKind, before: Row | null, after: Row, tag: string, extra?: Cond): void {
  const next = normalizeRow(kind, after);
  const id = next.id as string;
  if (before === null) {
    plan.put(tag, rowItem(kind, next), "attribute_not_exists(pk)");
  } else {
    const prev = normalizeRow(kind, before);
    const names: Record<string, string> = { "#cs": "status" };
    const values: Record<string, unknown> = { ":cs": prev.status };
    let cond = "#cs = :cs";
    if (hasReviewVersion(kind)) {
      names["#crv"] = "review_version";
      values[":crv"] = prev.review_version;
      cond += " AND #crv = :crv";
    }
    if (extra !== undefined) {
      cond += ` AND ${extra.expr}`;
      Object.assign(names, extra.names);
      Object.assign(values, extra.values);
    }
    const sets: string[] = [];
    let n = 0;
    for (const c of COLUMNS[kind]) {
      if (sameValue(prev[c], next[c])) continue;
      names[`#c${n}`] = c;
      values[`:v${n}`] = next[c] ?? null;
      sets.push(`#c${n} = :v${n}`);
      n++;
    }
    if (sets.length > 0 || extra !== undefined) {
      plan.add(tag, {
        Update: {
          TableName: plan.table,
          Key: subKey(kind, id),
          ...(sets.length > 0 ? { UpdateExpression: `SET ${sets.join(", ")}` } : { UpdateExpression: "SET #cs = :cs" }),
          ConditionExpression: cond,
          ExpressionAttributeNames: names,
          ExpressionAttributeValues: values,
        },
      });
    }
  }

  // Index items: delete what vanished, put what is new or changed.
  const was = before === null ? [] : indexItems(kind, before);
  const now = indexItems(kind, next);
  const wasBy = new Map(was.map((i) => [`${i.pk}\u0000${i.sk}`, i]));
  const nowBy = new Map(now.map((i) => [`${i.pk}\u0000${i.sk}`, i]));
  for (const [k, i] of wasBy) {
    if (!nowBy.has(k)) plan.delete(`${tag}:ix`, { pk: i.pk as string, sk: i.sk as string });
  }
  for (const [k, i] of nowBy) {
    const old = wasBy.get(k);
    if (old === undefined || !sameItem(old, i)) plan.put(`${tag}:ix`, i);
  }

  if (kind === "comment") {
    const delta = (isLiveComment(next) ? 1 : 0) - (before === null ? 0 : isLiveComment(before) ? 1 : 0);
    if (before === null || delta !== 0) plan.commentCount(next.layout_id as string, delta);
  }

  if (before !== null) {
    const prev = normalizeRow(kind, before);
    if (prev.status !== next.status || prev.review_version !== next.review_version || prev.source_message_url !== next.source_message_url) {
      plan.markDirty(kind, id);
    }
  }
}

// ---------------------------------------------------------------------------
// Guards (R5)
// ---------------------------------------------------------------------------

export async function readVer(ctx: DdbContext, key: Key): Promise<number> {
  const it = await getItem(ctx, key);
  return it === null ? 0 : (it.ver as number);
}

/**
 * Condition a set-based write on the guard being as read, and move it by
 * `delta` (a delta of zero is a pure check). A guard that would fall to zero is
 * deleted, so it exists exactly when its set is non-empty.
 */
export function guard(plan: Plan, tag: string, key: Key, ver: number, delta: number): void {
  const names = { "#v": "ver" };
  const cond = ver === 0 ? "attribute_not_exists(#v)" : "#v = :rv";
  const values = ver === 0 ? undefined : { ":rv": ver };
  if (delta === 0) {
    plan.add(tag, { ConditionCheck: { TableName: plan.table, Key: key, ConditionExpression: cond, ExpressionAttributeNames: names, ...(values === undefined ? {} : { ExpressionAttributeValues: values }) } });
  } else if (ver + delta === 0) {
    plan.delete(tag, key, { expr: cond, names, ...(values === undefined ? {} : { values }) });
  } else {
    plan.add(tag, {
      Update: {
        TableName: plan.table,
        Key: key,
        UpdateExpression: "ADD #v :d",
        ConditionExpression: cond,
        ExpressionAttributeNames: names,
        ExpressionAttributeValues: { ":d": delta, ...(values ?? {}) },
      },
    });
  }
}

// ---------------------------------------------------------------------------
// Layout checks and events
// ---------------------------------------------------------------------------

/**
 * The CAT condition under a decision: the layout is as read (name and owner,
 * which the event copies; live too when the decision requires it). A layout
 * read as absent must still be absent.
 */
export function catCheck(plan: Plan, layoutId: string, cat: CatInfo | null, requireLive: boolean): void {
  if (cat === null) {
    plan.add("cat", { ConditionCheck: { TableName: plan.table, Key: catKey(layoutId), ConditionExpression: "attribute_not_exists(pk)" } });
    return;
  }
  plan.add("cat", {
    ConditionCheck: {
      TableName: plan.table,
      Key: catKey(layoutId),
      ConditionExpression: `#n = :n AND #o = :o${requireLive ? " AND #d = :d" : ""}`,
      ExpressionAttributeNames: { "#n": "name", "#o": "owner", ...(requireLive ? { "#d": "deleted" } : {}) },
      ExpressionAttributeValues: { ":n": cat.name, ":o": cat.owner, ...(requireLive ? { ":d": cat.deleted } : {}) },
    },
  });
}

/** The row `gatedEventStatement` inserts: a moderation event, admin = 1, name/owner copied from the layout. */
export function moderationEvent(at: string, m: GatedEvent, cat: CatInfo | null): EventInput {
  return {
    at,
    kind: m.kind,
    layout_id: m.layoutId,
    name: cat?.name ?? null,
    owner: cat?.owner ?? null,
    format: null,
    rev: null,
    actor: m.actor,
    via: m.via,
    admin: 1,
    detail_json: m.detail === undefined ? null : canonical(m.detail),
    before_json: null,
    after_json: m.after === undefined ? null : canonical(m.after),
    source_client: m.source.client,
    source_version: m.source.version,
  };
}

// ---------------------------------------------------------------------------
// Outbox (lane K's shapes; `gatedOutboxStatement`)
// ---------------------------------------------------------------------------

export function outboxOps(plan: Plan, o: OutboxIntent, eventSeq: number): void {
  const row: Item = {
    ...outboxRowKey(o.deliveryKey),
    delivery_key: o.deliveryKey,
    event_seq: eventSeq,
    kind: o.kind,
    submission_id: o.submissionId,
    layout_id: o.layoutId,
    recipient_id: o.recipientId,
    nonce: o.nonce,
    status: "pending",
    attempts: 0,
    next_attempt_at: o.at,
    lease_token: null,
    lease_until: null,
    ambiguous_message_attempt_at: null,
    dm_channel_id: null,
    discord_message_id: null,
    last_error_class: null,
    created_at: o.at,
    updated_at: o.at,
    sent_at: null,
    review_version: o.reviewVersion,
    decision: o.decision,
  };
  plan.put("outbox:row", row, "attribute_not_exists(pk)");
  plan.put("outbox:seq", { ...outboxSeqClaimKey(eventSeq), delivery_key: o.deliveryKey }, "attribute_not_exists(pk)");
  plan.put("outbox:nonce", { ...outboxNonceClaimKey(o.nonce), delivery_key: o.deliveryKey }, "attribute_not_exists(pk)");
  plan.put("outbox:due", { ...outboxDueKey("pending", o.at, o.deliveryKey), delivery_key: o.deliveryKey });
}

// ---------------------------------------------------------------------------
// Review history (R3)
// ---------------------------------------------------------------------------

export interface HistoryState {
  readonly kind: "comment" | "wpm";
  readonly submissionId: string;
  /** History items in ordinal order. */
  readonly rows: readonly Item[];
  /** `<review_version>#<action>` of every claim that exists. */
  readonly claims: ReadonlySet<string>;
  /** The next free ordinal. */
  next: number;
  /** The global history counter as read, and as this plan has advanced it (the last id handed out). */
  readonly counterRead: number;
  counter: number;
}

/** `META/REVIEW_HISTORY.last`: the highest id ever handed out, D1's AUTOINCREMENT as one counter item. */
export const REVIEW_HISTORY_COUNTER: Key = { pk: "META", sk: "REVIEW_HISTORY" };

export async function readHistory(ctx: DdbContext, kind: "comment" | "wpm", submissionId: string): Promise<HistoryState> {
  const pk = `SUB#${kind}#${submissionId}`;
  const rows = await queryPartition(ctx, pk, { prefix: "H#" });
  const claims = new Set<string>();
  for (const c of await queryPartition(ctx, pk, { prefix: "HK#" })) claims.add(`${c.review_version}#${c.action}`);
  const last = rows.length === 0 ? 0 : Math.max(...rows.map((r) => r.n as number));
  const counter = ((await getItem(ctx, REVIEW_HISTORY_COUNTER))?.last as number | undefined) ?? 0;
  return { kind, submissionId, rows, claims, next: last + 1, counterRead: counter, counter };
}

export class HistoryUnique extends Error {
  constructor(what: string) {
    super(`UNIQUE constraint failed: moderation_review_history (${what})`);
  }
}

/**
 * Add one history row and its claim. With `ignoreIfClaimed` an existing claim
 * skips it (`INSERT OR IGNORE`), otherwise it is D1's UNIQUE violation.
 * Returns whether a row was added.
 */
export function addHistory(plan: Plan, st: HistoryState, h: HistoryIntent, ignoreIfClaimed = false): boolean {
  const claim = `${h.reviewVersion}#${h.action}`;
  if (st.claims.has(claim)) {
    if (ignoreIfClaimed) return false;
    throw new HistoryUnique(`${h.kind}, ${h.submissionId}, ${h.reviewVersion}, ${h.action}`);
  }
  (st.claims as Set<string>).add(claim);
  const n = st.next++;
  // D1's AUTOINCREMENT: one global ascending sequence, advanced in this transaction (conditioned on the value read).
  const id = ++st.counter;
  plan.historyCounter = { read: st.counterRead, now: st.counter };
  plan.put(
    "history",
    {
      ...historyKey(h.kind, h.submissionId, n),
      id,
      n,
      kind: h.kind,
      submission_id: h.submissionId,
      action: h.action,
      actor: h.actor,
      at: h.at,
      reason: h.reason,
      review_version: h.reviewVersion,
    },
    "attribute_not_exists(pk)",
  );
  plan.put(
    "history:claim",
    {
      ...historyClaimKey(h.kind, h.submissionId, h.reviewVersion, h.action),
      n,
      kind: h.kind,
      submission_id: h.submissionId,
      action: h.action,
      actor: h.actor,
      review_version: h.reviewVersion,
    },
    "attribute_not_exists(pk)",
  );
  return true;
}

// ---------------------------------------------------------------------------
// Retrying a decision
// ---------------------------------------------------------------------------

export const RETRY = Symbol("retry");

/**
 * Re-read-and-rebuild loop for a decision whose transaction lost a condition
 * that is not its claim (a guard, a layout rename, a concurrent index move).
 * `attempt` returns the result, or RETRY.
 */
export async function decide<T>(attempt: () => Promise<T | typeof RETRY>): Promise<T> {
  for (let i = 0; i < 8; i++) {
    if (i > 0) await txTuning.sleep(5 * 2 ** Math.min(i, 5) * (0.5 + txTuning.random()));
    let r: T | typeof RETRY;
    try {
      r = await attempt();
    } catch (e) {
      // A claim already in the history while the row still read as undecided is a concurrent decision committed between
      // the two reads: re-read, and the row shows it (D1 runs both in one batch and never sees this). Only a claim that
      // survives every re-read is D1's UNIQUE violation.
      if (e instanceof HistoryUnique && i < 7) continue;
      throw e;
    }
    if (r !== RETRY) return r;
  }
  console.error("EVENTTX_EXHAUSTED community decision: gave up after 8 attempts");
  throw internal();
}

/** Tags of a lost transaction that name a UNIQUE conflict D1 would have raised as an error. */
export function uniqueConflict(e: TxConditionFailed): string | undefined {
  return e.tags.find((t) => t.startsWith("outbox:") || t === "history" || t === "history:claim" || t === "insert");
}
