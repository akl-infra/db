// The shadow feed applier (design A phase D, LDB-PV5/PV6): turns ONE event of production's PUBLIC feed
// (`GET /v1/changes`, the shape `rowToEvent` + `publicDetail` produce) into the SQL statements that leave this database
// holding exactly the rows the production write path (src/store/d1/events.ts) left behind, for the FEED tables.
//
//   FEED tables (reproduced exactly, from the feed plus the rev payload that `GET /v1/layouts/<id>/rev/<n>` serves):
//     events, layouts, layout_formats, layout_revs, likes   (layouts_head moves by its triggers)
//   STATE tables (NOT reproducible from public data: submissions, comment bodies, authors, clients, import bookkeeping ...):
//     authors(+authors_head), admins, clients, bans, import_state, import_map, link_submissions, wpm_submissions,
//     layout_comments, comment_likes
//     An event of a kind that changes one of these is applied as its `events` row (and any feed-table effect it has) only;
//     the table named in KINDS[kind].state is counted as stale and is replaced wholesale from the next public dump
//     (follower.ts). Nothing here ever writes an approximation into a state table.
//
// The statements are deterministic SQL over the database's own state (n is `layouts.n + 1`, like_count is COUNT(likes)),
// never over values the caller read earlier, because the shim re-executes a unit against a newer state when its append
// loses a race (SH5). Every statement of one event, and the cursor advance, form ONE unit (`db.batch`).
//
// What is refused, loudly (FollowerRefusal; the follower raises `akldb-alarm: shadow-follower: ...` and stops, leaving the
// cursor where it was so the next tick retries the same event): a kind not listed in KINDS; a rev-bumping event of a kind that
// is not a write kind (or a write kind without a rev); an `after` snapshot with an unexpected scope; a source whose client
// starts with `legacy:` but is not `legacy:<via>` (the feed maps a NULL source to that, so the original cannot be told
// apart); a format event whose payload is unavailable or does not belong to the event; a feed that skips a seq; and any
// event that contradicts this database (a like of a layout it does not have, an unlike of a like it does not have).
import { canonical } from "../../core/canonical";

export const FEED_TABLES = ["events", "layouts", "layout_formats", "layout_revs", "likes"] as const;
export const STATE_TABLES = ["authors", "admins", "clients", "bans", "import_state", "import_map", "link_submissions", "wpm_submissions", "layout_comments", "comment_likes"] as const;
export type StateTable = (typeof STATE_TABLES)[number];

/** How an event is applied. "write" is the commitWrite path (rev-bumping); "row" is the events row alone. */
export type ApplyKind = "write" | "like" | "unlike" | "link" | "row";

export interface KindRule {
  apply: ApplyKind;
  /** State tables the production write of this kind may change and this applier does NOT reproduce. */
  state: StateTable[];
}

const row = (...state: StateTable[]): KindRule => ({ apply: "row", state });
const write: KindRule = { apply: "write", state: [] };

/** Every kind of `/v1/changes` (routes/changes.ts KNOWN_KINDS; a test keeps the two lists equal). */
export const KINDS: Record<string, KindRule> = {
  created: write,
  format_added: write,
  updated: write,
  renamed: write,
  fingermap: write,
  transferred: write,
  deleted: write,
  restored: write,
  imported: { apply: "write", state: ["import_map", "import_state"] },
  // rev-bumping when a following layout is tombstoned (a write), informational otherwise (a row)
  upstream_deleted: { apply: "write", state: ["import_map", "import_state"] },
  liked: { apply: "like", state: [] },
  unliked: { apply: "unlike", state: [] },
  link_approved: { apply: "link", state: ["link_submissions"] },
  link_cleared: { apply: "link", state: ["link_submissions"] },
  link_submitted: row("link_submissions"),
  link_rejected: row("link_submissions"),
  upstream_changed: row("import_map", "import_state"),
  import_conflict: row("import_map", "import_state"),
  import_error: row("import_state"),
  import_relabel: row("import_map", "import_state"),
  "admin.added": row("admins"),
  "admin.removed": row("admins"),
  "admin.import_paused": row("import_state"),
  "admin.import_resumed": row("import_state"),
  "admin.client_registered": row("clients"),
  "admin.client_revoked": row("clients"),
  "admin.client_suspended": row("clients", "import_state"),
  "admin.client_reactivated": row("clients", "import_state"),
  "admin.import_ticked": row("import_state"),
  "admin.diff_ticked": row("import_state"),
  "admin.nightly_ticked": row("import_state"),
  "admin.import_unstalled": row("import_state"),
  "admin.user_banned": row("bans"),
  "admin.user_unbanned": row("bans"),
  "admin.author_renamed": row("authors"),
  wpm_submitted: row("wpm_submissions"),
  wpm_approved: row("wpm_submissions"),
  wpm_rejected: row("wpm_submissions"),
  wpm_reopened: row("wpm_submissions"),
  comment_submitted: row("layout_comments"),
  comment_approved: row("layout_comments"),
  comment_rejected: row("layout_comments"),
  comment_reopened: row("layout_comments"),
  comment_removed: row("layout_comments", "comment_likes"),
  comment_deleted: row("layout_comments", "comment_likes"),
  comment_liked: row("comment_likes"),
  comment_unliked: row("comment_likes"),
  // retired in H24 and ignored by the fold; old logs may still hold one
  "admin.likes_set": row(),
};

