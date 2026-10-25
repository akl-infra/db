// Lane G's slice of the item model (src/store/ddb/contracts.ts `LaneSchema`,
// design/p2-p5-briefs.md): rows of these tables <-> their DynamoDB items.
//
//   layouts + layout_formats  CAT/<id>      one item, formats in `fmt` keyed by lineage
//   (live layouts)            NAME#<fold>/LIVE   claim, derived
//   layout_revs               L#<id>/V#<lineage|->#<rev 8>
//   likes                     L#<id>/LK#<user>   + U#<user>/LK#<id> (derived)
//   events                    EV/<seq 12>        + EVL#/EVK#/EVA# mirrors (derived)
//   layouts_head              META/HEAD.live     (seq and max_at come from events)
//   import_state              STATE/<key>
//   import_map                IMPORTMAP/<upstream_id>
//
// Rows are D1-shaped (0/1 booleans, JSON columns as strings). A payload over
// SPILL_BYTES is stored as `payload_ref` (a blob key); `inlinePayloads` puts
// it back before `fromItems`, `payloadBlobs` lists what `toItems` spilled.
import type { D1Row, Item, LaneSchema, RowsByTable } from "../contracts";
import {
  catKey,
  eventActorKey,
  eventKey,
  eventKindKey,
  eventLayoutKey,
  HEAD_KEY,
  importMapKey,
  likeKey,
  nameKey,
  revKey,
  stateKey,
  userLikeKey,
} from "../keys";
import { byteLength, getPayload, payloadRef, SPILL_BYTES } from "../payload";
import type { BlobStore } from "../../../platform/port";
import { rowToFormat, rowToLayout, type FormatDbRow, type FormatRow, type LayoutDbRow, type LayoutRow } from "../../../core/records";

export const LAYOUT_COLUMNS = [
  "id", "name", "owner", "n", "layout_rev", "created_at", "modified_at", "deleted", "like_count", "like_adjust", "link",
  "upstream_source", "upstream_id", "upstream_state", "source_client", "source_version",
] as const;

/** The per-format columns kept inside `CAT.fmt.<lineage>` (layout_id and lineage are implied by the key). */
export const FORMAT_COLUMNS = [
  "format", "rev", "created_at", "modified_at", "has_magic", "has_alts", "has_combos", "source_client", "source_version",
] as const;

export const EVENT_COLUMNS = [
  "seq", "at", "kind", "layout_id", "name", "owner", "format", "rev", "actor", "via", "admin", "detail_json", "before_json", "after_json",
  "source_client", "source_version",
] as const;

type Fmt = Record<string, unknown>;

function pick(row: D1Row, cols: readonly string[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const c of cols) out[c] = row[c] === undefined ? null : row[c];
  return out;
}

/** The `fmt` entry of a layout_formats row. Payloads over the spill limit become `payload_ref`. */
export function fmtEntry(row: D1Row, spilled?: Map<string, string>): Fmt {
  const entry: Fmt = pick(row, FORMAT_COLUMNS);
  const json = row.payload_json as string;
  if (byteLength(json) > SPILL_BYTES) {
    const ref = payloadRef(json);
    spilled?.set(ref, json);
    entry.payload_ref = ref;
  } else {
    entry.payload_json = json;
  }
  return entry;
}

/** A CAT item from a `layouts` row and its `layout_formats` rows. */
export function catItem(layout: D1Row, formats: readonly D1Row[], spilled?: Map<string, string>): Item {
  const fmt: Record<string, Fmt> = {};
  for (const f of formats) fmt[f.lineage as string] = fmtEntry(f, spilled);
  return { ...catKey(layout.id as string), ...pick(layout, LAYOUT_COLUMNS), like_adjust: layout.like_adjust ?? 0, fmt };
}

/** Rows back from a CAT item; refs must already be inlined (`inlinePayloads`). */
export function catRows(item: Item): { layout: D1Row; formats: D1Row[] } {
  const layout = pick(item, LAYOUT_COLUMNS);
  const formats: D1Row[] = [];
  for (const [lineage, e] of Object.entries(item.fmt as Record<string, Fmt>)) {
    if (e.payload_json === undefined) throw new Error(`CAT/${item.sk} format '${lineage}' has an unresolved payload_ref`);
    formats.push({ layout_id: item.sk, lineage, ...pick(e, FORMAT_COLUMNS), payload_json: e.payload_json });
  }
  return { layout, formats };
}

