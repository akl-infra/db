// Shared setup for lane G's DynamoDB tests: a context on DynamoDB Local with
// an in-memory blob store and a catalog built from a full consistent scan
// (the stand-in for lane H until it lands; the Catalog contract is the same).
import { QueryCommand, ScanCommand, TransactWriteCommand, type ScanCommandOutput } from "@aws-sdk/lib-dynamodb";
import type { BlobStore } from "../../src/platform/port";
import { createDocClient } from "../../src/store/ddb/client";
import type { Catalog, CatalogLayout, CatalogView, DdbContext, Item } from "../../src/store/ddb/contracts";
import { createCatalog } from "../../src/store/ddb/catalog";
import { createTables, deleteTables } from "../../src/store/ddb/tables";
import { formatRowsOf, layoutRowOf } from "../../src/store/ddb/schema/core";
import { txTuning } from "../../src/store/ddb/tx";
import { createDdbStore } from "../../src/store/ddb";
import { withCallCounter, type CountingDoc } from "../../src/store/ddb/counting";
import { withFaults, type FaultyDoc } from "../../src/store/ddb/faults";
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

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type AnyItem = Record<string, any>;

export async function scanAll(doc: DdbContext["doc"], table: string): Promise<AnyItem[]> {
  const out: AnyItem[] = [];
  let start: Record<string, any> | undefined;
  do {
    const r: ScanCommandOutput = await doc.send(new ScanCommand({ TableName: table, ConsistentRead: true, ExclusiveStartKey: start }));
    out.push(...(r.Items ?? []));
    start = r.LastEvaluatedKey;
  } while (start !== undefined);
  return out;
}

export interface TestDdb {
  ctx: DdbContext;
  blobs: ReturnType<typeof memoryBlobs>;
  head: ReturnType<typeof ddbHeadStore>;
  state: ReturnType<typeof ddbStateStore>;
  layouts: ReturnType<typeof ddbLayoutReadStore>;
  events: ReturnType<typeof ddbEventStore>;
  /** The fault wrapper (random conflicts at `faultRate`, `failWritesFor`, `staleReads`) and the call counter around it. */
  faulty: FaultyDoc;
  counted: CountingDoc;
  reset(): Promise<void>;
  drop(): Promise<void>;
}

export interface OpenOptions {
  /** Probability that a write call is faulted with a conflict, throttle or 500 (default 0). */
  faultRate?: number;
  seed?: number;
}

/** Tables named per test file; `reset()` empties them between tests. */
export async function openDdb(name: string, opts: OpenOptions = {}): Promise<TestDdb> {
  const doc = createDocClient({ endpoint: `http://127.0.0.1:${PORT}`, region: "us-east-2" });
  const tables = { main: `${name}-main`, ephemeral: `${name}-eph` };
  const blobs = memoryBlobs();
  const faulty = withFaults(doc, { rate: opts.faultRate ?? Number(process.env.LAB_FAULT_RATE ?? 0), seed: opts.seed ?? 1, tables });
  const counted = withCallCounter(faulty);
  const base = { doc: counted as DdbContext["doc"], tables, blobs };
  const ctx: DdbContext = { ...base, catalog: createCatalog(base) };
  // Real backoff shape, scaled down: lockstep retries (no delay) would exhaust 8 attempts under a 12-way burst.
  txTuning.sleep = (ms) => new Promise((r) => setTimeout(r, ms / 5));
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
    faulty,
    counted,
    reset,
    drop: () => deleteTables(doc, tables),
  };
}

export async function queryPk(ctx: DdbContext, pk: string, table: "main" | "ephemeral" = "main"): Promise<AnyItem[]> {
  const r = await ctx.doc.send(
    new QueryCommand({ TableName: ctx.tables[table], KeyConditionExpression: "pk = :p", ExpressionAttributeValues: { ":p": pk }, ConsistentRead: true }),
  );
  return r.Items ?? [];
}

export type { Store };
export { createDdbStore };
