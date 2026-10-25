// The test-only storage inspector (design/aws-port.md §4.3), FROZEN with
// src/store/port.ts. Tests seed and assert through it instead of raw SQL, so
// one test file runs against both backends. Rows are D1-shaped (the
// columns of migrations/*.sql, 0/1 booleans, JSON columns as strings) on
// every backend; the DynamoDB implementation (P2) converts through the row
// codec. `table` is a D1 table name; `key` is that table's primary key.
export type TableName =
  | "layouts" | "layout_formats" | "layout_revs" | "likes" | "events" | "authors" | "authors_head" | "layouts_head"
  | "admins" | "bans" | "clients" | "nonces" | "auth_cache" | "ratelimit" | "idempotency" | "import_state" | "import_map"
  | "link_submissions" | "wpm_submissions" | "layout_comments" | "comment_likes" | "moderation_review_history"
  | "modqueue_notifications" | "modqueue_delivery_gate" | "discord_pending_actions" | "discord_reopen_actions"
  | "discord_deny_modals" | "discord_reopen_confirmations" | "discord_rejection_dm_outbox";

export type Row = Record<string, unknown>;
/** Column equality filter; every listed column must equal its value (`null` matches NULL). */
export type Where = Row;

export interface TestStore {
  /** Every matching row, ordered by `orderBy` columns ascending (default: the primary key). */
  rows<T extends Row = Row>(table: TableName, where?: Where, orderBy?: string[]): Promise<T[]>;
  /** The one matching row, or null. Throws if more than one matches. */
  row<T extends Row = Row>(table: TableName, where: Where): Promise<T | null>;
  /** Number of matching rows. */
  count(table: TableName, where?: Where): Promise<number>;
  /** Insert full rows (columns not given take their schema defaults). */
  insert(table: TableName, ...rows: Row[]): Promise<void>;
  /** Set `fields` on every row matching `where`; returns how many changed. */
  patch(table: TableName, where: Where, fields: Row): Promise<number>;
  /** Delete every row matching `where`; returns how many went. */
  remove(table: TableName, where: Where): Promise<number>;
}
