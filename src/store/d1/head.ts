// D1 implementation of `HeadStore` (src/store/port.ts). Owner: P1 agent A
// (design/p1-briefs.md). Today's SQL from core/etag.ts (readHead, headSeq,
// authorsHead) and core/meta.ts (readMetaCore's three queries), moved verbatim.
import type { AuthorsHead, Head } from "../../core/etag";
import type { HeadStore } from "../port";

export function d1HeadStore(db: D1Database): HeadStore {
  return {
    async readHead(stateKeys: readonly string[] = [], deletesSinceIso?: string): Promise<Head> {
      const cols = [
        "(SELECT MAX(seq) FROM events) AS seq",
        "(SELECT version FROM authors_head WHERE id = 1) AS authors_version",
        "(SELECT modified_at FROM authors_head WHERE id = 1) AS authors_modified_at",
        ...stateKeys.map((_, i) => `(SELECT value FROM import_state WHERE key = ?${i + 1}) AS state_${i}`),
        ...(deletesSinceIso !== undefined
          ? [`(SELECT COUNT(*) FROM events WHERE kind = 'upstream_deleted' AND rev IS NOT NULL AND at >= ?${stateKeys.length + 1}) AS deletes_24h`]
          : []),
      ];
      const row = await db
        .prepare(`SELECT ${cols.join(", ")}`)
        .bind(...stateKeys, ...(deletesSinceIso !== undefined ? [deletesSinceIso] : []))
        .first<Record<string, string | number | null>>();
      return {
        seq: (row?.seq as number | null) ?? 0,
        authors: {
          version: (row?.authors_version as number | null) ?? 0,
          modifiedAt: (row?.authors_modified_at as string | null) ?? null,
        },
        state: stateKeys.map((_, i) => (row?.[`state_${i}`] as string | null | undefined) ?? null),
        deletes24h: deletesSinceIso !== undefined ? ((row?.deletes_24h as number | null) ?? 0) : 0,
      };
    },

    async headSeq() {
      const row = await db.prepare("SELECT MAX(seq) AS seq FROM events").first<{ seq: number | null }>();
      return row?.seq ?? 0;
    },

    async authorsHead(): Promise<AuthorsHead> {
      const row = await db
        .prepare("SELECT version, modified_at FROM authors_head WHERE id = 1")
        .first<{ version: number; modified_at: string | null }>();
      return { version: row?.version ?? 0, modifiedAt: row?.modified_at ?? null };
    },

    async metaCounts() {
      const [layoutRow, authorRow, eventRow] = await Promise.all([
        // `layouts_head.live` (migrations/0034) is the live-row count, kept by
        // triggers -- `COUNT(*)` here scanned every live row on each call.
        db
          .prepare(
            "SELECT (SELECT live FROM layouts_head WHERE id = 1) AS n, (SELECT MAX(modified_at) FROM layouts WHERE deleted = 0) AS modified",
          )
          .first<{ n: number; modified: string | null }>(),
        // `authors_head.count` (migrations/0035): trigger-kept, not a scan.
        db.prepare("SELECT count AS n FROM authors_head WHERE id = 1").first<{ n: number }>(),
        // The head event's `at` (its `revision` timestamp).
        db.prepare("SELECT MAX(at) AS at FROM events").first<{ at: string | null }>(),
      ]);
      return {
        layoutCount: layoutRow?.n ?? 0,
        layoutsModifiedAt: layoutRow?.modified ?? null,
        authorCount: authorRow?.n ?? 0,
        revisionAt: eventRow?.at ?? null,
      };
    },
  };
}
