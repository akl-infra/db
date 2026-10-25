// D1 implementation of `DumpStore` (src/store/port.ts). Owner: P1 agent D
// (design/p1-briefs.md). The keyset pagers are dump/write.ts's, moved
// verbatim. The restore statements come from the pure renderer
// `restoreSql()` below, which scripts/rehost.mjs also imports under plain
// Node: this file must keep type-only imports.
//
// `restoreSql` renders plain, literal-valued SQL text -- no `?`
// placeholders -- because rehost.mjs writes the joined statements to a
// `restore.sql` file for `wrangler d1 execute --file` (a CLI that cannot
// bind parameters); `restore()` below runs the same strings in batches, so
// the two paths can never disagree about what gets written. Besides the
// event commit (store/d1/events.ts), this is the one file allowed to write
// the `layouts` table (LDB-P1, tests/tools/onlywriter.test.ts): a restore
// reconstructs rows verbatim from a dump rather than replaying writes
// through the fold.
import type { ClientDbRow, Dump } from "../../dump/write";
import type { AdminDbRow, AuthorDbRow, BanDbRow, CommentLikeDbRow, ImportMapDbRow, ImportStateDbRow, LayoutCommentDbRow, LayoutRevDbRow, LikeDbRow, LinkSubmissionDbRow, WpmSubmissionDbRow } from "../../dump/write";
import type { EventDbRow } from "../../core/events";
import type { FormatDbRow, LayoutDbRow } from "../../core/records";
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

// SQLite's own AUTOINCREMENT rule (07 §4, confirmed against real D1): an
// explicit INSERT into an AUTOINCREMENT primary key advances `sqlite_sequence`
// to that value when it exceeds the current max, so re-inserting `events`
// with their original `seq` needs no separate bookkeeping -- the next real
// write after a restore continues from the highest restored `seq`.

const TABLE_ORDER_DELETE = [
  // children (reference a layout_id) before the `layouts` parent; the rest
  // are independent tables, order irrelevant. `d1_migrations` is untouched.
  "events",
  "modqueue_notifications", // private webhook message ids/status; never present in the public dump
  "moderation_review_history", // private decisions/reasons, never included in public dumps
  "discord_rejection_dm_outbox", // private moderation DM delivery identifiers/state; never present in the public dump
  "discord_pending_actions", // private expiring interaction tokens/actions; never dumped
  "discord_deny_modals", // private short-lived modal bindings; never dumped
  "discord_reopen_actions", // private reopening jobs and interaction tokens; never dumped
  "discord_reopen_confirmations", // private expiring moderator confirmations; never dumped
  "layout_revs",
  "layout_formats",
  "likes",
  "link_submissions", // [LDB-MD8] §4.5: references a layout_id, before the parent
  "wpm_submissions", // [LDB-WPM10]: references a layout_id, before the parent
  "comment_likes", // [LDB-CMT12]: references a layout_id, before the parent
  "layout_comments", // [LDB-CMT10]: references a layout_id, before the parent
  "import_map",
  "layouts",
  "authors",
  "admins",
  "import_state",
  "clients", // LDB-D9: dumped and restored below -- pubkeys/caps are public, no reason to drop them
  "bans", // [LDB-MD8] §4.5
  "auth_cache",
  "ratelimit",
  "nonces", // never dumped (replay guard, <=300s lifetime by construction -- 09 §2.5); deleted here too so a restore starts with no history of recent requests
] as const;

// A conservative multi-row-INSERT chunk size: mirrors `core/events.ts`'s own
// "<= 100 bound params per statement" rule (07 §4) even though these
// statements carry literal values, not bound params -- keeping the same cap
// keeps one mental model for "how big can one INSERT get" across the code.
const MAX_PARAMS_PER_STMT = 100;

function sqlLit(v: string | number | null): string {
  if (v === null) return "NULL";
  if (typeof v === "number") return String(v);
  return `'${v.replace(/'/g, "''")}'`;
}