/** Puts spilled payloads back inline (CAT `fmt` entries and layout_revs items). Returns new items. */
export async function inlinePayloads(blobs: BlobStore, items: readonly Item[]): Promise<Item[]> {
  const out: Item[] = [];
  for (const it of items) {
    if (it.pk === "CAT") {
      const fmt: Record<string, Fmt> = {};
      for (const [lin, e] of Object.entries(it.fmt as Record<string, Fmt>)) {
        if (typeof e.payload_ref === "string") {
          const { payload_ref, ...rest } = e;
          fmt[lin] = { ...rest, payload_json: await getPayload(blobs, payload_ref) };
        } else fmt[lin] = e;
      }
      out.push({ ...it, fmt });
    } else if (typeof it.payload_ref === "string") {
      const { payload_ref, ...rest } = it;
      out.push({ ...rest, payload_json: await getPayload(blobs, payload_ref as string) });
    } else out.push(it);
  }
  return out;
}

/** The layout_revs item for a row. */
export function revItem(row: D1Row, spilled?: Map<string, string>): Item {
  const base = {
    ...revKey(row.layout_id as string, (row.lineage as string | null) ?? null, row.rev as number),
    layout_id: row.layout_id,
    n: row.n,
    lineage: row.lineage ?? null,
    rev: row.rev,
    event_seq: row.event_seq,
    format: row.format ?? null,
  };
  const json = (row.payload_json as string | null | undefined) ?? null;
  if (json !== null && byteLength(json) > SPILL_BYTES) {
    const ref = payloadRef(json);
    spilled?.set(ref, json);
    return { ...base, payload_ref: ref };
  }
  return { ...base, payload_json: json };
}

export function eventRow(item: Item): D1Row {
  return pick(item, EVENT_COLUMNS);
}

/** The EV item plus its mirrors, in write order. */
export function eventItems(row: D1Row): Item[] {
  const seq = row.seq as number;
  const body = pick(row, EVENT_COLUMNS);
  const items: Item[] = [{ ...eventKey(seq), ...body }];
  if (row.layout_id !== null && row.layout_id !== undefined) items.push({ ...eventLayoutKey(row.layout_id as string, seq), ...body });
  items.push({ ...eventKindKey(row.kind as string, seq), ...body }, { ...eventActorKey(row.actor as string, seq), ...body });
  return items;
}

/** What `toItems` spilled to the blob store, keyed by blob key. */
export function payloadBlobs(rows: RowsByTable): Map<string, string> {
  const spilled = new Map<string, string>();
  toItems(rows, spilled);
  return spilled;
}

/**
 * The META/HEAD attributes the given rows determine: `seq`/`max_at` from
 * events, `live` from layouts_head. A harness that inserts one table at a
 * time must merge these into HEAD (an Update), never Put HEAD whole.
 */
export function headPatch(rows: RowsByTable): { seq?: number; max_at?: string | null; live?: number } {
  const out: { seq?: number; max_at?: string | null; live?: number } = {};
  if (rows.events !== undefined) {
    out.seq = rows.events.reduce((m, r) => Math.max(m, r.seq as number), 0);
    out.max_at = rows.events.reduce<string | null>((m, r) => (m === null || (r.at as string) > m ? (r.at as string) : m), null);
  }
  if (rows.layouts_head !== undefined) {
    const r = rows.layouts_head[0];
    if (r !== undefined) out.live = r.live as number;
  }
  return out;
}

function toItems(rows: RowsByTable, spilled?: Map<string, string>): { main: Item[]; ephemeral: Item[] } {
  const main: Item[] = [];
  const formatsByLayout = new Map<string, D1Row[]>();
  for (const f of rows.layout_formats ?? []) {
    const id = f.layout_id as string;
    const list = formatsByLayout.get(id) ?? [];
    list.push(f);
    formatsByLayout.set(id, list);
  }
  for (const l of rows.layouts ?? []) {
    main.push(catItem(l, formatsByLayout.get(l.id as string) ?? [], spilled));
    formatsByLayout.delete(l.id as string);
    if (l.deleted === 0 || l.deleted === false) main.push({ ...nameKey(l.name as string), id: l.id });
  }
  if (formatsByLayout.size > 0 && rows.layouts !== undefined) {
    throw new Error(`layout_formats rows without a layouts row: ${[...formatsByLayout.keys()].join(", ")}`);
  }
  for (const r of rows.layout_revs ?? []) main.push(revItem(r, spilled));
  for (const k of rows.likes ?? []) {
    const body = { layout_id: k.layout_id, user_id: k.user_id, at: k.at, via: k.via ?? "import:cmini" };
    main.push(
      { ...likeKey(k.layout_id as string, k.user_id as string), ...body },
      { ...userLikeKey(k.user_id as string, k.layout_id as string), ...body },
    );
  }
  for (const e of rows.events ?? []) main.push(...eventItems(e));
  if (rows.events !== undefined || rows.layouts_head !== undefined) {
    const p = headPatch(rows);
    main.push({ ...HEAD_KEY, ...(p.seq !== undefined ? { seq: p.seq } : {}), ...(p.max_at != null ? { max_at: p.max_at } : {}), ...(p.live !== undefined ? { live: p.live } : {}) });
  }
  for (const s of rows.import_state ?? []) main.push({ ...stateKey(s.key as string), key: s.key, value: s.value });
  for (const m of rows.import_map ?? []) {
    main.push({
      ...importMapKey(m.upstream_id as string),
      upstream_id: m.upstream_id,
      layout_id: m.layout_id,
      upstream_name: m.upstream_name ?? null,
      upstream_modified_at: m.upstream_modified_at ?? null,
    });
  }
  return { main, ephemeral: [] };
}

