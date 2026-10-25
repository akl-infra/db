// DynamoDB implementation of `OutboxStore` (src/store/port.ts). Owner: P2 lane K
// (design/p2-p5-briefs.md). Rows are `DMO#<delivery_key>/ROW` (inserted by lane
// J's decision transactions, see `outboxInsertItems`); the due queue is the
// sparse `IX#dmo#due` partition that holds pending and leased rows only, and it
// moves in the same transaction as the status change it mirrors. Every
// mutation after the lease checks the lease token, so an expired worker cannot
// overwrite a newer worker's state.
import { UpdateCommand } from "@aws-sdk/lib-dynamodb";
import type { RejectionOutboxRow } from "../../core/rejection-dm";
import type { OutboxContentRow, OutboxStore } from "../port";
import { TxConditionFailed, type DdbContext, type Item, type TxItem } from "./contracts";
import {
  batchGet, catalogItemKey, DMO_DUE_PK, exprInput, getItem, idOfIndexSk, isConditionFailed, isNull, outboxDueKey, outboxKey, queryPartition,
  retrying, setClause, submissionKey, type OutboxStatus, type SubKind,
} from "./keys-discord";
import { runTx } from "./tx";

const MAX_CAS_ATTEMPTS = 6;

const ROW_COLUMNS = [
  "delivery_key", "event_seq", "review_version", "decision", "kind", "submission_id", "layout_id", "recipient_id", "nonce", "status",
  "attempts", "next_attempt_at", "lease_token", "lease_until", "ambiguous_message_attempt_at",
] as const;

function dueRow(item: Item): RejectionOutboxRow {
  const out: Record<string, unknown> = {};
  for (const c of ROW_COLUMNS) out[c] = item[c] === undefined ? null : item[c];
  return out as unknown as RejectionOutboxRow;
}

const nul = (v: unknown): unknown => (v === undefined ? null : v);

