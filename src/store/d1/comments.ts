// D1 implementation of `CommentStore` (src/store/port.ts). Owner: P1 agent C
// (design/p1-briefs.md). Today's SQL from core/comments.ts, moved verbatim.
import type { CommentQueueRow, CommentRow, PublicCommentCount } from "../../core/comments";
import type { CommentStore, PublicCommentDbRow } from "../port";
import { gatedEventStatement, gatedHistoryStatement, gatedOutboxStatement } from "./sql";

// [LDB-CMT9] The explicit column list (never `SELECT *`) keeps `notified_at`
// off every wire these rows reach.
const COMMENT_COLUMNS = "id, layout_id, user_id, body, via, submitted_at, status, decided_by, decided_at, reason, review_version";

// [LDB-CMT11] A slot's likes are cleared on the author's delete or a mod's
// removal. Conditional on that, so a statement that follows a decision which
// did not happen (a lost race) clears nothing.
function clearLikesOfEmptySlot(db: D1Database, layoutId: string, authorId: string, requireWinningClaim = false): D1PreparedStatement {
  return db
    .prepare(
      `DELETE FROM comment_likes WHERE layout_id = ? AND author_id = ?
       ${requireWinningClaim ? "AND changes() = 1" : ""}
       AND NOT EXISTS (SELECT 1 FROM layout_comments WHERE layout_id = ? AND user_id = ? AND status = 'approved')`,
    )
    .bind(layoutId, authorId, layoutId, authorId);
}

