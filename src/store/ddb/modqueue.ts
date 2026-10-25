// DynamoDB implementation of `ModqueueStore` (src/store/port.ts). Owner: P2 lane K
// (design/p2-p5-briefs.md). Same CAS columns as src/store/d1/modqueue.ts; the
// stale-card query reads the dirty set instead of joining every submission.
import { UpdateCommand } from "@aws-sdk/lib-dynamodb";
import type { QueueKind } from "../../core/modqueue";
import type { CommentCandidateRow, LinkCandidateRow, ModqueueStore, NotificationDbRow, QueueSourceStatusRow, WpmCandidateRow } from "../port";
import type { DdbContext, Item, TxItem } from "./contracts";
import {
  authorItemKey, batchGet, catalogItemKey, commentPairPartition, exprInput, getItem, idOfIndexSk, isConditionFailed, isNull, mapKey,
  MQGATE_KEY, MQN_DIRTY_PK, mqnDirtyKey, mqnKey, namesIn, queryPartition, retrying, setClause, submissionKey, submissionStatusPartition,
  type SubKind,
} from "./keys-discord";
import { TxConditionFailed } from "./contracts";
import { runTx } from "./tx";

const nullable = <T>(v: T | undefined): T | null => (v === undefined ? null : v);

/** What a card shows, as `modqueue_notifications` records it. */
interface Shown {
  status: string;
  reviewVersion: number;
  sourceMessageUrl: string | null;
}

/**
 * The condition under which a submission row agrees with a card showing
 * `shown` (the negation of the stale predicate in D1's `retryStatusEdits`),
 * or null if no row could (a link card with a non-zero version). Placeholders
 * are prefixed so the caller can merge value maps.
 */
function inSyncCondition(kind: SubKind, shown: Shown, values: Record<string, unknown>): string | null {
  values[":sync_status"] = shown.status;
  if (kind === "link") return shown.reviewVersion === 0 ? "#status = :sync_status" : null;
  values[":sync_rv"] = shown.reviewVersion;
  let cond = "#status = :sync_status AND #review_version = :sync_rv";
  if (kind === "wpm") {
    if (shown.sourceMessageUrl === null) cond += ` AND ${isNull("source_message_url", values)}`;
    else {
      values[":sync_url"] = shown.sourceMessageUrl;
      cond += " AND #source_message_url = :sync_url";
    }
  }
  return cond;
}

/** Is the card out of step with its source? D1: the three branches of `retryStatusEdits`'s UNION ALL. */
function isStale(kind: SubKind, n: Item, s: Item): boolean {
  if (n.shown_status !== s.status) return true;
  if (kind === "link") return (n.shown_review_version ?? 0) !== 0;
  if ((n.shown_review_version ?? 0) !== (s.review_version ?? 0)) return true;
  return kind === "wpm" && (n.shown_source_message_url ?? null) !== (s.source_message_url ?? null);
}

async function authorName(ctx: DdbContext, userId: string | null | undefined): Promise<string | null> {
  if (userId === null || userId === undefined) return null;
  const a = await getItem(ctx, ctx.tables.main, authorItemKey(userId));
  return (a?.name as string | undefined) ?? null;
}

async function namesOf(ctx: DdbContext, ids: readonly (string | null)[]): Promise<Map<string, string>> {
  const want = [...new Set(ids.filter((i): i is string => i !== null))];
  const got = await batchGet(ctx, ctx.tables.main, want.map(authorItemKey));
  const out = new Map<string, string>();
  for (const id of want) {
    const a = got.get(mapKey(authorItemKey(id)));
    if (a?.name !== undefined) out.set(id, a.name as string);
  }
  return out;
}

/**
 * Pending, never-announced submissions of `kind`, oldest first, with their layout
 * (an inner join: a row whose layout is gone is skipped, as in SQL).
 */
