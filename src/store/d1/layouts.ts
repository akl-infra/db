// D1 implementation of `LayoutReadStore` (src/store/port.ts). Owner: P1 agent A
// (design/p1-briefs.md). Today's SELECTs from core/records.ts, routes/layouts.ts,
// core/write.ts, core/revert.ts, routes/authors.ts and the link/wpm/comment
// presence checks, moved verbatim. The row mappers stay in core/records.ts.
import { rowToEvent, type Event, type EventDbRow } from "../../core/events";
import {
  encodeCursor,
  isUlidShaped,
  rowToFormat,
  rowToLayout,
  sourceFromRow,
  type FormatDbRow,
  type FormatRow,
  type LayoutDbRow,
  type LayoutRow,
  type LayoutWithFormats,
  type ListItem,
  type ListPage,
  type ListParams,
  type SortKey,
} from "../../core/records";
import type { LayoutReadStore } from "../port";

// `GET /v1/layouts?format=F`'s sort options (03 §2): `name` is the only
// ascending one (case-insensitive, the column's own COLLATE); the other
// three are all descending.
const SORT_DESC: Record<SortKey, boolean> = {
  name: false,
  modified_at: true,
  created_at: true,
  like_count: true,
};

// The SQL expression for a sort column: `name`/`created_at`/`like_count`
// are layout-only concepts (unaffected by which format was requested);
// `modified_at` is `max(layouts.modified_at, F.modified_at)` (21-formats.md
// §2.2: "the last time anything an F reader sees changed").
function sortExpr(sort: SortKey): string {
  if (sort === "modified_at") return "MAX(l.modified_at, f.modified_at)";
  return `l.${sort}`;
}

interface JoinedRow extends LayoutDbRow {
  f_layout_id: string | null;
  f_lineage: string | null;
  f_format: string | null;
  f_rev: number | null;
  f_created_at: string | null;
  f_modified_at: string | null;
  f_payload_json: string | null;
  f_has_magic: number | null;
  f_has_alts: number | null;
  f_has_combos: number | null;
  f_source_client: string | null;
  f_source_version: string | null;
}

const JOIN_SELECT = `
  SELECT l.*,
    f.layout_id AS f_layout_id, f.lineage AS f_lineage, f.format AS f_format, f.rev AS f_rev,
    f.created_at AS f_created_at, f.modified_at AS f_modified_at, f.payload_json AS f_payload_json,
    f.has_magic AS f_has_magic, f.has_alts AS f_has_alts, f.has_combos AS f_has_combos,
    f.source_client AS f_source_client, f.source_version AS f_source_version
  FROM layouts l LEFT JOIN layout_formats f ON f.layout_id = l.id
`;

function joinedToFormat(row: JoinedRow): FormatRow | null {
  if (row.f_lineage === null || row.f_format === null || row.f_rev === null || row.f_payload_json === null) return null;
  return rowToFormat({
    layout_id: row.f_layout_id ?? row.id,
    lineage: row.f_lineage,
    format: row.f_format,
    rev: row.f_rev,
    created_at: row.f_created_at ?? row.created_at,
    modified_at: row.f_modified_at ?? row.modified_at,
    payload_json: row.f_payload_json,
    has_magic: row.f_has_magic ?? 0,
    has_alts: row.f_has_alts ?? 0,
    has_combos: row.f_has_combos ?? 0,
    source_client: row.f_source_client,
    source_version: row.f_source_version,
  });
}

function groupJoined(results: JoinedRow[]): LayoutWithFormats | null {
  if (results.length === 0) return null;
  const layout = rowToLayout(results[0]!);
  const formats = new Map<string, FormatRow>();
  for (const row of results) {
    const f = joinedToFormat(row);
    if (f !== null) formats.set(f.lineage, f);
  }
  return { layout, formats };
}

interface ListJoinedRow extends LayoutDbRow {
  f_rev: number;
  f_format: string;
  f_created_at: string;
  f_modified_at: string;
  f_payload_json: string;
  f_has_magic: number;
  f_has_alts: number;
  f_has_combos: number;
  f_source_client: string | null;
  f_source_version: string | null;
  sort_value: string | number;
}

/** `SELECT * FROM layouts WHERE id = ?`, shared with d1/events.ts (same agent). */
export async function readLayoutById(db: D1Database, id: string): Promise<LayoutRow | null> {
  const row = await db.prepare("SELECT * FROM layouts WHERE id = ?").bind(id).first<LayoutDbRow>();
  return row === null ? null : rowToLayout(row);
}

