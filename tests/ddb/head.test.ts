import { PutCommand } from "@aws-sdk/lib-dynamodb";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { ddbCutoverStore } from "../../src/store/ddb/cutover";
import { ddbHoldStore } from "../../src/store/ddb/holds";
import { eventKindKey } from "../../src/store/ddb/keys";
import { openDdb, type TestDdb } from "./helpers";

let t: TestDdb;
beforeAll(async () => {
  t = await openDdb("g-head");
});
afterAll(async () => {
  await t.drop();
});
beforeEach(async () => {
  await t.reset();
});

const put = (item: Record<string, unknown>, table: "main" | "ephemeral" = "main") =>
  t.ctx.doc.send(new PutCommand({ TableName: t.ctx.tables[table], Item: item }));

describe("head and state", () => {
  it("[LDB-DDB12] reads the validator in one shot and defaults an empty store to zeros", async () => {
    expect(await t.head.readHead(["a", "b"], "2026-01-01T00:00:00.000Z")).toEqual({
      seq: 0, authors: { version: 0, modifiedAt: null }, state: [null, null], deletes24h: 0,
    });
    expect(await t.head.headSeq()).toBe(0);
    expect(await t.head.metaCounts()).toEqual({ layoutCount: 0, layoutsModifiedAt: null, authorCount: 0, revisionAt: null });
    await put({ pk: "META", sk: "HEAD", seq: 7, live: 3, max_at: "2026-02-02T00:00:00.000Z" });
    await put({ pk: "META", sk: "AUTHORS", version: 4, modified_at: "2026-02-01T00:00:00.000Z", count: 9 });
    await t.state.put("cmini.last_full", "x");
    await t.state.put("dump.last_at", "y");
    // upstream_deleted events: only rolling-window ones with a rev count
    await put({ ...eventKindKey("upstream_deleted", 1), at: "2026-01-02T00:00:00.000Z", rev: 1 });
    await put({ ...eventKindKey("upstream_deleted", 2), at: "2025-01-02T00:00:00.000Z", rev: 1 });
    await put({ ...eventKindKey("upstream_deleted", 3), at: "2026-01-03T00:00:00.000Z", rev: null });
    expect(await t.head.readHead(["dump.last_at", "nope", "cmini.last_full"], "2026-01-01T00:00:00.000Z")).toEqual({
      seq: 7, authors: { version: 4, modifiedAt: "2026-02-01T00:00:00.000Z" }, state: ["y", null, "x"], deletes24h: 1,
    });
    expect(await t.head.readHead()).toMatchObject({ deletes24h: 0 });
    expect(await t.head.authorsHead()).toEqual({ version: 4, modifiedAt: "2026-02-01T00:00:00.000Z" });
    expect(await t.head.metaCounts()).toMatchObject({ layoutCount: 3, authorCount: 9, revisionAt: "2026-02-02T00:00:00.000Z" });
  });

  it("[LDB-DDB12] state get/getMany/put/delete", async () => {
    expect(await t.state.get("k")).toBeNull();
    await t.state.put("k", "1");
    await t.state.put("k", "2");
    await t.state.put("j", "3");
    expect(await t.state.get("k")).toBe("2");
    expect([...(await t.state.getMany(["k", "j", "zz", "k"]))]).toEqual([["k", "2"], ["j", "3"]]);
    expect((await t.state.getMany([])).size).toBe(0);
    await t.state.delete("k");
    await t.state.delete("k");
    expect(await t.state.get("k")).toBeNull();
    const many = Array.from({ length: 130 }, (_, i) => `key${i}`);
    for (const k of many.slice(0, 130)) await t.state.put(k, k);
    expect((await t.state.getMany(many)).size).toBe(130); // over BatchGet's 100-key limit
  });
});

describe("holds", () => {
  const clock = (iso: string) => () => iso;
  it("[LDB-DDB10] defaults to always granted", async () => {
    const h = ddbHoldStore(t.ctx);
    expect(await h.takeHold("c", 25, clock("2026-10-25T00:00:00.000Z"))).toBe(true);
    expect(await h.takeHold("c", 25, clock("2026-10-25T00:00:00.000Z"))).toBe(true);
    await h.releaseHold("c");
  });

  it("[LDB-DDB10] real holds: one lease per client, a daily budget, release and expiry", async () => {
    const h = ddbHoldStore(t.ctx, { realHolds: true, dailyBudgetSeconds: 60 });
    const t0 = new Date().toISOString();
    expect(await h.takeHold("a", 25, clock(t0))).toBe(true);
    expect(await h.takeHold("a", 25, clock(t0))).toBe(false); // lease held
    expect(await h.takeHold("b", 25, clock(t0))).toBe(true); // 50 of 60 used
    expect(await h.takeHold("c", 25, clock(t0))).toBe(false); // over budget; no lease left behind
    await h.releaseHold("a");
    expect(await h.takeHold("a", 10, clock(t0))).toBe(true); // 60 of 60
    expect(await h.takeHold("d", 1, clock(t0))).toBe(false);
    // An expired lease can be retaken (next day: fresh budget too).
    const tomorrow = new Date(Date.now() + 86400_000).toISOString();
    expect(await h.takeHold("b", 25, clock(tomorrow))).toBe(true);
    // A declined take left no lease: c can hold tomorrow.
    expect(await h.takeHold("c", 25, clock(tomorrow))).toBe(true);
  });
});

describe("cutover", () => {
  it("[LDB-DDB10] defaults to null", async () => {
    await t.state.put("cutover.mode", "read_only");
    expect(await ddbCutoverStore(t.ctx).mode()).toBeNull();
  });

  it("[LDB-DDB10] real mode reads STATE/cutover.mode and caches for a second", async () => {
    let now = 1000;
    const c = ddbCutoverStore(t.ctx, { realCutover: true, nowMs: () => now });
    expect(await c.mode()).toBeNull();
    await t.state.put("cutover.mode", "read_only");
    expect(await c.mode()).toBeNull(); // cached
    now += 1001;
    expect(await c.mode()).toBe("read_only");
    await t.state.put("cutover.mode", "proxy");
    now += 1001;
    expect(await c.mode()).toBe("proxy");
    await t.state.put("cutover.mode", "garbage");
    now += 1001;
    expect(await c.mode()).toBeNull();
  });
});
