// D1 implementation of `WpmStore` (src/store/port.ts). Owner: P1 agent C
// (design/p1-briefs.md). Today's SQL from core/wpm.ts, moved verbatim.
import type { WpmQueueRow, WpmRecord, WpmSubmissionRow } from "../../core/wpm";
import type { WpmStore } from "../port";
import { gatedEventStatement, gatedHistoryStatement, gatedOutboxStatement } from "./sql";

// [LDB-WPM9] The explicit column list (never `SELECT *`) keeps `notified_at`
// off every wire these rows reach.
const SUBMISSION_COLUMNS = "id, layout_id, user_id, wpm, proof, submitted_by, via, submitted_at, status, decided_by, decided_at, reason, review_version";

export function d1WpmStore(db: D1Database): WpmStore {
  return {
    async get(id) {
      return db.prepare(`SELECT ${SUBMISSION_COLUMNS} FROM wpm_submissions WHERE id = ?`).bind(id).first<WpmSubmissionRow>();
    },
    async bindSourceMessage(r) {
      const result = await db
        .prepare(`UPDATE wpm_submissions SET source_message_url = ?
    WHERE id = ? AND (submitted_by = ? OR ? = 1) AND source_message_url IS NULL`)
        .bind(r.url, r.id, r.actorId, r.admin ? 1 : 0)
        .run();
      return result.meta.changes === 1;
    },
    async sourceMessage(r) {
      return db
        .prepare(`SELECT source_message_url FROM wpm_submissions
    WHERE id = ? AND (submitted_by = ? OR ? = 1)`)
        .bind(r.id, r.actorId, r.admin ? 1 : 0)
        .first<{ source_message_url: string | null }>();
    },
    async insertApproved(r) {
      const row = r.row;
      await db.batch([
        db
          .prepare(`INSERT INTO wpm_submissions (id, layout_id, user_id, wpm, proof, submitted_by, via, submitted_at, status, decided_by, decided_at, reason)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'approved', ?, ?, NULL)`)
          .bind(row.id, row.layout_id, row.user_id, row.wpm, row.proof, row.submitted_by, row.via, row.submitted_at, row.decided_by, row.decided_at),
        gatedEventStatement(db, r.history.at, r.event),
        gatedHistoryStatement(db, r.history),
      ]);
    },
    async submit(r) {
      const row = r.row;
      await db.batch([
        db
          .prepare("UPDATE wpm_submissions SET status = 'superseded', decided_by = ?, decided_at = ? WHERE layout_id = ? AND user_id = ? AND status = 'pending'")
          .bind(r.by, r.at, row.layout_id, row.user_id),
        db
          .prepare(
            `INSERT INTO wpm_submissions (id, layout_id, user_id, wpm, proof, submitted_by, via, submitted_at, status, decided_by, decided_at, reason)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', NULL, NULL, NULL)`,
          )
          .bind(row.id, row.layout_id, row.user_id, row.wpm, row.proof, row.submitted_by, row.via, row.submitted_at),
      ]);
    },
    async queue(status) {
      const cols = SUBMISSION_COLUMNS.split(", ")
        .map((c) => `s.${c}`)
        .join(", ");
      const { results } = await db
        .prepare(
          `SELECT ${cols}, l.name AS layout_name, a.name AS user_name
       FROM wpm_submissions s
       JOIN layouts l ON l.id = s.layout_id
       LEFT JOIN authors a ON a.user_id = s.user_id
       WHERE s.status = ? AND l.deleted = 0
       ORDER BY s.submitted_at ASC, s.id ASC`,
        )
        .bind(status)
        .all<WpmQueueRow>();
      return results;
    },
    async approve(r) {
      const results = await db.batch([
        db
          .prepare(`UPDATE wpm_submissions SET status = 'approved', decided_by = ?, decided_at = ?, reason = NULL
      WHERE id = ? AND status = 'pending' AND review_version = ?
        AND EXISTS (SELECT 1 FROM layouts WHERE id = wpm_submissions.layout_id AND deleted = 0)`)
          .bind(r.by, r.at, r.id, r.reviewVersion),
        gatedEventStatement(db, r.at, r.event),
        ...(r.outbox !== undefined ? [gatedOutboxStatement(db, r.outbox)] : []),
        gatedHistoryStatement(db, r.history),
      ]);
      return { claimed: results[0]!.meta.changes === 1, eventAppended: results[1]!.meta.changes === 1 };
    },
    async reject(r) {
      const [claim, event] = await db.batch([
        db
          .prepare(`UPDATE wpm_submissions SET status = 'rejected', decided_by = ?, decided_at = ?, reason = ?
      WHERE id = ? AND status = 'pending' AND review_version = ? `)
          .bind(r.by, r.at, r.reason, r.id, r.reviewVersion),
        gatedEventStatement(db, r.at, r.event),
        ...(r.outbox !== undefined ? [gatedOutboxStatement(db, r.outbox)] : []),
        gatedHistoryStatement(db, r.history),
      ]);
      return { claimed: claim!.meta.changes === 1, eventAppended: event!.meta.changes === 1 };
    },
    async records(filter) {
      const where: string[] = [];
      const params: string[] = [];
      if (filter.layoutId !== undefined) {
        where.push("AND s.layout_id = ?");
        params.push(filter.layoutId);
      }
      if (filter.userId !== undefined) {
        where.push("AND s.user_id = ?");
        params.push(filter.userId);
      }
      const { results } = await db
        .prepare(
          `SELECT s.layout_id AS layout_id, l.name AS layout_name, s.user_id AS user_id, a.name AS user_name,
              s.wpm AS wpm, s.proof AS proof, s.decided_at AS approved_at, s.id AS submission_id
       FROM wpm_submissions s
       JOIN layouts l ON l.id = s.layout_id AND l.deleted = 0
       LEFT JOIN authors a ON a.user_id = s.user_id
       WHERE s.status = 'approved' ${where.join(" ")}
         AND NOT EXISTS (
           SELECT 1 FROM wpm_submissions b
           WHERE b.layout_id = s.layout_id AND b.user_id = s.user_id AND b.status = 'approved'
             AND (b.wpm > s.wpm
                  OR (b.wpm = s.wpm AND (b.decided_at < s.decided_at OR (b.decided_at = s.decided_at AND b.id < s.id))))
         )
       ORDER BY s.wpm DESC, s.decided_at ASC, s.id ASC`,
        )
        .bind(...params)
        .all<WpmRecord>();
      return results;
    },
  };
}
