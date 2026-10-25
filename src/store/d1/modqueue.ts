// D1 implementation of `ModqueueStore` (src/store/port.ts). Owner: P1 agent D
// (design/p1-briefs.md). Today's SQL from core/modqueue.ts and
// core/modqueue-delivery.ts, moved verbatim.
import type { QueueKind } from "../../core/modqueue";
import { discordUserJoin, resolvedNameSql } from "./discord-users";
import type { CommentCandidateRow, LinkCandidateRow, ModqueueStore, NotificationDbRow, QueueSourceStatusRow, WpmCandidateRow } from "../port";

const STATUS_TABLE: Record<QueueKind, string> = { link: "link_submissions", wpm: "wpm_submissions", comment: "layout_comments" };
const ANNOUNCE_TABLE = { link: "link_submissions", wpm: "wpm_submissions" } as const;

// The table name is a constant of this module, never caller input.
function announceTable(kind: "link" | "wpm" | "comment"): "link_submissions" | "wpm_submissions" {
  if (kind === "comment") throw new Error("layout_comments has no notified_at: comments are never claimed for announcement");
  return ANNOUNCE_TABLE[kind];
}

export function d1ModqueueStore(db: D1Database): ModqueueStore {
  return {
    async sourceStatus(kind, id): Promise<QueueSourceStatusRow | null> {
      return db.prepare(`SELECT s.status, s.reason, s.${kind === "link" ? "submitted_by" : "user_id"} AS submitter_id, ${kind === "wpm" ? "s.source_message_url" : "NULL"} AS source_message_url, ${kind === 'link' ? '0' : 's.review_version'} AS review_version, a.name AS decider_name FROM ${STATUS_TABLE[kind]} s
    LEFT JOIN authors a ON a.user_id = s.decided_by WHERE s.id = ?`).bind(id)
        .first<QueueSourceStatusRow>();
    },
    async bumpFailedAttempts(kind, id) {
      await db.prepare("UPDATE modqueue_notifications SET failed_attempts = failed_attempts + 1 WHERE kind = ? AND submission_id = ?")
        .bind(kind, id).run();
    },
    async leaseNotification(kind, id, token, until, nowIso) {
      const lease = await db.prepare(`UPDATE modqueue_notifications SET reconcile_lease_token = ?, reconcile_lease_until = ?
    WHERE kind = ? AND submission_id = ? AND (reconcile_lease_token IS NULL OR reconcile_lease_until < ?)`)
        .bind(token, until, kind, id, nowIso).run();
      return (lease.meta.changes ?? 0) === 1;
    },
    async notification(kind, id): Promise<NotificationDbRow | null> {
      return db.prepare("SELECT message_id, shown_status, shown_review_version, shown_source_message_url, message_format, transport, channel_id FROM modqueue_notifications WHERE kind = ? AND submission_id = ?")
        .bind(kind, id).first<NotificationDbRow>();
    },
    async deleteNotification(kind, id) {
      await db.prepare("DELETE FROM modqueue_notifications WHERE kind = ? AND submission_id = ?").bind(kind, id).run();
    },
    async markShown(r) {
      await db.prepare("UPDATE modqueue_notifications SET shown_status = ?, shown_review_version = ?, shown_source_message_url = ?, failed_attempts = 0 WHERE kind = ? AND submission_id = ? AND reconcile_lease_token = ?")
        .bind(r.status, r.reviewVersion, r.sourceMessageUrl, r.kind, r.id, r.leaseToken).run();
    },
    async releaseNotificationLease(kind, id, leaseToken) {
      await db.prepare("UPDATE modqueue_notifications SET reconcile_lease_token = NULL, reconcile_lease_until = NULL WHERE kind = ? AND submission_id = ? AND reconcile_lease_token = ?")
        .bind(kind, id, leaseToken).run();
    },
    async insertNotification(r) {
      await db.prepare(`INSERT INTO modqueue_notifications (kind, submission_id, message_id, shown_status, message_format, transport, channel_id, shown_review_version, shown_source_message_url)
      VALUES (?, ?, ?, 'pending', ?, ?, ?, ?, ?) ON CONFLICT(kind, submission_id) DO NOTHING`)
        .bind(r.kind, r.id, r.messageId, r.format, r.transport, r.channelId, r.reviewVersion, r.sourceMessageUrl).run();
    },
    async staleNotifications(limit) {
      const candidates = await db.prepare(`SELECT n.kind, n.submission_id, n.failed_attempts FROM modqueue_notifications n
    JOIN link_submissions s ON n.kind = 'link' AND s.id = n.submission_id WHERE n.shown_status != s.status OR n.shown_review_version != 0
    UNION ALL SELECT n.kind, n.submission_id, n.failed_attempts FROM modqueue_notifications n
    JOIN wpm_submissions s ON n.kind = 'wpm' AND s.id = n.submission_id WHERE n.shown_status != s.status OR n.shown_review_version != s.review_version OR n.shown_source_message_url IS NOT s.source_message_url
    UNION ALL SELECT n.kind, n.submission_id, n.failed_attempts FROM modqueue_notifications n
    JOIN layout_comments s ON n.kind = 'comment' AND s.id = n.submission_id WHERE n.shown_status != s.status OR n.shown_review_version != s.review_version
    ORDER BY failed_attempts ASC LIMIT ?`).bind(limit).all<{ kind: QueueKind; submission_id: string }>();
      return candidates.results;
    },
    async linkCandidates(limit): Promise<LinkCandidateRow[]> {
      const { results } = await db.prepare(`SELECT s.id AS id, s.layout_id AS layout_id, s.url AS url, s.submitted_by AS submitted_by,
                l.name AS layout_name, a.name AS submitter_name
         FROM link_submissions s
         JOIN layouts l ON l.id = s.layout_id
         LEFT JOIN authors a ON a.user_id = s.submitted_by
         WHERE s.status = 'pending' AND s.notified_at IS NULL
         ORDER BY s.submitted_at ASC
         LIMIT ?`).bind(limit).all<LinkCandidateRow>();
      return results;
    },
    async wpmCandidates(limit): Promise<WpmCandidateRow[]> {
      const { results } = await db.prepare(`SELECT s.id AS id, s.review_version, s.source_message_url, s.layout_id AS layout_id, s.user_id AS user_id, s.wpm AS wpm, s.proof AS proof,
                l.name AS layout_name, ${resolvedNameSql("a.name", "s.user_id")} AS user_name
         FROM wpm_submissions s
         JOIN layouts l ON l.id = s.layout_id
         LEFT JOIN authors a ON a.user_id = s.user_id
         ${discordUserJoin("s.user_id")}
         WHERE s.status = 'pending' AND s.notified_at IS NULL
         ORDER BY s.submitted_at ASC
         LIMIT ?`).bind(limit).all<WpmCandidateRow>();
      return results;
    },
    async commentCandidate(id): Promise<CommentCandidateRow | null> {
      return db
        .prepare(
          `SELECT s.id AS id, s.review_version, s.layout_id AS layout_id, s.user_id AS user_id, s.body AS body,
                l.name AS layout_name, l.owner AS layout_owner, a.name AS user_name,
                EXISTS (SELECT 1 FROM layout_comments b WHERE b.layout_id = s.layout_id AND b.user_id = s.user_id AND b.status = 'approved') AS has_live
                , (SELECT b.body FROM layout_comments b WHERE b.layout_id = s.layout_id AND b.user_id = s.user_id AND b.status = 'approved' AND b.body IS NOT NULL ORDER BY b.decided_at DESC LIMIT 1) AS live_body
         FROM layout_comments s
         JOIN layouts l ON l.id = s.layout_id
         LEFT JOIN authors a ON a.user_id = s.user_id
         WHERE s.id = ? AND s.status = 'pending' AND s.body IS NOT NULL`,
        )
        .bind(id)
        .first<CommentCandidateRow>();
    },
    async claimAnnounce(kind, id, at) {
      const res = await db
        .prepare(`UPDATE ${announceTable(kind)} SET notified_at = ? WHERE id = ? AND notified_at IS NULL AND status = 'pending'`)
        .bind(at, id)
        .run();
      return res.meta.changes === 1;
    },
    async releaseAnnounce(kind, id, claimedAt) {
      await db.prepare(`UPDATE ${announceTable(kind)} SET notified_at = NULL WHERE id = ? AND notified_at = ?`).bind(id, claimedAt).run();
    },
    async claimDeliveryGate(token, untilMs, nowMs) {
      const claim = await db.prepare(`UPDATE modqueue_delivery_gate SET lease_token = ?, lease_until = ?
    WHERE id = 1 AND retry_at <= ? AND (lease_token IS NULL OR lease_until <= ?)`)
        .bind(token, untilMs, nowMs, nowMs).run();
      return claim.meta.changes === 1;
    },
    async deferDeliveryGate(token, retryAtMs) {
      await db.prepare("UPDATE modqueue_delivery_gate SET retry_at = MAX(retry_at, ?) WHERE id = 1 AND lease_token = ?")
        .bind(retryAtMs, token).run();
    },
    async releaseDeliveryGate(token) {
      await db.prepare("UPDATE modqueue_delivery_gate SET lease_token = NULL, lease_until = 0 WHERE id = 1 AND lease_token = ?").bind(token).run();
    },
  };
}
