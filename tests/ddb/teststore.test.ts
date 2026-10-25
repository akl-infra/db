// [LDB-DDB75] [LDB-DDB76] The DynamoDB TestStore answers like the D1 one:
// D1-shaped rows, defaults, constraint errors, trigger effects on the head
// tables, ordering by primary key -- and keeps every derived item consistent
// (the index checker stays clean). `faults.failWrites(table)` cancels any
// write touching an item of that table.
import { GetCommand, PutCommand } from "@aws-sdk/lib-dynamodb";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { seedBootstrap } from "../../src/store/ddb/codec";
import { checkIndexes } from "../../src/store/ddb/checker";
import { SPILL_BYTES } from "../../src/store/ddb/payload";
import { SCHEMAS } from "../../src/store/ddb/schema";
import { ddbHarness, testStore } from "../harness/ddb";
import { wipeTables } from "../harness/ddb-store";

const ctx = { doc: ddbHarness.raw, tables: ddbHarness.tables, blobs: ddbHarness.blobs };
const T = ctx.tables.main;
const head = async () => (await ctx.doc.send(new GetCommand({ TableName: T, Key: { pk: "META", sk: "HEAD" }, ConsistentRead: true }))).Item;
const clean = async () => expect(await checkIndexes(ctx)).toEqual({ ok: true, problems: [] });

const laneReady = (i: number): boolean => {
  try {
    SCHEMAS[i]!.toItems({ [SCHEMAS[i]!.tables[0]!]: [] });
    return true;
  } catch {
    return false;
  }
};

const layout = (id: string, name: string, over: Record<string, unknown> = {}) => ({
  id, name, owner: "u1", n: 1, layout_rev: 1, created_at: "2026-01-01T00:00:00.000Z", modified_at: "2026-01-01T00:00:00.000Z", ...over,
});
const format = (layout_id: string, lineage: string, over: Record<string, unknown> = {}) => ({
  layout_id, lineage, format: lineage, rev: 1, created_at: "2026-01-01T00:00:00.000Z", modified_at: "2026-01-01T00:00:00.000Z", payload_json: '{"a":1}', ...over,
});

beforeEach(() => wipeTables(ctx));
afterEach(() => testStore.faults.clear());