export interface FeedSource {
  client: string;
  version: string | null;
}

export interface FeedEvent {
  seq: number;
  at: string;
  kind: string;
  layout_id: string | null;
  name: string | null;
  owner: string | null;
  format: string | null;
  rev: number | null;
  actor: string;
  via: string;
  admin: boolean;
  detail: unknown;
  before: unknown;
  after: unknown;
  source: FeedSource;
}

export class FollowerRefusal extends Error {
  constructor(readonly seq: number, readonly kind: string, readonly reason: string) {
    super(`seq ${seq} (${kind}): ${reason}`);
    this.name = "FollowerRefusal";
  }
}

/** The payload of a format-scope event: what `GET /v1/layouts/<id>/rev/<rev>?format=<format>` answers, already checked to belong to the event. */
export type PayloadFor = (ev: FeedEvent) => Promise<unknown>;

export interface LayoutAfter {
  scope: "layout";
  id: string;
  name: string;
  owner: string;
  layout_rev: number;
  created_at: string;
  modified_at: string;
  deleted: boolean;
  upstream: { source: string; id: string; state: string } | null;
  source: FeedSource | null;
}
export interface FormatAfter {
  scope: "format";
  layout_id: string;
  lineage: string;
  format: string;
  rev: number;
  created_at: string;
  modified_at: string;
  has_magic: boolean;
  has_alts?: boolean;
  has_combos?: boolean;
  source: FeedSource | null;
  upstream?: { source: string; id: string; state: string } | null;
}

const lineageOf = (format: string): string => (format.lastIndexOf("/") === -1 ? format : format.slice(0, format.lastIndexOf("/")));

/** The `source_client`/`source_version` columns of an event row. The feed shows a NULL source as `legacy:<via>`. */
export function sourceColumns(ev: FeedEvent): [string | null, string | null] {
  if (ev.source.client === `legacy:${ev.via}` && ev.source.version === null) return [null, null];
  if (ev.source.client.startsWith("legacy:")) throw new FollowerRefusal(ev.seq, ev.kind, `source client '${ev.source.client}' is ambiguous (the feed shows a NULL source as legacy:<via>)`);
  return [ev.source.client, ev.source.version];
}

function snapshotSource(s: FeedSource | null): [string | null, string | null] {
  return s === null ? [null, null] : [s.client, s.version];
}

const json = (v: unknown): string | null => (v === null || v === undefined ? null : canonical(v));

/** Class of the event, or a refusal. */
export function applyKindOf(ev: FeedEvent): ApplyKind {
  const rule = KINDS[ev.kind];
  if (rule === undefined) throw new FollowerRefusal(ev.seq, ev.kind, "unknown kind: the applier does not know what this event changes");
  if (ev.rev !== null) {
    if (rule.apply !== "write") throw new FollowerRefusal(ev.seq, ev.kind, `a rev-bumping event (rev ${ev.rev}) of a kind that is not a write kind`);
    return "write";
  }
  if (rule.apply === "write") {
    if (ev.kind === "upstream_deleted") return "row"; // the informational variant
    throw new FollowerRefusal(ev.seq, ev.kind, "a write kind without a rev");
  }
  return rule.apply;
}

/** State tables this event may have changed without this database following (empty for the feed-only kinds). */
export function staleTablesOf(ev: FeedEvent): StateTable[] {
  const rule = KINDS[ev.kind];
  if (rule === undefined) return [];
  if (ev.kind === "upstream_deleted" || ev.kind === "imported") return rule.state;
  return rule.state;
}

