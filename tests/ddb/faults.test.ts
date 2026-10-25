// [LDB-DDB80..DDB84] The fault and call-count wrappers (lane L) behave as the
// suite's conflict injection and lane G's round-trip bounds rely on. Runs on
// DynamoDB Local through the `ddb` project's table pair.
import { GetCommand, PutCommand, QueryCommand, TransactWriteCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { describe, expect, it } from "vitest";
import { withCallCounter } from "../../src/store/ddb/counting";
import { withFaults, type WriteTouch } from "../../src/store/ddb/faults";
import { ddbHarness } from "../harness/ddb";

const { raw, tables } = ddbHarness;
const T = tables.main;
const put = (pk: string, sk: string, extra: Record<string, unknown> = {}) => new PutCommand({ TableName: T, Item: { pk, sk, ...extra } });
const get = (pk: string, sk: string, consistent = true) => new GetCommand({ TableName: T, Key: { pk, sk }, ConsistentRead: consistent });

describe("withFaults", () => {
  it("[LDB-DDB80] rate 1 faults every write unapplied, with SDK-shaped errors, and never a read", async () => {
    const doc = withFaults(raw, { rate: 1, seed: 7, tables });
    const names = new Set<string>();
    for (let i = 0; i < 60; i++) {
      const call =
        i % 2 === 0
          ? doc.send(put("A", `s${i}`))
          : doc.send(new TransactWriteCommand({ TransactItems: [{ Put: { TableName: T, Item: { pk: "A", sk: `s${i}` } } }, { Put: { TableName: T, Item: { pk: "A", sk: `t${i}` } } }] }));
      const e = await call.then(() => null, (x: unknown) => x as Error & { CancellationReasons?: { Code: string }[] });
      expect(e).not.toBeNull();
      names.add(e!.name);
      if (e!.name === "TransactionCanceledException") {
        expect(e!.CancellationReasons).toHaveLength(2);
        expect(e!.CancellationReasons!.some((r) => r.Code === "TransactionConflict")).toBe(true);
      }
    }
    expect(names).toContain("TransactionCanceledException");
    expect(names).toContain("InternalServerError");
    expect([...names].some((n) => n === "ThrottlingException" || n === "ProvisionedThroughputExceededException")).toBe(true);
    const q = await raw.send(new QueryCommand({ TableName: T, KeyConditionExpression: "pk = :p", ExpressionAttributeValues: { ":p": "A" }, ConsistentRead: true }));
    expect(q.Count).toBe(0); // injected calls are never applied
    expect((await doc.send(get("A", "x"))).Item).toBeUndefined(); // reads pass
    expect(doc.faultStats().injected.TransactionConflict).toBeGreaterThan(0);
  });

  it("[LDB-DDB80] the same seed injects the same faults; the fraction is near the rate", async () => {
    const run = async (seed: number) => {
      const doc = withFaults(raw, { rate: 0.2, seed, kinds: ["Throttling"] });
      const out: boolean[] = [];
      for (let i = 0; i < 400; i++) out.push(await doc.send(put("B", `k${i % 5}`, { i })).then(() => false, () => true));
      return out;
    };
    const a = await run(11);
    expect(await run(11)).toEqual(a);
    expect(await run(12)).not.toEqual(a);
    const n = a.filter(Boolean).length;
    expect(n).toBeGreaterThan(40);
    expect(n).toBeLessThan(120);
  });

  it("[LDB-DDB81] failWritesFor fails the whole call, Put and Transact and Update alike, until disposed", async () => {
    const doc = withFaults(raw, { tables });
    await doc.send(put("C", "keep", { v: 1 }));
    const seen: WriteTouch[] = [];
    const off = doc.failWritesFor((t) => (seen.push(t), t.key.pk === "C" && t.item?.poison === true));
    await expect(doc.send(put("C", "p1", { poison: true }))).rejects.toMatchObject({ name: "InjectedWriteFault" });
    await doc.send(put("C", "ok", { poison: false }));
    // A transaction with one poisoned item applies none of its items.
    await expect(
      doc.send(new TransactWriteCommand({ TransactItems: [{ Put: { TableName: T, Item: { pk: "C", sk: "t1" } } }, { Put: { TableName: T, Item: { pk: "C", sk: "t2", poison: true } } }] })),
    ).rejects.toMatchObject({ name: "InjectedWriteFault" });
    expect((await raw.send(get("C", "t1"))).Item).toBeUndefined();
    // Update/Delete predicates see the stored pre-image.
    await doc.send(put("C", "pre", { poison: true })).catch(() => {});
    await raw.send(put("C", "pre", { poison: true }));
    await expect(doc.send(new UpdateCommand({ TableName: T, Key: { pk: "C", sk: "pre" }, UpdateExpression: "SET v = :v", ExpressionAttributeValues: { ":v": 2 } }))).rejects.toMatchObject({ name: "InjectedWriteFault" });
    expect((await raw.send(get("C", "pre"))).Item).toEqual({ pk: "C", sk: "pre", poison: true });
    expect(seen.find((t) => t.op === "put")?.kind).toBe("main");
    off();
    await doc.send(put("C", "p1", { poison: true }));
    expect((await raw.send(get("C", "p1"))).Item?.poison).toBe(true);
    doc.clearFaults();
  });

  it("[LDB-DDB82] staleReads serves the previous version to eventual reads only, n times", async () => {
    const doc = withFaults(raw, { tables });
    await doc.send(put("D", "r", { v: 1 }));
    doc.staleReads(2);
    await doc.send(put("D", "r", { v: 2 }));
    expect((await doc.send(get("D", "r", true))).Item?.v).toBe(2); // consistent read is never stale
    expect((await doc.send(get("D", "r", false))).Item?.v).toBe(1);
    const q = await doc.send(new QueryCommand({ TableName: T, KeyConditionExpression: "pk = :p", ExpressionAttributeValues: { ":p": "D" } }));
    expect(q.Items?.map((i) => i.v)).toEqual([1]);
    expect((await doc.send(get("D", "r", false))).Item?.v).toBe(2); // budget spent
    // A key created while tracking reads as absent when stale.
    doc.staleReads(1);
    await doc.send(put("D", "new", { v: 1 }));
    expect((await doc.send(get("D", "new", false))).Item).toBeUndefined();
    expect(doc.faultStats().staleServed).toBe(3);
  });
});

describe("withCallCounter", () => {
  it("[LDB-DDB83] counts each command type, transact items and measure() deltas", async () => {
    const doc = withCallCounter(raw);
    const { calls } = await doc.calls.measure(async () => {
      await doc.send(put("E", "a"));
      await doc.send(get("E", "a"));
      await doc.send(new TransactWriteCommand({ TransactItems: [{ Put: { TableName: T, Item: { pk: "E", sk: "b" } } }, { Put: { TableName: T, Item: { pk: "E", sk: "c" } } }] }));
      await doc.send(new QueryCommand({ TableName: T, KeyConditionExpression: "pk = :p", ExpressionAttributeValues: { ":p": "E" } }));
    });
    expect(calls).toEqual({ total: 4, byCommand: { Put: 1, Get: 1, TransactWrite: 1, Query: 1 }, reads: 2, writes: 2, transactItems: 2 });
    doc.calls.reset();
    expect(doc.calls.snapshot().total).toBe(0);
  });

  it("[LDB-DDB84] composes over withFaults: counts attempts, faults included", async () => {
    const doc = withCallCounter(withFaults(raw, { rate: 1, kinds: ["InternalServerError"] }));
    await doc.send(put("F", "a")).catch(() => {});
    expect(doc.calls.snapshot().byCommand).toEqual({ Put: 1 });
  });
});