// `insertPrefix` is the FULL, literal "INSERT INTO <table>" text -- spelled
// out at each call site below, not assembled from a bare table-name
// parameter -- so this file, like `core/events.ts`, contains the literal
// string "INSERT INTO layouts" and stays visible to
// `tests/tools/onlywriter.test.ts`'s plain-text write-boundary scan.
function chunkedInserts(
  insertPrefix: string,
  columns: string[],
  rows: Array<Record<string, string | number | null>>,
): string[] {
  if (rows.length === 0) return [];
  const rowsPerStmt = Math.max(1, Math.floor(MAX_PARAMS_PER_STMT / columns.length));
  const colList = columns.join(", ");
  const out: string[] = [];
  for (let i = 0; i < rows.length; i += rowsPerStmt) {
    const chunk = rows.slice(i, i + rowsPerStmt);
    const values = chunk
      .map((row) => "(" + columns.map((c) => sqlLit(row[c] ?? null)).join(",") + ")")
      .join(",");
    out.push(`${insertPrefix} (${colList}) VALUES ${values}`);
  }
  return out;
}

// `string[]`: complete, independently-runnable SQL statements, in
// application order (deletes, then inserts, children after their parent).
// `scripts/rehost.mjs` joins them with ";\n" for a `restore.sql` file;
// `restoreInto` below re-`prepare()`s each one directly.
export function restoreSql(dump: Dump): string[] {
  const statements: string[] = [];

  for (const table of TABLE_ORDER_DELETE) statements.push(`DELETE FROM ${table}`);

  statements.push(
    ...chunkedInserts(
      "INSERT INTO layouts",
      [
        "id",
        "name",
        "owner",
        "n",
        "layout_rev",
        "created_at",
        "modified_at",
        "deleted",
        "like_count",
        "like_adjust",
        "link",
        "upstream_source",
        "upstream_id",
        "upstream_state",
        "source_client",
        "source_version",
      ],
      dump.records.map((r) => ({
        id: r.id,
        name: r.name,
        owner: r.owner,
        n: r.n,
        layout_rev: r.layout_rev,
        created_at: r.created_at,
        modified_at: r.modified_at,
        deleted: r.deleted,
        like_count: r.like_count,
        // H24 (2026-09-13): `like_adjust` is a dead column (migrations/
        // 0015) -- a dump taken before this change (or one that still
        // carries the raw physical column) may include it, but restore
        // ignores whatever value it has and always writes 0; the column
        // stays NOT NULL DEFAULT 0 and no code reads it any more.
        like_adjust: 0,
        link: r.link ?? null,
        upstream_source: r.upstream_source ?? null,
        upstream_id: r.upstream_id ?? null,
        upstream_state: r.upstream_state ?? null,
        source_client: r.source_client ?? null,
        source_version: r.source_version ?? null,
      })),
    ),
  );

  // 21-formats.md F2: one row per (layout, lineage) -- a tombstoned
  // layout's format rows restore too (untouched by deletion, D3).
  statements.push(
    ...chunkedInserts(
      "INSERT INTO layout_formats",
      ["layout_id", "lineage", "format", "rev", "created_at", "modified_at", "payload_json", "has_magic", "has_alts", "has_combos", "source_client", "source_version"],
      // design/alts/07-format.md: `has_alts`/`has_combos` round-trip; a dump
      // written before migrations/0020 has neither column, and restores as
      // 0 (the column's own default) -- same fallback pattern
      // `upstream_name`/`notified_at` above use.
      dump.layout_formats.map((r) => ({ ...r, has_alts: r.has_alts ?? 0, has_combos: r.has_combos ?? 0 })),
    ),
  );

  statements.push(
    ...chunkedInserts(
      "INSERT INTO layout_revs",
      ["layout_id", "n", "lineage", "rev", "event_seq", "format", "payload_json"],
      dump.layout_revs.map((r) => ({ ...r })),
    ),
  );

  statements.push(
    ...chunkedInserts(
      "INSERT INTO likes",
      ["layout_id", "user_id", "at", "via"],
      // LDB-B1: `via` round-trips; a dump written before migrations/0011
      // has none, and restores as 'import:cmini' (the column's own
      // default -- NOT NULL, so `chunkedInserts`'s NULL won't do).
      dump.likes.map((r) => ({ ...r, via: r.via ?? "import:cmini" })),
    ),
  );

  statements.push(
    ...chunkedInserts(
      "INSERT INTO authors",
      ["user_id", "name", "first_seen_at", "last_seen_at", "name_source"],
      // LDB-I17: `name_source` round-trips; a dump written before
      // migrations/0006 has none, and restores as 'import' (the column's
      // own default -- NOT NULL, so `chunkedInserts`'s NULL won't do).
      dump.authors.map((r) => ({ ...r, name_source: r.name_source ?? "import" })),
    ),
  );

  // Explicit `seq` on every row -- see the AUTOINCREMENT note above.
  statements.push(
    ...chunkedInserts(
      "INSERT INTO events",
      [
        "seq",
        "at",
        "kind",
        "layout_id",
        "name",
        "owner",
        "format",
        "rev",
        "actor",
        "via",
        "admin",
        "detail_json",
        "before_json",
        "after_json",
        "source_client",
        "source_version",
      ],
      dump.events.map((e) => ({
        seq: e.seq,
        at: e.at,
        kind: e.kind,
        layout_id: e.layout_id,
        name: e.name,
        owner: e.owner,
        format: e.format ?? null, // 21-formats.md F2: absent from a pre-0009 dump -- `?? null` treats that as a layout-level event
        rev: e.rev,
        actor: e.actor,
        via: e.via,
        admin: e.admin,
        detail_json: e.detail_json,
        before_json: e.before_json,
        after_json: e.after_json,
        // 20-spark.md S3s (LDB-D1/D5 amended): a dump written before 0005
        // has no such keys -- `?? null` treats that as present-and-NULL.
        source_client: e.source_client ?? null,
        source_version: e.source_version ?? null,
      })),
    ),
  );

  statements.push(
    ...chunkedInserts(
      "INSERT INTO admins",
      ["user_id", "added_by", "added_at", "note"],
      dump.admins.map((r) => ({ ...r })),
    ),
  );

  statements.push(
    ...chunkedInserts("INSERT INTO import_state", ["key", "value"], dump.import_state.map((r) => ({ ...r }))),
  );

  statements.push(
    ...chunkedInserts(
      "INSERT INTO import_map",
      ["upstream_id", "layout_id", "upstream_name", "upstream_modified_at"],
      // B2 sticky shadow: `upstream_name` round-trips; a dump written
      // before migrations/0013 has none, and restores as NULL (the
      // column's own default -- `chunkedInserts` treats an explicit
      // `null` as NULL, unlike the NOT NULL columns elsewhere here that
      // need a real fallback value).
      // LDB-I24: `upstream_modified_at` round-trips the same way; a dump
      // written before migrations/0018 has none, and restores as NULL.
      dump.import_map.map((r) => ({ ...r, upstream_name: r.upstream_name ?? null, upstream_modified_at: r.upstream_modified_at ?? null })),
    ),
  );

  // LDB-D9: `clients` round-trips (pubkeys, caps, status) -- unlike the
  // now-deleted `webhooks` table (LEDGER.md L4), nothing here is a secret
  // (10 C1 §4), so there is no reason for a rehost to lose every
  // registered bot key and need the admin bootstrap redone.
  statements.push(
    ...chunkedInserts(
      "INSERT INTO clients",
      ["id", "name", "pubkey", "owner_user_id", "caps", "discord_app_id", "status", "created_at", "revoked_at"],
      dump.clients.map((r) => ({
        id: r.id,
        name: r.name,
        pubkey: r.pubkey,
        owner_user_id: r.owner_user_id,
        caps: r.caps,
        discord_app_id: r.discord_app_id ?? null,
        status: r.status,
        created_at: r.created_at,
        revoked_at: r.revoked_at ?? null,
      })),
    ),
  );

  // [LDB-MD8] §4.5: `bans`/`link_submissions` round-trip whole, same
  // shape every other small admin-authored table here uses -- absent
  // entirely from a dump written before migrations/0014 (`?? []` at the
  // call site in dump/write.ts's own reader would be wrong; here the
  // arrays themselves are simply empty for such a dump, nothing to
  // default per-row).
  statements.push(
    ...chunkedInserts(
      "INSERT INTO bans",
      ["user_id", "by", "at", "reason"],
      (dump.bans ?? []).map((r) => ({ ...r })),
    ),
  );

  statements.push(
    ...chunkedInserts(
      "INSERT INTO link_submissions",
      ["id", "layout_id", "url", "submitted_by", "submitted_at", "status", "decided_by", "decided_at", "reason", "notified_at"],
      // [LDB-MD11] `notified_at` (migrations/0019) is absent from a dump
      // written before it existed -- read as null, same fallback
      // `upstream_name`/`upstream_modified_at` use above.
      (dump.link_submissions ?? []).map((r) => ({ ...r, notified_at: r.notified_at ?? null })),
    ),
  );

  // [LDB-WPM10] migrations/0022: absent entirely from a dump written before
  // it (`?? []`), every row restored whole -- proofs and the notifier's
  // claim included.
  statements.push(
    ...chunkedInserts(
      "INSERT INTO wpm_submissions",
      ["id", "layout_id", "user_id", "wpm", "proof", "submitted_by", "via", "submitted_at", "status", "decided_by", "decided_at", "reason", "notified_at", "review_version"],
      (dump.wpm_submissions ?? []).map((r) => ({ ...r, notified_at: r.notified_at ?? null, review_version: r.review_version ?? 0 })),
    ),
  );

  // [LDB-CMT10] migrations/0023: absent entirely from a dump written before
  // it (`?? []`), every dumped (approved) row restored whole
  // (comments have no `notified_at`, so there is no notifier claim to keep).
  statements.push(
    ...chunkedInserts(
      "INSERT INTO layout_comments",
      ["id", "layout_id", "user_id", "body", "via", "submitted_at", "status", "decided_by", "decided_at", "reason", "review_version"],
      (dump.layout_comments ?? []).map((r) => ({ ...r, review_version: r.review_version ?? 0 })),
    ),
  );

  // [LDB-CMT12] migrations/0023: absent from a dump written before it.
  statements.push(
    ...chunkedInserts(
      "INSERT INTO comment_likes",
      ["layout_id", "author_id", "user_id", "via", "created_at"],
      (dump.comment_likes ?? []).map((r) => ({ ...r })),
    ),
  );

  // `auth_cache`/`ratelimit`/`nonces`: deleted above, nothing re-inserted --
  // a rehost starts with a cold auth cache, no rate-limit windows and no
  // replay-guard rows (none of the three is ever part of the dump, 07 §6
  // S7); `dump.last_at` (LDB-D8) is excluded from `dump.import_state`
  // itself (`dump/write.ts`'s own comment), so it needs no special-casing
  // here either -- a restored database simply starts eligible for an
  // immediate catch-up dump, which is correct.

  // `authors_head` (migrations/0007, LDB-R9, LDB-D1 amended): never
  // deleted above (its triggers need the row), and the `authors` deletes
  // and inserts above each moved it by trigger -- so it is set LAST, to
  // exactly the dumped value, and a restored `/v1/meta` equals the dumped
  // one. A dump from before 0007 carries no `authors_version` and restores
  // as 0, the value 0007 itself seeds.
  statements.push(
    `INSERT INTO authors_head (id, version, modified_at) VALUES (1, ${sqlLit(dump.meta.authors_version ?? 0)}, ${sqlLit(dump.meta.authors_modified_at ?? null)}) ` +
      "ON CONFLICT(id) DO UPDATE SET version = excluded.version, modified_at = excluded.modified_at",
  );

  return statements;
}
