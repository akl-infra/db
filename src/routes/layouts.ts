// GET /v1/layouts (list + `?full=1`), /v1/layouts/{ref}(?as=), /likes,
// /history, /rev/{n}(?as=) (03 §2, 07 §6 S6).
import { Hono, type Context } from "hono";
import type { Bindings } from "../env";
import { canonical } from "../core/canonical";
import { badRequest, held, notFound, unknownFormat } from "../core/errors";
import { cachePut, conditional, etagFor, headSeq } from "../core/etag";
import type { EventDbRow, RecordSansPayload } from "../core/events";
import { rowToEvent } from "../core/events";
import {
  byRef,
  decodeCursor,
  list as listRecords,
  type ListCursor,
  type RecordRow,
  type SortKey,
} from "../core/records";
import { get as getFormat, list as listFormats, translate } from "../formats/registry";

const CACHE_CONTROL = "public, max-age=10";
const SORT_KEYS: readonly SortKey[] = ["name", "modified_at", "created_at", "like_count"];
const DEFAULT_FORMAT = "akl/1"; // 03 §1: every read that returns a payload defaults `as` here

function sansPayload(rec: RecordRow): RecordSansPayload {
  const { payload: _payload, ...rest } = rec;
  return rest;
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

// `?as=` validated against the registry up front so a bad format 400s
// before any D1 read, on every route that takes it.
function resolveAsFormat(raw: string | undefined): string {
  const as = raw ?? DEFAULT_FORMAT;
  if (getFormat(as) === undefined) {
    throw unknownFormat(
      as,
      listFormats().map((f) => f.id),
    );
  }
  return as;
}

export const layoutsRoute = new Hono<{ Bindings: Bindings }>();

layoutsRoute.get("/v1/layouts", async (c) => {
  const db = c.env.DB;
  const full = c.req.query("full") === "1";

  if (full) return handleFullDump(c);

  const owner = c.req.query("owner");
  const format = c.req.query("format");
  const hasMagic = parseHasMagic(c.req.query("has_magic"));
  const since = parseSince(c.req.query("since"));
  const sort = parseSort(c.req.query("sort"));
  const limit = parseLimit(c.req.query("limit"));
  const cursor = parseCursor(c.req.query("cursor"));

  const seq = await headSeq(db);
  const query = { owner, format, hasMagic, since, sort, limit, cursor };
  const etag = await etagFor(seq, query);
  const short = await conditional(c, etag, CACHE_CONTROL);
  if (short) return short;

  const page = await listRecords(db, { owner, format, hasMagic, since, sort, limit, cursor });
  const res = c.json({ items: page.items.map(sansPayload), next_cursor: page.nextCursor });
  res.headers.set("ETag", etag);
  res.headers.set("Cache-Control", CACHE_CONTROL);
  await cachePut(c, res.clone());
  return res;
});

// `?full=1&as=<f>`: every live record, translated, streamed in keyset
// pages of 500 (07 §6 S6) so the response never buffers the whole corpus
// in memory. A held record contributes its record fields (already minus
// `payload`) plus `held: true` -- `format` is already the record's own
// native format from that same spread, so nothing extra is added for it
// (03 §1's "record fields plus held: true, format").
const FULL_PAGE_SIZE = 500;

async function handleFullDump(c: Context<{ Bindings: Bindings }>): Promise<Response> {
  const db = c.env.DB;
  const as = resolveAsFormat(c.req.query("as"));

  const seq = await headSeq(db);
  const etag = await etagFor(seq, { full: 1, as });
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
        const page = await listRecords(db, { sort: "name", limit: FULL_PAGE_SIZE, cursor });
        for (const rec of page.items) {
          const result = translate(rec, as);
          const body: Record<string, unknown> =
            "held" in result ? { ...sansPayload(rec), held: true } : { ...sansPayload(rec), payload: result.payload };
          await writer.write(encoder.encode((first ? "" : ",") + canonical(body)));
          first = false;
        }
        if (page.nextCursor === null) break;
        const decoded = decodeCursor(page.nextCursor);
        if (decoded === null) break; // unreachable: we just encoded it ourselves
        cursor = decoded;
      }
      await writer.write(encoder.encode("]}"));
    } catch (e) {
      console.error("full=1 dump stream failed", e); // never surfaced to the client -- the stream is already open
    } finally {
      await writer.close();
    }
  })();
  c.executionCtx.waitUntil(pump); // keep the isolate alive for the writer loop even if the client stops reading

  // No `cachePut` here: it would mean `await`ing the whole dump (a
  // `Response.clone()`'d stream tees the SAME underlying writes, so
  // `caches.default.put()` only resolves once `pump` has finished) before
  // returning anything to the client, which defeats streaming entirely.
  // The conditional() call above still gets the "consult" half of caching
  // (a 304, or a prior cached response, short-circuits before any of this
  // runs); the "put" half is skipped for this one streamed route.
  return new Response(readable, {
    headers: { "Content-Type": "application/json", ETag: etag, "Cache-Control": CACHE_CONTROL },
  });
}

