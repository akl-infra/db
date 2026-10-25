// D1 implementation of `OutboxStore` (src/store/port.ts). Owner: P1 agent D
// (design/p1-briefs.md). Today's SQL from core/rejection-dm.ts, moved
// verbatim. Every mutation after the lease checks the lease token, so an
// expired worker cannot overwrite a newer worker's state.
import type { RejectionOutboxRow } from "../../core/rejection-dm";
import type { OutboxContentRow, OutboxStore } from "../port";

export function d1OutboxStore(db: D1Database): OutboxStore {
  return {
    async due(nowIso, limit) {
      const candidates = await db.prepare(
        `SELECT delivery_key, event_seq, review_version, decision, kind, submission_id, layout_id, recipient_id, nonce,
            status, attempts, next_attempt_at, lease_token, lease_until, ambiguous_message_attempt_at
       FROM discord_rejection_dm_outbox
      WHERE (status = 'pending' AND next_attempt_at <= ?)
         OR (status = 'leased' AND lease_until <= ?)
      ORDER BY next_attempt_at, event_seq LIMIT ?`,
      ).bind(nowIso, nowIso, limit).all<RejectionOutboxRow>();
      return candidates.results ?? [];
    },

    async lease(deliveryKey, token, until, at) {
      const claim = await db.prepare(
        `UPDATE discord_rejection_dm_outbox
          SET status = 'leased', lease_token = ?, lease_until = ?, attempts = attempts + 1, updated_at = ?
        WHERE delivery_key = ? AND ((status = 'pending' AND next_attempt_at <= ?) OR (status = 'leased' AND lease_until <= ?))`,
      ).bind(token, until, at, deliveryKey, at, at).run();
      return claim.meta.changes === 1;
    },

    async content(row): Promise<OutboxContentRow | null> {
      if (row.decision === "approval" && row.kind === "link") return null;
      const source = row.kind === "comment" ? "layout_comments" : row.kind === "link" ? "link_submissions" : "wpm_submissions";
      const recipient = row.kind === "link" ? "submitted_by" : "user_id";
      const cycleEligibility = row.kind === "link" ? "" : " AND s.review_version = ?";
      const bodyEligibility = row.kind === "comment" ? " AND s.body IS NOT NULL" : "";
      return db.prepare(
        `SELECT s.${recipient} AS recipient_id, s.reason, l.name AS layout_name, l.deleted,
            ${row.kind === "comment" ? "s.body" : "NULL"} AS comment_body,
            ${row.kind === "wpm" ? "s.wpm" : "NULL"} AS wpm, ${row.kind === "wpm" ? "s.proof" : "NULL"} AS proof, ${row.kind === "link" ? "s.url" : "NULL"} AS link_url,
            s.status = '${row.decision === "approval" ? "approved" : "rejected"}'${bodyEligibility}${cycleEligibility} AS eligible
       FROM ${source} s JOIN layouts l ON l.id = s.layout_id
      WHERE s.id = ? AND s.layout_id = ?`,
      ).bind(...(row.kind === "link" ? [] : [row.review_version]), row.submission_id, row.layout_id).first<OutboxContentRow>();
    },

    async beginMessage({ deliveryKey, token, at, channelId }) {
      const begin = await db.prepare(
        `UPDATE discord_rejection_dm_outbox
          SET ambiguous_message_attempt_at = COALESCE(ambiguous_message_attempt_at, ?), dm_channel_id = ?, updated_at = ?
        WHERE delivery_key = ? AND status = 'leased' AND lease_token = ? AND lease_until > ?`,
      ).bind(at, channelId, at, deliveryKey, token, at).run();
      return begin.meta.changes === 1;
    },

    async markSent({ deliveryKey, token, messageId, at }) {
      await db.prepare(
        `UPDATE discord_rejection_dm_outbox
            SET status = 'sent', discord_message_id = ?, sent_at = ?, updated_at = ?, lease_token = NULL, lease_until = NULL
          WHERE delivery_key = ? AND status = 'leased' AND lease_token = ?`,
      ).bind(messageId, at, at, deliveryKey, token).run();
    },

    async clearAmbiguous({ deliveryKey, token, at }) {
      await db.prepare(`UPDATE discord_rejection_dm_outbox SET ambiguous_message_attempt_at = NULL, updated_at = ?
        WHERE delivery_key = ? AND status = 'leased' AND lease_token = ?`).bind(at, deliveryKey, token).run();
    },

    async retry({ deliveryKey, token, at, nextAttemptAt, error }) {
      await db.prepare(
        `UPDATE discord_rejection_dm_outbox
        SET status = 'pending', next_attempt_at = ?, updated_at = ?, lease_token = NULL, lease_until = NULL, last_error_class = ?
      WHERE delivery_key = ? AND status = 'leased' AND lease_token = ?`,
      ).bind(nextAttemptAt, at, error, deliveryKey, token).run();
    },

    async deferAllPending(until, at) {
      await db.prepare("UPDATE discord_rejection_dm_outbox SET next_attempt_at = MAX(next_attempt_at, ?), updated_at = ? WHERE status = 'pending'")
        .bind(until, at).run();
    },

    async terminal({ deliveryKey, token, at, status, error }) {
      await db.prepare(
        `UPDATE discord_rejection_dm_outbox
        SET status = ?, updated_at = ?, lease_token = NULL, lease_until = NULL, last_error_class = ?
      WHERE delivery_key = ? AND status = 'leased' AND lease_token = ?`,
      ).bind(status, at, error, deliveryKey, token).run();
    },
  };
}
