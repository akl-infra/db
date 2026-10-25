// DynamoDB implementation of `LayoutReadStore` (src/store/port.ts). Owner: P2
// lane G. Single-layout reads are consistent GetItems of CAT/<id>; every
// list-shaped read runs over the catalog read model (lane H, design §2.7).
import { GetCommand, QueryCommand, type QueryCommandOutput } from "@aws-sdk/lib-dynamodb";
import { withRetry } from "./tx";
import { rowToEvent, type Event } from "../../core/events";
import {
  encodeCursor,
  isUlidShaped,
  type FormatRow,
  type LayoutRow,
  type LayoutWithFormats,
  type ListItem,
  type ListPage,
  type ListParams,
  type SortKey,
} from "../../core/records";
import type { LayoutReadStore } from "../port";
import type { CatalogLayout, DdbContext, Item } from "./contracts";
import { compareBinary, compareSortValue, compareSqlite } from "./catalog";
import { collectEvents, readHeadSeq } from "./evquery";
import { consistentGet } from "./head";
import { catKey, eventKey, fold, nameKey, revKey, userLikesPrefix, likesPrefix } from "./keys";
import { getPayload } from "./payload";
import { eventRow, formatRowsOf, layoutRowOf } from "./schema/core";

const SORT_DESC: Record<SortKey, boolean> = { name: false, modified_at: true, created_at: true, like_count: true };

const cmpBinary = compareBinary;

function sortValueOf(sort: SortKey, l: CatalogLayout, lineage: string): string | number {
  switch (sort) {
    case "name":
      return l.layout.name;
    case "created_at":
      return l.layout.created_at;
    case "like_count":
      return l.layout.like_count;
    case "modified_at": {
      const f = l.formats.get(lineage)!.modified_at;
      return cmpBinary(l.layout.modified_at, f) >= 0 ? l.layout.modified_at : f;
    }
  }
}

function cmpSortValues(sort: SortKey, a: string | number, b: string | number): number {
  return compareSqlite(a, b, sort === "name" ? "nocase" : "binary");
}

// ---------------------------------------------------------------------------

async function getItem(ctx: DdbContext, key: { pk: string; sk: string }): Promise<Item | undefined> {
  return consistentGet(ctx, key);
}

async function queryCount(ctx: DdbContext, pk: string, skPrefix: string): Promise<number> {
  let n = 0;
  let start: Record<string, unknown> | undefined;
  do {
    const r: QueryCommandOutput = await withRetry(() => ctx.doc.send(
      new QueryCommand({
        TableName: ctx.tables.main,
        KeyConditionExpression: "pk = :p AND begins_with(sk, :s)",
        ExpressionAttributeValues: { ":p": pk, ":s": skPrefix },
        Select: "COUNT",
        ConsistentRead: true,
        ExclusiveStartKey: start,
      }),
    ));
    n += r.Count ?? 0;
    start = r.LastEvaluatedKey;
  } while (start !== undefined);
  return n;
}

export async function likersOf(ctx: DdbContext, layoutId: string): Promise<string[]> {
  const out: string[] = [];
  const k = likesPrefix(layoutId);
  let start: Record<string, unknown> | undefined;
  do {
    const r: QueryCommandOutput = await withRetry(() => ctx.doc.send(
      new QueryCommand({
        TableName: ctx.tables.main,
        KeyConditionExpression: "pk = :p AND begins_with(sk, :s)",
        ExpressionAttributeValues: { ":p": k.pk, ":s": k.sk },
        ProjectionExpression: "user_id",
        ConsistentRead: true,
        ExclusiveStartKey: start,
      }),
    ));
    for (const it of r.Items ?? []) out.push(it.user_id as string);
    start = r.LastEvaluatedKey;
  } while (start !== undefined);
  return out;
}