layoutsRoute.get("/v1/layouts/:ref", async (c) => {
  const db = c.env.DB;
  const ref = c.req.param("ref");
  const as = resolveAsFormat(c.req.query("as"));

  const rec = await byRef(db, ref);
  if (rec === null) throw notFound(`no layout '${ref}'`, ref);

  const result = translate(rec, as);
  if ("held" in result) throw held(result.format, result.see);

  return c.json({ ...sansPayload(rec), payload: result.payload });
});

layoutsRoute.get("/v1/layouts/:ref/likes", async (c) => {
  const db = c.env.DB;
  const ref = c.req.param("ref");
  const rec = await byRef(db, ref);
  if (rec === null) throw notFound(`no layout '${ref}'`, ref);

  const { results } = await db
    .prepare("SELECT user_id FROM likes WHERE layout_id = ? ORDER BY user_id ASC")
    .bind(rec.id)
    .all<{ user_id: string }>();
  return c.json({ user_ids: results.map((r) => r.user_id) });
});

layoutsRoute.get("/v1/layouts/:ref/history", async (c) => {
  const db = c.env.DB;
  const ref = c.req.param("ref");
  const rec = await byRef(db, ref);
  if (rec === null) throw notFound(`no layout '${ref}'`, ref);

  const { results } = await db
    .prepare("SELECT * FROM events WHERE layout_id = ? ORDER BY seq ASC")
    .bind(rec.id)
    .all<EventDbRow>();
  const items = results.map(rowToEvent).map((e) => ({
    seq: e.seq,
    rev: e.rev,
    at: e.at,
    actor: e.actor,
    via: e.via,
    kind: e.kind,
    admin: e.admin,
  }));
  return c.json(items);
});

layoutsRoute.get("/v1/layouts/:ref/rev/:n", async (c) => {
  const db = c.env.DB;
  const ref = c.req.param("ref");
  const as = resolveAsFormat(c.req.query("as"));
  const nRaw = c.req.param("n");
  const n = Number(nRaw);
  if (!Number.isInteger(n) || n <= 0) throw badRequest(`invalid rev '${nRaw}' (expected a positive integer)`, "n");

  const rec = await byRef(db, ref);
  if (rec === null) throw notFound(`no layout '${ref}'`, ref);

  const [revRow, eventRow] = await Promise.all([
    db
      .prepare("SELECT format, payload_json FROM layout_revs WHERE layout_id = ? AND rev = ?")
      .bind(rec.id, n)
      .first<{ format: string; payload_json: string }>(),
    db
      .prepare("SELECT after_json FROM events WHERE layout_id = ? AND rev = ?")
      .bind(rec.id, n)
      .first<{ after_json: string | null }>(),
  ]);
  if (revRow === null || eventRow === null || eventRow.after_json === null) {
    throw notFound(`layout '${ref}' has no rev ${n}`, ref);
  }

  const after = JSON.parse(eventRow.after_json) as RecordSansPayload;
  const payload: unknown = JSON.parse(revRow.payload_json);
  const result = translate({ format: revRow.format, payload }, as);
  if ("held" in result) throw held(result.format, result.see);

  return c.json({ ...after, payload: result.payload });
});
