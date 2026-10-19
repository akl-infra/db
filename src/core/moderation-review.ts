// [LDB-MD20] Review cycles are append-only moderation history. D1 batch()
// keeps each winning transition, its public event and private history atomic.
import type { Actor } from "../auth/actor";
import type { Bindings } from "../env";
import { notFound, reviewConflict } from "./errors";
import { rejectionModerationStatement } from "./events";
import type { Clock } from "./time";

export type ReviewKind = "comment" | "wpm";
export interface ReviewExpectation { status: "approved" | "rejected"; review_version: number }
export interface ReviewHistoryRow {
  action: "approved" | "rejected" | "reopened";
  actor: string;
  at: string;
  reason: string | null;
  review_version: number;
}
const tableFor = (kind: ReviewKind) => kind === "comment" ? "layout_comments" : "wpm_submissions";

// Immediately follows a conditional event (or its conditional outbox insert).
export function reviewHistoryStatement(db: Bindings["DB"], kind: ReviewKind, id: string, action: ReviewHistoryRow["action"], actor: string, at: string, reason: string | null, reviewVersion: number): D1PreparedStatement {
  return db.prepare(`INSERT INTO moderation_review_history (kind, submission_id, action, actor, at, reason, review_version)
    SELECT ?, ?, ?, ?, ?, ?, ? WHERE changes() = 1`).bind(kind, id, action, actor, at, reason, reviewVersion);
}

export async function readReviewHistory(db: Bindings["DB"], kind: ReviewKind, id: string): Promise<ReviewHistoryRow[]> {
  const row = await db.prepare(`SELECT status, decided_by, decided_at, reason, review_version FROM ${tableFor(kind)} WHERE id = ?`)
    .bind(id).first<{ status: string; decided_by: string | null; decided_at: string | null; reason: string | null; review_version: number }>();
  if (row === null) throw notFound(`no ${kind} submission '${id}'`, id);
  const { results } = await db.prepare(`SELECT action, actor, at, reason, review_version FROM moderation_review_history
    WHERE kind = ? AND submission_id = ? ORDER BY id`).bind(kind, id).all<ReviewHistoryRow>();
  // Existing decisions (and public snapshot restores) predate private history.
  if ((row.status === "approved" || row.status === "rejected") && row.decided_by !== null && row.decided_at !== null
    && !results.some((h) => h.review_version === row.review_version && h.action === row.status)) {
    results.push({ action: row.status, actor: row.decided_by, at: row.decided_at, reason: row.reason, review_version: row.review_version });
  }
  return results;
}

export async function reopenReview(db: Bindings["DB"], now: Clock, actor: Actor, version: string | null, kind: ReviewKind, id: string, expected: ReviewExpectation): Promise<void> {
  const table = tableFor(kind);
  const submission = await db.prepare(`SELECT layout_id FROM ${table} WHERE id = ?`).bind(id).first<{ layout_id: string }>();
  if (submission === null) throw notFound(`no ${kind} submission '${id}'`, id);
  const at = now();
  const eligible = `id = ? AND status = ? AND review_version = ?
    ${kind === "comment" ? "AND body IS NOT NULL" : ""}
    AND EXISTS (SELECT 1 FROM layouts WHERE id = ${table}.layout_id AND deleted = 0)
    AND NOT EXISTS (SELECT 1 FROM ${table} newer WHERE newer.layout_id = ${table}.layout_id AND newer.user_id = ${table}.user_id
      AND newer.id != ${table}.id AND (newer.status = 'pending' OR newer.submitted_at > ${table}.submitted_at
        OR (newer.submitted_at = ${table}.submitted_at AND newer.id > ${table}.id)))`;
  const [, claim, event] = await db.batch([
    // Save an older decision's private reason before clearing the current row.
    db.prepare(`INSERT OR IGNORE INTO moderation_review_history (kind, submission_id, action, actor, at, reason, review_version)
      SELECT ?, id, status, decided_by, decided_at, reason, review_version FROM ${table}
      WHERE ${eligible} AND decided_by IS NOT NULL AND decided_at IS NOT NULL`).bind(kind, id, expected.status, expected.review_version),
    db.prepare(`UPDATE ${table} SET status = 'pending', review_version = review_version + 1,
      decided_by = NULL, decided_at = NULL, reason = NULL WHERE ${eligible}`).bind(id, expected.status, expected.review_version),
    rejectionModerationStatement(db, at, { kind: kind === "comment" ? "comment_reopened" : "wpm_reopened", layoutId: submission.layout_id,
      actor: actor.user_id, via: actor.via, source: { client: actor.source_client, version }, detail: { submission_id: id } }),
    reviewHistoryStatement(db, kind, id, "reopened", actor.user_id, at, null, expected.review_version + 1),
    db.prepare(`UPDATE discord_rejection_dm_outbox SET status = 'expired', lease_token = NULL, lease_until = NULL,
      updated_at = ?, last_error_class = 'review_reopened'
      WHERE kind = ? AND submission_id = ? AND status IN ('pending', 'leased') AND changes() = 1`).bind(at, kind, id),
  ]);
  if (claim!.meta.changes !== 1 || event!.meta.changes !== 1) throw reviewConflict(id);
}
