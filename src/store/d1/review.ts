// D1 implementation of `ReviewStore` (src/store/port.ts). Owner: P1 agent C
// (design/p1-briefs.md). Today's SQL from core/moderation-review.ts and
// core/discord-interactions.ts, moved verbatim.
import type { ReviewHistoryRow, ReviewKind } from "../../core/moderation-review";
import type { QueueKind } from "../../core/modqueue";
import type { ReviewStore } from "../port";
import { gatedEventStatement, gatedHistoryStatement } from "./sql";

const tableFor = (kind: ReviewKind) => (kind === "comment" ? "layout_comments" : "wpm_submissions");

export function d1ReviewStore(db: D1Database): ReviewStore {
  return {
    async decisionState(kind, id) {
      return db
        .prepare(`SELECT status, decided_by, decided_at, reason, review_version FROM ${tableFor(kind)} WHERE id = ?`)
        .bind(id)
        .first<{ status: string; decided_by: string | null; decided_at: string | null; reason: string | null; review_version: number }>();
    },
    async history(kind, id) {
      const { results } = await db
        .prepare(`SELECT action, actor, at, reason, review_version FROM moderation_review_history
    WHERE kind = ? AND submission_id = ? ORDER BY id`)
        .bind(kind, id)
        .all<ReviewHistoryRow>();
      return results;
    },
    async submissionLayout(kind, id) {
      const row = await db.prepare(`SELECT layout_id FROM ${tableFor(kind)} WHERE id = ?`).bind(id).first<{ layout_id: string }>();
      return row === null ? null : row.layout_id;
    },
    async reopen(r) {
      const { kind, id, expected, at } = r;
      const table = tableFor(kind);
      const eligible = `id = ? AND status = ? AND review_version = ?
    ${kind === "comment" ? "AND body IS NOT NULL" : ""}
    AND EXISTS (SELECT 1 FROM layouts WHERE id = ${table}.layout_id AND deleted = 0)
    AND NOT EXISTS (SELECT 1 FROM ${table} newer WHERE newer.layout_id = ${table}.layout_id AND newer.user_id = ${table}.user_id
      AND newer.id != ${table}.id AND (newer.status = 'pending' OR newer.submitted_at > ${table}.submitted_at
        OR (newer.submitted_at = ${table}.submitted_at AND newer.id > ${table}.id)))`;
      const [, claim, event] = await db.batch([
        // Save an older decision's private reason before clearing the current row.
        db
          .prepare(`INSERT OR IGNORE INTO moderation_review_history (kind, submission_id, action, actor, at, reason, review_version)
      SELECT ?, id, status, decided_by, decided_at, reason, review_version FROM ${table}
      WHERE ${eligible} AND decided_by IS NOT NULL AND decided_at IS NOT NULL`)
          .bind(kind, id, expected.status, expected.review_version),
        db
          .prepare(`UPDATE ${table} SET status = 'pending', review_version = review_version + 1,
      decided_by = NULL, decided_at = NULL, reason = NULL WHERE ${eligible}`)
          .bind(id, expected.status, expected.review_version),
        gatedEventStatement(db, at, r.event),
        gatedHistoryStatement(db, r.history),
        db
          .prepare(`UPDATE discord_rejection_dm_outbox SET status = 'expired', lease_token = NULL, lease_until = NULL,
      updated_at = ?, last_error_class = 'review_reopened'
      WHERE kind = ? AND submission_id = ? AND status IN ('pending', 'leased') AND changes() = 1`)
          .bind(at, kind, id),
      ]);
      return { claimed: claim!.meta.changes === 1, eventAppended: event!.meta.changes === 1 };
    },
    async reopenRecorded(r) {
      return (
        (await db
          .prepare("SELECT 1 FROM moderation_review_history WHERE kind = ? AND submission_id = ? AND review_version = ? AND action = 'reopened' AND actor = ?")
          .bind(r.kind, r.id, r.reviewVersion, r.actor)
          .first()) !== null
      );
    },
    async submissionDecision(kind: QueueKind, id) {
      const table = kind === "link" ? "link_submissions" : kind === "wpm" ? "wpm_submissions" : "layout_comments";
      return db
        .prepare(`SELECT status, decided_by, ${kind === "link" ? "0" : "review_version"} AS review_version FROM ${table} WHERE id = ?`)
        .bind(id)
        .first<{ status: string; decided_by: string | null; review_version: number }>();
    },
  };
}
