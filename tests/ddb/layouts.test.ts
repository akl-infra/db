import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { CommitInput } from "../../src/core/events";
import { decodeCursor, encodeCursor, type ListParams } from "../../src/core/records";
import { cmpBinary, cmpNocase } from "../../src/store/ddb/layouts";
import { openDdb, type TestDdb } from "./helpers";

let t: TestDdb;
beforeAll(async () => {
  t = await openDdb("g-layouts");
});
afterAll(async () => {
  await t.drop();
});
beforeEach(async () => {
  await t.reset();
});

const src = { client: "test", version: "1" };
const now = () => "2026-10-01T00:00:00.000Z";

async function create(id: string, name: string, o: { owner?: string; at?: string; fmtAt?: string; magic?: boolean; alts?: boolean; combos?: boolean; lineage?: string } = {}) {
  const input: CommitInput = {
    layoutId: id, creating: true, currentN: 0, currentLayout: null, currentFormats: new Map(),
    layout: { kind: "created", name, owner: o.owner ?? "u1", created_at: o.at ?? "2026-01-01T00:00:00.000Z", deleted: false },
    format: { kind: "created", lineage: o.lineage ?? "spark", format: `${o.lineage ?? "spark"}/1`, payload: { n: name }, hasMagic: o.magic ?? false, hasAlts: o.alts, hasCombos: o.combos },
    modified_at: o.fmtAt ?? o.at ?? "2026-01-01T00:00:00.000Z", actor: "u1", via: "test", source: src, upstream: null,
  };
  return t.events.commitWrite(now, input);
}
const like = (id: string, userId: string) => t.events.appendLike(now, { kind: "liked", layoutId: id, userId, via: "t", source: src });

const base = (over: Partial<ListParams> = {}): ListParams => ({ sourceLineage: "spark", sort: "name", limit: 50, ...over });
const names = async (p: ListParams) => (await t.layouts.list(p)).items.map((i) => i.layout.name);

async function walk(p: ListParams, limit: number): Promise<string[]> {
  const out: string[] = [];
  let cursor = undefined as ListParams["cursor"];
  for (let i = 0; i < 100; i++) {
    const page = await t.layouts.list({ ...p, limit, cursor });
    out.push(...page.items.map((x) => x.layout.id));
    if (page.nextCursor === null) return out;
    cursor = decodeCursor(page.nextCursor)!;
  }
  throw new Error("list never ended");
}

describe("comparators", () => {
  it("[LDB-DDB9] compares by code point, and NOCASE folds ASCII only", () => {
    expect(cmpBinary("a", "b")).toBe(-1);
    expect(cmpBinary("￿", "\u{10000}")).toBe(-1); // JS `<` says the opposite
    expect("￿" < "\u{10000}").toBe(false);
    expect(cmpBinary("ab", "abc")).toBe(-1);
    expect(cmpNocase("ABC", "abc")).toBe(0);
    expect(cmpNocase("Ä", "ä")).toBe(-1); // non-ASCII is not folded
  });
});