export function d1CommentStore(db: D1Database): CommentStore {
  return {
    async get(id) {
      return db.prepare(`SELECT ${COMMENT_COLUMNS} FROM layout_comments WHERE id = ?`).bind(id).first<CommentRow>();
    },
    async submit(r) {
      const supersede = db
        .prepare("UPDATE layout_comments SET status = 'superseded', decided_by = ?, decided_at = ? WHERE layout_id = ? AND user_id = ? AND status = 'pending'")
        .bind(r.by, r.at, r.row.layout_id, r.by);
      await db.batch([
        supersede,
        db
          .prepare(
            `INSERT INTO layout_comments (id, layout_id, user_id, body, via, submitted_at, status, decided_by, decided_at, reason)
         VALUES (?, ?, ?, ?, ?, ?, 'pending', NULL, NULL, NULL)`,
          )
          .bind(r.row.id, r.row.layout_id, r.row.user_id, r.row.body, r.row.via, r.row.submitted_at),
      ]);
    },
    async hasBody(layoutId, userId) {
      const live = await db
        .prepare("SELECT 1 AS one FROM layout_comments WHERE layout_id = ? AND user_id = ? AND body IS NOT NULL LIMIT 1")
        .bind(layoutId, userId)
        .first();
      return live !== null;
    },
    async deleteOwn(r) {
      await db.batch([
        db
          .prepare(
            `UPDATE layout_comments
         SET body = NULL, status = 'deleted', decided_by = ?, decided_at = ?
         WHERE layout_id = ? AND user_id = ? AND status IN ('approved', 'pending')`,
          )
          .bind(r.userId, r.at, r.layoutId, r.userId),
        db.prepare("UPDATE layout_comments SET body = NULL WHERE layout_id = ? AND user_id = ? AND body IS NOT NULL").bind(r.layoutId, r.userId),
        clearLikesOfEmptySlot(db, r.layoutId, r.userId),
      ]);
    },
    async queue(status) {
      const cols = COMMENT_COLUMNS.split(", ")
        .map((c) => `s.${c}`)
        .join(", ");
      const { results } = await db
        .prepare(
          `SELECT ${cols}, l.name AS layout_name, a.name AS user_name,
              (SELECT b.body FROM layout_comments b
               WHERE b.layout_id = s.layout_id AND b.user_id = s.user_id AND b.status = 'approved' AND b.id != s.id
               ORDER BY b.decided_at DESC, b.id ASC LIMIT 1) AS live_body
       FROM layout_comments s
       JOIN layouts l ON l.id = s.layout_id
       LEFT JOIN authors a ON a.user_id = s.user_id
       WHERE s.status = ? AND l.deleted = 0
       ORDER BY s.submitted_at ASC, s.id ASC`,
        )
        .bind(status)
        .all<CommentQueueRow>();
      return results;
    },
    async approve(r) {
      const results = await db.batch([
        db
          .prepare(`UPDATE layout_comments SET status = 'replaced', body = NULL, decided_by = ?, decided_at = ?
      WHERE layout_id = ? AND user_id = ? AND status = 'approved' AND id != ?
        AND EXISTS (SELECT 1 FROM layout_comments WHERE id = ? AND status = 'pending' AND review_version = ? AND body IS NOT NULL)
        AND EXISTS (SELECT 1 FROM layouts WHERE id = ? AND deleted = 0)`)
          .bind(r.by, r.at, r.layoutId, r.userId, r.id, r.id, r.reviewVersion, r.layoutId),
        db
          .prepare(`UPDATE layout_comments SET status = 'approved', decided_by = ?, decided_at = ?, reason = NULL
      WHERE id = ? AND status = 'pending' AND review_version = ? AND body IS NOT NULL
        AND EXISTS (SELECT 1 FROM layouts WHERE id = layout_comments.layout_id AND deleted = 0)`)
          .bind(r.by, r.at, r.id, r.reviewVersion),
        gatedEventStatement(db, r.at, r.event),
        ...(r.outbox !== undefined ? [gatedOutboxStatement(db, r.outbox)] : []),
        gatedHistoryStatement(db, r.history),
      ]);
      return { claimed: results[1]!.meta.changes === 1, eventAppended: results[2]!.meta.changes === 1 };
    },
    async reject(r) {
      const [claim, event] = await db.batch([
        db
          .prepare(`UPDATE layout_comments SET status = 'rejected', decided_by = ?, decided_at = ?, reason = ?
      WHERE id = ? AND status = 'pending' AND review_version = ? AND body IS NOT NULL`)
          .bind(r.by, r.at, r.reason, r.id, r.reviewVersion),
        gatedEventStatement(db, r.at, r.event),
        ...(r.outbox !== undefined ? [gatedOutboxStatement(db, r.outbox)] : []),
        gatedHistoryStatement(db, r.history),
      ]);
      return { claimed: claim!.meta.changes === 1, eventAppended: event!.meta.changes === 1 };
    },
    async remove(r) {
      const [res] = await db.batch([
        db
          .prepare("UPDATE layout_comments SET status = 'removed', decided_by = ?, decided_at = ?, reason = ? WHERE id = ? AND status = 'approved' AND review_version = ?")
          .bind(r.by, r.at, r.reason, r.id, r.reviewVersion),
        clearLikesOfEmptySlot(db, r.layoutId, r.userId, true),
      ]);
      return { claimed: res!.meta.changes === 1 };
    },
    async counts() {
      const { results } = await db
        .prepare(
          `SELECT l.id AS layout_id, l.name AS layout_name, COUNT(*) AS count
       FROM layouts l
       JOIN layout_comments c ON c.layout_id = l.id
       WHERE l.deleted = 0 AND c.status = 'approved' AND c.body IS NOT NULL
       GROUP BY l.id, l.name
       ORDER BY l.name COLLATE NOCASE ASC, l.id ASC`,
        )
        .all<PublicCommentCount>();
      return results;
    },
    async list(r) {
      const { results } = await db
        .prepare(
          `SELECT c.id AS id, c.user_id AS user_id, a.name AS name, c.body AS body, c.decided_at AS approved_at,
              EXISTS (
                SELECT 1 FROM layout_comments r
                WHERE r.layout_id = c.layout_id AND r.user_id = c.user_id AND r.status = 'replaced'
                  AND r.decided_at > COALESCE(
                    (SELECT MAX(d.decided_at) FROM layout_comments d
                     WHERE d.layout_id = c.layout_id AND d.user_id = c.user_id AND d.status IN ('deleted', 'removed')),
                    '')
              ) AS edited,
              (SELECT COUNT(*) FROM comment_likes k WHERE k.layout_id = c.layout_id AND k.author_id = c.user_id) AS likes,
              EXISTS (SELECT 1 FROM comment_likes k WHERE k.layout_id = c.layout_id AND k.author_id = c.user_id AND k.user_id = ?) AS liked,
              (c.user_id = ?) AS is_author
       FROM layout_comments c
       LEFT JOIN authors a ON a.user_id = c.user_id
       WHERE c.layout_id = ? AND c.status = 'approved' AND c.body IS NOT NULL
       ORDER BY is_author DESC, ${r.sort === "newest" ? "" : "likes DESC, "}c.decided_at DESC, c.id ASC`,
        )
        .bind(r.viewer, r.owner, r.layoutId)
        .all<PublicCommentDbRow>();
      return results;
    },
    async like(r) {
      const res = await db
        .prepare(
          `INSERT INTO comment_likes (layout_id, author_id, user_id, via, created_at)
       SELECT ?, ?, ?, ?, ?
       WHERE EXISTS (SELECT 1 FROM layout_comments WHERE layout_id = ? AND user_id = ? AND status = 'approved' AND body IS NOT NULL)
       ON CONFLICT (layout_id, author_id, user_id) DO NOTHING`,
        )
        .bind(r.layoutId, r.authorId, r.userId, r.via, r.at, r.layoutId, r.authorId)
        .run();
      return res.meta.changes === 1;
    },
    async approvedSlotExists(layoutId, authorId) {
      const slot = await db
        .prepare("SELECT 1 AS one FROM layout_comments WHERE layout_id = ? AND user_id = ? AND status = 'approved' AND body IS NOT NULL LIMIT 1")
        .bind(layoutId, authorId)
        .first();
      return slot !== null;
    },
    async unlike(layoutId, authorId, userId) {
      const res = await db.prepare("DELETE FROM comment_likes WHERE layout_id = ? AND author_id = ? AND user_id = ?").bind(layoutId, authorId, userId).run();
      return res.meta.changes === 1;
    },
    async pairRows(layoutId, userId) {
      const { results } = await db
        .prepare(`SELECT ${COMMENT_COLUMNS} FROM layout_comments WHERE layout_id = ? AND user_id = ? ORDER BY submitted_at ASC, id ASC`)
        .bind(layoutId, userId)
        .all<CommentRow>();
      return results;
    },
    async mine(userId) {
      const cols = COMMENT_COLUMNS.split(", ").map((c) => `s.${c}`).join(", ");
      const { results } = await db
        .prepare(
          `SELECT ${cols}, l.name AS layout_name, l.owner AS layout_owner
       FROM layout_comments s
       JOIN layouts l ON l.id = s.layout_id AND l.deleted = 0
       WHERE s.user_id = ?
       ORDER BY s.layout_id ASC, s.submitted_at ASC, s.id ASC`,
        )
        .bind(userId)
        .all<CommentRow & { layout_name: string; layout_owner: string }>();
      const likeCounts = await db
        .prepare("SELECT layout_id, COUNT(*) AS n FROM comment_likes WHERE author_id = ? GROUP BY layout_id")
        .bind(userId)
        .all<{ layout_id: string; n: number }>();
      return { rows: results, likeCounts: new Map(likeCounts.results.map((r) => [r.layout_id, r.n])) };
    },
  };
}
