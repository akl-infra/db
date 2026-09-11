// GET /v1/layouts (list + `?full=1`), /v1/layouts/{ref}, /likes, /history,
// /rev/{n} (21-formats.md §2.4). `?format=` is required wherever a payload
// is returned or a layout could have several -- D4: no default.
import { Hono, type Context } from "hono";
import type { Bindings } from "../env";
import { canonical } from "../core/canonical";
import { badRequest, formatAbsent, formatRequired, held, notFound, unknownFormat } from "../core/errors";
import { cachePut, conditional, etagFor, headSeq } from "../core/etag";
import type { EventDbRow } from "../core/events";
import { rowToEvent, sourceOfEvent } from "../core/events";
import { resolveReadFormat, sourceLineageFor } from "../core/formatread";
import {
  byRefWithFormats,
  decodeCursor,
  formatsMapToWire,
  fullWire,
  layoutToWire,
  list as listRecords,
  type ListCursor,
  type SortKey,
} from "../core/records";
import { get as getFormat, list as listFormats, translate } from "../formats/registry";

const CACHE_CONTROL = "public, max-age=10";
const SORT_KEYS: readonly SortKey[] = ["name", "modified_at", "created_at", "like_count"];

function parseFormatRequired(raw: string | undefined): string {
  if (raw === undefined) throw formatRequired();
  return raw;
}

function parseLimit(raw: string | undefined): number {
  if (raw === undefined) return 100;
  const n = Number(raw);
  if (!Number.isInteger(n) || n <= 0) throw badRequest(`invalid 'limit' (expected a positive integer)`, "limit");
  return Math.min(n, 1000);
}

function parseSort(raw: string | undefined): SortKey {
  if (raw === undefined) return "name";
  if (!(SORT_KEYS as string[]).includes(raw)) {
    throw badRequest(`unknown 'sort' value '${raw}' (expected one of ${SORT_KEYS.join(", ")})`, "sort");
  }
  return raw as SortKey;
}

function parseCursor(raw: string | undefined): ListCursor | undefined {
  if (raw === undefined) return undefined;
  const decoded = decodeCursor(raw);
  if (decoded === null) throw badRequest(`invalid 'cursor'`, "cursor");
  return decoded;
}

function parseSince(raw: string | undefined): string | undefined {
  if (raw === undefined) return undefined;
  if (Number.isNaN(Date.parse(raw))) throw badRequest(`invalid 'since' (expected an ISO 8601 timestamp)`, "since");
  return raw;
}

function parseHasMagic(raw: string | undefined): boolean | undefined {
  if (raw === "true") return true;
  if (raw === "false") return false;
  return undefined;
}

const LIKED_BY_RE = /^\d{17,20}$/;
function parseLikedBy(raw: string | undefined): string | undefined {
  if (raw === undefined) return undefined;
  if (!LIKED_BY_RE.test(raw)) throw badRequest(`invalid 'liked_by' (expected a Discord user id)`, "liked_by");
  return raw;
}

// Resolves `?format=F` to the SQL join's source lineage, 400ing on an
// unregistered id and 404ing (format_absent) on a registered one no
// stored lineage reaches (registry-level, independent of any one layout).
function resolveSourceLineage(as: string): string {
  const resolved = sourceLineageFor(as);
  if ("unknown" in resolved) throw unknownFormat(as, resolved.known);
  if ("absent" in resolved) throw formatAbsent(as);
  return resolved.lineage;
}

export const layoutsRoute = new Hono<{ Bindings: Bindings }>();

