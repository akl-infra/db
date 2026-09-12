// restoreSql(dump) / restoreInto(db, dump) (07 §6 S7): the inverse of
// `dump/write.ts`. `restoreSql` renders plain, literal-valued SQL text --
// no `?` placeholders -- because its other consumer is `scripts/rehost.mjs`,
// which writes the joined statements to a `restore.sql` file for `wrangler
// d1 execute --file` (a CLI that cannot bind parameters). `restoreInto`
// re-`prepare()`s the same strings and runs them through `db.batch()` for
// tests, so the two paths can never disagree about what gets written.
//
// This is the one place outside `core/events.ts` allowed to say `INSERT
// INTO layouts` (`tests/tools/onlywriter.test.ts`'s allow-list names this
// file explicitly): a restore reconstructs rows verbatim from a dump, not
// by replaying writes through `appendWrite`'s fold, so going through it
// here would be re-deriving `rev`/`created_at`/etc. from data that already
// carries them -- pure overhead with a chance to disagree with the dump.
import type { Bindings } from "../env";
import type { Dump } from "./write";

// SQLite's own AUTOINCREMENT rule (07 §4, confirmed against real D1): an
// explicit INSERT into an AUTOINCREMENT primary key advances `sqlite_sequence`
// to that value when it exceeds the current max, so re-inserting `events`
// with their original `seq` needs no separate bookkeeping -- the next real
// write after a restore continues from the highest restored `seq`.

const TABLE_ORDER_DELETE = [
  // children (reference a layout_id) before the `layouts` parent; the rest
  // are independent tables, order irrelevant. `d1_migrations` is untouched.
  "events",
  "layout_revs",
  "layout_formats",
  "likes",
  "import_map",
  "layouts",
  "authors",
  "admins",
  "import_state",
  "clients", // LDB-D9: dumped and restored below -- pubkeys/caps are public, no reason to drop them
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
      ["layout_id", "lineage", "format", "rev", "created_at", "modified_at", "payload_json", "has_magic", "source_client", "source_version"],
      dump.layout_formats.map((r) => ({ ...r })),
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
      ["upstream_id", "layout_id", "upstream_name"],
      // B2 sticky shadow: `upstream_name` round-trips; a dump written
      // before migrations/0012 has none, and restores as NULL (the
      // column's own default -- `chunkedInserts` treats an explicit
      // `null` as NULL, unlike the NOT NULL columns elsewhere here that
      // need a real fallback value).
      dump.import_map.map((r) => ({ ...r, upstream_name: r.upstream_name ?? null })),
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

// Applies `restoreSql(dump)` via `db.batch()`, chunked at <= 100 statements
// per batch (the same per-batch cap `import/apply.ts` uses) so one restore
// of a full corpus doesn't try to submit thousands of statements in a
// single D1 batch call. Test-only in phase 1 (`tests/rehost.test.ts`);
// `scripts/rehost.mjs` uses `restoreSql` directly against `wrangler d1
// execute --file` instead, so a real rehost never depends on Worker code
// running at all.
export async function restoreInto(db: Bindings["DB"], dump: Dump): Promise<void> {
  const statements = restoreSql(dump);
  const BATCH_CHUNK = 100;
  for (let i = 0; i < statements.length; i += BATCH_CHUNK) {
    const chunk = statements.slice(i, i + BATCH_CHUNK);
    await db.batch(chunk.map((sql) => db.prepare(sql)));
  }
}