async function pendingUnannounced(ctx: DdbContext, kind: "link" | "wpm", limit: number): Promise<{ row: Item; layout: Item }[]> {
  const out: { row: Item; layout: Item }[] = [];
  if (limit <= 0) return out;
  const index = await queryPartition(ctx, submissionStatusPartition(kind, "pending"));
  for (let i = 0; i < index.length && out.length < limit; i += 50) {
    const ids = index.slice(i, i + 50).map((it) => idOfIndexSk(it.sk as string));
    const rows = await batchGet(ctx, ctx.tables.main, ids.map((id) => submissionKey(kind, id)));
    const candidates = ids
      .map((id) => rows.get(mapKey(submissionKey(kind, id))))
      .filter((r): r is Item => r !== undefined && r.status === "pending" && (r.notified_at ?? null) === null);
    const layouts = await batchGet(ctx, ctx.tables.main, candidates.map((r) => catalogItemKey(r.layout_id as string)));
    for (const row of candidates) {
      const layout = layouts.get(mapKey(catalogItemKey(row.layout_id as string)));
      if (layout !== undefined && out.length < limit) out.push({ row, layout });
    }
  }
  return out;
}

/**
 * Drop a dirty mark if (and only if, in one transaction) the notification and
 * its source still hold the values just read and agree. A concurrent change by
 * lane J rewrites the source row and re-puts the mark, so a lost race keeps it.
 */
async function clearMarkIfInSync(ctx: DdbContext, kind: SubKind, id: string, shown: Shown, notification: Item | null): Promise<boolean> {
  const values: Record<string, unknown> = {};
  const cond = inSyncCondition(kind, shown, values);
  if (cond === null) return false;
  const names = namesIn(cond);
  const items: { tag: string; item: TxItem }[] = [
    { tag: "src", item: { ConditionCheck: { TableName: ctx.tables.main, Key: submissionKey(kind, id), ConditionExpression: cond, ExpressionAttributeNames: names, ExpressionAttributeValues: values } } },
    { tag: "mark", item: { Delete: { TableName: ctx.tables.main, Key: mqnDirtyKey(kind, id) } } },
  ];
  if (notification !== null) {
    const nv: Record<string, unknown> = { ":ss": shown.status, ":srv": shown.reviewVersion };
    let nc = "#shown_status = :ss AND #shown_review_version = :srv";
    if (shown.sourceMessageUrl === null) nc += ` AND ${isNull("shown_source_message_url", nv)}`;
    else {
      nv[":surl"] = shown.sourceMessageUrl;
      nc += " AND #shown_source_message_url = :surl";
    }
    items.push({ tag: "mqn", item: { ConditionCheck: { TableName: ctx.tables.main, Key: mqnKey(kind, id), ConditionExpression: nc, ExpressionAttributeNames: namesIn(nc), ExpressionAttributeValues: nv } } });
  }
  try {
    await runTx(ctx, items);
    return true;
  } catch (e) {
    if (e instanceof TxConditionFailed) return false;
    throw e;
  }
}

/** Drop the mark of a notification that does not exist (guarded: an insert racing in keeps it). */
async function clearOrphanMark(ctx: DdbContext, kind: SubKind, id: string): Promise<void> {
  try {
    await runTx(ctx, [
      { tag: "mqn", item: { ConditionCheck: { TableName: ctx.tables.main, Key: mqnKey(kind, id), ConditionExpression: "attribute_not_exists(pk)" } } },
      { tag: "mark", item: { Delete: { TableName: ctx.tables.main, Key: mqnDirtyKey(kind, id) } } },
    ]);
  } catch (e) {
    if (!(e instanceof TxConditionFailed)) throw e;
  }
}

const CLEANUPS_PER_CALL = 25;

