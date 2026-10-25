// The catalog read model (src/store/ddb/contracts.ts `Catalog`, design §2.7).
// Owner: P2 lane H (design/p2-p5-briefs.md).
//
// A per-container map of every layout (the CAT item decoded, tombstones and
// payloads included, likers from the L#<id> LK# items, ascending). Every
// change to a CAT item or a like item happens in an EventTx that appends an
// event naming the layout (LDB-AWS-RM1), so the map catches up by reading the
// events past its cursor and re-reading just the layouts they name. The
// result is an exact snapshot at one HEAD seq.
import { GetCommand, QueryCommand, ScanCommand, TransactGetCommand } from "@aws-sdk/lib-dynamodb";
import { internal } from "../../core/errors";
import { rowToFormat, rowToLayout, type FormatDbRow, type FormatRow, type LayoutDbRow, type LayoutRow } from "../../core/records";
import type { Catalog, CatalogLayout, CatalogView, DdbContext, Item } from "./contracts";
import { catKey, HEAD_KEY, padSeq } from "./keys";
import { catRows, inlinePayloads } from "./schema/core";
import { txTuning } from "./tx";

export const SNAPSHOT_KEY = "replica/snapshot.json.gz";
const SNAPSHOT_MAGIC = "AKLSNAP1";
/** Rounds of "the HEAD moved while I was reading" before giving up (design §2.7). */
const MAX_ROUNDS = 5;
/** HEAD plus this many CAT items per TransactGetItems (100 items max). */
const CHUNK = 99;
const READ_RETRIES = 6;

// ---------------------------------------------------------------------------
// Ordering helpers (design §2.7 "Ordering details that must match SQLite")
// ---------------------------------------------------------------------------

const utf8 = new TextEncoder();

function bytes(s: string): Uint8Array {
  return utf8.encode(s);
}

/** memcmp order with the shorter prefix first, as SQLite's BINARY collation. */
function compareBytes(a: Uint8Array, b: Uint8Array): number {
  return Buffer.compare(a, b);
}

/** SQLite BINARY on text: UTF-8 byte order (JS `<` is UTF-16 order and differs above U+FFFF). */
export function compareBinary(a: string, b: string): number {
  return compareBytes(bytes(a), bytes(b));
}

const lower = (c: number): number => (c >= 0x41 && c <= 0x5a ? c + 32 : c);

/**
 * SQLite NOCASE on text (`nocaseCollatingFunc`): bytes compare with ASCII `A-Z` folded, over the shorter
 * length, stopping early at a NUL in the left operand (as `sqlite3StrNICmp` does); a tie breaks on length.
 * Returns <0, 0 or >0.
 */
export function compareNocase(a: string, b: string): number {
  const x = bytes(a);
  const y = bytes(b);
  const n = Math.min(x.length, y.length);
  for (let i = 0; i < n; i++) {
    const d = lower(x[i]!) - lower(y[i]!);
    if (d !== 0) return d;
    if (x[i] === 0) break;
  }
  return x.length - y.length;
}

export type SqliteValue = null | number | string;

function storageClass(v: SqliteValue): 0 | 1 | 2 {
  return v === null ? 0 : typeof v === "number" ? 1 : 2;
}

/**
 * SQLite's cross-type order for two values compared as-is (no affinity):
 * NULL < numbers < text, numbers numerically, text by `collation`. Returns <0, 0 or >0.
 */
export function compareSqlite(a: SqliteValue, b: SqliteValue, collation: "binary" | "nocase" = "binary"): number {
  const ca = storageClass(a);
  const cb = storageClass(b);
  if (ca !== cb) return ca < cb ? -1 : 1;
  if (ca === 0) return 0;
  if (ca === 1) return (a as number) < (b as number) ? -1 : (a as number) > (b as number) ? 1 : 0;
  return collation === "nocase" ? compareNocase(a as string, b as string) : compareBinary(a as string, b as string);
}

