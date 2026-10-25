import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { CommitInput } from "../../src/core/events";
import { RevConflictError } from "../../src/core/events";
import type { LayoutRow, Source } from "../../src/core/records";
import { catKey, nameKey } from "../../src/store/ddb/keys";
import { openDdb, queryPk, type TestDdb } from "./helpers";

let t: TestDdb;
beforeAll(async () => {
  t = await openDdb("g-events");
});
afterAll(async () => {
  await t.drop();
});
beforeEach(async () => {
  await t.reset();
});

const src: Source = { client: "test", version: "1" };
let clock = 0;
const now = () => new Date(Date.UTC(2026, 0, 1, 0, 0, clock++)).toISOString();

function createInput(id: string, name: string, over: Partial<CommitInput> = {}): CommitInput {
  return {
    layoutId: id, creating: true, currentN: 0, currentLayout: null, currentFormats: new Map(),
    layout: { kind: "created", name, owner: "u1", created_at: "2026-01-01T00:00:00.000Z", deleted: false },
    format: { kind: "created", lineage: "spark", format: "spark/1", payload: { keys: [1, 2, 3] }, hasMagic: false },
    modified_at: "2026-01-01T00:00:00.000Z", actor: "u1", via: "test", source: src, upstream: null,
    ...over,
  };
}

const cat = async (id: string) => (await t.ctx.doc.send(new (await import("@aws-sdk/lib-dynamodb")).GetCommand({ TableName: t.ctx.tables.main, Key: catKey(id), ConsistentRead: true }))).Item;

