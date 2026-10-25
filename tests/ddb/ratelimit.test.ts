// [LDB-DDB32] [LDB-DDB33] Rate-limit windows on DynamoDB: one ephemeral item
// per (key, window), counted with ADD, shaped as lane G's destructive budget
// expects, and a nightly prune that never resurrects a pruned window.
import { GetCommand, PutCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { describe, expect, it } from "vitest";
import { authSchema } from "../../src/store/ddb/schema/auth";
import { ddbHarness } from "../harness/ddb";

const { store, doc, tables, raw } = ddbHarness; // `raw` is the unfaulted client, for test setup writes
let n = 0;
const key = (p: string) => `${p}:${n++}-${Math.random().toString(36).slice(2, 8)}`;

describe("ratelimit", () => {
  it("[LDB-DDB32] counts hits in a window, resets in a new one, and N concurrent hits count 1..N exactly", async () => {
    const k = key("write");
    expect(await store.auth.hitWindow(k, 1200)).toEqual({ n: 1, window_start: 1200 });
    expect(await store.auth.hitWindow(k, 1200)).toEqual({ n: 2, window_start: 1200 });
    expect(await store.auth.hitWindow(k, 1800)).toEqual({ n: 1, window_start: 1800 });
    const k2 = key("write");
    const hits = await Promise.all(Array.from({ length: 20 }, () => store.auth.hitWindow(k2, 600)));
    expect(hits.map((h) => h.n).sort((a, b) => a - b)).toEqual(Array.from({ length: 20 }, (_, i) => i + 1));
  });

  it("[LDB-DDB32] the window item is RL#<key>/<window_start> with ttl = window_start + 2 h, in the ephemeral table", async () => {
    const k = key("client");
    const ws = Math.floor(Date.now() / 1000 / 600) * 600;
    await store.auth.hitWindow(k, ws);
    const r = await doc.send(new GetCommand({ TableName: tables.ephemeral, Key: { pk: `RL#${k}`, sk: String(ws) }, ConsistentRead: true }));
    expect(r.Item).toMatchObject({ n: 1, ttl: ws + 7200 });
  });

  it("[LDB-DDB33] a prune drops windows before the cutoff, keeps the rest, and a pruned window restarts at 1", async () => {
    const k = key("write");
    await store.auth.hitWindow(k, 600);
    await store.auth.hitWindow(k, 600);
    await store.auth.hitWindow(k, 1800);
    await store.auth.pruneRateLimits(1200);
    // The old window was pruned: the next hit just past its start counts from 1, never from its former 2.
    expect(await store.auth.hitWindow(k, 600)).toEqual({ n: 1, window_start: 600 });
    // The window at the cutoff and after it was kept.
    expect(await store.auth.hitWindow(k, 1800)).toEqual({ n: 2, window_start: 1800 });
  });

  it("[LDB-DDB33] a prune leaves lane G's daily holds budget alone", async () => {
    await raw.send(new PutCommand({ TableName: tables.ephemeral, Item: { pk: "RL#holds", sk: "2026-01-01", n: 3 } }));
    await store.auth.pruneRateLimits(10 ** 12);
    const r = await doc.send(new GetCommand({ TableName: tables.ephemeral, Key: { pk: "RL#holds", sk: "2026-01-01" }, ConsistentRead: true }));
    expect(r.Item?.n).toBe(3);
  });

  it("[LDB-DDB32] items written by hitWindow and by lane G's budget increment equal toItems of the exported rows", async () => {
    const k = key("client");
    const g = key("destructive");
    const ws = Math.floor(Date.now() / 1000 / 600) * 600;
    await store.auth.hitWindow(k, ws);
    await store.auth.hitWindow(k, ws);
    await raw.send(new UpdateCommand({
      TableName: tables.ephemeral, Key: { pk: `RL#${g}`, sk: String(ws) },
      UpdateExpression: "ADD n :one SET #ttl = :ttl", ExpressionAttributeNames: { "#ttl": "ttl" }, ExpressionAttributeValues: { ":one": 1, ":ttl": ws + 7200 },
    }));
    for (const x of [k, g]) {
      const stored = (await doc.send(new GetCommand({ TableName: tables.ephemeral, Key: { pk: `RL#${x}`, sk: String(ws) }, ConsistentRead: true }))).Item!;
      const rows = authSchema.fromItems({ main: [], ephemeral: [stored] }).ratelimit!;
      expect(authSchema.toItems({ ratelimit: rows }).ephemeral).toEqual([stored]);
    }
  });
});