const NUMERIC_TEXT = /^[ \t\n\r\f\v]*[+-]?(\d+(\.\d*)?|\.\d+)([eE][+-]?\d+)?[ \t\n\r\f\v]*$/;

/**
 * The comparison `<sort column> <op> ?cursor` as D1 evaluates it for a list
 * cursor (`d1/layouts.ts`): the bound cursor value gets the sort column's
 * affinity first. `name` and `created_at` are TEXT columns (a numeric cursor
 * becomes text; `name` also compares NOCASE); `like_count` is INTEGER (numeric
 * looking text becomes a number); `modified_at` is `MAX(l.modified_at,
 * f.modified_at)`, an expression with no affinity (a number stays below any
 * text). `value` is the row's own sort value. Returns <0, 0 or >0.
 */
export function compareSortValue(sort: "name" | "modified_at" | "created_at" | "like_count", value: SqliteValue, cursor: SqliteValue): number {
  let c = cursor;
  if ((sort === "name" || sort === "created_at") && typeof c === "number") c = String(c);
  else if (sort === "like_count" && typeof c === "string" && NUMERIC_TEXT.test(c)) c = Number(c);
  return compareSqlite(value, c, sort === "name" ? "nocase" : "binary");
}

// ---------------------------------------------------------------------------
// Decoding
// ---------------------------------------------------------------------------

/** A CAT item (payloads already inlined) as the catalog holds it, with the given likers. */
export function toCatalogLayout(item: Item, likers: readonly string[]): CatalogLayout {
  const { layout, formats } = catRows(item);
  const out = new Map<string, FormatRow>();
  for (const f of formats) out.set(f.lineage as string, rowToFormat(f as unknown as FormatDbRow));
  return { layout: rowToLayout(layout as unknown as LayoutDbRow), formats: out, likers };
}

// ---------------------------------------------------------------------------
// Snapshot blob: gzip("AKLSNAP1 <seq>\n" + json). The header line lets a writer
// read the stored seq without parsing the body.
// ---------------------------------------------------------------------------

interface SnapshotJson {
  v: 1;
  seq: number;
  layouts: { layout: LayoutRow; formats: [string, FormatRow][]; likers: string[] }[];
}