describe("commitWrite", () => {
  it("creates a layout with its events, revs, claim and counters", async () => {
    const r = await t.events.commitWrite(now, createInput("L1", "Foo"));
    expect(r.seqs).toEqual([1, 2]);
    expect(r.layout).toMatchObject({ id: "L1", name: "Foo", n: 2, layout_rev: 1, like_count: 0, link: null });
    expect(r.formats.get("spark")!.rev).toBe(1);
    expect(await t.head.headSeq()).toBe(2);
    expect((await t.head.metaCounts()).layoutCount).toBe(1);
    expect((await queryPk(t.ctx, "NAME#foo"))[0]).toMatchObject({ id: "L1" });
    expect(await queryPk(t.ctx, "EVL#L1")).toHaveLength(2);
    const byName = await t.layouts.byNameWithFormats("FOO");
    expect(byName!.layout.id).toBe("L1");
    expect(byName!.formats.get("spark")!.payload).toEqual({ keys: [1, 2, 3] });
    expect((await t.layouts.revision("L1", "spark", 1))!.eventSeq).toBe(2);
  });

  it("refuses a live name clash, case-insensitively, and writes nothing", async () => {
    await t.events.commitWrite(now, createInput("L1", "Foo"));
    await expect(t.events.commitWrite(now, createInput("L2", "fOO"))).rejects.toMatchObject({ status: 409 });
    expect(await t.head.headSeq()).toBe(2);
    expect(await cat("L2")).toBeUndefined();
  });

  it("maps a stale n to RevConflictError", async () => {
    const a = await t.events.commitWrite(now, createInput("L1", "Foo"));
    const upd = (n: number) => ({
      layoutId: "L1", creating: false, currentN: n, currentLayout: a.layout, currentFormats: a.formats,
      format: { kind: "updated" as const, lineage: "spark", format: "spark/1", payload: { keys: [9] }, hasMagic: false },
      modified_at: "2026-01-02T00:00:00.000Z", actor: "u1", via: "test", source: src, upstream: null,
    });
    const b = await t.events.commitWrite(now, upd(a.layout.n));
    expect(b.layout.n).toBe(3);
    await expect(t.events.commitWrite(now, upd(a.layout.n))).rejects.toBeInstanceOf(RevConflictError);
    expect(await t.head.headSeq()).toBe(3);
  });

  it("renames, deletes and restores moving the name claim and the live count", async () => {
    const a = await t.events.commitWrite(now, createInput("L1", "Foo"));
    const step = (cur: { layout: LayoutRow; formats: any }, kind: any, name: string, deleted: boolean) =>
      t.events.commitWrite(now, {
        layoutId: "L1", creating: false, currentN: cur.layout.n, currentLayout: cur.layout, currentFormats: cur.formats,
        layout: { kind, name, owner: "u1", created_at: cur.layout.created_at, deleted },
        modified_at: "2026-01-03T00:00:00.000Z", actor: "u1", via: "test", source: src, upstream: null,
      });
    const b = await step(a, "renamed", "Bar", false);
    expect(await queryPk(t.ctx, "NAME#foo")).toHaveLength(0);
    expect(await queryPk(t.ctx, "NAME#bar")).toHaveLength(1);
    const c = await step(b, "deleted", "Bar", true);
    expect(await queryPk(t.ctx, "NAME#bar")).toHaveLength(0);
    expect((await t.head.metaCounts()).layoutCount).toBe(0);
    expect(await t.layouts.byName("Bar")).toBeNull();
    expect((await t.layouts.byId("L1"))!.deleted).toBe(true);
    await t.events.commitWrite(now, createInput("L2", "Bar")); // the freed name is reusable
    expect((await t.layouts.tombstoneLikers("bar")).tombstoneId).toBe("L1");
    await step(c, "restored", "Bar", false).then(
      () => { throw new Error("restore over a live name must fail"); },
      (e) => expect(e.status).toBe(409),
    );
    expect(nameKey("Bar").pk).toBe("NAME#bar");
  });

  it("spills a payload over the item limit to a blob and reads it back", async () => {
    const big = { blob: "x".repeat(400_000) };
    const r = await t.events.commitWrite(now, createInput("L1", "Big", { format: { kind: "created", lineage: "spark", format: "spark/1", payload: big, hasMagic: false } }));
    expect(t.blobs.keys().length).toBe(1);
    expect((await cat("L1"))!.fmt.spark.payload_ref).toMatch(/^payloads\//);
    expect((await t.layouts.readFormat("L1", "spark"))!.payload).toEqual(big);
    expect((await t.layouts.revisionPayload("L1", "spark", 1))!.payloadJson.length).toBeGreaterThan(400_000);
    expect(r.seqs).toHaveLength(2);
  });

  it("counts destructive writes in the ephemeral table and probes the live count", async () => {
    const a = await t.events.commitWrite(now, createInput("L1", "Foo"));
    const del = (cur: typeof a) =>
      t.events.commitWrite(now, {
        layoutId: "L1", creating: false, currentN: cur.layout.n, currentLayout: cur.layout, currentFormats: cur.formats,
        layout: { kind: "renamed", name: "Foo2", owner: "u1", created_at: cur.layout.created_at, deleted: false },
        modified_at: "2026-01-03T00:00:00.000Z", actor: "u1", via: "client:c1", source: src, upstream: null, destructiveBudget: { clientId: "c1" },
      });
    const b = await del(a);
    expect(b.budgetProbe).toEqual({ clientId: "c1", countInWindow: 1, liveLayouts: 1 });
    const c = await del(b);
    expect(c.budgetProbe).toMatchObject({ countInWindow: 2 });
  });
});

describe("likes", () => {
  it("likes, refuses repeats, unlikes and counts", async () => {
    await t.events.commitWrite(now, createInput("L1", "Foo"));
    const like = (kind: "liked" | "unliked", userId = "u2") => t.events.appendLike(now, { kind, layoutId: "L1", userId, via: "test", source: src });
    expect((await like("liked")).like_count).toBe(1);
    await expect(like("liked")).rejects.toMatchObject({ status: 409 });
    expect((await like("liked", "u3")).like_count).toBe(2);
    expect((await t.layouts.likers(["L1"])).get("L1")).toEqual(["u2", "u3"]);
    expect(await t.layouts.likeCountByUser("u2")).toBe(1);
    expect((await like("unliked")).like_count).toBe(1);
    await expect(like("unliked")).rejects.toMatchObject({ status: 409 });
    expect(await t.layouts.likeCountByUser("u2")).toBe(0);
    await expect(t.events.appendLike(now, { kind: "liked", layoutId: "NOPE", userId: "u9", via: "t", source: src })).rejects.toThrow(/does not exist/);
  });

  it("inherited likes chunk at 15 and skip existing likers", async () => {
    await t.events.commitWrite(now, createInput("L1", "Foo"));
    await t.events.appendLike(now, { kind: "liked", layoutId: "L1", userId: "u0", via: "t", source: src });
    const users = Array.from({ length: 40 }, (_, i) => `u${i}`);
    const r = await t.events.appendInheritedLikes(now, { layoutId: "L1", name: "Foo", owner: "u1", userIds: users, via: "inherit", detail: { from: "L0" }, source: src });
    expect(r.like_count).toBe(40);
    expect((await t.layouts.likers(["L1"])).get("L1")!).toHaveLength(40);
    expect(await t.head.headSeq()).toBe(2 + 1 + 39);
  });
});

describe("events", () => {
  it("appends info, admin and moderation events and serves the feed", async () => {
    await t.events.commitWrite(now, createInput("L1", "Foo"));
    const i = await t.events.appendInfo(now, { kind: "upstream_changed", layoutId: "L1", actor: "sys", via: "import", source: src });
    const a = await t.events.appendAdmin(now, { kind: "admin.import_unstalled" as any, actor: "adm" });
    const m = await t.events.appendModeration(now, { kind: "link_submitted" as any, layoutId: "L1", actor: "adm", via: "discord", source: src, detail: { submission_id: "S1", url: "http://x" }, after: { a: 1 } });
    expect([i.seq, a.seq, m.seq]).toEqual([3, 4, 5]);
    const all = await t.events.feed(0, 100);
    expect(all.items.map((e) => e.seq)).toEqual([1, 2, 3, 4, 5]);
    expect(all.next).toBe(5);
    expect(all.items[4]!.detail).toEqual({ submission_id: "S1" }); // redacted on read
    expect((await t.events.feed(2, 2)).items.map((e) => e.seq)).toEqual([3, 4]);
    expect((await t.events.feed(0, 100, ["upstream_changed", "created"])).items.map((e) => e.seq)).toEqual([1, 2, 3]);
    expect((await t.events.feed(0, 100, ["created"])).items.map((e) => e.seq)).toEqual([1, 2]);
    expect((await t.events.feed(0, 100, undefined, { layoutId: "L1" })).items.map((e) => e.seq)).toEqual([1, 2, 3, 5]);
    expect((await t.events.feed(0, 100, undefined, { actor: "adm" })).items.map((e) => e.seq)).toEqual([4, 5]);
    expect((await t.events.feed(0, 100, undefined, { layoutId: "L1", format: "spark/1" })).items.map((e) => e.seq)).toEqual([2]);
    expect((await t.events.feed(5, 10)).items).toEqual([]);
    expect((await t.layouts.history("L1")).map((e) => e.seq)).toEqual([1, 2, 3, 5]);
    expect((await t.layouts.history("L1", "spark/1")).map((e) => e.seq)).toEqual([2]);
    expect((await t.layouts.latestRevBumpingEvent("L1", null))!.seq).toBe(1);
    expect((await t.layouts.latestRevBumpingEvent("L1", "spark/1"))!.seq).toBe(2);
    expect(await t.layouts.latestRevBumpingEvent("L1", "other/1")).toBeNull();
  });

  it("serves revert candidates newest first and the latest link event", async () => {
    const a = await t.events.commitWrite(now, createInput("L1", "Foo", { source: { client: "bot", version: null } }));
    await t.events.commitWrite(now, {
      layoutId: "L1", creating: false, currentN: a.layout.n, currentLayout: a.layout, currentFormats: a.formats,
      layout: { kind: "renamed", name: "Bar", owner: "u1", created_at: a.layout.created_at, deleted: false },
      modified_at: "2026-01-03T00:00:00.000Z", actor: "u1", via: "test", source: { client: "bot", version: null }, upstream: null,
    });
    const link = await t.events.appendLinkChange(now, { layoutId: "L1", kind: "link_cleared", link: null, actor: "adm", via: "d", admin: true, source: { client: "bot", version: null } });
    const c = await t.events.revertCandidates("bot", "2000-01-01T00:00:00.000Z", 1000, 10);
    expect(c.map((r) => [r.seq, r.kind])).toEqual([[link.seq, "link_cleared"], [3, "renamed"]]);
    expect((await t.events.revertCandidates("bot", "2000-01-01T00:00:00.000Z", link.seq, 10)).map((r) => r.seq)).toEqual([3]);
    expect((await t.events.revertCandidates("other", "2000-01-01T00:00:00.000Z", 1000, 10))).toEqual([]);
    expect((await t.events.latestLinkEvent("L1"))!.seq).toBe(link.seq);
    expect(await t.events.latestLinkEvent("L1", link.seq)).toBeNull();
  });

  it("approves a link through its claim, once", async () => {
    await t.events.commitWrite(now, createInput("L1", "Foo"));
    const { PutCommand } = await import("@aws-sdk/lib-dynamodb");
    await t.ctx.doc.send(new PutCommand({ TableName: t.ctx.tables.main, Item: { pk: "SUB#link#S1", sk: "ROW", status: "pending" } }));
    const r = await t.events.appendLinkChange(now, { layoutId: "L1", kind: "link_approved", link: "http://x", actor: "adm", via: "d", admin: true, source: src, submissionId: "S1" });
    expect(r.link).toBe("http://x");
    expect((await t.layouts.approvedLink("L1"))!.link).toBe("http://x");
    await expect(t.events.appendLinkChange(now, { layoutId: "L1", kind: "link_approved", link: "http://y", actor: "adm", via: "d", admin: true, source: src, submissionId: "S1" })).rejects.toMatchObject({ status: 404 });
    expect((await t.layouts.approvedLink("L1"))!.link).toBe("http://x");
  });
});