export function ddbModqueueStore(ctx: DdbContext): ModqueueStore {
  const T = ctx.tables.main;
  const update = async (key: { pk: string; sk: string }, update: string | undefined, cond: string | undefined, values: Record<string, unknown>): Promise<boolean> => {
    try {
      await retrying(() => ctx.doc.send(new UpdateCommand({ TableName: T, Key: key, ...exprInput(update, cond, values) })));
      return true;
    } catch (e) {
      if (isConditionFailed(e)) return false;
      throw e;
    }
  };

  return {
    async sourceStatus(kind, id): Promise<QueueSourceStatusRow | null> {
      const s = await getItem(ctx, T, submissionKey(kind, id));
      if (s === null) return null;
      return {
        status: s.status as string,
        reason: nullable(s.reason as string | null | undefined),
        submitter_id: (kind === "link" ? s.submitted_by : s.user_id) as string,
        source_message_url: kind === "wpm" ? nullable(s.source_message_url as string | null | undefined) : null,
        review_version: kind === "link" ? 0 : ((s.review_version as number | undefined) ?? 0),
        decider_name: await authorName(ctx, s.decided_by as string | null | undefined),
      };
    },

    async bumpFailedAttempts(kind, id) {
      await update(mqnKey(kind, id), "ADD #failed_attempts :one", "attribute_exists(pk)", { ":one": 1 });
    },

    async leaseNotification(kind, id, token, until, nowIso) {
      const values: Record<string, unknown> = { ":now": nowIso };
      const set = setClause({ reconcile_lease_token: token, reconcile_lease_until: until }, values);
      return update(mqnKey(kind, id), set, `attribute_exists(pk) AND (${isNull("reconcile_lease_token", values)} OR #reconcile_lease_until < :now)`, values);
    },

    async notification(kind, id): Promise<NotificationDbRow | null> {
      const n = await getItem(ctx, T, mqnKey(kind, id));
      if (n === null) return null;
      return {
        message_id: n.message_id as string,
        shown_status: n.shown_status as string,
        shown_review_version: (n.shown_review_version as number | undefined) ?? 0,
        shown_source_message_url: nullable(n.shown_source_message_url as string | null | undefined),
        message_format: (n.message_format as NotificationDbRow["message_format"] | undefined) ?? "text",
        transport: (n.transport as NotificationDbRow["transport"] | undefined) ?? "legacy_webhook",
        channel_id: nullable(n.channel_id as string | null | undefined),
      };
    },

    async deleteNotification(kind, id) {
      await runTx(ctx, [
        { tag: "mqn", item: { Delete: { TableName: T, Key: mqnKey(kind, id) } } },
        { tag: "mark", item: { Delete: { TableName: T, Key: mqnDirtyKey(kind, id) } } },
      ]);
    },

    async markShown(r) {
      const values: Record<string, unknown> = { ":tok": r.leaseToken };
      const set = setClause({ shown_status: r.status, shown_review_version: r.reviewVersion, shown_source_message_url: r.sourceMessageUrl, failed_attempts: 0 }, values);
      const shown: Shown = { status: r.status, reviewVersion: r.reviewVersion, sourceMessageUrl: r.sourceMessageUrl };
      const sv: Record<string, unknown> = {};
      const sync = inSyncCondition(r.kind, shown, sv);
      const cond = "#reconcile_lease_token = :tok";
      if (sync !== null) {
        const names = namesIn(sync);
        try {
          await runTx(ctx, [
            { tag: "mqn", item: { Update: { TableName: T, Key: mqnKey(r.kind, r.id), UpdateExpression: set, ConditionExpression: cond, ...exprInput(set, cond, values) } } },
            { tag: "src", item: { ConditionCheck: { TableName: T, Key: submissionKey(r.kind, r.id), ConditionExpression: sync, ExpressionAttributeNames: names, ExpressionAttributeValues: sv } } },
            { tag: "mark", item: { Delete: { TableName: T, Key: mqnDirtyKey(r.kind, r.id) } } },
          ]);
          return;
        } catch (e) {
          if (!(e instanceof TxConditionFailed)) throw e;
          if (e.tags.includes("mqn")) return; // the lease is not ours: nothing changes, as in SQL
        }
      }
      // The source moved on (or cannot agree): record what the card shows and keep the mark.
      await update(mqnKey(r.kind, r.id), set, cond, values);
    },

    async releaseNotificationLease(kind, id, leaseToken) {
      const values: Record<string, unknown> = { ":tok": leaseToken, ":null": null };
      await update(mqnKey(kind, id), "SET #reconcile_lease_token = :null, #reconcile_lease_until = :null", "#reconcile_lease_token = :tok", values);
    },

    async insertNotification(r) {
      const row: Item = {
        ...mqnKey(r.kind, r.id), kind: r.kind, submission_id: r.id, message_id: r.messageId, shown_status: "pending", failed_attempts: 0,
        message_format: r.format, transport: r.transport, channel_id: r.channelId, reconcile_lease_token: null, reconcile_lease_until: null,
        shown_review_version: r.reviewVersion, shown_source_message_url: r.sourceMessageUrl,
      };
      try {
        // The mark makes the reconciler compare this card with its source at least once (a decision may have landed since the announce read).
        await runTx(ctx, [
          { tag: "mqn", item: { Put: { TableName: T, Item: row, ConditionExpression: "attribute_not_exists(pk)" } } },
          { tag: "mark", item: { Put: { TableName: T, Item: { ...mqnDirtyKey(r.kind, r.id) } } } },
        ]);
      } catch (e) {
        if (!(e instanceof TxConditionFailed)) throw e; // ON CONFLICT DO NOTHING
      }
    },

    async staleNotifications(limit) {
      const marks = await queryPartition(ctx, MQN_DIRTY_PK);
      const parsed = marks.map((m) => {
        const sk = m.sk as string;
        const cut = sk.indexOf("#");
        return { kind: sk.slice(0, cut) as SubKind, id: sk.slice(cut + 1) };
      });
      const stale: { kind: QueueKind; submission_id: string; failed: number }[] = [];
      let cleanups = 0;
      for (let i = 0; i < parsed.length; i += 50) {
        const chunk = parsed.slice(i, i + 50);
        const got = await batchGet(ctx, T, chunk.flatMap((p) => [mqnKey(p.kind, p.id), submissionKey(p.kind, p.id)]));
        for (const p of chunk) {
          const n = got.get(mapKey(mqnKey(p.kind, p.id)));
          const s = got.get(mapKey(submissionKey(p.kind, p.id)));
          if (n === undefined) {
            if (cleanups++ < CLEANUPS_PER_CALL) await clearOrphanMark(ctx, p.kind, p.id);
          } else if (s === undefined) {
            continue; // an inner join: no source, no work
          } else if (isStale(p.kind, n, s)) {
            stale.push({ kind: p.kind, submission_id: p.id, failed: (n.failed_attempts as number | undefined) ?? 0 });
          } else if (cleanups++ < CLEANUPS_PER_CALL) {
            await clearMarkIfInSync(ctx, p.kind, p.id, { status: n.shown_status as string, reviewVersion: (n.shown_review_version as number | undefined) ?? 0, sourceMessageUrl: nullable(n.shown_source_message_url as string | null | undefined) }, n);
          }
        }
      }
      stale.sort((a, b) => a.failed - b.failed);
      return stale.slice(0, limit).map(({ kind, submission_id }) => ({ kind, submission_id }));
    },

    async linkCandidates(limit): Promise<LinkCandidateRow[]> {
      const found = await pendingUnannounced(ctx, "link", limit);
      const names = await namesOf(ctx, found.map((f) => f.row.submitted_by as string));
      return found.map(({ row, layout }) => ({
        id: row.id as string, layout_id: row.layout_id as string, url: row.url as string, submitted_by: row.submitted_by as string,
        layout_name: layout.name as string, submitter_name: names.get(row.submitted_by as string) ?? null,
      }));
    },

    async wpmCandidates(limit): Promise<WpmCandidateRow[]> {
      const found = await pendingUnannounced(ctx, "wpm", limit);
      const names = await namesOf(ctx, found.map((f) => f.row.user_id as string));
      return found.map(({ row, layout }) => ({
        id: row.id as string, review_version: (row.review_version as number | undefined) ?? 0, source_message_url: nullable(row.source_message_url as string | null | undefined),
        layout_id: row.layout_id as string, user_id: row.user_id as string, wpm: row.wpm as number, proof: row.proof as string,
        layout_name: layout.name as string, user_name: names.get(row.user_id as string) ?? null,
      }));
    },

    async commentCandidate(id): Promise<CommentCandidateRow | null> {
      const s = await getItem(ctx, T, submissionKey("comment", id));
      if (s === null || s.status !== "pending" || (s.body ?? null) === null) return null;
      const layout = await getItem(ctx, T, catalogItemKey(s.layout_id as string));
      if (layout === null) return null;
      const pair = await queryPartition(ctx, commentPairPartition(s.layout_id as string, s.user_id as string));
      const mates = await batchGet(ctx, T, pair.map((p) => submissionKey("comment", idOfIndexSk(p.sk as string))));
      const approved = [...mates.values()].filter((m) => m.status === "approved");
      const withBody = approved.filter((m) => (m.body ?? null) !== null).sort((a, b) => ((b.decided_at as string | null) ?? "").localeCompare((a.decided_at as string | null) ?? ""));
      return {
        id: s.id as string, review_version: (s.review_version as number | undefined) ?? 0, layout_id: s.layout_id as string, user_id: s.user_id as string,
        body: s.body as string, layout_name: layout.name as string, layout_owner: layout.owner as string, user_name: await authorName(ctx, s.user_id as string),
        has_live: approved.length > 0 ? 1 : 0, live_body: withBody.length > 0 ? (withBody[0]!.body as string) : null,
      };
    },

    async claimAnnounce(kind, id, at) {
      if (kind === "comment") throw new Error("layout_comments has no notified_at: comments are never claimed for announcement");
      const values: Record<string, unknown> = { ":pending": "pending" };
      const set = setClause({ notified_at: at }, values);
      return update(submissionKey(kind, id), set, `attribute_exists(pk) AND ${isNull("notified_at", values)} AND #status = :pending`, values);
    },

    async releaseAnnounce(kind, id, claimedAt) {
      if (kind === "comment") throw new Error("layout_comments has no notified_at: comments are never claimed for announcement");
      const values: Record<string, unknown> = { ":claimed": claimedAt };
      const set = setClause({ notified_at: null }, values);
      await update(submissionKey(kind, id), set, "#notified_at = :claimed", values);
    },

    async claimDeliveryGate(token, untilMs, nowMs) {
      const values: Record<string, unknown> = { ":now": nowMs, ":zero": 0 };
      const set = `${setClause({ lease_token: token, lease_until: untilMs }, values)}, #retry_at = if_not_exists(#retry_at, :zero)`;
      // The migration seeds the row; a database that never had it behaves as {NULL, 0, 0}.
      const cond = `attribute_not_exists(pk) OR (#retry_at <= :now AND (${isNull("lease_token", values)} OR #lease_until <= :now))`;
      return update(MQGATE_KEY, set, cond, values);
    },

    async deferDeliveryGate(token, retryAtMs) {
      const values: Record<string, unknown> = { ":tok": token, ":r": retryAtMs };
      await update(MQGATE_KEY, "SET #retry_at = :r", "#lease_token = :tok AND #retry_at < :r", values);
    },

    async releaseDeliveryGate(token) {
      const values: Record<string, unknown> = { ":tok": token, ":null": null, ":zero": 0 };
      await update(MQGATE_KEY, "SET #lease_token = :null, #lease_until = :zero", "#lease_token = :tok", values);
    },
  };
}
