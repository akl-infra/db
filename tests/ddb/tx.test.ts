import { GetCommand, PutCommand, ScanCommand, TransactWriteCommand } from "@aws-sdk/lib-dynamodb";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { TxConditionFailed, type DdbContext, type EventInput } from "../../src/store/ddb/contracts";
import { createDocClient } from "../../src/store/ddb/client";
import { HEAD_KEY } from "../../src/store/ddb/keys";
import { createTables, deleteTables } from "../../src/store/ddb/tables";
import { runEventTx, runTx, txTuning } from "../../src/store/ddb/tx";

const PORT = Number(process.env.DDB_PORT ?? process.env.AKLDB_DDB_PORT ?? 18307);
const doc = createDocClient({ endpoint: `http://127.0.0.1:${PORT}`, region: "us-east-2" });
const tables = { main: "tx-test-main", ephemeral: "tx-test-eph" };
const ctx = { doc, tables, blobs: undefined as never, catalog: undefined as never } as DdbContext;

const ev = (over: Partial<EventInput> = {}): EventInput => ({
  at: "2026-01-01T00:00:00.000Z", kind: "created", layout_id: "L1", name: "n", owner: "u", format: null, rev: null,
  actor: "u", via: "test", admin: 0, detail_json: null, before_json: null, after_json: null, source_client: null, source_version: null,
  ...over,
});

const head = async () => (await doc.send(new GetCommand({ TableName: tables.main, Key: HEAD_KEY, ConsistentRead: true }))).Item;
const count = async (pk: string) =>
  (await doc.send(new ScanCommand({ TableName: tables.main, FilterExpression: "pk = :p", ExpressionAttributeValues: { ":p": pk } }))).Items!.length;

beforeAll(async () => {
  await deleteTables(doc, tables);
  await createTables(doc, tables);
  txTuning.sleep = async () => {};
});
afterAll(async () => {
  await deleteTables(doc, tables);
});
beforeEach(async () => {
  for (const t of [tables.main]) {
    const all = (await doc.send(new ScanCommand({ TableName: t }))).Items!;
    for (const i of all) await doc.send(new TransactWriteCommand({ TransactItems: [{ Delete: { TableName: t, Key: { pk: i.pk, sk: i.sk } } }] }));
  }
});

describe("client", () => {
  it("[LDB-DDB13] refuses a non-loopback endpoint", () => {
    expect(() => createDocClient({ endpoint: "https://dynamodb.us-east-2.amazonaws.com", region: "us-east-2" })).toThrow(/refusing/);
    expect(() => createDocClient({ region: "us-east-2" })).toThrow(/refusing/);
  });
});

describe("runEventTx", () => {
  it("[LDB-DDB6] assigns gap-free seqs, writes mirrors and moves HEAD", async () => {
    const r = await runEventTx(ctx, (b) => {
      expect(b.head.seq).toBe(0);
      expect(b.event(ev())).toBe(1);
      expect(b.event(ev({ at: "2025-01-01T00:00:00.000Z", layout_id: null }))).toBe(2);
      b.addLive(1);
    });
    expect(r.seqs).toEqual([1, 2]);
    expect(await head()).toMatchObject({ seq: 2, live: 1, max_at: "2026-01-01T00:00:00.000Z" });
    expect(await count("EV")).toBe(2);
    expect(await count("EVL#L1")).toBe(1);
    expect(await count("EVK#created")).toBe(2);
    expect(await count("EVA#u")).toBe(2);
    await runEventTx(ctx, (b) => {
      expect(b.head).toEqual({ seq: 2, live: 1, maxAt: "2026-01-01T00:00:00.000Z" });
      b.event(ev({ at: "2025-06-01T00:00:00.000Z" }));
      b.addLive(-1);
    });
    expect(await head()).toMatchObject({ seq: 3, live: 0, max_at: "2026-01-01T00:00:00.000Z" });
  });

  it("[LDB-DDB6] throws TxConditionFailed with the tag of a failed domain item, and writes nothing", async () => {
    await doc.send(new PutCommand({ TableName: tables.main, Item: { pk: "CAT", sk: "x", n: 1 } }));
    await expect(
      runEventTx(ctx, (b) => {
        b.event(ev());
        b.item("cat", {
          Update: { TableName: tables.main, Key: { pk: "CAT", sk: "x" }, UpdateExpression: "SET n = :m", ConditionExpression: "n = :n", ExpressionAttributeValues: { ":n": 9, ":m": 10 } },
        });
      }),
    ).rejects.toEqual(new TxConditionFailed(["cat"]));
    expect(await head()).toBeUndefined();
    expect(await count("EV")).toBe(0);
  });

  it("[LDB-DDB6] retries when another append wins the HEAD", async () => {
    let calls = 0;
    const r = await runEventTx(ctx, async (b) => {
      calls++;
      if (calls === 1) await runEventTx(ctx, (b2) => void b2.event(ev({ kind: "other" }))); // a rival commits between read and write
      b.event(ev());
    });
    expect(calls).toBe(2);
    expect(r.seqs).toEqual([2]);
    expect(await head()).toMatchObject({ seq: 2 });
  });

  it("[LDB-DDB6] retries a TransactionConflict, then gives up with a 500 and a log line", async () => {
    const real = doc.send.bind(doc);
    let fails = 3;
    const spy = vi.spyOn(doc, "send").mockImplementation((async (c: any) => {
      if (c instanceof TransactWriteCommand && fails-- > 0) {
        throw Object.assign(new Error("cancelled"), { name: "TransactionCanceledException", CancellationReasons: [{ Code: "TransactionConflict" }] });
      }
      return real(c);
    }) as never);
    const r = await runEventTx(ctx, (b) => void b.event(ev()));
    expect(r.seqs).toEqual([1]);
    expect(spy.mock.calls.filter(([c]) => c instanceof TransactWriteCommand).length).toBe(4);

    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    fails = Infinity;
    await expect(runEventTx(ctx, (b) => void b.event(ev()))).rejects.toMatchObject({ status: 500 });
    expect(log.mock.calls.some(([m]) => String(m).includes("EVENTTX_EXHAUSTED"))).toBe(true);
    spy.mockRestore();
    log.mockRestore();
  });
});

describe("runTx", () => {
  it("[LDB-DDB6] commits, and tags a failed condition", async () => {
    await runTx(ctx, [{ tag: "a", item: { Put: { TableName: tables.main, Item: { pk: "X", sk: "1" }, ConditionExpression: "attribute_not_exists(pk)" } } }]);
    await expect(
      runTx(ctx, [
        { tag: "ok", item: { Put: { TableName: tables.main, Item: { pk: "X", sk: "2" } } } },
        { tag: "dup", item: { Put: { TableName: tables.main, Item: { pk: "X", sk: "1" }, ConditionExpression: "attribute_not_exists(pk)" } } },
      ]),
    ).rejects.toEqual(new TxConditionFailed(["dup"]));
    expect(await count("X")).toBe(1);
  });
});
