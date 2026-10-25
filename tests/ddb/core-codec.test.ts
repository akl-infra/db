import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { CommitInput } from "../../src/core/events";
import type { Item } from "../../src/store/ddb/contracts";
import { coreSchema, inlinePayloads, payloadBlobs } from "../../src/store/ddb/schema/core";
import { openDdb, scanAll, type TestDdb } from "./helpers";

let t: TestDdb;
beforeAll(async () => {
  t = await openDdb("g-codec");
});
afterAll(async () => {
  await t.drop();
});

const src = { client: "test", version: "1" };
const now = () => "2026-10-01T00:00:00.000Z";

const sorted = (v: unknown): unknown =>
  Array.isArray(v) ? v.map(sorted) : v !== null && typeof v === "object" ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => (a < b ? -1 : 1)).map(([k, x]) => [k, sorted(x)])) : v;
const norm = (items: Item[]) => items.map((i) => JSON.stringify(sorted(i))).sort();

describe("[LDB-DDB1] the core codec matches what the store writes", () => {
  it("[LDB-DDB1] fromItems then toItems reproduces every item the store wrote, derived ones included", async () => {
    const mk = (id: string, name: string, payload: unknown): CommitInput => ({
      layoutId: id, creating: true, currentN: 0, currentLayout: null, currentFormats: new Map(),
      layout: { kind: "created", name, owner: "u1", created_at: now(), deleted: false },
      format: { kind: "created", lineage: "spark", format: "spark/1", payload, hasMagic: true, hasAlts: true },
      modified_at: now(), actor: "u1", via: "test", source: src, upstream: { source: "cmini", id: "77", state: "following" },
    });
    const a = await t.events.commitWrite(now, mk("K1", "One", { k: 1 }));
    await t.events.commitWrite(now, mk("K2", "Two", { k: 2 }));
    await t.events.commitWrite(now, mk("K3", "Big", { blob: "y".repeat(400_000) }));
    await t.events.appendLike(now, { kind: "liked", layoutId: "K1", userId: "fan", via: "t", source: src });
    await t.events.appendLike(now, { kind: "liked", layoutId: "K2", userId: "fan", via: "t", source: src });
    await t.events.appendLike(now, { kind: "unliked", layoutId: "K2", userId: "fan", via: "t", source: src });
    await t.events.appendInfo(now, { kind: "upstream_changed", layoutId: "K1", actor: "sys", via: "import", source: src });
    await t.events.appendAdmin(now, { kind: "admin.import_unstalled" as never, actor: "adm" });
    const second = await t.events.commitWrite(now, {
      layoutId: "K1", creating: false, currentN: a.layout.n, currentLayout: a.layout, currentFormats: a.formats,
      layout: { kind: "deleted", name: "One", owner: "u1", created_at: now(), deleted: true },
      modified_at: now(), actor: "u1", via: "test", source: src, upstream: null,
    });
    expect(second.layout.deleted).toBe(true);
    await t.state.put("dump.last_at", "x");

    const written = (await scanAll(t.ctx.doc, t.ctx.tables.main)).filter((i) => coreSchema.tableOf(i) !== null);
    const written2 = await inlinePayloads(t.blobs, written);
    const rows = coreSchema.fromItems({ main: written2, ephemeral: [] });
    expect(rows.layouts).toHaveLength(3);
    expect(rows.layout_formats).toHaveLength(3);
    expect(rows.events!.length).toBe(12);
    expect(rows.layouts_head).toEqual([{ id: 1, live: 2 }]);
    expect(rows.likes).toEqual([{ layout_id: "K1", user_id: "fan", at: now(), via: "t" }]);

    const regenerated = coreSchema.toItems(rows).main;
    // Spilled payloads come back as refs in both.
    expect(norm(regenerated)).toEqual(norm(written));
    expect([...payloadBlobs(rows).keys()]).toEqual(t.blobs.keys());
    expect(written.every((i) => coreSchema.tableOf(i) !== null)).toBe(true);
  });

  it("tableOf claims only lane G's items", () => {
    expect(coreSchema.tableOf({ pk: "SUB#link#1", sk: "ROW" })).toBeNull();
    expect(coreSchema.tableOf({ pk: "L#1", sk: "SET#link" })).toBeNull();
    expect(coreSchema.tableOf({ pk: "U#u", sk: "CL#1#a" })).toBeNull();
    expect(coreSchema.tableOf({ pk: "AUTHORS", sk: "u" })).toBeNull();
    expect(coreSchema.tableOf({ pk: "META", sk: "AUTHORS" })).toBeNull();
    expect(coreSchema.tableOf({ pk: "U#u", sk: "LK#1" })).toBe("likes");
  });
});