async function gzip(text: string): Promise<Uint8Array> {
  const stream = new Blob([text]).stream().pipeThrough(new CompressionStream("gzip"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

function snapshotText(view: CatalogView): string {
  const body: SnapshotJson = {
    v: 1,
    seq: view.seq,
    layouts: [...view.layouts.values()].map((c) => ({ layout: c.layout, formats: [...c.formats], likers: [...c.likers] })),
  };
  return `${SNAPSHOT_MAGIC} ${view.seq}\n${JSON.stringify(body)}`;
}

function parseSnapshot(text: string): CatalogView {
  const nl = text.indexOf("\n");
  const header = /^AKLSNAP1 (\d+)$/.exec(text.slice(0, nl));
  if (nl < 0 || header === null) throw new Error("snapshot header is not AKLSNAP1");
  const json = JSON.parse(text.slice(nl + 1)) as SnapshotJson;
  if (json.v !== 1 || json.seq !== Number(header[1])) throw new Error("snapshot header and body disagree");
  const layouts = new Map<string, CatalogLayout>();
  for (const c of json.layouts) layouts.set(c.layout.id, { layout: c.layout, formats: new Map(c.formats), likers: c.likers });
  return { seq: json.seq, layouts };
}

async function readSnapshotBlob(ctx: Pick<DdbContext, "blobs">): Promise<CatalogView | null> {
  try {
    const obj = await ctx.blobs.get(SNAPSHOT_KEY);
    if (obj === null) return null;
    const text = await new Response(obj.body.pipeThrough(new DecompressionStream("gzip"))).text();
    return parseSnapshot(text);
  } catch (e) {
    console.error(`CATALOG_SNAPSHOT_UNREADABLE ${(e as Error).message}`);
    return null;
  }
}

/** The seq of the stored snapshot from its header line alone; null if absent or unreadable. */
async function peekSnapshotSeq(ctx: Pick<DdbContext, "blobs">): Promise<number | null> {
  try {
    const obj = await ctx.blobs.get(SNAPSHOT_KEY);
    if (obj === null) return null;
    const reader = obj.body.pipeThrough(new DecompressionStream("gzip")).pipeThrough(new TextDecoderStream()).getReader();
    let head = "";
    try {
      while (!head.includes("\n")) {
        const { done, value } = await reader.read();
        if (done) break;
        head += value;
      }
    } finally {
      await reader.cancel().catch(() => {});
    }
    const m = /^AKLSNAP1 (\d+)\n/.exec(head);
    return m === null ? null : Number(m[1]);
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------

function sortStrings(xs: string[]): string[] {
  return xs.sort(compareBinary);
}

const TRANSIENT = new Set([
  "TransactionConflictException",
  "TransactionInProgressException",
  "ThrottlingException",
  "ProvisionedThroughputExceededException",
  "RequestLimitExceeded",
]);

function isTransient(e: unknown): boolean {
  const err = e as { name?: string; CancellationReasons?: { Code?: string }[] };
  if (err?.name === "TransactionCanceledException") {
    return (err.CancellationReasons ?? []).some((r) => r.Code === "TransactionConflict" || r.Code === "ThrottlingError" || r.Code === "ProvisionedThroughputExceeded");
  }
  return err?.name !== undefined && TRANSIENT.has(err.name);
}

async function retrying<T>(fn: () => Promise<T>): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await fn();
    } catch (e) {
      if (attempt >= READ_RETRIES || !isTransient(e)) throw e;
      await txTuning.sleep(10 * (attempt + 1) * (0.5 + txTuning.random()));
    }
  }
}

export function createCatalog(ctx: Omit<DdbContext, "catalog">): Catalog {
  const table = ctx.tables.main;

  async function headSeq(): Promise<number> {
    const got = await ctx.doc.send(new GetCommand({ TableName: table, Key: HEAD_KEY, ConsistentRead: true }));
    return (got.Item?.seq as number | undefined) ?? 0;
  }

  /** Events in [from, to] (consistent): which layouts they name, and which of those changed likes. */
  async function eventsBetween(from: number, to: number): Promise<{ ids: Set<string>; liked: Set<string> }> {
    const ids = new Set<string>();
    const liked = new Set<string>();
    let seen = 0;
    let last: Record<string, unknown> | undefined;
    do {
      const r = await ctx.doc.send(
        new QueryCommand({
          TableName: table,
          ConsistentRead: true,
          KeyConditionExpression: "pk = :p AND sk BETWEEN :a AND :b",
          ProjectionExpression: "sk, layout_id, #k",
          ExpressionAttributeNames: { "#k": "kind" },
          ExpressionAttributeValues: { ":p": "EV", ":a": padSeq(from), ":b": padSeq(to) },
          ExclusiveStartKey: last,
        }),
      );
      for (const it of r.Items ?? []) {
        seen++;
        const id = it.layout_id as string | null | undefined;
        if (id === null || id === undefined) continue;
        ids.add(id);
        if (it.kind === "liked" || it.kind === "unliked") liked.add(id);
      }
      last = r.LastEvaluatedKey;
    } while (last !== undefined);
    if (seen !== to - from + 1) {
      console.error(`CATALOG_EVENT_GAP expected ${to - from + 1} events in (${from - 1}, ${to}], found ${seen}`);
      throw internal();
    }
    return { ids, liked };
  }

  async function likersOf(id: string): Promise<string[]> {
    const out: string[] = [];
    let last: Record<string, unknown> | undefined;
    do {
      const r = await ctx.doc.send(
        new QueryCommand({
          TableName: table,
          ConsistentRead: true,
          KeyConditionExpression: "pk = :p AND begins_with(sk, :lk)",
          ExpressionAttributeValues: { ":p": `L#${id}`, ":lk": "LK#" },
          ExclusiveStartKey: last,
        }),
      );
      for (const it of r.Items ?? []) out.push(it.user_id as string);
      last = r.LastEvaluatedKey;
    } while (last !== undefined);
    return sortStrings(out);
  }

  /**
   * Brings `base` (an exact snapshot at `cursor`) to an exact snapshot at some HEAD
   * seq >= the HEAD current when called. Never mutates `base`.
   */
  async function catchUp(base: ReadonlyMap<string, CatalogLayout>, cursor: number): Promise<CatalogView> {
    let h = await headSeq();
    if (h < cursor) throw new Error(`catalog cursor ${cursor} is ahead of HEAD ${h}`);
    if (h === cursor) return { seq: h, layouts: base as Map<string, CatalogLayout> };
    const map = new Map(base);
    const dirty = new Set<string>();
    const likeReload = new Set<string>();
    let scanned = cursor;
    for (let round = 0; round < MAX_ROUNDS; round++) {
      if (scanned < h) {
        const ev = await eventsBetween(scanned + 1, h);
        scanned = h;
        for (const id of ev.ids) {
          dirty.add(id);
          if (ev.liked.has(id) || !map.has(id)) likeReload.add(id);
        }
      }
      let converged = true;
      const ids = [...dirty];
      for (let i = 0; i < ids.length || i === 0; i += CHUNK) {
        const chunk = ids.slice(i, i + CHUNK);
        const r = await retrying(() =>
          ctx.doc.send(
            new TransactGetCommand({
              TransactItems: [HEAD_KEY, ...chunk.map((id) => catKey(id))].map((Key) => ({ Get: { TableName: table, Key } })),
            }),
          ),
        );
        const seen = (r.Responses?.[0]?.Item?.seq as number | undefined) ?? 0;
        if (seen > h) {
          converged = false;
          h = seen;
        }
        const found = await inlinePayloads(
          ctx.blobs,
          chunk.map((_, j) => r.Responses?.[j + 1]?.Item as Item | undefined).filter((it): it is Item => it !== undefined),
        );
        const byId = new Map(found.map((it) => [it.sk as string, it]));
        for (const id of chunk) {
          dirty.delete(id);
          const it = byId.get(id);
          if (it === undefined) {
            map.delete(id);
            likeReload.delete(id);
            continue;
          }
          const old = map.get(id);
          const next = toCatalogLayout(it, old?.likers ?? []);
          if (next.likers.length !== next.layout.like_count) likeReload.add(id);
          map.set(id, next);
        }
      }
      if (!converged) continue;
      // Every chunk saw HEAD = h with nothing dirty left: the layouts are exact at h. With no likers to reload that is the answer.
      if (likeReload.size === 0) return { seq: h, layouts: map };
      // Likers are read after the layouts; HEAD must not have moved since, or they could be newer than the CAT items.
      for (const id of likeReload) {
        const cur = map.get(id);
        if (cur !== undefined) map.set(id, { ...cur, likers: await likersOf(id) });
      }
      const after = await headSeq();
      if (after === h) return { seq: h, layouts: map };
      h = after;
      for (const id of likeReload) if (!map.has(id)) likeReload.delete(id);
      // keep likeReload: the next round re-reads whatever the new events name, and reloads these again
    }
    console.error(`CATALOG_NOT_CONVERGED after ${MAX_ROUNDS} rounds at HEAD ${h}`);
    throw internal();
  }

  /** A consistent Scan of CAT and LK# items, decoded. Not a snapshot by itself (callers catch up). */
  async function scanAll(): Promise<Map<string, CatalogLayout>> {
    const cats: Item[] = [];
    const likers = new Map<string, string[]>();
    let last: Record<string, unknown> | undefined;
    do {
      const r = await ctx.doc.send(
        new ScanCommand({
          TableName: table,
          ConsistentRead: true,
          FilterExpression: "pk = :cat OR (begins_with(pk, :l) AND begins_with(sk, :lk))",
          ExpressionAttributeValues: { ":cat": "CAT", ":l": "L#", ":lk": "LK#" },
          ExclusiveStartKey: last,
        }),
      );
      for (const it of r.Items ?? []) {
        if (it.pk === "CAT") cats.push(it);
        else {
          const id = (it.pk as string).slice(2);
          const list = likers.get(id) ?? [];
          list.push(it.user_id as string);
          likers.set(id, list);
        }
      }
      last = r.LastEvaluatedKey;
    } while (last !== undefined);
    const out = new Map<string, CatalogLayout>();
    const inlined = await inlinePayloads(ctx.blobs, cats);
    for (const it of inlined) out.set(it.sk as string, toCatalogLayout(it, sortStrings(likers.get(it.sk as string) ?? [])));
    return out;
  }

  async function scanView(): Promise<CatalogView> {
    const h0 = await headSeq();
    const scanned = await scanAll();
    return catchUp(scanned, h0);
  }

  async function boot(): Promise<CatalogView> {
    const snap = await readSnapshotBlob(ctx);
    if (snap !== null) {
      try {
        return await catchUp(snap.layouts, snap.seq);
      } catch (e) {
        console.error(`CATALOG_SNAPSHOT_REJECTED ${(e as Error).message}`);
      }
    }
    return scanView();
  }

  let view: CatalogView | null = null;
  let running: Promise<CatalogView> | null = null;
  let queued: Promise<CatalogView> | null = null;
  // invalidate() bumps `gen`: a refresh that started before it must not install its result.
  let gen = 0;
  let forceScan = false;

  async function refresh(): Promise<CatalogView> {
    const g = gen;
    const scan = forceScan;
    forceScan = false;
    const base = view;
    let next: CatalogView;
    if (base === null || scan) {
      next = scan ? await scanView() : await boot();
    } else {
      try {
        next = await catchUp(base.layouts, base.seq);
      } catch (e) {
        if (!/ahead of HEAD/.test((e as Error).message)) throw e;
        next = await scanView(); // the table went backwards (restore, test reset): start over
      }
      if (next.layouts === base.layouts && next.seq === base.seq) next = base;
    }
    if (g === gen) view = next;
    else if (scan) forceScan = true; // invalidated again while scanning: the next call scans again
    return next;
  }

  function run(): Promise<CatalogView> {
    const p: Promise<CatalogView> = refresh().finally(() => {
      if (running === p) running = null;
    });
    running = p;
    return p;
  }

  // A call that arrives while a refresh runs may have seen a write that refresh did not, so it waits
  // for the next one; every call that arrives in the meantime shares that next refresh.
  function current(): Promise<CatalogView> {
    if (running === null) return run();
    if (queued === null) {
      const after = (): Promise<CatalogView> => {
        queued = null;
        return run();
      };
      queued = running.then(after, after);
    }
    return queued;
  }

  return {
    current,

    // Writes that bypass the event log (a restore, a raw insert) leave the model stale: drop it, and the next
    // `current()` rebuilds from a consistent scan (never from the snapshot, which those writes also outdate).
    invalidate() {
      gen++;
      view = null;
      forceScan = true;
    },

    async writeSnapshot() {
      const v = await current();
      const stored = await peekSnapshotSeq(ctx);
      if (stored !== null && stored >= v.seq) return { seq: stored, written: false };
      // BlobStore has no conditional put: this compare-before-write narrows the race with a stale writer, it cannot close it.
      await ctx.blobs.put(SNAPSHOT_KEY, await gzip(snapshotText(v)), "application/gzip");
      return { seq: v.seq, written: true };
    },

    rebuildFromScan: scanView,
  };
}