describe("TestStore reads and writes", () => {
  it("[LDB-DDB75] insert fills column defaults, booleans become 0/1, and rows read back D1-shaped", async () => {
    await testStore.insert("layouts", layout("L1", "One", { deleted: false }));
    await testStore.insert("layout_formats", format("L1", "spark/1"));
    await testStore.insert("likes", { layout_id: "L1", user_id: "u9", at: "2026-01-02T00:00:00.000Z" });
    expect(await testStore.row("layouts", { id: "L1" })).toEqual({
      ...layout("L1", "One"), deleted: 0, like_count: 0, like_adjust: 0, link: null, upstream_source: null, upstream_id: null, upstream_state: null,
      source_client: null, source_version: null,
    });
    expect(await testStore.row("layout_formats", { layout_id: "L1", lineage: "spark/1" })).toMatchObject({ has_magic: 0, has_alts: 0, has_combos: 0, source_client: null });
    expect(await testStore.row("likes", { user_id: "u9" })).toMatchObject({ via: "import:cmini" });
    await clean();
  });

  it("[LDB-DDB75] where (null matches NULL, booleans match 0/1), orderBy, count and row", async () => {
    await testStore.insert("layouts", layout("B", "bee", { link: "x" }), layout("A", "Ay"), layout("C", "see", { deleted: 1 }));
    expect((await testStore.rows("layouts")).map((r) => r.id)).toEqual(["A", "B", "C"]); // primary key order
    expect((await testStore.rows("layouts", {}, ["name"])).map((r) => r.name)).toEqual(["Ay", "bee", "see"]); // bytewise: uppercase first
    expect((await testStore.rows("layouts", { link: null })).map((r) => r.id)).toEqual(["A", "C"]);
    expect(await testStore.count("layouts", { deleted: true })).toBe(1);
    expect(await testStore.count("layouts")).toBe(3);
    expect(await testStore.row("layouts", { id: "nope" })).toBeNull();
    await expect(testStore.row("layouts", { owner: "u1" })).rejects.toThrow(/more than one/);
    await expect(testStore.rows("layouts", { nope: 1 })).rejects.toThrow(/no column named nope/);
    await clean();
  });

  it("[LDB-DDB75] refuses what SQLite refuses: unknown columns, missing NOT NULL, duplicate primary keys, NULL into NOT NULL", async () => {
    await expect(testStore.insert("layouts", layout("L1", "n", { bogus: 1 }))).rejects.toThrow(/no column named bogus/);
    const { name: _n, ...noName } = layout("L1", "n");
    await expect(testStore.insert("layouts", noName)).rejects.toThrow(/NOT NULL constraint failed: layouts.name/);
    await testStore.insert("layouts", layout("L1", "n"));
    await expect(testStore.insert("layouts", layout("L1", "other"))).rejects.toThrow(/UNIQUE constraint failed/);
    await expect(testStore.patch("layouts", { id: "L1" }, { owner: null })).rejects.toThrow(/NOT NULL/);
    expect(await testStore.count("layouts")).toBe(1);
  });

  it("[LDB-DDB75] patch returns the rows matched and moves the name claim; remove returns the rows gone and drops the claim", async () => {
    await testStore.insert("layouts", layout("L1", "Alpha"), layout("L2", "Beta"));
    expect(await testStore.patch("layouts", { owner: "u1" }, { owner: "u2" })).toBe(2);
    expect(await testStore.patch("layouts", { owner: "nobody" }, { owner: "u2" })).toBe(0);
    await testStore.patch("layouts", { id: "L1" }, { name: "Gamma" });
    const claims = async () => (await ddbHarness.raw.send(new (await import("@aws-sdk/lib-dynamodb")).ScanCommand({ TableName: T, ConsistentRead: true }))).Items!.filter((i) => String(i.pk).startsWith("NAME#")).map((i) => i.pk).sort();
    expect(await claims()).toEqual(["NAME#beta", "NAME#gamma"]);
    expect(await testStore.remove("layouts", { id: "L2" })).toBe(1);
    expect(await claims()).toEqual(["NAME#gamma"]);
    expect(await testStore.remove("layouts", { id: "L2" })).toBe(0);
    await clean();
  });

  it("[LDB-DDB75] D1's layouts_head triggers: live moves with insert, tombstoning, reviving and delete", async () => {
    const live = async () => (await testStore.row("layouts_head", { id: 1 }))!.live;
    expect(await live()).toBe(0); // a store with no HEAD reads like D1's seeded row
    await testStore.insert("layouts", layout("L1", "a"), layout("L2", "b", { deleted: 1 }));
    expect(await live()).toBe(1);
    await testStore.patch("layouts", { id: "L2" }, { deleted: 0 });
    expect(await live()).toBe(2);
    await testStore.patch("layouts", { id: "L1" }, { deleted: 1 });
    expect(await live()).toBe(1);
    await testStore.patch("layouts", { id: "L1" }, { deleted: 1, owner: "z" }); // not a flip
    expect(await live()).toBe(1);
    await testStore.remove("layouts", { id: "L2" });
    expect(await live()).toBe(0);
    expect((await head())?.live).toBe(0);
    await clean();
  });

  it("[LDB-DDB75] events: seq is assigned when absent, HEAD seq/max_at follow and never move down, HEAD is merged not replaced", async () => {
    const ev = (at: string, over: Record<string, unknown> = {}) => ({ at, kind: "created", actor: "a", via: "t", ...over });
    await testStore.insert("events", ev("2026-01-01T00:00:00.000Z"), ev("2026-03-01T00:00:00.000Z", { layout_id: "L1" }));
    expect((await testStore.rows("events")).map((r) => r.seq)).toEqual([1, 2]);
    await ctx.doc.send(new (await import("@aws-sdk/lib-dynamodb")).UpdateCommand({ TableName: T, Key: { pk: "META", sk: "HEAD" }, UpdateExpression: "SET other_lane_attr = :x", ExpressionAttributeValues: { ":x": 7 } }));
    await testStore.insert("events", ev("2026-02-01T00:00:00.000Z"));
    expect(await head()).toMatchObject({ seq: 3, max_at: "2026-03-01T00:00:00.000Z", other_lane_attr: 7 });
    await testStore.remove("events", { seq: 3 });
    expect(await head()).toMatchObject({ seq: 3, other_lane_attr: 7 }); // AUTOINCREMENT never reuses a seq
    await testStore.insert("events", ev("2026-04-01T00:00:00.000Z"));
    expect((await testStore.rows("events")).map((r) => r.seq)).toEqual([1, 2, 3]); // max of the rows + 1: D1 without the removed row's history
    await ctx.doc.send(new (await import("@aws-sdk/lib-dynamodb")).UpdateCommand({ TableName: T, Key: { pk: "META", sk: "HEAD" }, UpdateExpression: "REMOVE other_lane_attr" }));
    await clean();
  });

  it("[LDB-DDB75] a payload over the spill limit reads back inline through the TestStore", async () => {
    const big = JSON.stringify({ pad: "x".repeat(SPILL_BYTES + 10) });
    await testStore.insert("layouts", layout("L1", "big"));
    await testStore.insert("layout_formats", format("L1", "spark/1", { payload_json: big }));
    expect((await testStore.row("layout_formats", { layout_id: "L1" }))!.payload_json).toBe(big);
    expect(ddbHarness.blobs).toBeDefined();
    await testStore.patch("layout_formats", { layout_id: "L1" }, { rev: 2 });
    expect((await testStore.row("layout_formats", { layout_id: "L1" }))!.payload_json).toBe(big);
    await clean();
  });

  it("[LDB-DDB75] two live layouts whose names fold together cannot both be inserted, as D1's partial unique index refuses", async () => {
    await testStore.insert("layouts", layout("L1", "Same"));
    await expect(testStore.insert("layouts", layout("L2", "sAME"))).rejects.toThrow(/two rows imply item/);
    await testStore.insert("layouts", layout("L3", "sAME", { deleted: 1 }));
    expect(await testStore.count("layouts")).toBe(2);
  });

  it.skipIf(!laneReady(1))("[LDB-DDB75] D1's authors_head triggers: version, modified_at and count move with insert, rename and delete", async () => {
    const h = async () => testStore.row("authors_head", { id: 1 });
    await testStore.insert("authors", { user_id: "u1", name: "One", first_seen_at: "t1", last_seen_at: "t1" });
    expect(await h()).toMatchObject({ version: 1, modified_at: "t1", count: 1 });
    await testStore.patch("authors", { user_id: "u1" }, { name: "Uno", last_seen_at: "t2" });
    expect(await h()).toMatchObject({ version: 2, modified_at: "t2", count: 1 });
    await testStore.patch("authors", { user_id: "u1" }, { last_seen_at: "t3" }); // not a rename
    expect(await h()).toMatchObject({ version: 2, modified_at: "t2" });
    await testStore.remove("authors", { user_id: "u1" });
    expect(await h()).toMatchObject({ version: 3, count: 0 });
    await clean();
  });
});