layoutsRoute.get("/v1/layouts", async (c) => {
  const db = c.env.DB;
  const full = c.req.query("full") === "1";
  const format = parseFormatRequired(c.req.query("format"));

  if (full) return handleFullDump(c, format);

  const owner = c.req.query("owner");
  const hasMagic = parseHasMagic(c.req.query("has_magic"));
  const since = parseSince(c.req.query("since"));
  const likedBy = parseLikedBy(c.req.query("liked_by"));
  const sort = parseSort(c.req.query("sort"));
  const limit = parseLimit(c.req.query("limit"));
  const cursor = parseCursor(c.req.query("cursor"));
  const sourceLineage = resolveSourceLineage(format);

  const seq = await headSeq(db);
  const query = { format, owner, hasMagic, since, likedBy, sort, limit, cursor };
  const etag = await etagFor(seq, query);
  const short = await conditional(c, etag, CACHE_CONTROL);
  if (short) return short;

  const page = await listRecords(db, { sourceLineage, owner, hasMagic, since, likedBy, sort, limit, cursor });
  const items = page.items.map(({ layout, format: row }) => {
    const translated = row.format === format ? { payload: row.payload } : translate({ format: row.format, payload: row.payload }, format);
    const summary = { rev: row.rev, created_at: row.created_at, modified_at: row.modified_at, has_magic: row.has_magic, source: row.source };
    if ("held" in translated) {
      return { ...layoutToWire(layout), formats: { [row.format]: summary }, held: true, format: translated.format, see: translated.see };
    }
    return {
      ...layoutToWire(layout),
      formats: { [row.format]: summary },
      format,
      payload: translated.payload,
      ...(row.format !== format ? { derived_from: row.format } : {}),
    };
  });
  const res = c.json({ items, next_cursor: page.nextCursor });
  res.headers.set("ETag", etag);
  res.headers.set("Cache-Control", CACHE_CONTROL);
  await cachePut(c, res.clone());
  return res;
});

const FULL_PAGE_SIZE = 500;

async function likesByLayout(db: Bindings["DB"], ids: string[]): Promise<Map<string, string[]>> {
  const out = new Map<string, string[]>(ids.map((id) => [id, []]));
  for (let i = 0; i < ids.length; i += 90) {
    const chunk = ids.slice(i, i + 90);
    const rows = await db
      .prepare(`SELECT layout_id, user_id FROM likes WHERE layout_id IN (${chunk.map(() => "?").join(",")}) ORDER BY layout_id, user_id ASC`)
      .bind(...chunk)
      .all<{ layout_id: string; user_id: string }>();
    for (const r of rows.results) out.get(r.layout_id)!.push(r.user_id);
  }
  return out;
}

async function handleFullDump(c: Context<{ Bindings: Bindings }>, format: string): Promise<Response> {
  const db = c.env.DB;
  const likedBy = parseLikedBy(c.req.query("liked_by"));
  const sourceLineage = resolveSourceLineage(format);

  const seq = await headSeq(db);
  const etag = await etagFor(seq, { full: 1, format, likedBy });
  const short = await conditional(c, etag, CACHE_CONTROL);
  if (short) return short;

  const encoder = new TextEncoder();
  const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>();
  const writer = writable.getWriter();

  const pump = (async () => {
    try {
      await writer.write(encoder.encode('{"items":['));
      let cursor: ListCursor | undefined;
      let first = true;
      for (;;) {
        const page = await listRecords(db, { sourceLineage, sort: "name", limit: FULL_PAGE_SIZE, cursor, likedBy });
        const likes = await likesByLayout(db, page.items.map(({ layout }) => layout.id));
        for (const { layout, format: row } of page.items) {
          const translated = format === row.format ? { payload: row.payload } : translate({ format: row.format, payload: row.payload }, format);
          const base = { ...layoutToWire(layout), likes: likes.get(layout.id) ?? [] };
          const body: Record<string, unknown> =
            "held" in translated
              ? { ...base, held: true, format: row.format }
              : { ...base, payload: translated.payload, format, ...(row.format !== format ? { derived_from: row.format } : {}) };
          await writer.write(encoder.encode((first ? "" : ",") + canonical(body)));
          first = false;
        }
        if (page.nextCursor === null) break;
        const decoded = decodeCursor(page.nextCursor);
        if (decoded === null) break;
        cursor = decoded;
      }
      await writer.write(encoder.encode("]}"));
    } catch (e) {
      console.error("full=1 dump stream failed", e);
    } finally {
      await writer.close();
    }
  })();
  c.executionCtx.waitUntil(pump);

  return new Response(readable, {
    headers: { "Content-Type": "application/json", ETag: etag, "Cache-Control": CACHE_CONTROL },
  });
}

layoutsRoute.get("/v1/layouts/:ref", async (c) => {
  const db = c.env.DB;
  const ref = c.req.param("ref");
  const format = parseFormatRequired(c.req.query("format"));

  const lwf = await byRefWithFormats(db, ref);
  if (lwf === null) throw notFound(`no layout '${ref}'`, ref);

  const resolved = resolveReadFormat(lwf.formats, format);

  const likes = await likesByLayout(db, [lwf.layout.id]);
  return c.json({
    ...fullWire(lwf.layout, lwf.formats, { format: resolved.format, payload: resolved.payload, derived_from: resolved.derived_from }),
    likes: likes.get(lwf.layout.id) ?? [],
  });
});

