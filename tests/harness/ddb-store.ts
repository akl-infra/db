// The DynamoDB `TestStore` (tests/harness/port.ts; lane N). Rows are D1-shaped
// on both backends: reads are `exportRows` filtered in memory, and a write
//   1. exports the rows,
//   2. changes the affected table's rows (and the head rows D1's triggers move),
//   3. recomputes that lane's items with `toItems`,
//   4. applies the item difference with BatchWriteItem.
// It is slow per call and correct; tests use small data. It talks to DynamoDB
// through the unwrapped client, so neither fault injection nor the call counter
// sees (or can break) the test's own seeding.
import { GetCommand, PutCommand, ScanCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import type { D1Row, D1TableName, Item, LaneSchema } from "../../src/store/ddb/contracts";
import {
  batchWrite,
  canonicalString,
  classify,
  compareRows,
  completeRow,
  D1_TABLES,
  itemKey,
  rowsFromScan,
  rowsToItems,
  scanItems,
  schemaOfTable,
  sortRows,
  tableOfItem,
  type CodecContext,
  type ItemSet,
} from "../../src/store/ddb/codec";
import { putPayload } from "../../src/store/ddb/payload";
import { HEAD_KEY } from "../../src/store/ddb/keys";
import { mqnDirtyKey, mqnKey } from "../../src/store/ddb/keys-discord";
import { payloadBlobs } from "../../src/store/ddb/schema/core";
import { invalidateAllCatalogs } from "../../src/store/ddb/catalog";
import type { Row, TableName, TestStore, Where } from "./port";
import type { FaultControl } from "../../src/store/ddb/faults";

/** The slice of `ddbHarness` (tests/harness/ddb.ts) this file uses. */
export interface TestStoreHarness {
  raw: CodecContext["doc"];
  tables: CodecContext["tables"];
  blobs: CodecContext["blobs"];
  faults: FaultControl;
}

const norm = (v: unknown): unknown => (typeof v === "boolean" ? (v ? 1 : 0) : v);

function normRow(r: Row): Row {
  const out: Row = {};
  for (const [k, v] of Object.entries(r)) out[k] = norm(v);
  return out;
}

function spec(table: TableName) {
  const s = D1_TABLES[table as D1TableName];
  if (s === undefined) throw new Error(`TestStore: unknown table '${table}'`);
  return s;
}

function checkColumns(table: TableName, cols: Iterable<string>): void {
  const known = new Set(spec(table).columns);
  for (const c of cols) if (!known.has(c)) throw new Error(`TestStore: table ${table} has no column named ${c}`);
}

function matches(row: D1Row, where: Where | undefined): boolean {
  for (const [c, v] of Object.entries(where ?? {})) {
    const want = norm(v);
    if (want === null) {
      if (row[c] !== null && row[c] !== undefined) return false;
    } else if (row[c] !== want) return false;
  }
  return true;
}

const pkOf = (table: TableName, r: D1Row): string => canonicalString(spec(table).pk.map((c) => r[c]));

type Rows = Record<string, D1Row[]>;

/** The effects of D1's triggers on the head tables (0007, 0034, 0035), replayed on rows. */
function layoutsHead(rows: Rows): D1Row {
  let h = rows.layouts_head![0];
  if (h === undefined) {
    h = { id: 1, live: 0 };
    rows.layouts_head = [h];
  }
  return h;
}
function authorsHead(rows: Rows): D1Row {
  let h = rows.authors_head![0];
  if (h === undefined) {
    h = { id: 1, version: 0, modified_at: null, count: 0 };
    rows.authors_head = [h];
  }
  return h;
}
function discordUsersHead(rows: Rows): D1Row {
  let h = rows.discord_users_head![0];
  if (h === undefined) {
    h = { id: 1, version: 0 };
    rows.discord_users_head = [h];
  }
  return h;
}
const bump = (h: D1Row, col: string, by: number): void => void (h[col] = ((h[col] as number) ?? 0) + by);

function triggersOnInsert(table: TableName, rows: Rows, added: D1Row[]): void {
  if (table === "layouts") for (const r of added) if (r.deleted === 0) bump(layoutsHead(rows), "live", 1);
  if (table === "discord_users") for (const _ of added) bump(discordUsersHead(rows), "version", 1); // 0036's discord_users_head_on_insert
  if (table === "authors") {
    for (const r of added) {
      const h = authorsHead(rows);
      bump(h, "version", 1);
      h.modified_at = r.last_seen_at;
      bump(h, "count", 1);
    }
  }
}
function triggersOnRemove(table: TableName, rows: Rows, gone: D1Row[]): void {
  if (table === "layouts") for (const r of gone) if (r.deleted === 0) bump(layoutsHead(rows), "live", -1);
  if (table === "authors") {
    for (const _ of gone) {
      const h = authorsHead(rows);
      bump(h, "version", 1);
      bump(h, "count", -1);
    }
  }
}
function triggersOnPatch(table: TableName, rows: Rows, before: D1Row, after: D1Row): void {
  if (table === "layouts" && (before.deleted === 0) !== (after.deleted === 0)) bump(layoutsHead(rows), "live", after.deleted === 0 ? 1 : -1);
  // 0036's discord_users_head_on_rename: OLD.x IS NOT NEW.x for username or global_name (null-safe).
  if (table === "discord_users" && ((before.username ?? null) !== (after.username ?? null) || (before.global_name ?? null) !== (after.global_name ?? null))) {
    bump(discordUsersHead(rows), "version", 1);
  }
  if (table === "authors" && (before.name !== after.name || before.user_id !== after.user_id)) {
    const h = authorsHead(rows);
    bump(h, "version", 1);
    h.modified_at = after.last_seen_at;
  }
}

export function ddbTestStore(h: TestStoreHarness): TestStore {
  const ctx: CodecContext = { doc: h.raw, tables: h.tables, blobs: h.blobs };
  const disposers: (() => void)[] = [];

  async function load(): Promise<{ items: ItemSet; rows: Rows }> {
    const items = await scanItems(ctx);
    const rows = (await rowsFromScan(ctx, items)) as Rows;
    return { items, rows };
  }

  async function tableRows(table: TableName): Promise<D1Row[]> {
    spec(table);
    return (await load()).rows[table] ?? [];
  }

  /** Applies a change to `rows` (mutating it) and writes the lane's item difference. */
  async function change(table: TableName, mutate: (rows: Rows) => number): Promise<number> {
    const { items, rows } = await load();
    const lane: LaneSchema = schemaOfTable(table as D1TableName);
    const n = mutate(rows);
    const laneRows: Rows = {};
    for (const t of lane.tables) laneRows[t] = rows[t] ?? [];
    const expected = rowsToItems(laneRows);
    for (const json of payloadBlobs(laneRows).values()) await putPayload(ctx.blobs, json);
    const inLane = (i: Item): boolean => classify(i)?.schema === lane;
    const touchedSubs: { kind: "link" | "wpm" | "comment"; id: string }[] = [];
    for (const [which, tableName] of [["main", h.tables.main], ["ephemeral", h.tables.ephemeral]] as const) {
      const have = new Map(items[which].filter(inLane).map((i) => [itemKey(i), i]));
      const want = new Map(expected[which].map((i) => [itemKey(i), i]));
      const requests: Record<string, unknown>[] = [];
      for (const [k, it] of want) {
        const old = have.get(k);
        if (old !== undefined && canonicalString(old) === canonicalString(it)) continue;
        if (which === "main" && it.pk === HEAD_KEY.pk && it.sk === HEAD_KEY.sk) {
          await mergeHead(old, it);
          continue;
        }
        requests.push({ PutRequest: { Item: it } });
        const sub = /^SUB#(link|wpm|comment)#(.+)$/.exec(String(it.pk));
        if (which === "main" && sub !== null && it.sk === "ROW") touchedSubs.push({ kind: sub[1] as "link" | "wpm" | "comment", id: sub[2]! });
      }
      for (const [k, old] of have) {
        if (want.has(k)) continue;
        if (which === "main" && old.pk === HEAD_KEY.pk && old.sk === HEAD_KEY.sk) continue; // HEAD is never deleted
        requests.push({ DeleteRequest: { Key: { pk: old.pk, sk: old.sk } } });
      }
      await batchWrite(ctx, tableName, requests);
    }
    // Rows written with no event: the catalog's event-driven catch-up cannot see them.
    if (lane.lane === "G") invalidateAllCatalogs();
    // A row written around the stores still moves its card: mark it dirty where a card exists, as lane J's decisions do.
    for (const { kind, id } of touchedSubs) {
      const card = await h.raw.send(new GetCommand({ TableName: h.tables.main, Key: mqnKey(kind, id), ConsistentRead: true }));
      if (card.Item !== undefined) await h.raw.send(new PutCommand({ TableName: h.tables.main, Item: { ...mqnDirtyKey(kind, id), kind, submission_id: id } }));
    }
    return n;
  }

  /** HEAD is only ever Update-merged: `seq` and `max_at` never move down (D1's AUTOINCREMENT does not reuse a seq), `live` follows the rows. */
  async function mergeHead(old: Item | undefined, want: Item): Promise<void> {
    const seq = Math.max(Number(old?.seq ?? 0), Number(want.seq ?? 0));
    const maxAt = [old?.max_at, want.max_at].filter((x): x is string => typeof x === "string").sort().pop();
    const sets: string[] = [];
    const values: Record<string, unknown> = {};
    if (want.seq !== undefined && seq !== old?.seq) (sets.push("seq = :seq"), (values[":seq"] = seq));
    if (maxAt !== undefined && maxAt !== old?.max_at) (sets.push("max_at = :max_at"), (values[":max_at"] = maxAt));
    if (want.live !== undefined && want.live !== old?.live) (sets.push("#live = :live"), (values[":live"] = want.live));
    if (sets.length === 0) return;
    await ctx.doc.send(
      new UpdateCommand({
        TableName: h.tables.main,
        Key: HEAD_KEY,
        UpdateExpression: `SET ${sets.join(", ")}`,
        ExpressionAttributeNames: ":live" in values ? { "#live": "live" } : undefined,
        ExpressionAttributeValues: values,
      }),
    );
  }

  return {
    async rows<T extends Row = Row>(table: TableName, where?: Where, orderBy?: string[]) {
      if (where !== undefined) checkColumns(table, Object.keys(where));
      if (orderBy !== undefined) checkColumns(table, orderBy);
      const found = (await tableRows(table)).filter((r) => matches(r, where));
      if (orderBy !== undefined && orderBy.length > 0) found.sort((a, b) => compareRows(a, b, orderBy));
      return found.map((r) => ({ ...r })) as T[];
    },

    async row<T extends Row = Row>(table: TableName, where: Where) {
      checkColumns(table, Object.keys(where));
      const found = (await tableRows(table)).filter((r) => matches(r, where));
      if (found.length > 1) throw new Error(`TestStore.row: more than one ${table} row matches`);
      return (found[0] === undefined ? null : { ...found[0] }) as T | null;
    },

    async count(table: TableName, where?: Where) {
      if (where !== undefined) checkColumns(table, Object.keys(where));
      return (await tableRows(table)).filter((r) => matches(r, where)).length;
    },

    async insert(table: TableName, ...given: Row[]) {
      await change(table, (rows) => {
        const list = (rows[table] ??= []);
        const added: D1Row[] = [];
        for (const g of given) {
          const r = normRow(g);
          checkColumns(table, Object.keys(r));
          if (table === "events" && r.seq === undefined) r.seq = list.reduce((m, x) => Math.max(m, x.seq as number), 0) + 1;
          for (const c of spec(table).required) {
            if (r[c] === undefined || r[c] === null) throw new Error(`TestStore.insert: NOT NULL constraint failed: ${table}.${c}`);
          }
          const full = completeRow(table as D1TableName, r);
          if (list.some((x) => pkOf(table, x) === pkOf(table, full))) throw new Error(`TestStore.insert: UNIQUE constraint failed: ${table} primary key`);
          list.push(full);
          added.push(full);
        }
        rows[table] = sortRows(table as D1TableName, list);
        triggersOnInsert(table, rows, added);
        return added.length;
      });
    },

    async patch(table: TableName, where: Where, fields: Row) {
      checkColumns(table, Object.keys(where));
      checkColumns(table, Object.keys(fields));
      const set = normRow(fields);
      for (const c of spec(table).required) if (c in set && set[c] === null) throw new Error(`TestStore.patch: NOT NULL constraint failed: ${table}.${c}`);
      return change(table, (rows) => {
        const list = (rows[table] ??= []);
        let n = 0;
        for (let i = 0; i < list.length; i++) {
          const before = list[i]!;
          if (!matches(before, where)) continue;
          const after = { ...before, ...set };
          list[i] = after;
          triggersOnPatch(table, rows, before, after);
          n++;
        }
        rows[table] = sortRows(table as D1TableName, list);
        return n;
      });
    },

    async remove(table: TableName, where: Where) {
      checkColumns(table, Object.keys(where));
      return change(table, (rows) => {
        const list = rows[table] ?? [];
        const gone = list.filter((r) => matches(r, where));
        rows[table] = list.filter((r) => !matches(r, where));
        triggersOnRemove(table, rows, gone);
        return gone.length;
      });
    },

    faults: {
      async failWrites(table: TableName) {
        spec(table);
        disposers.push(h.faults.failWritesFor((t) => tableOfItem((t.item ?? t.key) as Item) === table));
      },
      async clear() {
        for (const d of disposers.splice(0)) d();
        h.faults.clearFaults();
      },
    },
  };
}

/** Deletes every item of both tables (tests that share one table pair across cases). */
export async function wipeTables(ctx: CodecContext): Promise<void> {
  // scanItems drops bookkeeping items (STATE/migrations); those go too.
  const all = { main: await rawScan(ctx, ctx.tables.main), ephemeral: await rawScan(ctx, ctx.tables.ephemeral) };
  for (const [t, list] of [[ctx.tables.main, all.main], [ctx.tables.ephemeral, all.ephemeral]] as const) {
    await batchWrite(ctx, t, list.map((i) => ({ DeleteRequest: { Key: { pk: i.pk, sk: i.sk } } })));
  }
}

async function rawScan(ctx: CodecContext, table: string): Promise<Item[]> {
  const out: Item[] = [];
  let start: Record<string, unknown> | undefined;
  do {
    const r = await ctx.doc.send(new ScanCommand({ TableName: table, ConsistentRead: true, ExclusiveStartKey: start }));
    out.push(...((r.Items ?? []) as Item[]));
    start = r.LastEvaluatedKey;
  } while (start !== undefined);
  return out;
}