export function ddbLayoutReadStore(ctx: DdbContext): LayoutReadStore {
  const catItem = (id: string) => getItem(ctx, catKey(id));

  /** The live layout's CAT item for `name`: the NAME claim, then the layout, re-checked (design §2.8). */
  async function liveItemByName(name: string): Promise<Item | undefined> {
    for (let attempt = 0; attempt < 5; attempt++) {
      const claim = await getItem(ctx, nameKey(name));
      if (claim === undefined) return undefined;
      const cat = await catItem(claim.id as string);
      if (cat !== undefined && cat.deleted === 0 && fold(cat.name as string) === fold(name)) return cat;
      // Renamed or deleted between the two reads: look again.
    }
    throw new Error(`name claim for '${name}' does not settle`);
  }

  async function withFormats(item: Item | undefined): Promise<LayoutWithFormats | null> {
    if (item === undefined) return null;
    return { layout: layoutRowOf(item), formats: await formatRowsOf(ctx.blobs, item) };
  }

  const byId = async (id: string): Promise<LayoutRow | null> => {
    const it = await catItem(id);
    return it === undefined ? null : layoutRowOf(it);
  };
  const byName = async (name: string): Promise<LayoutRow | null> => {
    const it = await liveItemByName(name);
    return it === undefined ? null : layoutRowOf(it);
  };

  return {
    byId,
    byName,
    async byRef(ref) {
      if (isUlidShaped(ref)) {
        const found = await byId(ref);
        if (found !== null) return found;
      }
      return byName(ref);
    },

    byIdWithFormats: async (id) => withFormats(await catItem(id)),
    byNameWithFormats: async (name) => withFormats(await liveItemByName(name)),
    async byRefWithFormats(ref) {
      if (isUlidShaped(ref)) {
        const found = await withFormats(await catItem(ref));
        if (found !== null) return found;
      }
      return withFormats(await liveItemByName(ref));
    },

    async formatsForLayout(layoutId) {
      const it = await catItem(layoutId);
      return it === undefined ? new Map() : formatRowsOf(ctx.blobs, it);
    },

    async formatsForLayouts(layoutIds) {
      const view = await ctx.catalog.current();
      const out = new Map<string, Map<string, FormatRow>>();
      for (const id of layoutIds) out.set(id, new Map(view.layouts.get(id)?.formats ?? []));
      return out;
    },

    async readFormat(layoutId, lineage) {
      const it = await catItem(layoutId);
      if (it === undefined) return null;
      return (await formatRowsOf(ctx.blobs, it)).get(lineage) ?? null;
    },

    async list(params: ListParams): Promise<ListPage> {
      const view = await ctx.catalog.current();
      const desc = SORT_DESC[params.sort];
      const lineage = params.sourceLineage;
      const rows: { l: CatalogLayout; value: string | number }[] = [];
      for (const l of view.layouts.values()) {
        if (l.layout.deleted) continue;
        const f = l.formats.get(lineage);
        if (f === undefined) continue;
        if (params.owner !== undefined && l.layout.owner !== params.owner) continue;
        if (params.hasMagic !== undefined && f.has_magic !== params.hasMagic) continue;
        if (params.hasAlts !== undefined && f.has_alts !== params.hasAlts) continue;
        if (params.hasCombos !== undefined && f.has_combos !== params.hasCombos) continue;
        if (params.since !== undefined) {
          const m = cmpBinary(l.layout.modified_at, f.modified_at) >= 0 ? l.layout.modified_at : f.modified_at;
          if (!(cmpBinary(m, params.since) > 0)) continue;
        }
        if (params.likedBy !== undefined && !l.likers.includes(params.likedBy)) continue;
        const value = sortValueOf(params.sort, l, lineage);
        if (params.cursor !== undefined) {
          const c = compareSortValue(params.sort, value, params.cursor.sortValue);
          const after = desc ? c < 0 : c > 0;
          if (!(after || (c === 0 && cmpBinary(l.layout.id, params.cursor.id) > 0))) continue;
        }
        rows.push({ l, value });
      }
      rows.sort((a, b) => {
        const c = cmpSortValues(params.sort, a.value, b.value);
        if (c !== 0) return desc ? -c : c;
        return cmpBinary(a.l.layout.id, b.l.layout.id);
      });
      const withPayload = params.withPayload !== false;
      const page = rows.slice(0, params.limit);
      const items: ListItem[] = page.map(({ l }) => {
        const f = l.formats.get(lineage)!;
        return { layout: l.layout, format: withPayload ? f : { ...f, payload: undefined } };
      });
      const nextCursor = rows.length > params.limit ? encodeCursor({ sortValue: page[page.length - 1]!.value, id: page[page.length - 1]!.l.layout.id }) : null;
      return { items, nextCursor };
    },

    async likers(layoutIds) {
      const out = new Map<string, string[]>(layoutIds.map((id) => [id, []]));
      const ids = [...out.keys()];
      for (let i = 0; i < ids.length; i += 10) {
        await Promise.all(ids.slice(i, i + 10).map(async (id) => out.set(id, await likersOf(ctx, id))));
      }
      return out;
    },

    async history(layoutId, format): Promise<Event[]> {
      const hi = await readHeadSeq(ctx);
      const rows = await collectEvents(ctx, {
        pk: `EVL#${layoutId}`,
        lo: 1,
        hi,
        ...(format === undefined ? {} : { filter: { expr: "#fmt = :fmt", names: { "#fmt": "format" }, values: { ":fmt": format } } }),
      });
      return rows.map((r) => rowToEvent(eventRow(r) as never));
    },

    async revision(layoutId, lineage, rev) {
      const r = await getItem(ctx, revKey(layoutId, lineage, rev));
      if (r === undefined) return null;
      const ev = await getItem(ctx, eventKey(r.event_seq as number));
      if (ev === undefined || ev.after_json === null) return null;
      const payloadJson = typeof r.payload_ref === "string" ? await getPayload(ctx.blobs, r.payload_ref) : (r.payload_json as string);
      return {
        format: r.format as string,
        payloadJson,
        eventSeq: r.event_seq as number,
        afterJson: ev.after_json as string,
        via: ev.via as string,
        sourceClient: (ev.source_client as string | null) ?? null,
        sourceVersion: (ev.source_version as string | null) ?? null,
      };
    },

    async revisionPayload(layoutId, lineage, rev) {
      const r = await getItem(ctx, revKey(layoutId, lineage, rev));
      if (r === undefined) return null;
      const payloadJson = typeof r.payload_ref === "string" ? await getPayload(ctx.blobs, r.payload_ref) : (r.payload_json as string);
      return { format: r.format as string, payloadJson };
    },

    async latestRevBumpingEvent(layoutId, format) {
      const hi = await readHeadSeq(ctx);
      const rows = await collectEvents(
        ctx,
        {
          pk: `EVL#${layoutId}`,
          lo: 1,
          hi,
          desc: true,
          filter:
            format === null
              ? { expr: "attribute_type(rev, :n) AND attribute_type(#fmt, :null)", names: { "#fmt": "format" }, values: { ":n": "N", ":null": "NULL" } }
              : { expr: "attribute_type(rev, :n) AND #fmt = :fmt", names: { "#fmt": "format" }, values: { ":n": "N", ":fmt": format } },
        },
        1,
      );
      return rows[0] === undefined ? null : rowToEvent(eventRow(rows[0]) as never);
    },

    // The latest tombstone holding the name (NOCASE) and its likers, from the catalog.
    async tombstoneLikers(name) {
      const view = await ctx.catalog.current();
      const folded = fold(name);
      let best: CatalogLayout | undefined;
      for (const l of view.layouts.values()) {
        if (!l.layout.deleted || fold(l.layout.name) !== folded) continue;
        if (best === undefined) best = l;
        else {
          const c = cmpBinary(l.layout.modified_at, best.layout.modified_at) || l.layout.layout_rev - best.layout.layout_rev;
          if (c > 0 || (c === 0 && cmpBinary(l.layout.id, best.layout.id) < 0)) best = l;
        }
      }
      return best === undefined ? { tombstoneId: null, userIds: [] } : { tombstoneId: best.layout.id, userIds: [...best.likers] };
    },

    async authorExists(userId) {
      return (await getItem(ctx, { pk: "AUTHORS", sk: userId })) !== undefined;
    },

    async layoutPresence(id) {
      const r = await withRetry(() => ctx.doc.send(
        new GetCommand({ TableName: ctx.tables.main, Key: catKey(id), ConsistentRead: true, ProjectionExpression: "deleted" }),
      ));
      return r.Item === undefined ? { exists: false, live: false } : { exists: true, live: r.Item.deleted === 0 };
    },

    async approvedLink(layoutId) {
      const it = await catItem(layoutId);
      return it === undefined ? null : { link: (it.link as string | null) ?? null };
    },

    async liveCountByOwner(owner) {
      const view = await ctx.catalog.current();
      let n = 0;
      for (const l of view.layouts.values()) if (!l.layout.deleted && l.layout.owner === owner) n++;
      return n;
    },

    async likeCountByUser(userId) {
      const k = userLikesPrefix(userId);
      return queryCount(ctx, k.pk, k.sk);
    },
  };
}