describe("list", () => {
  it("[LDB-DDB9] name order is ASCII-case-insensitive byte order, with astral names last", async () => {
    await create("L1", "banana");
    await create("L2", "Apple");
    await create("L3", "cherry");
    await create("L4", "\u{1F600}smile");
    await create("L5", "￿end");
    await create("L6", "Zed");
    expect(await names(base())).toEqual(["Apple", "banana", "cherry", "Zed".toLowerCase() === "zed" ? "Zed" : "", "￿end", "\u{1F600}smile"]);
    // (Paging across the non-Latin-1 names is not tested: core's encodeCursor uses btoa and throws on them, on D1 too.)
    expect(await walk(base(), 50)).toHaveLength(6);
  });

  it("[LDB-DDB9] sorts like_count, created_at and modified_at descending, ties by id ascending", async () => {
    await create("B1", "one", { at: "2026-01-01T00:00:00.000Z" });
    await create("B2", "two", { at: "2026-03-01T00:00:00.000Z" });
    await create("B3", "three", { at: "2026-02-01T00:00:00.000Z", fmtAt: "2026-06-01T00:00:00.000Z" });
    await create("B4", "four", { at: "2026-03-01T00:00:00.000Z" });
    await like("B3", "x");
    await like("B3", "y");
    await like("B1", "x");
    expect(await walk(base({ sort: "like_count" }), 3)).toEqual(["B3", "B1", "B2", "B4"]);
    expect(await walk(base({ sort: "created_at" }), 3)).toEqual(["B2", "B4", "B3", "B1"]);
    // modified_at = max(layout, format): B3's format moved later than its layout
    expect((await t.layouts.list(base({ sort: "modified_at" }))).items[0]!.layout.id).toBe("B3");
  });

  it("[LDB-DDB9] filters: owner, flags, since, likedBy, lineage; skips tombstones; withPayload false", async () => {
    await create("C1", "one", { owner: "u1", magic: true });
    await create("C2", "two", { owner: "u2", alts: true, at: "2026-05-01T00:00:00.000Z" });
    await create("C3", "three", { owner: "u1", combos: true });
    await create("C4", "four", { owner: "u1", lineage: "lw" });
    await like("C2", "fan");
    expect(await names(base({ owner: "u1" }))).toEqual(["one", "three"]);
    expect(await names(base({ hasMagic: true }))).toEqual(["one"]);
    expect(await names(base({ hasMagic: false }))).toEqual(["three", "two"]);
    expect(await names(base({ hasAlts: true }))).toEqual(["two"]);
    expect(await names(base({ hasCombos: true }))).toEqual(["three"]);
    expect(await names(base({ since: "2026-04-01T00:00:00.000Z" }))).toEqual(["two"]);
    expect(await names(base({ since: "2026-05-01T00:00:00.000Z" }))).toEqual([]); // strictly greater
    expect(await names(base({ likedBy: "fan" }))).toEqual(["two"]);
    expect(await names(base({ sourceLineage: "lw" }))).toEqual(["four"]);
    const noPayload = await t.layouts.list(base({ withPayload: false }));
    expect(noPayload.items[0]!.format.payload).toBeUndefined();
    expect(noPayload.items[0]!.format.has_magic).toBe(true);
    await t.events.commitWrite(now, {
      layoutId: "C1", creating: false, currentN: 2, currentLayout: (await t.layouts.byId("C1"))!, currentFormats: await t.layouts.formatsForLayout("C1"),
      layout: { kind: "deleted", name: "one", owner: "u1", created_at: "2026-01-01T00:00:00.000Z", deleted: true },
      modified_at: "2026-07-01T00:00:00.000Z", actor: "u1", via: "t", source: src, upstream: null,
    });
    expect(await names(base({ owner: "u1" }))).toEqual(["three"]);
  });

  it("[LDB-DDB9] applies SQLite's cross-type rules to hand-made cursors", async () => {
    await create("D1", "a", { at: "2026-01-01T00:00:00.000Z" });
    await create("D2", "b", { at: "2026-02-01T00:00:00.000Z" });
    await like("D1", "x");
    await like("D2", "x");
    await like("D2", "y");
    const ids = async (p: ListParams) => (await t.layouts.list(p)).items.map((i) => i.layout.id);
    // like_count has INTEGER affinity: "1" behaves as 1; non-numeric text sorts above every number
    expect(await ids(base({ sort: "like_count", cursor: { sortValue: "1", id: "D1" } }))).toEqual([]);
    expect(await ids(base({ sort: "like_count", cursor: { sortValue: 2, id: "A" } }))).toEqual(["D2", "D1"]);
    expect(await ids(base({ sort: "like_count", cursor: { sortValue: 2, id: "D2" } }))).toEqual(["D1"]);
    expect(await ids(base({ sort: "like_count", cursor: { sortValue: "abc", id: "A" } }))).toEqual(["D2", "D1"]);
    // created_at has TEXT affinity: a number becomes text ("5" > "2026-...")
    expect(await ids(base({ sort: "created_at", cursor: { sortValue: 5, id: "A" } }))).toEqual(["D2", "D1"]);
    // MAX(...) has no affinity: any text is greater than any number
    expect(await ids(base({ sort: "modified_at", cursor: { sortValue: 5, id: "A" } }))).toEqual([]);
  });

  it("[LDB-DDB9] encodes the next cursor from the last returned row's sort value", async () => {
    await create("E1", "Mixed");
    await create("E2", "other");
    const page = await t.layouts.list(base({ limit: 1 }));
    expect(decodeCursor(page.nextCursor!)).toEqual({ sortValue: "Mixed", id: "E1" });
    expect(page.nextCursor).toBe(encodeCursor({ sortValue: "Mixed", id: "E1" }));
  });
});

describe("single-layout reads", () => {
  it("[LDB-DDB12] resolves ids and names, ULID-shaped refs try the id first", async () => {
    const id = "01HZZZZZZZZZZZZZZZZZZZZZZZ";
    await create(id, "Real");
    await create("X1", "other");
    expect((await t.layouts.byRef(id))!.name).toBe("Real");
    expect((await t.layouts.byRef("REAL"))!.id).toBe(id);
    expect(await t.layouts.byRef("nope")).toBeNull();
    expect((await t.layouts.byRefWithFormats("real"))!.formats.get("spark")!.format).toBe("spark/1");
    expect((await t.layouts.layoutPresence(id))).toEqual({ exists: true, live: true });
    expect((await t.layouts.layoutPresence("zzz"))).toEqual({ exists: false, live: false });
    expect(await t.layouts.liveCountByOwner("u1")).toBe(2);
    expect((await t.layouts.formatsForLayouts([id, "missing"])).get("missing")!.size).toBe(0);
    expect(await t.layouts.readFormat(id, "lw")).toBeNull();
    expect(await t.layouts.revisionPayload(id, "spark", 9)).toBeNull();
  });

  it("[LDB-DDB12] finds the latest tombstone of a name with its likers", async () => {
    await create("T1", "Gone");
    await like("T1", "u9");
    await like("T1", "u2");
    const cur = (await t.layouts.byId("T1"))!;
    await t.events.commitWrite(now, {
      layoutId: "T1", creating: false, currentN: cur.n, currentLayout: cur, currentFormats: await t.layouts.formatsForLayout("T1"),
      layout: { kind: "deleted", name: "Gone", owner: "u1", created_at: cur.created_at, deleted: true },
      modified_at: "2026-08-01T00:00:00.000Z", actor: "u1", via: "t", source: src, upstream: null,
    });
    expect(await t.layouts.tombstoneLikers("GONE")).toEqual({ tombstoneId: "T1", userIds: ["u2", "u9"] });
    expect(await t.layouts.tombstoneLikers("none")).toEqual({ tombstoneId: null, userIds: [] });
  });
});