function tableOf(item: Item): ReturnType<LaneSchema["tableOf"]> {
  const pk = item.pk as string;
  const sk = item.sk as string;
  if (pk === "CAT" || pk.startsWith("NAME#")) return "layouts";
  if (pk.startsWith("L#")) return sk.startsWith("V#") ? "layout_revs" : sk.startsWith("LK#") ? "likes" : null;
  if (pk.startsWith("U#")) return sk.startsWith("LK#") ? "likes" : null;
  if (pk === "EV" || pk.startsWith("EVL#") || pk.startsWith("EVK#") || pk.startsWith("EVA#")) return "events";
  if (pk === "META" && sk === "HEAD") return "layouts_head";
  if (pk === "STATE") return "import_state";
  if (pk === "IMPORTMAP") return "import_map";
  return null;
}

export const coreSchema: LaneSchema = {
  lane: "G",
  tables: ["layouts", "layout_formats", "layout_revs", "likes", "events", "layouts_head", "import_state", "import_map"],
  toItems: (rows, spilled?: Map<string, string>) => toItems(rows, spilled),
  tableOf,
  fromItems({ main }) {
    const out: RowsByTable = { layouts: [], layout_formats: [], layout_revs: [], likes: [], events: [], layouts_head: [], import_state: [], import_map: [] };
    for (const it of main) {
      const pk = it.pk as string;
      const sk = it.sk as string;
      if (pk === "CAT") {
        const { layout, formats } = catRows(it);
        out.layouts!.push(layout);
        out.layout_formats!.push(...formats);
      } else if (pk.startsWith("L#") && sk.startsWith("V#")) {
        if (it.payload_ref !== undefined) throw new Error(`${pk}/${sk} has an unresolved payload_ref`);
        out.layout_revs!.push({
          layout_id: it.layout_id, n: it.n, lineage: it.lineage ?? null, rev: it.rev, event_seq: it.event_seq,
          format: it.format ?? null, payload_json: it.payload_json ?? null,
        });
      } else if (pk.startsWith("L#") && sk.startsWith("LK#")) {
        out.likes!.push({ layout_id: it.layout_id, user_id: it.user_id, at: it.at, via: it.via });
      } else if (pk === "EV") {
        out.events!.push(eventRow(it));
      } else if (pk === "META" && sk === "HEAD") {
        out.layouts_head!.push({ id: 1, live: it.live ?? 0 });
      } else if (pk === "STATE") {
        out.import_state!.push({ key: it.key, value: it.value });
      } else if (pk === "IMPORTMAP") {
        out.import_map!.push({ upstream_id: it.upstream_id, layout_id: it.layout_id, upstream_name: it.upstream_name ?? null, upstream_modified_at: it.upstream_modified_at ?? null });
      }
    }
    return out;
  },
};

// ---------------------------------------------------------------------------
// Decoders for the read paths (layouts.ts, the catalog)
// ---------------------------------------------------------------------------

/** The `LayoutRow` a CAT item holds (no payloads involved). */
export function layoutRowOf(item: Item): LayoutRow {
  return rowToLayout(pick(item, LAYOUT_COLUMNS) as unknown as LayoutDbRow);
}

/** Every format of a CAT item as `FormatRow`s keyed by lineage; spilled payloads are fetched from `blobs`. */
export async function formatRowsOf(blobs: BlobStore, item: Item): Promise<Map<string, FormatRow>> {
  const out = new Map<string, FormatRow>();
  for (const [lineage, e] of Object.entries((item.fmt ?? {}) as Record<string, Fmt>)) {
    const json = typeof e.payload_ref === "string" ? await getPayload(blobs, e.payload_ref) : (e.payload_json as string);
    out.set(lineage, rowToFormat({ layout_id: item.sk as string, lineage, ...pick(e, FORMAT_COLUMNS), payload_json: json } as unknown as FormatDbRow));
  }
  return out;
}
