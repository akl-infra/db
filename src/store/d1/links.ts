// D1 implementation of `LinkStore` (src/store/port.ts). Owner: P1 agent C
// (design/p1-briefs.md). Today's SQL from core/links.ts, moved verbatim.
import type { LinkQueueRow, LinkSubmissionRow } from "../../core/links";
import type { LinkStore } from "../port";
import { gatedEventStatement, gatedOutboxStatement } from "./sql";

// [LDB-MD11] The explicit column list (never `SELECT *`) keeps `notified_at`
// off every wire this row reaches.
const SUBMISSION_COLUMNS = "id, layout_id, url, submitted_by, submitted_at, status, decided_by, decided_at, reason";

export function d1LinkStore(db: D1Database): LinkStore {
  return {
    async pending(layoutId) {
      return db
        .prepare(`SELECT ${SUBMISSION_COLUMNS} FROM link_submissions WHERE layout_id = ? AND status = 'pending' ORDER BY submitted_at DESC LIMIT 1`)
        .bind(layoutId)
        .first<LinkSubmissionRow>();
    },
    async get(id) {
      return db.prepare(`SELECT ${SUBMISSION_COLUMNS} FROM link_submissions WHERE id = ?`).bind(id).first<LinkSubmissionRow>();
    },
    async submit(r) {
      if (r.supersedeId !== null) {
        await db
          .prepare("UPDATE link_submissions SET status = 'superseded', decided_by = ?, decided_at = ? WHERE id = ?")
          .bind(r.by, r.at, r.supersedeId)
          .run();
      }
      await db
        .prepare(
          `INSERT INTO link_submissions (id, layout_id, url, submitted_by, submitted_at, status, decided_by, decided_at, reason)
       VALUES (?, ?, ?, ?, ?, 'pending', NULL, NULL, NULL)`,
        )
        .bind(r.row.id, r.row.layout_id, r.row.url, r.row.submitted_by, r.row.submitted_at)
        .run();
    },
    async queue(status) {
      const cols = SUBMISSION_COLUMNS.split(", ")
        .map((c) => `s.${c}`)
        .join(", ");
      const { results } = await db
        .prepare(
          `SELECT ${cols}, l.name AS layout_name, a.name AS submitter_name
       FROM link_submissions s JOIN layouts l ON l.id = s.layout_id
       LEFT JOIN authors a ON a.user_id = s.submitted_by
       WHERE s.status = ? AND l.deleted = 0
       ORDER BY s.submitted_at ASC`,
        )
        .bind(status)
        .all<LinkQueueRow>();
      return results;
    },
    async reject(r) {
      const [claim, event] = await db.batch([
        db
          .prepare("UPDATE link_submissions SET status = 'rejected', decided_by = ?, decided_at = ?, reason = ? WHERE id = ? AND status = 'pending'")
          .bind(r.by, r.at, r.reason, r.id),
        gatedEventStatement(db, r.at, r.event),
        ...(r.outbox !== undefined ? [gatedOutboxStatement(db, r.outbox)] : []),
      ]);
      return { claimed: claim!.meta.changes === 1, eventAppended: event!.meta.changes === 1 };
    },
  };
}