export function d1LayoutReadStore(db: D1Database): LayoutReadStore {
  async function byName(name: string): Promise<LayoutRow | null> {
    // `name` is COLLATE NOCASE -- a plain `=` already compares
    // case-insensitively. `deleted = 0` matters here, not just as a filter: a
    // tombstone keeps its literal name (LDB-P8) so a live record can share a
    // name string with a dead one; byName must see the live one and only the
    // live one.
    const row = await db.prepare("SELECT * FROM layouts WHERE name = ? AND deleted = 0").bind(name).first<LayoutDbRow>();
    return row === null ? null : rowToLayout(row);
  }

  async function byIdWithFormats(id: string): Promise<LayoutWithFormats | null> {
    const { results } = await db.prepare(`${JOIN_SELECT} WHERE l.id = ?`).bind(id).all<JoinedRow>();
    return groupJoined(results);
  }

  async function byNameWithFormats(name: string): Promise<LayoutWithFormats | null> {
    const { results } = await db.prepare(`${JOIN_SELECT} WHERE l.name = ? AND l.deleted = 0`).bind(name).all<JoinedRow>();
    return groupJoined(results);
  }

  return {
    byId: (id) => readLayoutById(db, id),
    byName,

    async byRef(ref) {
      if (isUlidShaped(ref)) {
        const found = await readLayoutById(db, ref);
        if (found !== null) return found;
      }
      return byName(ref);
    },

    byIdWithFormats,
    byNameWithFormats,

    async byRefWithFormats(ref) {
      if (isUlidShaped(ref)) {
        const found = await byIdWithFormats(ref);
        if (found !== null) return found;
      }
      return byNameWithFormats(ref);
    },

    // Every `layout_formats` row a layout has, lineage-keyed.
    async formatsForLayout(layoutId) {
      const { results } = await db.prepare("SELECT * FROM layout_formats WHERE layout_id = ?").bind(layoutId).all<FormatDbRow>();
      const out = new Map<string, FormatRow>();
      for (const row of results) out.set(row.lineage, rowToFormat(row));
      return out;
    },

    // One batched `IN (...)` query per PAGE (chunked the same way
    // `likers` batches likes), never one query per layout.
    async formatsForLayouts(layoutIds) {
      const out = new Map<string, Map<string, FormatRow>>(layoutIds.map((id) => [id, new Map<string, FormatRow>()]));
      for (let i = 0; i < layoutIds.length; i += 90) {
        const chunk = layoutIds.slice(i, i + 90);
        const { results } = await db
          .prepare(`SELECT * FROM layout_formats WHERE layout_id IN (${chunk.map(() => "?").join(",")})`)
          .bind(...chunk)
          .all<FormatDbRow>();
        for (const row of results) out.get(row.layout_id)!.set(row.lineage, rowToFormat(row));
      }
      return out;
    },

    async readFormat(layoutId, lineage) {
      const row = await db.prepare("SELECT * FROM layout_formats WHERE layout_id = ? AND lineage = ?").bind(layoutId, lineage).first<FormatDbRow>();
      return row === null ? null : rowToFormat(row);
    },

    // Filtered, sorted, keyset-paginated live layouts that have `sourceLineage`
    // stored (`deleted = 0` always -- tombstones never appear in a list).
    async list(params: ListParams): Promise<ListPage> {
      const desc = SORT_DESC[params.sort];
      const collate = params.sort === "name" ? " COLLATE NOCASE" : "";
      const dir = desc ? "DESC" : "ASC";
      const sortColExpr = sortExpr(params.sort) + collate;

      const where: string[] = ["l.deleted = 0", "f.lineage = ?"];
      const args: unknown[] = [params.sourceLineage];
      if (params.owner !== undefined) {
        where.push("l.owner = ?");
        args.push(params.owner);
      }
      if (params.hasMagic !== undefined) {
        where.push("f.has_magic = ?");
        args.push(params.hasMagic ? 1 : 0);
      }
      if (params.hasAlts !== undefined) {
        where.push("f.has_alts = ?");
        args.push(params.hasAlts ? 1 : 0);
      }
      if (params.hasCombos !== undefined) {
        where.push("f.has_combos = ?");
        args.push(params.hasCombos ? 1 : 0);
      }
      if (params.since !== undefined) {
        where.push(`${sortExpr("modified_at")} > ?`);
        args.push(params.since);
      }
      if (params.likedBy !== undefined) {
        where.push("l.id IN (SELECT layout_id FROM likes WHERE user_id = ?)");
        args.push(params.likedBy);
      }
      if (params.cursor !== undefined) {
        const cmp = desc ? "<" : ">";
        where.push(`(${sortColExpr} ${cmp} ? OR (${sortColExpr} = ? AND l.id > ?))`);
        args.push(params.cursor.sortValue, params.cursor.sortValue, params.cursor.id);
      }

      // LDB-R12/R13: `layouts` drives the join unless a format-flag filter is
      // present. This database has one lineage, so `f.lineage = ?` matches every
      // format row, yet SQLite (no statistics on D1) takes it for a selective
      // lookup and starts from a `(lineage, ...)` index: every list then read
      // the whole catalog and sorted it, whatever the filter or the page size
      // (2026-10-05: 9,100 rows per `?owner=` call, 80% of all rows read).
      // `CROSS JOIN` is SQLite's own way to pin the left table as the outer
      // loop; same rows, same order. With `layouts` outside, an owner list
      // walks `layouts_owner_name` (migrations/0021) and a name-sorted page
      // walks `layouts_name_live`, both already in order: nothing is sorted and
      // the read stops at the limit (a cursor page first steps over the index
      // entries before its cursor). A `has_magic`/`has_alts`/`has_combos` filter
      // keeps the planner's own choice: its `(lineage, flag)` index IS selective
      // for the rare value.
      const flagFiltered = params.hasMagic !== undefined || params.hasAlts !== undefined || params.hasCombos !== undefined;
      const join = flagFiltered ? "JOIN" : "CROSS JOIN";
      const withPayload = params.withPayload !== false;
      const sql = `
    SELECT l.*, f.rev AS f_rev, f.format AS f_format, f.created_at AS f_created_at, f.modified_at AS f_modified_at,
      ${withPayload ? "f.payload_json AS f_payload_json," : ""} f.has_magic AS f_has_magic, f.has_alts AS f_has_alts, f.has_combos AS f_has_combos,
      f.source_client AS f_source_client, f.source_version AS f_source_version,
      ${sortColExpr} AS sort_value
    FROM layouts l ${join} layout_formats f ON f.layout_id = l.id
    WHERE ${where.join(" AND ")}
    ORDER BY ${sortColExpr} ${dir}, l.id ASC
    LIMIT ?`;
      args.push(params.limit + 1);

      const { results } = await db.prepare(sql).bind(...args).all<ListJoinedRow>();
      const items: ListItem[] = results.map((row) => ({
        layout: rowToLayout(row),
        // `withPayload: false` skips `rowToFormat`'s own unconditional
        // `JSON.parse(payload_json)` entirely -- there is no payload column
        // in the row to parse, and nothing downstream may read `.payload`
        // when the caller asked for this.
        format: withPayload
          ? rowToFormat({
              layout_id: row.id,
              lineage: params.sourceLineage,
              format: row.f_format,
              rev: row.f_rev,
              created_at: row.f_created_at,
              modified_at: row.f_modified_at,
              payload_json: row.f_payload_json,
              has_magic: row.f_has_magic,
              has_alts: row.f_has_alts,
              has_combos: row.f_has_combos,
              source_client: row.f_source_client,
              source_version: row.f_source_version,
            })
          : {
              layout_id: row.id,
              lineage: params.sourceLineage,
              format: row.f_format,
              rev: row.f_rev,
              created_at: row.f_created_at,
              modified_at: row.f_modified_at,
              payload: undefined,
              has_magic: row.f_has_magic !== 0,
              has_alts: row.f_has_alts !== 0,
              has_combos: row.f_has_combos !== 0,
              source: sourceFromRow({ source_client: row.f_source_client, source_version: row.f_source_version }),
            },
      }));

      let nextCursor: string | null = null;
      let page = items;
      if (items.length > params.limit) {
        page = items.slice(0, params.limit);
        const lastItem = page[page.length - 1]!;
        nextCursor = encodeCursor({ sortValue: results[params.limit - 1]!.sort_value, id: lastItem.layout.id });
      }
      return { items: page, nextCursor };
    },

    async likers(layoutIds) {
      const out = new Map<string, string[]>(layoutIds.map((id) => [id, []]));
      for (let i = 0; i < layoutIds.length; i += 90) {
        const chunk = layoutIds.slice(i, i + 90);
        const rows = await db
          .prepare(`SELECT layout_id, user_id FROM likes WHERE layout_id IN (${chunk.map(() => "?").join(",")}) ORDER BY layout_id, user_id ASC`)
          .bind(...chunk)
          .all<{ layout_id: string; user_id: string }>();
        for (const r of rows.results) out.get(r.layout_id)!.push(r.user_id);
      }
      return out;
    },

    async history(layoutId, format): Promise<Event[]> {
      const sql = format === undefined ? "SELECT * FROM events WHERE layout_id = ? ORDER BY seq ASC" : "SELECT * FROM events WHERE layout_id = ? AND format = ? ORDER BY seq ASC";
      const stmt = format === undefined ? db.prepare(sql).bind(layoutId) : db.prepare(sql).bind(layoutId, format);
      const { results } = await stmt.all<EventDbRow>();
      return results.map(rowToEvent);
    },

    async revision(layoutId, lineage, rev) {
      const revRow = await db
        .prepare("SELECT format, payload_json, event_seq FROM layout_revs WHERE layout_id = ? AND lineage = ? AND rev = ?")
        .bind(layoutId, lineage, rev)
        .first<{ format: string; payload_json: string; event_seq: number }>();
      if (revRow === null) return null;
      const eventRow = await db
        .prepare("SELECT after_json, via, source_client, source_version FROM events WHERE seq = ?")
        .bind(revRow.event_seq)
        .first<{ after_json: string | null; via: string; source_client: string | null; source_version: string | null }>();
      if (eventRow === null || eventRow.after_json === null) return null;
      return {
        format: revRow.format,
        payloadJson: revRow.payload_json,
        eventSeq: revRow.event_seq,
        afterJson: eventRow.after_json,
        via: eventRow.via,
        sourceClient: eventRow.source_client,
        sourceVersion: eventRow.source_version,
      };
    },

    async revisionPayload(layoutId, lineage, rev) {
      const row = await db
        .prepare("SELECT format, payload_json FROM layout_revs WHERE layout_id = ? AND lineage = ? AND rev = ?")
        .bind(layoutId, lineage, rev)
        .first<{ format: string; payload_json: string }>();
      return row === null ? null : { format: row.format, payloadJson: row.payload_json };
    },

    async latestRevBumpingEvent(layoutId, format) {
      const row = await db
        .prepare("SELECT * FROM events WHERE layout_id = ? AND rev IS NOT NULL AND format IS ? ORDER BY seq DESC LIMIT 1")
        .bind(layoutId, format)
        .first<EventDbRow>();
      return row === null ? null : rowToEvent(row);
    },

    // LDB-L8c: one query instead of two -- a CTE picks the "latest tombstone
    // of this name" row, then LEFT JOINs its likes so a name with no
    // tombstone (zero rows back), a tombstone with none (one row, `user_id`
    // null), and a tombstone with likes (one row per liker) are all told
    // apart from the SAME single round trip.
    async tombstoneLikers(name) {
      const { results } = await db
        .prepare(
          `WITH t AS (SELECT id FROM layouts WHERE name = ? AND deleted = 1 ORDER BY modified_at DESC, layout_rev DESC LIMIT 1)
       SELECT t.id AS tombstone_id, lk.user_id AS user_id FROM t LEFT JOIN likes lk ON lk.layout_id = t.id ORDER BY lk.user_id ASC`,
        )
        .bind(name)
        .all<{ tombstone_id: string; user_id: string | null }>();
      if (results.length === 0) return { tombstoneId: null, userIds: [] };
      const tombstoneId = results[0]!.tombstone_id;
      const userIds = results.filter((r): r is { tombstone_id: string; user_id: string } => r.user_id !== null).map((r) => r.user_id);
      return { tombstoneId, userIds };
    },

    async authorExists(userId) {
      return (await db.prepare("SELECT 1 FROM authors WHERE user_id = ?").bind(userId).first()) !== null;
    },

    async layoutPresence(id) {
      const row = await db.prepare("SELECT deleted FROM layouts WHERE id = ?").bind(id).first<{ deleted: number }>();
      return row === null ? { exists: false, live: false } : { exists: true, live: row.deleted === 0 };
    },

    async approvedLink(layoutId) {
      const row = await db.prepare("SELECT link FROM layouts WHERE id = ?").bind(layoutId).first<{ link: string | null }>();
      return row === null ? null : { link: row.link };
    },

    async liveCountByOwner(owner) {
      const row = await db.prepare("SELECT COUNT(*) AS n FROM layouts WHERE owner = ? AND deleted = 0").bind(owner).first<{ n: number }>();
      return row?.n ?? 0;
    },

    async likeCountByUser(userId) {
      const row = await db.prepare("SELECT COUNT(*) AS n FROM likes WHERE user_id = ?").bind(userId).first<{ n: number }>();
      return row?.n ?? 0;
    },
  };
}