export function ddbOutboxStore(ctx: DdbContext): OutboxStore {
  const T = ctx.tables.main;

  const update = async (key: { pk: string; sk: string }, upd: string, cond: string, values: Record<string, unknown>): Promise<boolean> => {
    try {
      await retrying(() => ctx.doc.send(new UpdateCommand({ TableName: T, Key: key, ...exprInput(upd, cond, values) })));
      return true;
    } catch (e) {
      if (isConditionFailed(e)) return false;
      throw e;
    }
  };

  /**
   * Change a row and its due-index item together. `plan` sees the row as read and
   * says what to set, or null to give up (the D1 statement would have changed 0 rows);
   * the write is conditioned on the status, `next_attempt_at`, `attempts` and lease
   * token it saw, so a concurrent change re-reads and re-plans.
   */
  const mutate = async (
    deliveryKey: string,
    plan: (row: Item) => { fields: Record<string, unknown>; next: { status: OutboxStatus; nextAttemptAt: string } } | null,
  ): Promise<boolean> => {
    for (let attempt = 0; attempt < MAX_CAS_ATTEMPTS; attempt++) {
      const row = await getItem(ctx, T, outboxKey(deliveryKey));
      if (row === null) return false;
      const p = plan(row);
      if (p === null) return false;
      const values: Record<string, unknown> = { ":st": row.status, ":na": row.next_attempt_at, ":at": nul(row.attempts) };
      const set = setClause(p.fields, values);
      let cond = "#status = :st AND #next_attempt_at = :na AND #attempts = :at";
      if (row.lease_token === null || row.lease_token === undefined) cond += ` AND ${isNull("lease_token", values)}`;
      else {
        values[":lt"] = row.lease_token;
        cond += " AND #lease_token = :lt";
      }
      const items: { tag: string; item: TxItem }[] = [
        { tag: "row", item: { Update: { TableName: T, Key: outboxKey(deliveryKey), UpdateExpression: set, ConditionExpression: cond, ...exprInput(set, cond, values) } } },
      ];
      const oldIdx = row.status === "pending" || row.status === "leased" ? outboxDueKey(row.status, row.next_attempt_at as string, deliveryKey) : null;
      const newIdx = p.next.status === "pending" || p.next.status === "leased" ? outboxDueKey(p.next.status, p.next.nextAttemptAt, deliveryKey) : null;
      const same = oldIdx !== null && newIdx !== null && oldIdx.sk === newIdx.sk;
      if (oldIdx !== null && !same) items.push({ tag: "idx-del", item: { Delete: { TableName: T, Key: oldIdx } } });
      if (newIdx !== null && !same) items.push({ tag: "idx-put", item: { Put: { TableName: T, Item: { ...newIdx } } } });
      try {
        await runTx(ctx, items);
        return true;
      } catch (e) {
        if (!(e instanceof TxConditionFailed)) throw e;
      }
    }
    throw new Error(`outbox row ${deliveryKey} kept changing under a lease CAS`);
  };

  const leased = (token: string) => (row: Item): boolean => row.status === "leased" && row.lease_token === token;

  return {
    async due(nowIso, limit) {
      // pending past next_attempt_at: every index sort key up to `pending#<now>#<anything>`; every leased row is checked against its lease_until.
      const pending = await queryPartition(ctx, DMO_DUE_PK, { sk: { between: ["pending#", `pending#${nowIso}#￿`] } });
      const leasedIdx = await queryPartition(ctx, DMO_DUE_PK, { sk: { beginsWith: "leased#" } });
      const keys = [...pending, ...leasedIdx].map((it) => outboxKey(idOfIndexSk(it.sk as string)));
      const rows = await batchGet(ctx, T, keys);
      const out = [...rows.values()].filter(
        (r) => (r.status === "pending" && (r.next_attempt_at as string) <= nowIso) || (r.status === "leased" && r.lease_until !== null && r.lease_until !== undefined && (r.lease_until as string) <= nowIso),
      );
      out.sort((a, b) => {
        const n = (a.next_attempt_at as string) < (b.next_attempt_at as string) ? -1 : (a.next_attempt_at as string) > (b.next_attempt_at as string) ? 1 : 0;
        return n !== 0 ? n : (a.event_seq as number) - (b.event_seq as number);
      });
      return out.slice(0, limit).map(dueRow);
    },

    async lease(deliveryKey, token, until, at) {
      return mutate(deliveryKey, (row) => {
        const due = (row.status === "pending" && (row.next_attempt_at as string) <= at) || (row.status === "leased" && row.lease_until != null && (row.lease_until as string) <= at);
        if (!due) return null;
        return {
          fields: { status: "leased", lease_token: token, lease_until: until, attempts: ((row.attempts as number | undefined) ?? 0) + 1, updated_at: at },
          next: { status: "leased", nextAttemptAt: row.next_attempt_at as string },
        };
      });
    },

    async content(row): Promise<OutboxContentRow | null> {
      if (row.decision === "approval" && row.kind === "link") return null;
      const s = await getItem(ctx, T, submissionKey(row.kind as SubKind, row.submission_id));
      if (s === null || s.layout_id !== row.layout_id) return null;
      const layout = await getItem(ctx, T, catalogItemKey(row.layout_id));
      if (layout === null) return null;
      const want = row.decision === "approval" ? "approved" : "rejected";
      let eligible = s.status === want;
      if (row.kind === "comment") eligible = eligible && nul(s.body) !== null;
      if (row.kind !== "link") eligible = eligible && ((s.review_version as number | undefined) ?? 0) === row.review_version;
      return {
        recipient_id: (row.kind === "link" ? s.submitted_by : s.user_id) as string,
        reason: nul(s.reason) as string | null,
        layout_name: layout.name as string,
        deleted: (layout.deleted as number | undefined) ?? 0,
        comment_body: row.kind === "comment" ? (nul(s.body) as string | null) : null,
        wpm: row.kind === "wpm" ? (s.wpm as number) : null,
        proof: row.kind === "wpm" ? (s.proof as string) : null,
        link_url: row.kind === "link" ? (s.url as string) : null,
        eligible: eligible ? 1 : 0,
      };
    },

    async beginMessage({ deliveryKey, token, at, channelId }) {
      const key = outboxKey(deliveryKey);
      const base = (extra: Record<string, unknown>): [string, string, Record<string, unknown>] => {
        const values: Record<string, unknown> = { ":leased": "leased", ":tok": token, ":at": at };
        const set = setClause({ ...extra, dm_channel_id: channelId, updated_at: at }, values);
        return [set, "#status = :leased AND #lease_token = :tok AND #lease_until > :at", values];
      };
      // COALESCE(ambiguous_message_attempt_at, at): set it when empty, keep it otherwise.
      const [set1, cond1, v1] = base({ ambiguous_message_attempt_at: at });
      if (await update(key, set1, `${cond1} AND ${isNull("ambiguous_message_attempt_at", v1)}`, v1)) return true;
      const [set2, cond2, v2] = base({});
      return update(key, set2, cond2, v2);
    },

    async markSent({ deliveryKey, token, messageId, at }) {
      await mutate(deliveryKey, (row) =>
        leased(token)(row)
          ? { fields: { status: "sent", discord_message_id: messageId, sent_at: at, updated_at: at, lease_token: null, lease_until: null }, next: { status: "sent", nextAttemptAt: row.next_attempt_at as string } }
          : null,
      );
    },

    async clearAmbiguous({ deliveryKey, token, at }) {
      const values: Record<string, unknown> = { ":leased": "leased", ":tok": token };
      await update(outboxKey(deliveryKey), setClause({ ambiguous_message_attempt_at: null, updated_at: at }, values), "#status = :leased AND #lease_token = :tok", values);
    },

    async retry({ deliveryKey, token, at, nextAttemptAt, error }) {
      await mutate(deliveryKey, (row) =>
        leased(token)(row)
          ? { fields: { status: "pending", next_attempt_at: nextAttemptAt, updated_at: at, lease_token: null, lease_until: null, last_error_class: error }, next: { status: "pending", nextAttemptAt } }
          : null,
      );
    },

    async deferAllPending(until, at) {
      // A pending row inserted after this read is not deferred (a set guard would need lane J's insert to bump it); the sender
      // would only meet the rate limit once more.
      const idx = await queryPartition(ctx, DMO_DUE_PK, { sk: { beginsWith: "pending#" } });
      for (const it of idx) {
        const deliveryKey = idOfIndexSk(it.sk as string);
        await mutate(deliveryKey, (row) => {
          if (row.status !== "pending") return null;
          const next = (row.next_attempt_at as string) >= until ? (row.next_attempt_at as string) : until;
          return { fields: { next_attempt_at: next, updated_at: at }, next: { status: "pending", nextAttemptAt: next } };
        });
      }
    },

    async terminal({ deliveryKey, token, at, status, error }) {
      await mutate(deliveryKey, (row) =>
        leased(token)(row)
          ? { fields: { status, updated_at: at, lease_token: null, lease_until: null, last_error_class: error }, next: { status, nextAttemptAt: row.next_attempt_at as string } }
          : null,
      );
    },
  };
}
