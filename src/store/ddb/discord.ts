// DynamoDB implementation of `DiscordStore` (src/store/port.ts). Owner: P2 lane K
// (design/p2-p5-briefs.md). The four interaction tables are small, pruned
// partitions: reads take the whole partition and filter in memory (as the D1
// code's `ORDER BY created_at LIMIT 1` would). Every interaction id is held by
// one `DINT#<id>/CLAIM` item that lives and dies with the row created for it;
// a taken claim is `DuplicateInteractionError`.
import { UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { DuplicateInteractionError, type ActionTable, type DenyModalRow, type DiscordActionRow, type DiscordStore, type ReopenConfirmationRow } from "../port";
import { TxConditionFailed, type DdbContext, type Item, type TxItem } from "./contracts";
import {
  actionKey, actionPartition, DCONF_PK, denyModalKey, DMOD_PK, exprInput, getItem, interactionClaimKey, isConditionFailed, isNull, mqnKey,
  queryPartition, reopenConfKey, retrying, rowOf, setClause, submissionKey, type SubKind,
} from "./keys-discord";
import { normalize } from "./schema/discord";
import { runTx } from "./tx";
import type { D1TableName } from "./contracts";

const MAX_TX = 100;

export function ddbDiscordStore(ctx: DdbContext): DiscordStore {
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

  const claimPut = (interactionId: string, tbl: D1TableName, conditional: boolean): TxItem => ({
    Put: { TableName: T, Item: { ...interactionClaimKey(interactionId), tbl }, ...(conditional ? { ConditionExpression: "attribute_not_exists(pk)" } : {}) },
  });

  /** Delete items in transactions of at most MAX_TX; the sets are small, pruned partitions. */
  const deleteKeys = async (keys: { pk: string; sk: string }[]): Promise<void> => {
    for (let i = 0; i < keys.length; i += MAX_TX) {
      await runTx(ctx, keys.slice(i, i + MAX_TX).map((Key, n) => ({ tag: `del${i + n}`, item: { Delete: { TableName: T, Key } } })));
    }
  };

  const actions = async (table: ActionTable): Promise<DiscordActionRow[]> =>
    (await queryPartition(ctx, actionPartition(table))).map((i) => rowOf<DiscordActionRow>(i));

  /** `DuplicateInteractionError` unless the failed condition is one of `benign`. */
  const asDuplicate = (e: unknown, benign: readonly string[]): boolean => {
    if (!(e instanceof TxConditionFailed)) throw e;
    if (e.tags.some((t) => benign.includes(t))) return false;
    throw new DuplicateInteractionError(`interaction already recorded: ${e.tags.join(", ")}`);
  };

  return {
    async trackedTarget(target, channelId, messageId) {
      const n = await getItem(ctx, T, mqnKey(target.kind as SubKind, target.id));
      if (
        n === null || n.transport !== "bot" || n.channel_id !== channelId || n.message_id !== messageId ||
        n.shown_status !== target.status || ((n.shown_review_version as number | undefined) ?? 0) !== target.reviewVersion
      ) return false;
      const s = await getItem(ctx, T, submissionKey(target.kind as SubKind, target.id));
      if (s === null || s.status !== target.status) return false;
      return (target.kind === "link" ? 0 : ((s.review_version as number | undefined) ?? 0)) === target.reviewVersion;
    },

    async hasReceipt(interactionId) {
      return (await getItem(ctx, T, interactionClaimKey(interactionId))) !== null;
    },

    async claimAction(table, at, until, leaseToken) {
      const claimable = (await actions(table))
        .filter((r) => r.expires_at > at && (r.state === "pending" || (r.state === "working" && r.lease_until !== null && r.lease_until < at)))
        .sort((a, b) => (a.created_at < b.created_at ? -1 : a.created_at > b.created_at ? 1 : a.interaction_id < b.interaction_id ? -1 : 1));
      const row = claimable[0];
      if (row === undefined) return null;
      const values: Record<string, unknown> = { ":pending": "pending", ":working": "working", ":at": at, ":one": 1 };
      const set = `${setClause({ state: "working", lease_until: until, lease_token: leaseToken }, values)} ADD #attempts :one`;
      const ok = await update(actionKey(table, row.interaction_id), set, "attribute_exists(pk) AND (#state = :pending OR (#state = :working AND #lease_until < :at))", values);
      return ok ? { ...row, state: "working", lease_until: until, lease_token: leaseToken } : null;
    },

    async expireActions(table, nowIso) {
      const modals = (await queryPartition(ctx, DMOD_PK)).filter((m) => (m.expires_at as string) <= nowIso);
      await deleteKeys(modals.flatMap((m) => [{ pk: m.pk as string, sk: m.sk as string }, interactionClaimKey(m.initial_interaction_id as string)]));
      // Open rows past their expiry are expired and then deleted with the finished ones: every row past `expires_at` goes.
      const due = (await actions(table)).filter((r) => r.expires_at <= nowIso);
      await deleteKeys(due.flatMap((r) => [actionKey(table, r.interaction_id), interactionClaimKey(r.interaction_id)]));
    },

    async disableActions(table) {
      for (const r of await actions(table)) {
        const key = actionKey(table, r.interaction_id);
        if (r.state === "pending" || r.state === "working") {
          const values: Record<string, unknown> = { ":state": r.state };
          const set = setClause({ state: "expired", token: "", result: "actions disabled", lease_until: null, lease_token: null }, values);
          await update(key, set, "#state = :state", values);
        } else if (r.state === "complete") {
          const values: Record<string, unknown> = { ":complete": "complete" };
          await update(key, setClause({ token: "" }, values), "#state = :complete", values);
        }
      }
    },

    async expireLeasedAction(table, interactionId, leaseToken, result) {
      const values: Record<string, unknown> = { ":tok": leaseToken };
      const set = setClause({ state: "expired", token: "", result, lease_until: null, lease_token: null }, values);
      await update(actionKey(table, interactionId), set, "#lease_token = :tok", values);
    },

    async releaseAction(table, interactionId, leaseToken) {
      const values: Record<string, unknown> = { ":tok": leaseToken, ":working": "working" };
      const set = setClause({ state: "pending", lease_until: null, lease_token: null }, values);
      await update(actionKey(table, interactionId), set, "#state = :working AND #lease_token = :tok", values);
    },

    async completeAction(table, interactionId, leaseToken, result, token) {
      const values: Record<string, unknown> = { ":tok": leaseToken, ":working": "working" };
      const set = setClause({ state: "complete", result, token, lease_until: null, lease_token: null }, values);
      await update(actionKey(table, interactionId), set, "#state = :working AND #lease_token = :tok", values);
    },

    async pendingCallbacks(table, nowIso, limit) {
      return (await actions(table))
        .filter((r) => r.state === "complete" && r.token !== "" && r.expires_at > nowIso)
        .sort((a, b) => {
          const attempts = ((a as unknown as Item).attempts as number) - ((b as unknown as Item).attempts as number);
          return attempts !== 0 ? attempts : a.created_at < b.created_at ? -1 : a.created_at > b.created_at ? 1 : 0;
        })
        .slice(0, limit);
    },

    async clearCallbackToken(table, interactionId, token) {
      const values: Record<string, unknown> = { ":complete": "complete", ":tok": token };
      await update(actionKey(table, interactionId), setClause({ token: "" }, values), "#state = :complete AND #token = :tok", values);
    },

    async bumpCallbackAttempts(table, interactionId, token) {
      await update(actionKey(table, interactionId), "ADD #attempts :one", "#state = :complete AND #token = :tok", { ":one": 1, ":complete": "complete", ":tok": token });
    },

    async deleteExpiredConfirmations(nowIso) {
      const due = (await queryPartition(ctx, DCONF_PK)).filter((c) => (c.expires_at as string) <= nowIso);
      const keys: { pk: string; sk: string }[] = [];
      for (const c of due) {
        keys.push({ pk: c.pk as string, sk: c.sk as string }, interactionClaimKey(c.initial_interaction_id as string));
        const used = (c.consumed_interaction_id as string | null | undefined) ?? null;
        // A confirmation that queued a reopen shares its consumed id with that action, which owns the claim.
        if (used !== null && (await getItem(ctx, T, actionKey("discord_reopen_actions", used))) === null) keys.push(interactionClaimKey(used));
      }
      await deleteKeys(keys);
    },

    async reopenConfirmation(id): Promise<ReopenConfirmationRow | null> {
      const c = await getItem(ctx, T, reopenConfKey(id));
      return c === null ? null : rowOf<ReopenConfirmationRow>(c);
    },

    async consumeConfirmation(id, at, interactionId) {
      const values: Record<string, unknown> = {};
      const set = setClause({ consumed_at: at, consumed_interaction_id: interactionId }, values);
      const cond = `attribute_exists(pk) AND ${isNull("consumed_at", values)}`;
      try {
        // The consuming interaction is a receipt even though no action row is created for it.
        await runTx(ctx, [
          { tag: "conf", item: { Update: { TableName: T, Key: reopenConfKey(id), UpdateExpression: set, ConditionExpression: cond, ...exprInput(set, cond, values) } } },
          { tag: "claim", item: claimPut(interactionId, "discord_reopen_confirmations", false) },
        ]);
        return true;
      } catch (e) {
        if (e instanceof TxConditionFailed) return false;
        throw e;
      }
    },

    async consumeConfirmationAndQueueReopen({ confirmationId, at, action: a }) {
      const values: Record<string, unknown> = { ":at": at };
      const set = setClause({ consumed_at: at, consumed_interaction_id: a.interaction_id }, values);
      const cond = `attribute_exists(pk) AND ${isNull("consumed_at", values)} AND #expires_at > :at`;
      // `response_mode` is left to the column default ('reply'), as the D1 statement leaves it.
      const row = normalize("discord_reopen_actions", { ...a, action: "reopen", reason: null });
      try {
        await runTx(ctx, [
          { tag: "conf", item: { Update: { TableName: T, Key: reopenConfKey(confirmationId), UpdateExpression: set, ConditionExpression: cond, ...exprInput(set, cond, values) } } },
          { tag: "action", item: { Put: { TableName: T, Item: { ...actionKey("discord_reopen_actions", a.interaction_id), ...row }, ConditionExpression: "attribute_not_exists(pk)" } } },
          { tag: "claim", item: claimPut(a.interaction_id, "discord_reopen_actions", true) },
        ]);
        return true;
      } catch (e) {
        return asDuplicate(e, ["conf"]);
      }
    },

    async insertDenyModal(r) {
      const row = normalize("discord_deny_modals", {
        modal_id: r.modalId, initial_interaction_id: r.initialInteractionId, actor_id: r.actorId, kind: r.kind, submission_id: r.submissionId,
        channel_id: r.channelId, message_id: r.messageId, guild_id: r.guildId, created_at: r.createdAt, expires_at: r.expiresAt,
        expected_review_version: r.expectedReviewVersion,
      });
      try {
        await runTx(ctx, [
          { tag: "modal", item: { Put: { TableName: T, Item: { ...denyModalKey(r.modalId), ...row }, ConditionExpression: "attribute_not_exists(pk)" } } },
          { tag: "claim", item: claimPut(r.initialInteractionId, "discord_deny_modals", true) },
        ]);
      } catch (e) {
        asDuplicate(e, []);
      }
    },

    async denyModal(modalId): Promise<DenyModalRow | null> {
      const m = await getItem(ctx, T, denyModalKey(modalId));
      if (m === null) return null;
      return {
        actor_id: m.actor_id as string, kind: m.kind as DenyModalRow["kind"], submission_id: m.submission_id as string, channel_id: m.channel_id as string,
        message_id: m.message_id as string, guild_id: m.guild_id as string, expires_at: m.expires_at as string,
        consumed_at: (m.consumed_at as string | null | undefined) ?? null, expected_review_version: (m.expected_review_version as number | undefined) ?? 0,
      };
    },

    async consumeModalAndQueueDeny({ modalId, actorId, at, action: a }) {
      const values: Record<string, unknown> = { ":actor": actorId, ":at": at };
      const set = setClause({ consumed_at: at, consumed_interaction_id: a.interaction_id }, values);
      const cond = `attribute_exists(pk) AND #actor_id = :actor AND #expires_at > :at AND ${isNull("consumed_at", values)}`;
      const row = normalize("discord_pending_actions", { ...a, response_mode: "update" });
      try {
        await runTx(ctx, [
          { tag: "modal", item: { Update: { TableName: T, Key: denyModalKey(modalId), UpdateExpression: set, ConditionExpression: cond, ...exprInput(set, cond, values) } } },
          { tag: "action", item: { Put: { TableName: T, Item: { ...actionKey("discord_pending_actions", a.interaction_id), ...row }, ConditionExpression: "attribute_not_exists(pk)" } } },
          { tag: "claim", item: claimPut(a.interaction_id, "discord_pending_actions", true) },
        ]);
        return true;
      } catch (e) {
        return asDuplicate(e, ["modal"]);
      }
    },

    async insertAction(table: ActionTable, a) {
      const row = normalize(table, {
        ...a, reason: null, response_mode: "update",
        ...(table === "discord_reopen_actions" ? { expected_status: a.expected_status ?? null } : {}),
      });
      try {
        await runTx(ctx, [
          { tag: "action", item: { Put: { TableName: T, Item: { ...actionKey(table, a.interaction_id), ...row }, ConditionExpression: "attribute_not_exists(pk)" } } },
          { tag: "claim", item: claimPut(a.interaction_id, table, true) },
        ]);
      } catch (e) {
        asDuplicate(e, []);
      }
    },
  };
}