layoutsRoute.get("/v1/layouts/:ref/likes", async (c) => {
  const db = c.env.DB;
  const ref = c.req.param("ref");
  const rec = await byRefWithFormats(db, ref);
  if (rec === null) throw notFound(`no layout '${ref}'`, ref);

  const { results } = await db.prepare("SELECT user_id FROM likes WHERE layout_id = ? ORDER BY user_id ASC").bind(rec.layout.id).all<{ user_id: string }>();
  return c.json({ user_ids: results.map((r) => r.user_id) });
});

// 21-formats.md §2.4: `?format=F` is an OPTIONAL filter on `/history`
// (absent means every event, not a default -- D4's exception is explicit
// here).
layoutsRoute.get("/v1/layouts/:ref/history", async (c) => {
  const db = c.env.DB;
  const ref = c.req.param("ref");
  const format = c.req.query("format");
  const rec = await byRefWithFormats(db, ref);
  if (rec === null) throw notFound(`no layout '${ref}'`, ref);

  const sql = format === undefined ? "SELECT * FROM events WHERE layout_id = ? ORDER BY seq ASC" : "SELECT * FROM events WHERE layout_id = ? AND format = ? ORDER BY seq ASC";
  const stmt = format === undefined ? db.prepare(sql).bind(rec.layout.id) : db.prepare(sql).bind(rec.layout.id, format);
  const { results } = await stmt.all<EventDbRow>();
  const items = results.map(rowToEvent).map((e) => ({
    seq: e.seq,
    format: e.format,
    rev: e.rev,
    at: e.at,
    actor: e.actor,
    via: e.via,
    kind: e.kind,
    admin: e.admin,
    source: e.source,
  }));
  return c.json(items);
});

layoutsRoute.get("/v1/layouts/:ref/rev/:n", async (c) => {
  const db = c.env.DB;
  const ref = c.req.param("ref");
  const format = parseFormatRequired(c.req.query("format"));
  const nRaw = c.req.param("n");
  const n = Number(nRaw);
  if (!Number.isInteger(n) || n <= 0) throw badRequest(`invalid rev '${nRaw}' (expected a positive integer)`, "n");

  const rec = await byRefWithFormats(db, ref);
  if (rec === null) throw notFound(`no layout '${ref}'`, ref);

  const mod = getFormat(format);
  // MF-4/§2.4: "an unregistered id stays 400 unknown_format" -- every
  // route, not just detail/list. This route used to throw a bare
  // `badRequest` here, the one place in the router that didn't use the
  // shared factory (found by the MF-4 generated matrix).
  if (mod === undefined) throw unknownFormat(format, listFormats().map((f) => f.id));
  // An output format (mana2/1) has no `layout_revs` row of its own --
  // revs are numbered per (layout, lineage), and a derived format never
  // has a lineage. Deliberately narrower than the detail route (which
  // derives output formats): "rev N" only ever means a STORED format's
  // own history, so this stays a plain `bad_request` rather than
  // `format_absent` (nothing is missing on this layout -- the request
  // itself doesn't name a concept the route supports).
  if (mod.role !== "stored") throw badRequest(`'${format}' is an output format -- it has no numbered history of its own`, "format");
  const lin = format.slice(0, format.indexOf("/"));

  const [revRow, eventRow] = await Promise.all([
    db.prepare("SELECT format, payload_json FROM layout_revs WHERE layout_id = ? AND lineage = ? AND rev = ?").bind(rec.layout.id, lin, n).first<{ format: string; payload_json: string }>(),
    db
      .prepare("SELECT after_json, via, source_client, source_version FROM events WHERE layout_id = ? AND format = ? AND rev = ?")
      .bind(rec.layout.id, format, n)
      .first<{ after_json: string | null; via: string; source_client: string | null; source_version: string | null }>(),
  ]);
  if (revRow === null || eventRow === null || eventRow.after_json === null) {
    throw notFound(`layout '${ref}' has no rev ${n} of '${format}'`, ref);
  }

  const after = JSON.parse(eventRow.after_json) as Record<string, unknown>;
  const payload: unknown = JSON.parse(revRow.payload_json);
  const result = format === revRow.format ? { payload } : translate({ format: revRow.format, payload }, format);
  if ("held" in result) throw held(result.format, result.see);

  return c.json({ ...after, format, payload: result.payload, source: sourceOfEvent(eventRow) });
});