describe("TestStore.faults", () => {
  it("[LDB-DDB76] failWrites(table) cancels any write touching an item of that table, until clear()", async () => {
    await testStore.faults.failWrites("likes");
    const likeItem = { pk: "L#L1", sk: "LK#u1", layout_id: "L1", user_id: "u1", at: "t", via: "x" };
    const err = await ddbHarness.doc.send(new PutCommand({ TableName: T, Item: likeItem })).then(() => null, (e: Error) => e);
    expect(err?.name).toBe("InjectedWriteFault");
    // the user-side mirror is the same table; other tables are untouched
    await expect(ddbHarness.doc.send(new PutCommand({ TableName: T, Item: { pk: "U#u1", sk: "LK#L1" } }))).rejects.toThrow(/injected/);
    await ddbHarness.doc.send(new PutCommand({ TableName: T, Item: { pk: "STATE", sk: "k", key: "k", value: "v" } }));
    await testStore.faults.clear();
    await ddbHarness.doc.send(new PutCommand({ TableName: T, Item: likeItem }));
    expect((await ddbHarness.raw.send(new GetCommand({ TableName: T, Key: { pk: "L#L1", sk: "LK#u1" }, ConsistentRead: true }))).Item).toBeDefined();
  });

  it("[LDB-DDB76] the TestStore's own writes are not subject to the faults it installs", async () => {
    await testStore.faults.failWrites("layouts");
    await testStore.insert("layouts", layout("L1", "ok")); // seeding goes straight to DynamoDB
    expect(await testStore.count("layouts")).toBe(1);
    await testStore.faults.clear();
  });

  it("[LDB-DDB76] an unknown table is refused", async () => {
    await expect(testStore.faults.failWrites("nope" as never)).rejects.toThrow(/unknown table/);
  });
});

describe("migration parity", () => {
  it("[LDB-DDB79] seedBootstrap writes what the D1 migrations seed, once, and leaves the index checker clean", async () => {
    await seedBootstrap(ctx);
    await seedBootstrap(ctx); // repeatable, never overwrites
    expect(await testStore.row("layouts_head", { id: 1 })).toEqual({ id: 1, live: 0 });
    expect(await head()).toMatchObject({ seq: 0, live: 0 });
    if (laneReady(1)) {
      expect(await testStore.rows("admins")).toEqual([{ user_id: "184412255822020608", added_by: null, added_at: "2026-09-08T00:00:00Z", note: "bootstrap: deeroh" }]);
      expect(await testStore.row("authors_head", { id: 1 })).toEqual({ id: 1, version: 0, modified_at: null, count: 0 });
      const count = (await ctx.doc.send(new GetCommand({ TableName: T, Key: { pk: "META", sk: "ADMINS" }, ConsistentRead: true }))).Item;
      expect(count?.count).toBe(1);
      await testStore.insert("admins", { user_id: "2", added_at: "t" });
      expect((await ctx.doc.send(new GetCommand({ TableName: T, Key: { pk: "META", sk: "ADMINS" }, ConsistentRead: true }))).Item?.count).toBe(2);
    }
    await clean();
  });
});
