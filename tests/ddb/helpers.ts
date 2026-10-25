// Shared setup for lane G's DynamoDB tests: a context on DynamoDB Local with
// an in-memory blob store and a catalog built from a full consistent scan
// (the stand-in for lane H until it lands; the Catalog contract is the same).
import { QueryCommand, ScanCommand, TransactWriteCommand } from "@aws-sdk/lib-dynamodb";
import type { BlobStore } from "../../src/platform/port";
import { createDocClient } from "../../src/store/ddb/client";
import type { Catalog, CatalogLayout, CatalogView, DdbContext, Item } from "../../src/store/ddb/contracts";
import { createTables, deleteTables } from "../../src/store/ddb/tables";
import { formatRowsOf, layoutRowOf } from "../../src/store/ddb/schema/core";
import { txTuning } from "../../src/store/ddb/tx";
import { createDdbStore } from "../../src/store/ddb";
import type { Store } from "../../src/store/port";
import { ddbEventStore } from "../../src/store/ddb/events";
import { ddbHeadStore } from "../../src/store/ddb/head";
import { ddbLayoutReadStore } from "../../src/store/ddb/layouts";
import { ddbStateStore } from "../../src/store/ddb/state";

export const PORT = Number(process.env.DDB_PORT ?? 18301);

export function memoryBlobs(): BlobStore & { keys(): string[] } {
  const m = new Map<string, string>();
  return {
    keys: () => [...m.keys()],
    async get(key) {
      const v = m.get(key);
      if (v === undefined) return null;
      const bytes = new TextEncoder().encode(v);
      return { body: new Response(bytes).body!, httpEtag: '"x"', contentType: "application/json", size: bytes.length };
    },
    async put(key, body) {
      m.set(key, typeof body === "string" ? body : new TextDecoder().decode(body));
    },
  };
}

export async function scanAll(doc: DdbContext["doc"], table: string): Promise<Item[]> {
  const out: Item[] = [];
  let start: Record<string, unknown> | undefined;
  do {
    const r = await doc.send(new ScanCommand({ TableName: table, ConsistentRead: true, ExclusiveStartKey: start }));
    out.push(...(r.Items ?? []));
    start = r.LastEvaluatedKey;
  } while (start !== undefined);
  return out;
}

export function scanCatalog(ctx: Omit<DdbContext, "catalog">): Catalog {
  const build = async (): Promise<CatalogView> => {
    const items = await scanAll(ctx.doc, ctx.tables.main);
    const likers = new Map<string, string[]>();
    for (const it of items) {
      if ((it.pk as string).startsWith("L#") && (it.sk as string).startsWith("LK#")) {
        const l = likers.get(it.layout_id) ?? [];
        l.push(it.user_id);
        likers.set(it.layout_id, l);
      }
    }
    const layouts = new Map<string, CatalogLayout>();
    for (const it of items) {
      if (it.pk !== "CAT") continue;
      layouts.set(it.sk, { layout: layoutRowOf(it), formats: await formatRowsOf(ctx.blobs, it), likers: (likers.get(it.sk) ?? []).sort() });
    }
    const head = items.find((i) => i.pk === "META" && i.sk === "HEAD");
    return { seq: head?.seq ?? 0, layouts };
  };
  return { current: build, rebuildFromScan: build, writeSnapshot: async () => ({ seq: 0, written: false }) };
}

export interface TestDdb {
  ctx: DdbContext;
  blobs: ReturnType<typeof memoryBlobs>;
  head: ReturnType<typeof ddbHeadStore>;
  state: ReturnType<typeof ddbStateStore>;
  layouts: ReturnType<typeof ddbLayoutReadStore>;
  events: ReturnType<typeof ddbEventStore>;
  reset(): Promise<void>;
  drop(): Promise<void>;
}

/** Tables named per test file; `reset()` empties them between tests. */
export async function openDdb(name: string): Promise<TestDdb> {
  const doc = createDocClient({ endpoint: `http://127.0.0.1:${PORT}`, region: "us-east-2" });
  const tables = { main: `${name}-main`, ephemeral: `${name}-eph` };
  const blobs = memoryBlobs();
  const base = { doc, tables, blobs };
  const ctx: DdbContext = { ...base, catalog: scanCatalog(base) };
  txTuning.sleep = async () => {};
  await deleteTables(doc, tables);
  await createTables(doc, tables);
  const reset = async () => {
    for (const t of [tables.main, tables.ephemeral]) {
      for (const i of await scanAll(doc, t)) {
        await doc.send(new TransactWriteCommand({ TransactItems: [{ Delete: { TableName: t, Key: { pk: i.pk, sk: i.sk } } }] }));
      }
    }
  };
  return {
    ctx,
    blobs,
    head: ddbHeadStore(ctx),
    state: ddbStateStore(ctx),
    layouts: ddbLayoutReadStore(ctx),
    events: ddbEventStore(ctx),
    reset,
    drop: () => deleteTables(doc, tables),
  };
}

export async function queryPk(ctx: DdbContext, pk: string, table: "main" | "ephemeral" = "main"): Promise<Item[]> {
  const r = await ctx.doc.send(
    new QueryCommand({ TableName: ctx.tables[table], KeyConditionExpression: "pk = :p", ExpressionAttributeValues: { ":p": pk }, ConsistentRead: true }),
  );
  return r.Items ?? [];
}

export type { Store };
export { createDdbStore };