function eventInsert(db: D1Database, ev: FeedEvent): D1PreparedStatement {
  const [sc, sv] = sourceColumns(ev);
  return db
    .prepare(
      `INSERT INTO events (seq, at, kind, layout_id, name, owner, format, rev, actor, via, admin, detail_json, before_json, after_json, source_client, source_version)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(ev.seq, ev.at, ev.kind, ev.layout_id, ev.name, ev.owner, ev.format, ev.rev, ev.actor, ev.via, ev.admin ? 1 : 0, json(ev.detail), json(ev.before), json(ev.after), sc, sv);
}

function writeStatements(db: D1Database, ev: FeedEvent, payload: unknown): D1PreparedStatement[] {
  const after = ev.after as LayoutAfter | FormatAfter | null;
  if (after === null || typeof after !== "object") throw new FollowerRefusal(ev.seq, ev.kind, "a rev-bumping event without an 'after' snapshot");
  if (ev.layout_id === null) throw new FollowerRefusal(ev.seq, ev.kind, "a rev-bumping event without a layout id");
  const id = ev.layout_id;
  const stmts: D1PreparedStatement[] = [eventInsert(db, ev)];

  // layout_revs: n is the layout's write counter + 1 (the write path's currentN + 1), computed from the row itself
  const format = after.scope === "format" ? ev.format : null;
  if (after.scope === "format" && ev.format === null) throw new FollowerRefusal(ev.seq, ev.kind, "a format-scope event without a format");
  stmts.push(
    db
      .prepare(
        `INSERT INTO layout_revs (layout_id, n, lineage, rev, event_seq, format, payload_json)
         VALUES (?, COALESCE((SELECT n FROM layouts WHERE id = ?), 0) + 1, ?, ?, ?, ?, ?)`,
      )
      .bind(id, id, format === null ? null : lineageOf(format), ev.rev, ev.seq, format, format === null ? null : canonical(payload)),
  );

  if (after.scope === "layout") {
    const [sc, sv] = snapshotSource(after.source);
    stmts.push(
      db
        .prepare(
          `INSERT INTO layouts (id, name, owner, n, layout_rev, created_at, modified_at, deleted, like_count, link, upstream_source, upstream_id, upstream_state, source_client, source_version)
           VALUES (?, ?, ?, COALESCE((SELECT n FROM layouts WHERE id = ?), 0) + 1, ?, ?, ?, ?, (SELECT COUNT(*) FROM likes WHERE layout_id = ?), NULL, ?, ?, ?, ?, ?)
           ON CONFLICT(id) DO UPDATE SET
             name = excluded.name, owner = excluded.owner, n = excluded.n, layout_rev = excluded.layout_rev,
             created_at = excluded.created_at, modified_at = excluded.modified_at, deleted = excluded.deleted,
             like_count = (SELECT COUNT(*) FROM likes WHERE layout_id = excluded.id),
             upstream_source = excluded.upstream_source, upstream_id = excluded.upstream_id, upstream_state = excluded.upstream_state,
             source_client = excluded.source_client, source_version = excluded.source_version`,
        )
        .bind(id, after.name, after.owner, id, after.layout_rev, after.created_at, after.modified_at, after.deleted ? 1 : 0, id, after.upstream?.source ?? null, after.upstream?.id ?? null, after.upstream?.state ?? null, sc, sv),
    );
    return stmts;
  }

  // a format-scope event: the layout row keeps its fields and takes the next n, a re-counted like_count, and (for the
  // lineage that forks upstream) the snapshot's upstream; the layout_formats row is upserted
  const upstreamSet = "upstream" in after && after.upstream !== undefined;
  stmts.push(
    db
      .prepare(
        `UPDATE layouts SET n = n + 1, like_count = (SELECT COUNT(*) FROM likes WHERE layout_id = ?)${upstreamSet ? ", upstream_source = ?, upstream_id = ?, upstream_state = ?" : ""} WHERE id = ?`,
      )
      .bind(...[id, ...(upstreamSet ? [after.upstream?.source ?? null, after.upstream?.id ?? null, after.upstream?.state ?? null] : []), id]),
  );
  const [fsc, fsv] = snapshotSource(after.source);
  stmts.push(
    db
      .prepare(
        `INSERT INTO layout_formats (layout_id, lineage, format, rev, created_at, modified_at, payload_json, has_magic, has_alts, has_combos, source_client, source_version)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(layout_id, lineage) DO UPDATE SET
           format = excluded.format, rev = excluded.rev, created_at = excluded.created_at, modified_at = excluded.modified_at,
           payload_json = excluded.payload_json, has_magic = excluded.has_magic, has_alts = excluded.has_alts, has_combos = excluded.has_combos,
           source_client = excluded.source_client, source_version = excluded.source_version`,
      )
      .bind(id, after.lineage, after.format, after.rev, after.created_at, after.modified_at, canonical(payload), after.has_magic ? 1 : 0, after.has_alts ? 1 : 0, after.has_combos ? 1 : 0, fsc, fsv),
  );
  return stmts;
}

export interface ApplyDeps {
  db: D1Database;
  payload: PayloadFor;
}

export interface ApplyResult {
  kind: ApplyKind;
  /** State tables whose effect of this event was not reproduced. */
  stale: StateTable[];
}

const one = async <T>(db: D1Database, sql: string, ...args: unknown[]): Promise<T | null> => db.prepare(sql).bind(...args).first<T>();

/**
 * The statements of one event (without the cursor advance), after the pre-checks that need a read. A refusal throws
 * FollowerRefusal before anything is written.
 */
export async function eventStatements(deps: ApplyDeps, ev: FeedEvent): Promise<{ kind: ApplyKind; stmts: D1PreparedStatement[] }> {
  const { db } = deps;
  const kind = applyKindOf(ev);
  sourceColumns(ev); // refuses an ambiguous source for every kind, not only the ones that read it again
  if ((await one(db, "SELECT 1 AS x FROM events WHERE seq = ?", ev.seq)) !== null) throw new FollowerRefusal(ev.seq, ev.kind, "this database already has an event with that seq");
  switch (kind) {
    case "row":
      return { kind, stmts: [eventInsert(db, ev)] };
    case "write": {
      const after = ev.after as { scope?: unknown } | null;
      if (after === null || (after.scope !== "layout" && after.scope !== "format")) throw new FollowerRefusal(ev.seq, ev.kind, `unexpected 'after' scope '${String((after as { scope?: unknown } | null)?.scope)}'`);
      if (ev.layout_id === null) throw new FollowerRefusal(ev.seq, ev.kind, "a rev-bumping event without a layout id");
      if (after.scope === "format" && (await one(db, "SELECT 1 AS x FROM layouts WHERE id = ?", ev.layout_id)) === null) throw new FollowerRefusal(ev.seq, ev.kind, `a format event of layout ${ev.layout_id}, which this database does not have`);
      const payload = after.scope === "format" ? await deps.payload(ev) : null;
      return { kind, stmts: writeStatements(db, ev, payload) };
    }
    case "like":
    case "unlike": {
      if (ev.layout_id === null) throw new FollowerRefusal(ev.seq, ev.kind, "a like event without a layout id");
      if ((await one(db, "SELECT 1 AS x FROM layouts WHERE id = ?", ev.layout_id)) === null) throw new FollowerRefusal(ev.seq, ev.kind, `a like event of layout ${ev.layout_id}, which this database does not have`);
      const has = (await one(db, "SELECT 1 AS x FROM likes WHERE layout_id = ? AND user_id = ?", ev.layout_id, ev.actor)) !== null;
      if (kind === "like" && has) throw new FollowerRefusal(ev.seq, ev.kind, `${ev.actor} already likes ${ev.layout_id} here`);
      if (kind === "unlike" && !has) throw new FollowerRefusal(ev.seq, ev.kind, `${ev.actor} has no like of ${ev.layout_id} here to remove`);
      const likeStmt =
        kind === "like"
          ? db.prepare("INSERT INTO likes (layout_id, user_id, at, via) VALUES (?, ?, ?, ?)").bind(ev.layout_id, ev.actor, ev.at, ev.via)
          : db.prepare("DELETE FROM likes WHERE layout_id = ? AND user_id = ?").bind(ev.layout_id, ev.actor);
      return {
        kind,
        stmts: [eventInsert(db, ev), likeStmt, db.prepare("UPDATE layouts SET like_count = (SELECT COUNT(*) FROM likes WHERE layout_id = ?) WHERE id = ?").bind(ev.layout_id, ev.layout_id)],
      };
    }
    case "link": {
      if (ev.layout_id === null) throw new FollowerRefusal(ev.seq, ev.kind, "a link event without a layout id");
      const after = ev.after as { scope?: unknown; link?: unknown } | null;
      if (after === null || after.scope !== "link" || (after.link !== null && typeof after.link !== "string")) throw new FollowerRefusal(ev.seq, ev.kind, "a link event without a link 'after'");
      if ((await one(db, "SELECT 1 AS x FROM layouts WHERE id = ?", ev.layout_id)) === null) throw new FollowerRefusal(ev.seq, ev.kind, `a link event of layout ${ev.layout_id}, which this database does not have`);
      return { kind, stmts: [eventInsert(db, ev), db.prepare("UPDATE layouts SET link = ? WHERE id = ?").bind(after.link, ev.layout_id)] };
    }
  }
}
