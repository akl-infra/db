// Statement builders shared by several D1 area files (frozen with the port).
// They are copies of today's builders, so every area moves its batches here
// without reaching into another agent's files: the claim-gated moderation
// event (formerly core/events.ts rejectionModerationStatement), the claim-gated DM
// outbox row (formerly core/rejection-dm.ts decisionOutboxStatement) and the
// claim-gated review-history row (core/moderation-review.ts
// reviewHistoryStatement). Each one inserts only when the statement right
// before it in the batch changed exactly one row (`changes() = 1`).
import { canonical } from "../../core/canonical";
import type { GatedEvent, HistoryIntent, OutboxIntent } from "../port";

export function gatedEventStatement(db: D1Database, at: string, m: GatedEvent): D1PreparedStatement {
  return db
    .prepare(
      `INSERT INTO events (at, kind, layout_id, name, owner, format, rev, actor, via, admin, detail_json, before_json, after_json, source_client, source_version)
       SELECT ?, ?, ?, (SELECT name FROM layouts WHERE id = ?), (SELECT owner FROM layouts WHERE id = ?),
              NULL, NULL, ?, ?, 1, ?, NULL, ?, ?, ?
       WHERE changes() = 1`,
    )
    .bind(
      at,
      m.kind,
      m.layoutId,
      m.layoutId,
      m.layoutId,
      m.actor,
      m.via,
      m.detail === undefined ? null : canonical(m.detail),
      m.after === undefined ? null : canonical(m.after),
      m.source.client,
      m.source.version,
    );
}

export function gatedOutboxStatement(db: D1Database, o: OutboxIntent): D1PreparedStatement {
  return db
    .prepare(
      `INSERT INTO discord_rejection_dm_outbox
        (delivery_key, event_seq, kind, submission_id, layout_id, recipient_id, nonce, status,
         attempts, next_attempt_at, created_at, updated_at, review_version, decision)
       SELECT ?, last_insert_rowid(), ?, ?, ?, ?, ?, 'pending', 0, ?, ?, ?, ?, ?
       WHERE changes() = 1`,
    )
    .bind(o.deliveryKey, o.kind, o.submissionId, o.layoutId, o.recipientId, o.nonce, o.at, o.at, o.at, o.reviewVersion, o.decision);
}

export function gatedHistoryStatement(db: D1Database, h: HistoryIntent): D1PreparedStatement {
  return db
    .prepare(
      `INSERT INTO moderation_review_history (kind, submission_id, action, actor, at, reason, review_version)
    SELECT ?, ?, ?, ?, ?, ?, ? WHERE changes() = 1`,
    )
    .bind(h.kind, h.submissionId, h.action, h.actor, h.at, h.reason, h.reviewVersion);
}
