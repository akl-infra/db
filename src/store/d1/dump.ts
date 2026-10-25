// D1 implementation of `DumpStore` (src/store/port.ts). Owner: P1 agent D
// (design/p1-briefs.md). The keyset pagers are dump/write.ts's, moved
// verbatim. The restore statements come from the pure renderer
// `restoreSql()` in dump/restore.ts (shared with scripts/rehost.mjs, which
// cannot import store code); this file runs them in D1 batches of 100.
import type { ClientDbRow, Dump } from "../../dump/write";
import type { AdminDbRow, AuthorDbRow, BanDbRow, CommentLikeDbRow, ImportMapDbRow, ImportStateDbRow, LayoutCommentDbRow, LayoutRevDbRow, LikeDbRow, LinkSubmissionDbRow, WpmSubmissionDbRow } from "../../dump/write";
import type { EventDbRow } from "../../core/events";
import type { FormatDbRow, LayoutDbRow } from "../../core/records";
import { restoreSql } from "../../dump/restore";
import type { DumpStore } from "../port";

const PAGE_SIZE = 500;

// Single-column-PK keyset pager: `SELECT * FROM <table> WHERE <keyCol> > ?
// ORDER BY <keyCol> ASC LIMIT ?`, page after page until a short page ends
// it. `table`/`keyCol` are our own fixed constants below, never request
// input, so string-interpolating them into the SQL is safe. A fixed column
// projection excludes private receipt metadata from WPM snapshots.
async function pageBySingleKey<T>(db: D1Database, table: string, keyCol: string, columns = "*"): Promise<T[]> {
  const out: T[] = [];
  let cursor: string | number | null = null;
  for (;;) {
    const sql: string =
      cursor === null
        ? `SELECT ${columns} FROM ${table} ORDER BY ${keyCol} ASC LIMIT ?`
        : `SELECT ${columns} FROM ${table} WHERE ${keyCol} > ? ORDER BY ${keyCol} ASC LIMIT ?`;
    const args: (string | number)[] = cursor === null ? [PAGE_SIZE] : [cursor, PAGE_SIZE];
    const { results } = await db.prepare(sql).bind(...args).all<T>();
    out.push(...results);
    if (results.length < PAGE_SIZE) break;
    const last = results[results.length - 1] as unknown as Record<string, string | number>;
    cursor = last[keyCol]!;
  }
  return out;
}

// Composite-PK keyset pager (`layout_revs`, `likes`): a single-column cursor
// on `col1` alone would skip or repeat rows when many share one `col1`
// value (e.g. many revs of the same layout), so the predicate is the same
// tuple comparison `core/records.ts`'s `list()` uses for its own cursor.
async function pageByCompositeKey<T>(db: D1Database, table: string, col1: string, col2: string): Promise<T[]> {
  const out: T[] = [];
  let cursor: [string, number | string] | null = null;
  for (;;) {
    const sql: string =
      cursor === null
        ? `SELECT * FROM ${table} ORDER BY ${col1} ASC, ${col2} ASC LIMIT ?`
        : `SELECT * FROM ${table} WHERE (${col1} > ? OR (${col1} = ? AND ${col2} > ?)) ORDER BY ${col1} ASC, ${col2} ASC LIMIT ?`;
    const args: (string | number)[] = cursor === null ? [PAGE_SIZE] : [cursor[0], cursor[0], cursor[1], PAGE_SIZE];
    const { results } = await db.prepare(sql).bind(...args).all<T>();
    out.push(...results);
    if (results.length < PAGE_SIZE) break;
    const last = results[results.length - 1] as unknown as Record<string, string | number>;
    cursor = [last[col1] as string, last[col2]!];
  }
  return out;
}

// `comment_likes` has a three-column primary key, so it pages on the unique
// concatenation of the three (ids never contain '/'); the helper column is
// dropped again before the rows go into the dump.
async function pageCommentLikes(db: D1Database): Promise<CommentLikeDbRow[]> {
  const out: CommentLikeDbRow[] = [];
  let cursor: string | null = null;
  for (;;) {
    const sql: string = `SELECT *, layout_id || '/' || author_id || '/' || user_id AS k FROM comment_likes ${cursor === null ? "" : "WHERE k > ?"} ORDER BY k ASC LIMIT ?`;
    const args: (string | number)[] = cursor === null ? [PAGE_SIZE] : [cursor, PAGE_SIZE];
    const { results } = await db.prepare(sql).bind(...args).all<CommentLikeDbRow & { k: string }>();
    for (const { k: _k, ...row } of results) out.push(row);
    if (results.length < PAGE_SIZE) break;
    cursor = results[results.length - 1]!.k;
  }
  return out;
}

export function d1DumpStore(db: D1Database): DumpStore {
  return {
    async tables() {
      const [records, layout_formats, layout_revs, likes, authors, admins, events, import_state, import_map, clients, bans, link_submissions, wpm_submissions, layout_comments, comment_likes] = await Promise.all([
        pageBySingleKey<LayoutDbRow>(db, "layouts", "id"),
        pageByCompositeKey<FormatDbRow>(db, "layout_formats", "layout_id", "lineage"),
        pageByCompositeKey<LayoutRevDbRow>(db, "layout_revs", "layout_id", "n"),
        pageByCompositeKey<LikeDbRow>(db, "likes", "layout_id", "user_id"),
        pageBySingleKey<AuthorDbRow>(db, "authors", "user_id"),
        pageBySingleKey<AdminDbRow>(db, "admins", "user_id"),
        pageBySingleKey<EventDbRow>(db, "events", "seq"),
        pageBySingleKey<ImportStateDbRow>(db, "import_state", "key"),
        pageBySingleKey<ImportMapDbRow>(db, "import_map", "upstream_id"),
        pageBySingleKey<ClientDbRow>(db, "clients", "id"),
        pageBySingleKey<BanDbRow>(db, "bans", "user_id"),
        pageBySingleKey<LinkSubmissionDbRow>(db, "link_submissions", "id"),
        pageBySingleKey<WpmSubmissionDbRow>(db, "wpm_submissions", "id", "id, layout_id, user_id, wpm, proof, submitted_by, via, submitted_at, status, decided_by, decided_at, reason, notified_at, review_version"),
        pageBySingleKey<LayoutCommentDbRow>(db, "layout_comments", "id"),
        pageCommentLikes(db),
      ]);
      return { records, layout_formats, layout_revs, likes, authors, admins, events, import_state, import_map, clients, bans, link_submissions, wpm_submissions, layout_comments, comment_likes };
    },

    // Applies `restoreSql(dump)` via `db.batch()`, chunked at <= 100 statements
    // per batch (the same per-batch cap `import/apply.ts` uses) so one restore
    // of a full corpus doesn't try to submit thousands of statements in a
    // single D1 batch call.
    async restore(dump: Dump) {
      const statements = restoreSql(dump);
      const BATCH_CHUNK = 100;
      for (let i = 0; i < statements.length; i += BATCH_CHUNK) {
        const chunk = statements.slice(i, i + BATCH_CHUNK);
        await db.batch(chunk.map((sql) => db.prepare(sql)));
      }
    },
  };
}
