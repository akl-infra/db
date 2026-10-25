// D1 implementation of `DiscordStore` (src/store/port.ts). Owner: P1 agent D
// (design/p1-briefs.md). Today's SQL from core/discord-interactions.ts, moved
// verbatim. `table` is always one of the two `ActionTable` constants, never
// request input, so it is interpolated into the SQL.
import { DuplicateInteractionError, type ActionTable, type DenyModalRow, type DiscordActionRow, type DiscordStore, type ReopenConfirmationRow } from "../port";

// D1 reports a primary-key or unique violation on the interaction/modal id as
// "UNIQUE constraint failed: <table>.<column>" (SQLite also words a rowid or
// composite primary key clash that way).
function duplicateOrRethrow(error: unknown): never {
  const message = error instanceof Error ? error.message : String(error);
  if (/UNIQUE constraint failed|PRIMARY KEY/i.test(message)) throw new DuplicateInteractionError(message);
  throw error;
}

export function d1DiscordStore(db: D1Database): DiscordStore {
  return {
    async trackedTarget(target, channelId, messageId) {
      const row = await db.prepare(`SELECT 1 FROM modqueue_notifications
    WHERE kind = ? AND submission_id = ? AND transport = 'bot' AND channel_id = ?
      AND message_id = ? AND shown_status = ? AND shown_review_version = ? LIMIT 1`)
        .bind(target.kind, target.id, channelId, messageId, target.status, target.reviewVersion).first();
      if (row === null) return false;
      const table = target.kind === "link" ? "link_submissions" : target.kind === "wpm" ? "wpm_submissions" : "layout_comments";
      return await db.prepare(`SELECT 1 FROM ${table} WHERE id = ? AND status = ? AND ${target.kind === 'link' ? '0' : 'review_version'} = ?`).bind(target.id, target.status, target.reviewVersion).first() !== null;
    },

    async hasReceipt(interactionId) {
      return await db.prepare("SELECT 1 FROM discord_pending_actions WHERE interaction_id = ? UNION ALL SELECT 1 FROM discord_deny_modals WHERE initial_interaction_id = ? UNION ALL SELECT 1 FROM discord_reopen_actions WHERE interaction_id = ? UNION ALL SELECT 1 FROM discord_reopen_confirmations WHERE initial_interaction_id = ? OR consumed_interaction_id = ? LIMIT 1")
        .bind(interactionId, interactionId, interactionId, interactionId, interactionId).first() !== null;
    },

    async claimAction(table, at, until, leaseToken) {
      const row = await db.prepare(`SELECT * FROM ${table} WHERE expires_at > ? AND
    (state = 'pending' OR (state = 'working' AND lease_until < ?)) ORDER BY created_at ASC LIMIT 1`).bind(at, at).first<DiscordActionRow>();
      if (row === null) return null;
      const changed = await db.prepare(`UPDATE ${table} SET state = 'working', lease_until = ?, lease_token = ?, attempts = attempts + 1
    WHERE interaction_id = ? AND (state = 'pending' OR (state = 'working' AND lease_until < ?))`).bind(until, leaseToken, row.interaction_id, at).run();
      return changed.meta.changes === 1 ? { ...row, state: "working", lease_until: until, lease_token: leaseToken } : null;
    },

    async expireActions(table, nowIso) {
      await db.prepare(`UPDATE ${table} SET state = 'expired', token = '', result = 'expired', lease_until = NULL, lease_token = NULL WHERE expires_at <= ? AND state IN ('pending', 'working')`).bind(nowIso).run();
      await db.prepare("DELETE FROM discord_deny_modals WHERE expires_at <= ?").bind(nowIso).run();
      await db.prepare(`DELETE FROM ${table} WHERE expires_at <= ? AND state IN ('complete', 'expired')`).bind(nowIso).run();
    },

    async disableActions(table) {
      await db.prepare(`UPDATE ${table} SET state = 'expired', token = '', result = 'actions disabled', lease_until = NULL, lease_token = NULL WHERE state IN ('pending', 'working')`).run();
      await db.prepare(`UPDATE ${table} SET token = '' WHERE state = 'complete'`).run();
    },

    async expireLeasedAction(table, interactionId, leaseToken, result) {
      await db.prepare(`UPDATE ${table} SET state = 'expired', token = '', result = ?, lease_until = NULL, lease_token = NULL WHERE interaction_id = ? AND lease_token = ?`)
        .bind(result, interactionId, leaseToken).run();
    },

    async releaseAction(table, interactionId, leaseToken) {
      await db.prepare(`UPDATE ${table} SET state = 'pending', lease_until = NULL, lease_token = NULL WHERE interaction_id = ? AND state = 'working' AND lease_token = ?`)
        .bind(interactionId, leaseToken).run();
    },

    async completeAction(table, interactionId, leaseToken, result, token) {
      await db.prepare(`UPDATE ${table} SET state = 'complete', result = ?, token = ?, lease_until = NULL, lease_token = NULL WHERE interaction_id = ? AND state = 'working' AND lease_token = ?`)
        .bind(result, token, interactionId, leaseToken).run();
    },

    async pendingCallbacks(table, nowIso, limit) {
      const callbacks = await db.prepare(`SELECT * FROM ${table} WHERE state = 'complete' AND token != '' AND expires_at > ?
    ORDER BY attempts ASC, created_at ASC LIMIT ?`).bind(nowIso, limit).all<DiscordActionRow>();
      return callbacks.results;
    },

    async clearCallbackToken(table, interactionId, token) {
      await db.prepare(`UPDATE ${table} SET token = '' WHERE interaction_id = ? AND state = 'complete' AND token = ?`)
        .bind(interactionId, token).run();
    },

    async bumpCallbackAttempts(table, interactionId, token) {
      await db.prepare(`UPDATE ${table} SET attempts = attempts + 1 WHERE interaction_id = ? AND state = 'complete' AND token = ?`)
        .bind(interactionId, token).run();
    },

    async deleteExpiredConfirmations(nowIso) {
      await db.prepare("DELETE FROM discord_reopen_confirmations WHERE expires_at <= ?").bind(nowIso).run();
    },

    async reopenConfirmation(id): Promise<ReopenConfirmationRow | null> {
      return db.prepare("SELECT * FROM discord_reopen_confirmations WHERE confirmation_id = ?")
        .bind(id).first<ReopenConfirmationRow>();
    },

    async consumeConfirmation(id, at, interactionId) {
      const changed = await db.prepare("UPDATE discord_reopen_confirmations SET consumed_at = ?, consumed_interaction_id = ? WHERE confirmation_id = ? AND consumed_at IS NULL")
        .bind(at, interactionId, id).run();
      return changed.meta.changes === 1;
    },

    async consumeConfirmationAndQueueReopen({ confirmationId, at, action: a }) {
      try {
        const result = await db.batch([
          db.prepare("UPDATE discord_reopen_confirmations SET consumed_at = ?, consumed_interaction_id = ? WHERE confirmation_id = ? AND consumed_at IS NULL AND expires_at > ?")
            .bind(at, a.interaction_id, confirmationId, at),
          db.prepare(`INSERT INTO discord_reopen_actions
        (interaction_id, application_id, token, actor_id, actor_name, kind, action, submission_id, channel_id, message_id, guild_id, expected_status, expected_review_version, created_at, expires_at)
        SELECT ?, ?, ?, ?, ?, ?, 'reopen', ?, ?, ?, ?, ?, ?, ?, ? WHERE EXISTS
          (SELECT 1 FROM discord_reopen_confirmations WHERE confirmation_id = ? AND consumed_interaction_id = ?)`)
            .bind(a.interaction_id, a.application_id, a.token, a.actor_id, a.actor_name, a.kind, a.submission_id,
              a.channel_id, a.message_id, a.guild_id, a.expected_status, a.expected_review_version, a.created_at, a.expires_at, confirmationId, a.interaction_id),
        ]);
        return result[0]?.meta.changes === 1 && result[1]?.meta.changes === 1;
      } catch (error) {
        return duplicateOrRethrow(error);
      }
    },

    async insertDenyModal(r) {
      try {
        await db.prepare(`INSERT INTO discord_deny_modals (modal_id, initial_interaction_id, actor_id, kind, submission_id, channel_id, message_id, guild_id, created_at, expires_at, expected_review_version)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
          .bind(r.modalId, r.initialInteractionId, r.actorId, r.kind, r.submissionId, r.channelId, r.messageId, r.guildId, r.createdAt, r.expiresAt, r.expectedReviewVersion).run();
      } catch (error) {
        duplicateOrRethrow(error);
      }
    },

    async denyModal(modalId): Promise<DenyModalRow | null> {
      return db.prepare(`SELECT actor_id, kind, submission_id, channel_id, message_id, guild_id, expires_at, consumed_at, expected_review_version
      FROM discord_deny_modals WHERE modal_id = ?`).bind(modalId).first<DenyModalRow>();
    },

    async consumeModalAndQueueDeny({ modalId, actorId, at, action: a }) {
      try {
        const result = await db.batch([
          db.prepare("UPDATE discord_deny_modals SET consumed_at = ?, consumed_interaction_id = ? WHERE modal_id = ? AND actor_id = ? AND expires_at > ? AND consumed_at IS NULL")
            .bind(at, a.interaction_id, modalId, actorId, at),
          db.prepare(`INSERT INTO discord_pending_actions (interaction_id, application_id, token, actor_id, actor_name, kind, action, submission_id, reason, channel_id, message_id, guild_id, created_at, expires_at, response_mode, expected_review_version)
          SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'update', ? WHERE EXISTS
            (SELECT 1 FROM discord_deny_modals WHERE modal_id = ? AND consumed_interaction_id = ? AND actor_id = ?)`)
            .bind(a.interaction_id, a.application_id, a.token, a.actor_id, a.actor_name, a.kind, a.action, a.submission_id, a.reason, a.channel_id, a.message_id, a.guild_id, a.created_at, a.expires_at, a.expected_review_version, modalId, a.interaction_id, actorId),
        ]);
        return result[0]?.meta.changes === 1 && result[1]?.meta.changes === 1;
      } catch (error) {
        return duplicateOrRethrow(error);
      }
    },

    async insertAction(table: ActionTable, a) {
      const reopen = table === "discord_reopen_actions";
      try {
        await db.prepare(`INSERT INTO ${table} (interaction_id, application_id, token, actor_id, actor_name, kind, action, submission_id, reason, channel_id, message_id, guild_id, created_at, expires_at, response_mode, expected_review_version${reopen ? ", expected_status" : ""})
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, ?, ?, 'update', ?${reopen ? ", ?" : ""})`)
          .bind(a.interaction_id, a.application_id, a.token, a.actor_id, a.actor_name, a.kind, a.action, a.submission_id, a.channel_id, a.message_id, a.guild_id, a.created_at, a.expires_at, a.expected_review_version, ...(reopen ? [a.expected_status ?? null] : [])).run();
      } catch (error) {
        duplicateOrRethrow(error);
      }
    },
  };
}
