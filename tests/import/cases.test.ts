// [LDB-I2] [LDB-I4] [LDB-I5] One `it` per row of 07 §6 S5's case table,
// restated for 21-formats.md §2.2: the importer touches the layout's own
// fields (name/owner/created_at) and lineage `spark` ONLY, one event per
// scope actually changed. A create is layout+format together (two events);
// a name/owner/created_at-only change is a LAYOUT-scope event; a
// payload-only change is a FORMAT-scope event; both together append one of
// each, in one batch.
import { env } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Bindings } from "../../src/env";
import { commitWrite, type CommitInput } from "../../src/core/events";
import * as eventsModule from "../../src/core/events";
import { formatsForLayout, readById, readByName, type FormatRow, type LayoutRow } from "../../src/core/records";
import { fixedClock } from "../../src/core/time";
import { ulid } from "ulidx";
import { applyFetchedId } from "../../src/import/apply";
import { nextUpstream } from "../../src/core/upstream";
import type { RawUpstreamDetail } from "../../src/import/upstream";
import { fromCmini } from "../../formats/adapters/cmini/translate";
import type { Payload as CminiPayload } from "../../formats/adapters/cmini/index";
import listSnapshot from "../fixtures/upstream-100/list.json" with { type: "json" };
import fullSnapshot from "../fixtures/upstream-100/full.json" with { type: "json" };

const db = (env as unknown as Bindings).DB;
const clock = fixedClock("2026-06-01T00:00:00.000Z");
const SOURCE = { client: "discord-app:test", version: null };

afterEach(() => {
  vi.restoreAllMocks();
});

function detail(overrides: Partial<RawUpstreamDetail> & { name: string; user: string }): RawUpstreamDetail {
  return {
    board: "ortho",
    keys: {},
    created_at: "2026-01-01T00:00:00Z",
    modified_at: "2026-01-01T00:00:00Z",
    likes: [],
    ...overrides,
  };
}

async function importMapRow(upstreamId: string): Promise<{ layout_id: string } | null> {
  return db.prepare("SELECT layout_id FROM import_map WHERE upstream_id = ?").bind(upstreamId).first<{ layout_id: string }>();
}

async function eventsFor(layoutId: string): Promise<{ seq: number; kind: string; format: string | null; rev: number | null; actor: string; via: string; detail_json: string | null }[]> {
  const { results } = await db
    .prepare("SELECT seq, kind, format, rev, actor, via, detail_json FROM events WHERE layout_id = ? ORDER BY seq ASC")
    .bind(layoutId)
    .all<{ seq: number; kind: string; format: string | null; rev: number | null; actor: string; via: string; detail_json: string | null }>();
  return results;
}

async function likeIds(layoutId: string): Promise<string[]> {
  const { results } = await db.prepare("SELECT user_id FROM likes WHERE layout_id = ?").bind(layoutId).all<{ user_id: string }>();
  return results.map((r) => r.user_id).sort();
}

async function sparkOf(layoutId: string): Promise<FormatRow> {
  const formats = await formatsForLayout(db, layoutId);
  return formats.get("spark")!;
}

// A plain user create (layout + spark format together) -- the low-level
// stand-in for a "human record already exists" setup step throughout this
// file. `format` lets a handful of cases seed a NON-spark literal (matching
// the old tests' `cmini/1` stand-ins; `commitWrite` does no registry
// validation, so this is a fine cheap way to get a layout that ISN'T
// spark-shaped without touching the format registry).
async function createUser(name: string, owner: string, format = "spark/1", payload: unknown = { keys: {} }): Promise<LayoutRow> {
  const lineage = format.slice(0, format.lastIndexOf("/"));
  const input: CommitInput = {
    layoutId: ulid(),
    creating: true,
    currentN: 0,
    currentLayout: null,
    currentFormats: new Map(),
    layout: { kind: "created", name, owner, created_at: clock(), deleted: false },
    format: { kind: "format_added", lineage, format, payload, hasMagic: false },
    modified_at: clock(),
    actor: owner,
    via: "discord",
    source: SOURCE,
    upstream: null,
  };
  const { layout } = await commitWrite(db, clock, input);
  return layout;
}

// Flips a record to "not following upstream" without changing its content
// (a phase-2-shaped human edit on the SPARK format) -- setup for the
// not-following case rows.
async function humanTouch(layoutId: string): Promise<void> {
  const current = (await readById(db, layoutId))!;
  const formats = await formatsForLayout(db, layoutId);
  const spark = formats.get("spark")!;
  const input: CommitInput = {
    layoutId,
    creating: false,
    currentN: current.n,
    currentLayout: current,
    currentFormats: formats,
    format: { kind: "updated", lineage: "spark", format: "spark/1", payload: spark.payload, hasMagic: spark.has_magic },
    modified_at: current.modified_at,
    actor: current.owner,
    via: "discord",
    source: SOURCE,
    upstream: nextUpstream(current.upstream, "discord", true), // MF-12: a user write forks -- this is the whole point of "humanTouch"
  };
  await commitWrite(db, clock, input);
}

describe("import case table (07 §6 S5, restated by 21-formats.md §2.2)", () => {
  it("[LDB-I2] [LDB-I4] [LDB-F16] case 1: new id, name free -> imported (layout+format), mapped, likes seeded", async () => {
    const d = detail({ name: "Case1-Free", user: "1000000000000000001", likes: ["1000000000000000011", "1000000000000000012"] });
    const result = await applyFetchedId(db, clock, "case1", d);
    expect(result.errors).toEqual([]);

    const rec = await readByName(db, "Case1-Free");
    expect(rec).not.toBeNull();
    expect(rec!.owner).toBe("1000000000000000001");
    expect(rec!.layout_rev).toBe(1);
    const spark = await sparkOf(rec!.id);
    expect(spark.format).toBe("spark/1"); // every fresh import writes spark/1
    expect(spark.rev).toBe(1);

    const map = await importMapRow("case1");
    expect(map?.layout_id).toBe(rec!.id);

    const events = await eventsFor(rec!.id);
    expect(events).toHaveLength(4); // imported(layout) + imported(format) + 2 liked
    expect(events[0]).toMatchObject({ kind: "imported", format: null, rev: 1, actor: "system:cmini-import", via: "import:cmini" });
    expect(events[1]).toMatchObject({ kind: "imported", format: "spark/1", rev: 1, actor: "system:cmini-import", via: "import:cmini" });
    expect(JSON.parse(events[0]!.detail_json!)).toEqual({ source: "cmini", upstream_id: "case1" });
    expect(events.slice(2).map((e) => e.kind)).toEqual(["liked", "liked"]);
    expect(await likeIds(rec!.id)).toEqual(["1000000000000000011", "1000000000000000012"]);
  });

  it("[LDB-I2] case 2: new id, name held by a live LOCAL record with the SAME owner -> mapped, informational only", async () => {
    const owner = "2000000000000000001";
    const existing = await createUser("Case2-Shared", owner);

    const d = detail({ name: "Case2-Shared", user: owner });
    const result = await applyFetchedId(db, clock, "case2", d);
    expect(result.errors).toEqual([]);

    const map = await importMapRow("case2");
    expect(map?.layout_id).toBe(existing.id);

    const events = await eventsFor(existing.id);
    expect(events).toHaveLength(3); // created(layout) + created(format) [setup] + upstream_changed
    expect(events[2]).toMatchObject({ kind: "upstream_changed", rev: null, actor: "system:cmini-import", via: "import:cmini" });

    // the existing record itself is untouched (still layout_rev 1, still its own content)
    const after = await readById(db, existing.id);
    expect(after!.layout_rev).toBe(1);
    expect(after!.owner).toBe(owner);
  });

  it("[LDB-I2] case 3: new id, name held by a DIFFERENT owner -> shadowed import + import_conflict on the existing record", async () => {
    const existingOwner = "3000000000000000001";
    const upstreamOwner = "3000000000000000002";
    const existing = await createUser("Case3-Clash", existingOwner);

    const d = detail({ name: "Case3-Clash", user: upstreamOwner, likes: ["3000000000000000099"] });
    const result = await applyFetchedId(db, clock, "case3", d);
    expect(result.errors).toEqual([]);

    // the existing record got an import_conflict info event, nothing else
    const existingEvents = await eventsFor(existing.id);
    expect(existingEvents).toHaveLength(3); // created(layout) + created(format) + import_conflict
    expect(existingEvents[2]).toMatchObject({ kind: "import_conflict", rev: null, actor: "system:cmini-import", via: "import:cmini" });
    expect(JSON.parse(existingEvents[2]!.detail_json!)).toMatchObject({ upstream_id: "case3", upstream_name: "Case3-Clash", conflicts_with: existing.id });

    // a NEW shadowed record was created under a free name
    const shadow = await readByName(db, "Case3-Clash~cmini");
    expect(shadow).not.toBeNull();
    expect(shadow!.owner).toBe(upstreamOwner);
    const map = await importMapRow("case3");
    expect(map?.layout_id).toBe(shadow!.id);
    const shadowEvents = await eventsFor(shadow!.id);
    expect(shadowEvents[0]).toMatchObject({ kind: "imported", format: null, rev: 1 });
    expect(shadowEvents[0]!.detail_json !== null && JSON.parse(shadowEvents[0]!.detail_json!)).toMatchObject({ shadowed: { upstream_name: "Case3-Clash" } });
    expect(await likeIds(shadow!.id)).toEqual(["3000000000000000099"]);
  });

  it("[LDB-I2] case 3: a second collision picks ~cmini2", async () => {
    const ownerA = "3100000000000000001";
    const ownerB = "3100000000000000002";
    const ownerC = "3100000000000000003";
    await createUser("Case3b-Clash", ownerA);
    // pre-occupy the first shadow slot too
    await createUser("Case3b-Clash~cmini", ownerB);

    const d = detail({ name: "Case3b-Clash", user: ownerC });
    const result = await applyFetchedId(db, clock, "case3b", d);
    expect(result.errors).toEqual([]);

    const shadow2 = await readByName(db, "Case3b-Clash~cmini2");
    expect(shadow2).not.toBeNull();
    expect(shadow2!.owner).toBe(ownerC);
  });

  it("[LDB-I2] [LDB-I4] [LDB-F16] case 4: mapped + following + PAYLOAD differs -> FORMAT-scope imported (spark rev+1), layout_rev unchanged", async () => {
    const owner = "4000000000000000001";
    const d1 = detail({ name: "Case4-Content", user: owner, board: "ortho", keys: {} });
    await applyFetchedId(db, clock, "case4", d1);
    const before = await readByName(db, "Case4-Content");
    expect(before!.layout_rev).toBe(1);
    expect((await sparkOf(before!.id)).rev).toBe(1);

    // A key added upstream: a change that reaches the stored spark/1
    // payload (a cmini board-word change alone would not -- spark/1 has no
    // board, design/layout-db/26-no-board.md).
    const d2 = detail({ name: "Case4-Content", user: owner, board: "ortho", keys: { a: { row: 1, col: 0, finger: "LP" } }, modified_at: "2026-02-01T00:00:00Z" });
    const result = await applyFetchedId(db, clock, "case4", d2);
    expect(result.errors).toEqual([]);

    const after = await readById(db, before!.id);
    expect(after!.layout_rev).toBe(1); // untouched -- this write never touched the layout scope
    const spark = await sparkOf(before!.id);
    expect(spark.rev).toBe(2);
    expect(spark.format).toBe("spark/1");
    expect((spark.payload as { keys: unknown }).keys).toEqual(fromCmini(d2 as unknown as CminiPayload).keys);

    const events = await eventsFor(before!.id);
    expect(events.map((e) => ({ kind: e.kind, format: e.format }))).toEqual([
      { kind: "imported", format: null },
      { kind: "imported", format: "spark/1" },
      { kind: "imported", format: "spark/1" },
    ]);
    expect(events[2]).toMatchObject({ kind: "imported", format: "spark/1", rev: 2, actor: "system:cmini-import", via: "import:cmini" });
  });

  it("[LDB-I2] case 4b: mapped + following + upstream re-created the layout (created_at moved, payload unchanged) -> LAYOUT-scope imported, spark untouched", async () => {
    const owner = "4000000000000000001";
    const d1 = detail({ name: "Case4b-Recreated", user: owner, board: "ortho", keys: {}, created_at: "2026-01-01T00:00:00Z", modified_at: "2026-01-01T00:00:00Z" });
    await applyFetchedId(db, clock, "case4b", d1);
    const before = await readByName(db, "Case4b-Recreated");
    expect(before!.created_at).toBe("2026-01-01T00:00:00Z");

    // cmini deleted and re-added it between two ticks: same name, same keys, new created_at
    const d2 = detail({ name: "Case4b-Recreated", user: owner, board: "ortho", keys: {}, created_at: "2026-03-01T00:00:00Z", modified_at: "2026-03-01T00:00:00Z" });
    const result = await applyFetchedId(db, clock, "case4b", d2);
    expect(result.errors).toEqual([]);

    const after = await readById(db, before!.id);
    expect(after!.layout_rev).toBe(2);
    expect(after!.created_at).toBe("2026-03-01T00:00:00Z");
    expect(after!.modified_at).toBe("2026-03-01T00:00:00Z");
    const spark = await sparkOf(before!.id);
    expect(spark.rev).toBe(1); // untouched -- payload never changed

    const events = await eventsFor(before!.id);
    expect(events.at(-1)).toMatchObject({ kind: "imported", format: null, rev: 2 });

    // and a third identical tick is quiet again (LDB-I1)
    const again = await applyFetchedId(db, clock, "case4b", d2);
    expect(again.errors).toEqual([]);
    expect((await readById(db, before!.id))!.layout_rev).toBe(2);
  });

  // B2 (design/layout-db/review/audit-db.md B2): an upstream rename onto a
  // name a LIVE local layout already holds used to throw `name_taken`
  // straight out of `commitWrite`, aborting the WHOLE tick (every id
  // queued behind this one, forever, since `meta_token` never advanced
  // past it). It now shadows the rename exactly like `applyNew`'s case 3:
  // an `import_conflict` info event on the renamed (following) record,
  // then the SAME write retried under `<name>~cmini`.
  it("[LDB-I19] case 4 rename onto a name a LIVE local layout holds shadows instead of wedging the import", async () => {
    const followingOwner = "8200000000000000001";
    const holderOwner = "8200000000000000002";
    const d1 = detail({ name: "RenameSrc", user: followingOwner, board: "ortho", keys: {} });
    await applyFetchedId(db, clock, "caserename", d1);
    const rec = await readByName(db, "RenameSrc");

    // a live LOCAL layout already holds the name upstream is about to
    // rename this SAME upstream id into.
    const holder = await createUser("RenameDst", holderOwner);

    const d2 = detail({ name: "RenameDst", user: followingOwner, board: "ortho", keys: {} });
    const result = await applyFetchedId(db, clock, "caserename", d2);
    expect(result.errors).toEqual([]); // never thrown, never reported as a shape error either

    // the renamed record survives under a shadow name, still following
    const shadow = await readById(db, rec!.id);
    expect(shadow!.name).toBe("RenameDst~cmini");
    expect(shadow!.deleted).toBe(false);
    expect(shadow!.layout_rev).toBe(2);

    // the holder that actually owns "RenameDst" is completely untouched
    const holderAfter = await readById(db, holder.id);
    expect(holderAfter!.name).toBe("RenameDst");
    expect(holderAfter!.layout_rev).toBe(1);

    const events = await eventsFor(rec!.id);
    const conflict = events.find((e) => e.kind === "import_conflict");
    expect(conflict).toBeDefined();
    expect(JSON.parse(conflict!.detail_json!)).toMatchObject({ upstream_id: "caserename", upstream_name: "RenameDst", conflicts_with: holder.id });
    expect(events.at(-1)).toMatchObject({ kind: "imported", format: null, rev: 2 });
    expect(JSON.parse(events.at(-1)!.detail_json!)).toMatchObject({ shadowed: { upstream_name: "RenameDst" } });

    // the tick is NOT wedged: a completely unrelated id in the SAME
    // (conceptual) tick still imports normally.
    const otherOwner = "8200000000000000003";
    const other = detail({ name: "Unrelated-After-Rename", user: otherOwner, board: "ortho", keys: {} });
    const otherResult = await applyFetchedId(db, clock, "caserename-other", other);
    expect(otherResult.errors).toEqual([]);
    expect(await readByName(db, "Unrelated-After-Rename")).not.toBeNull();
  });

  // B2 sticky shadow (coordinator follow-up, 2026-09-12, migrations/0013):
  // a standing rename collision must be shadowed ONCE, not every tick --
  // the old version of this fix compared upstream's name against the
  // layout's own (now permanently shadowed) `name`, which looked like "yet
  // another rename to attempt" forever, minting `~cmini2`, `~cmini3`, ...
  // on every tick upstream kept reporting the SAME contested name.
  it("[LDB-I19] a standing rename collision writes the shadow ONCE -- repeated ticks with the same colliding upstream name make no further writes", async () => {
    const followingOwner = "8400000000000000001";
    const holderOwner = "8400000000000000002";
    const d1 = detail({ name: "StickySrc", user: followingOwner, board: "ortho", keys: {} });
    await applyFetchedId(db, clock, "sticky", d1);
    const rec = await readByName(db, "StickySrc");

    await createUser("StickyDst", holderOwner);
    const d2 = detail({ name: "StickyDst", user: followingOwner, board: "ortho", keys: {} });

    // Tick 1 of the "same colliding name" sequence: the first collision --
    // exactly one shadow write, one `import_conflict` event.
    const r1 = await applyFetchedId(db, clock, "sticky", d2);
    expect(r1.errors).toEqual([]);
    const afterFirst = await readById(db, rec!.id);
    expect(afterFirst!.name).toBe("StickyDst~cmini");
    expect(afterFirst!.layout_rev).toBe(2);
    const eventsAfterFirst = await eventsFor(rec!.id);
    expect(eventsAfterFirst.filter((e) => e.kind === "import_conflict")).toHaveLength(1);
    expect(eventsAfterFirst.filter((e) => e.kind === "imported" && e.format === null)).toHaveLength(2); // create + the one shadow rename

    // Tick 2: upstream reports the SAME "StickyDst" again -- no new write,
    // no new event, no `~cmini2`.
    const r2 = await applyFetchedId(db, clock, "sticky", d2);
    expect(r2.errors).toEqual([]);
    expect(await eventsFor(rec!.id)).toHaveLength(eventsAfterFirst.length);
    expect((await readById(db, rec!.id))!.name).toBe("StickyDst~cmini");
    expect((await readById(db, rec!.id))!.layout_rev).toBe(2);

    // Tick 3: same again -- still nothing.
    const r3 = await applyFetchedId(db, clock, "sticky", d2);
    expect(r3.errors).toEqual([]);
    const eventsAfterThird = await eventsFor(rec!.id);
    expect(eventsAfterThird).toHaveLength(eventsAfterFirst.length);
    expect(eventsAfterThird.filter((e) => e.kind === "import_conflict")).toHaveLength(1); // still exactly one, ever
    expect((await readById(db, rec!.id))!.name).toBe("StickyDst~cmini"); // never ~cmini2, ~cmini3, ...
  });

  it("[LDB-I19] once shadowed, the record does NOT auto-rename back even after the taken name frees up", async () => {
    const followingOwner = "8500000000000000001";
    const holderOwner = "8500000000000000002";
    const d1 = detail({ name: "StableSrc", user: followingOwner, board: "ortho", keys: {} });
    await applyFetchedId(db, clock, "stable", d1);
    const rec = await readByName(db, "StableSrc");

    const holder = await createUser("StableDst", holderOwner);
    const d2 = detail({ name: "StableDst", user: followingOwner, board: "ortho", keys: {} });
    await applyFetchedId(db, clock, "stable", d2);
    expect((await readById(db, rec!.id))!.name).toBe("StableDst~cmini");

    // the taken name frees up (the holder is gone) -- a shadow name is
    // stable once assigned; the owner can rename it, the importer never
    // does. (Bypassing the event log here is a test-setup shortcut, not
    // something under test -- any real free of the name works the same.)
    await db.prepare("UPDATE layouts SET deleted = 1 WHERE id = ?").bind(holder.id).run();

    // upstream still reports the SAME "StableDst" it always has -- this is
    // NOT a fresh rename, so the shadow must not be touched.
    const result = await applyFetchedId(db, clock, "stable", d2);
    expect(result.errors).toEqual([]);
    expect((await readById(db, rec!.id))!.name).toBe("StableDst~cmini");
  });

  // B3 (design/layout-db/review/audit-db.md B3): `layoutFieldsDiffer` never
  // looked at `deleted`, so a following tombstone re-listed upstream with
  // otherwise-identical fields was never revived -- it stayed deleted and
  // was re-fetched every tick forever. Restoring `deleted: false` is now
  // itself a reason to write the layout scope.
  it("[LDB-I20] a following tombstone re-listed upstream with identical fields is revived, not refetched forever", async () => {
    const owner = "8100000000000000001";
    const d1 = detail({ name: "Case-Revive", user: owner, board: "ortho", keys: {} });
    await applyFetchedId(db, clock, "caserevive", d1);
    const rec = await readByName(db, "Case-Revive");
    expect(rec).not.toBeNull();

    // upstream 404s -- tombstoned while following (case 8)
    await applyFetchedId(db, clock, "caserevive", "notfound");
    const tombstoned = await readById(db, rec!.id);
    expect(tombstoned!.deleted).toBe(true);
    expect(tombstoned!.layout_rev).toBe(2);
    expect(await readByName(db, "Case-Revive")).toBeNull(); // name released

    // upstream lists it again with the EXACT SAME content -- no field
    // `layoutFieldsDiffer` itself compares (name/owner/created_at) changed,
    // only `deleted` did.
    const result = await applyFetchedId(db, clock, "caserevive", d1);
    expect(result.errors).toEqual([]);

    const revived = await readById(db, rec!.id);
    expect(revived!.deleted).toBe(false);
    expect(revived!.layout_rev).toBe(3);
    expect((await readByName(db, "Case-Revive"))!.id).toBe(rec!.id); // the SAME record reclaims its name

    const spark = await sparkOf(rec!.id);
    expect(spark.rev).toBe(1); // payload never touched -- pure layout-scope revival

    const events = await eventsFor(rec!.id);
    expect(events.at(-1)).toMatchObject({ kind: "imported", format: null, rev: 3, actor: "system:cmini-import", via: "import:cmini" });

    // idempotent: the identical content again writes nothing further
    const again = await applyFetchedId(db, clock, "caserevive", d1);
    expect(again.errors).toEqual([]);
    expect((await readById(db, rec!.id))!.layout_rev).toBe(3);
  });

  // B2 + B3 together: a revival landing on a name since claimed locally.
  it("[LDB-I19] [LDB-I20] a following tombstone's revival onto a name since claimed locally shadows instead of wedging", async () => {
    const owner = "8300000000000000001";
    const holderOwner = "8300000000000000002";
    const d1 = detail({ name: "Case-ReviveClash", user: owner, board: "ortho", keys: {} });
    await applyFetchedId(db, clock, "casereviveclash", d1);
    const rec = await readByName(db, "Case-ReviveClash");

    await applyFetchedId(db, clock, "casereviveclash", "notfound");
    expect((await readById(db, rec!.id))!.deleted).toBe(true);

    // the freed name is claimed by a brand-new, unrelated live local layout
    const holder = await createUser("Case-ReviveClash", holderOwner);

    // upstream re-lists the SAME id with the SAME content -- revival
    // collides with the new holder's live claim on the name.
    const result = await applyFetchedId(db, clock, "casereviveclash", d1);
    expect(result.errors).toEqual([]);

    const revived = await readById(db, rec!.id);
    expect(revived!.deleted).toBe(false);
    expect(revived!.name).toBe("Case-ReviveClash~cmini");

    const holderAfter = await readById(db, holder.id);
    expect(holderAfter!.name).toBe("Case-ReviveClash");
    expect(holderAfter!.layout_rev).toBe(1); // untouched

    const events = await eventsFor(rec!.id);
    const conflict = events.find((e) => e.kind === "import_conflict");
    expect(conflict).toBeDefined();
    expect(JSON.parse(conflict!.detail_json!)).toMatchObject({ upstream_id: "casereviveclash", upstream_name: "Case-ReviveClash", conflicts_with: holder.id });
  });

  // B1 (design/layout-db/review/audit-db.md, LDB-L5 below): likes are a
  // UNION of cmini's and ours by user id, for a following layout same as
  // any other -- the importer only ever ADDS a missing like, never emits
  // `unliked` (this replaces the old "wholesale replace, revert local
  // likes" behavior this same test used to assert).
  it("[LDB-I2] [LDB-L5] case 5: mapped + following + ONLY likes differ -> union add, no content write, no unlike", async () => {
    const owner = "5000000000000000001";
    const d1 = detail({ name: "Case5-Likes", user: owner, likes: ["5000000000000000011", "5000000000000000012"] });
    await applyFetchedId(db, clock, "case5", d1);
    const rec = await readByName(db, "Case5-Likes");
    expect(await likeIds(rec!.id)).toEqual(["5000000000000000011", "5000000000000000012"]);

    // same content, upstream's own snapshot now shows 11 gone, 13 added --
    // a real local liker (11) must survive; a new upstream liker (13) is
    // unioned in.
    const d2 = detail({ name: "Case5-Likes", user: owner, likes: ["5000000000000000012", "5000000000000000013"] });
    const result = await applyFetchedId(db, clock, "case5", d2);
    expect(result.errors).toEqual([]);

    const after = await readById(db, rec!.id);
    expect(after!.layout_rev).toBe(1); // no content write
    expect((await sparkOf(rec!.id)).rev).toBe(1);

    const events = await eventsFor(rec!.id);
    // exactly one new `liked` (13) -- never an `unliked` for 11.
    expect(events.map((e) => e.kind)).toEqual(["imported", "imported", "liked", "liked", "liked"]);
    expect(await likeIds(rec!.id)).toEqual(["5000000000000000011", "5000000000000000012", "5000000000000000013"]);
  });

  it("[LDB-L5] the importer never emits `unliked` for a following layout even when upstream's own like list shrinks to empty", async () => {
    const owner = "5100000000000000001";
    const d1 = detail({ name: "Case5b-NeverUnlike", user: owner, likes: ["5100000000000000011", "5100000000000000012"] });
    await applyFetchedId(db, clock, "case5b", d1);
    const rec = await readByName(db, "Case5b-NeverUnlike");

    const d2 = detail({ name: "Case5b-NeverUnlike", user: owner, likes: [] });
    const result = await applyFetchedId(db, clock, "case5b", d2);
    expect(result.errors).toEqual([]);

    expect(await likeIds(rec!.id)).toEqual(["5100000000000000011", "5100000000000000012"]);
    const events = await eventsFor(rec!.id);
    expect(events.some((e) => e.kind === "unliked")).toBe(false);
  });

  // Coordinator review (MEDIUM, third batch): D13 L1/L2 made a repeat
  // like/redundant unlike a real thrown error -- the importer's own like
  // sync must never let one abort a tick and strand every id queued
  // behind it (LDB-P14). Two distinct ways it can happen:
  it("[LDB-I2] [LDB-P14] (a) a repeated id in cmini's own (undeduped) likes array never aborts the import", async () => {
    const d = detail({
      name: "CaseDup-Likes",
      user: "9100000000000000001",
      likes: ["9100000000000000011", "9100000000000000011", "9100000000000000012"],
    });
    const result = await applyFetchedId(db, clock, "casedup", d);
    expect(result.errors).toEqual([]);

    const rec = await readByName(db, "CaseDup-Likes");
    expect(await likeIds(rec!.id)).toEqual(["9100000000000000011", "9100000000000000012"]);
    const events = await eventsFor(rec!.id);
    // imported(layout) + imported(format) + exactly 2 liked events, not 3
    // -- deduped before ever calling appendLike, not papered over after.
    expect(events.map((e) => e.kind)).toEqual(["imported", "imported", "liked", "liked"]);
  });

  // B1 (audit-db.md): the importer no longer ever unlikes, so the old
  // scenario here (a real unlike racing the importer's OWN unlike attempt)
  // no longer exists -- the remaining real race under union semantics is a
  // real user liking a layout via `discord` at the exact moment the
  // importer is unioning in that SAME upstream liker; either order must
  // land on exactly one `liked` event, never an aborted tick.
  it("[LDB-I2] [LDB-P14] [LDB-L5] a real like racing the importer's own union-add of the same user never aborts the tick", async () => {
    const owner = "9200000000000000001";
    const d1 = detail({ name: "CaseRace-Likes", user: owner, likes: [] });
    await applyFetchedId(db, clock, "caserace", d1);
    const rec = await readByName(db, "CaseRace-Likes");
    expect(await likeIds(rec!.id)).toEqual([]);

    // Force the race deterministically: `applyMapped` (apply.ts) reads
    // `localLikeIds` once, up front, then loops calling the real,
    // cross-module `appendLike` (core/events.ts) per id that needs a
    // union-add -- spying on THAT import (unlike `currentLikeIds`, a
    // same-file self-call a same-module spy can't intercept) lands cleanly
    // on apply.ts's own call site. On the first call for this tick -- the
    // importer's own (about to be stale) attempt to union-add this user --
    // run a REAL like for the same user via `discord` FIRST, using the
    // original function, THEN let the importer's own original call
    // proceed: it now finds the like already there and throws
    // `already_liked`, which `importAppendLike` (apply.ts) catches and
    // swallows.
    const original = eventsModule.appendLike;
    let fired = false;
    const spy = vi.spyOn(eventsModule, "appendLike").mockImplementation(async (...args) => {
      if (!fired) {
        fired = true;
        await original(db, clock, {
          kind: "liked",
          layoutId: rec!.id,
          userId: "9200000000000000011",
          via: "discord",
          source: SOURCE,
        });
      }
      return original(...args);
    });

    const d2 = detail({ name: "CaseRace-Likes", user: owner, likes: ["9200000000000000011"] });
    const result = await applyFetchedId(db, clock, "caserace", d2);
    spy.mockRestore();
    expect(result.errors).toEqual([]);

    expect(await likeIds(rec!.id)).toEqual(["9200000000000000011"]);
    const events = await eventsFor(rec!.id);
    const liked = events.filter((e) => e.kind === "liked");
    // Exactly ONE liked event (the real user's, via discord) -- the
    // importer's own duplicate attempt hit `already_liked` and was
    // swallowed, never a second event, never an aborted tick.
    expect(liked).toHaveLength(1);
    expect(liked[0]).toMatchObject({ actor: "9200000000000000011", via: "discord" });
  });

  it("[LDB-I2] case 6: mapped + NOT following + content differs -> upstream_changed info, record untouched, not repeated", async () => {
    const owner = "6000000000000000001";
    const d1 = detail({ name: "Case6-NotFollow", user: owner, board: "ortho" });
    await applyFetchedId(db, clock, "case6", d1);
    const rec = await readByName(db, "Case6-NotFollow");
    await humanTouch(rec!.id);

    const d2 = detail({ name: "Case6-NotFollow", user: owner, board: "ortho", keys: { a: { row: 1, col: 0, finger: "LP" } } });
    const result = await applyFetchedId(db, clock, "case6", d2);
    expect(result.errors).toEqual([]);

    const spark = await sparkOf(rec!.id);
    // still d1's keys, untouched by the info event.
    expect((spark.payload as { keys: unknown }).keys).toEqual(fromCmini(d1 as unknown as CminiPayload).keys);

    const events = await eventsFor(rec!.id);
    expect(events.map((e) => e.kind)).toEqual(["imported", "imported", "updated", "upstream_changed"]);
    expect(events[3]).toMatchObject({ rev: null, format: null, actor: "system:cmini-import", via: "import:cmini" });

    // repeat: the SAME upstream content again -> no new event
    const result2 = await applyFetchedId(db, clock, "case6", d2);
    expect(result2.errors).toEqual([]);
    const eventsAfterRepeat = await eventsFor(rec!.id);
    expect(eventsAfterRepeat).toHaveLength(4);
  });

  it("[LDB-I2] case 7: mapped + NOT following + likes differ -> union only, never unlike", async () => {
    const owner = "7000000000000000001";
    const d1 = detail({ name: "Case7-Union", user: owner, likes: ["7000000000000000011"] });
    await applyFetchedId(db, clock, "case7", d1);
    const rec = await readByName(db, "Case7-Union");
    await humanTouch(rec!.id);
    // a local-only like, absent upstream -- must survive the union
    await db.prepare("INSERT INTO likes (layout_id, user_id, at) VALUES (?, ?, ?)").bind(rec!.id, "7000000000000000099", clock()).run();

    const d2 = detail({ name: "Case7-Union", user: owner, likes: ["7000000000000000011", "7000000000000000022"] });
    const result = await applyFetchedId(db, clock, "case7", d2);
    expect(result.errors).toEqual([]);

    expect(await likeIds(rec!.id)).toEqual(["7000000000000000011", "7000000000000000022", "7000000000000000099"]);
    const events = await eventsFor(rec!.id);
    expect(events.map((e) => e.kind)).toEqual(["imported", "imported", "liked", "updated", "liked"]);
    expect(events[4]).toMatchObject({ kind: "liked", actor: "7000000000000000022" });
  });

  it("[LDB-I2] [LDB-I4] [LDB-F16] case 8: delete (404) while following -> LAYOUT-scope upstream_deleted, name released, spark untouched", async () => {
    const owner = "8000000000000000001";
    const d1 = detail({ name: "Case8-Delete", user: owner });
    await applyFetchedId(db, clock, "case8", d1);
    const rec = await readByName(db, "Case8-Delete");

    const result = await applyFetchedId(db, clock, "case8", "notfound");
    expect(result.errors).toEqual([]);

    const after = await readById(db, rec!.id);
    expect(after!.deleted).toBe(true);
    expect(after!.layout_rev).toBe(2);
    const spark = await sparkOf(rec!.id);
    expect(spark.format).toBe("spark/1");
    expect(spark.rev).toBe(1); // untouched -- D3: deletion is layout-level only
    expect(await readByName(db, "Case8-Delete")).toBeNull(); // name released

    const events = await eventsFor(rec!.id);
    expect(events[2]).toMatchObject({ kind: "upstream_deleted", format: null, rev: 2, actor: "system:cmini-import", via: "import:cmini" });

    // a new record may now claim the freed name
    const reclaimed = await createUser("Case8-Delete", "someone-else");
    expect(reclaimed.name).toBe("Case8-Delete");
  });

  it("[LDB-I2] case 9: delete while NOT following -> upstream_deleted info once, record stays live", async () => {
    const owner = "9000000000000000001";
    const d1 = detail({ name: "Case9-Delete", user: owner });
    await applyFetchedId(db, clock, "case9", d1);
    const rec = await readByName(db, "Case9-Delete");
    await humanTouch(rec!.id);

    const result = await applyFetchedId(db, clock, "case9", "notfound");
    expect(result.errors).toEqual([]);

    const after = await readById(db, rec!.id);
    expect(after!.deleted).toBe(false); // still live

    const events = await eventsFor(rec!.id);
    expect(events.map((e) => e.kind)).toEqual(["imported", "imported", "updated", "upstream_deleted"]);
    expect(events[3]).toMatchObject({ rev: null, format: null, actor: "system:cmini-import", via: "import:cmini" });

    // idempotent: a second 404 tick doesn't duplicate the info event
    await applyFetchedId(db, clock, "case9", "notfound");
    expect(await eventsFor(rec!.id)).toHaveLength(4);
  });

  it("case: an invalid detail is skipped and reported, not thrown", async () => {
    const bad: RawUpstreamDetail = { name: "Case-Invalid", user: "1234567890123456789", created_at: "x", modified_at: "x", board: "not-a-real-board", keys: {} };
    const result = await applyFetchedId(db, clock, "case-invalid", bad);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]!.id).toBe("case-invalid");
    expect(await readByName(db, "Case-Invalid")).toBeNull();
  });

  it("case: a 404 for an id with no import_map row is a silent no-op", async () => {
    const result = await applyFetchedId(db, clock, "never-existed", "notfound");
    expect(result.errors).toEqual([]);
    expect(await importMapRow("never-existed")).toBeNull();
  });
});

describe("[LDB-I10] an imported payload never carries cmini's magic", () => {
  it("[LDB-I10] case 1: upstream detail carries magic -> the imported payload has none, has_magic is false", async () => {
    const d = detail({
      name: "I10-Fresh",
      user: "1100000000000000001",
      magic: [{ inputs: "e*", output: "ee", type: "repeat" }],
    });
    const result = await applyFetchedId(db, clock, "i10-fresh", d);
    expect(result.errors).toEqual([]);

    const rec = await readByName(db, "I10-Fresh");
    expect(rec).not.toBeNull();
    const spark = await sparkOf(rec!.id);
    expect((spark.payload as { magic?: unknown }).magic).toBeUndefined();
    expect(spark.has_magic).toBe(false);
  });

  it("[LDB-I10] case 4: upstream adding magic on a later fetch, content otherwise identical, is NOT a content difference -- no new event", async () => {
    const owner = "1100000000000000002";
    const d1 = detail({ name: "I10-NoDiff", user: owner, board: "ortho" });
    await applyFetchedId(db, clock, "i10-nodiff", d1);
    const rec = await readByName(db, "I10-NoDiff");
    const before = await eventsFor(rec!.id);

    const d2 = detail({
      name: "I10-NoDiff",
      user: owner,
      board: "ortho",
      magic: [{ inputs: "t*", output: "tt", type: "repeat" }],
    });
    const result = await applyFetchedId(db, clock, "i10-nodiff", d2);
    expect(result.errors).toEqual([]);

    const after = await readById(db, rec!.id);
    expect(after!.layout_rev).toBe(1);
    const spark = await sparkOf(rec!.id);
    expect(spark.rev).toBe(1); // no write at all -- upstream adding magic is invisible to change detection
    expect(await eventsFor(rec!.id)).toHaveLength(before.length);
    expect((spark.payload as { magic?: unknown }).magic).toBeUndefined();
  });
});

describe("[LDB-I11] an import write preserves the record's own magic", () => {
  it("[LDB-I11] a not-following record's own local magic is never reported as an upstream difference", async () => {
    const owner = "1100000000000000004";
    const d1 = detail({ name: "I11-NotFollow", user: owner, board: "ortho" });
    await applyFetchedId(db, clock, "i11-notfollow", d1);
    const rec = await readByName(db, "I11-NotFollow");
    await humanTouch(rec!.id);

    // The owner's own record now carries local magic (M2-shaped: akl.gg's
    // own rules on the record -- simulated directly via spark's own
    // raw-rule escape hatch).
    const localMagic = { rules: [{ inputs: "s*", output: "ss", type: "repeat" }] };
    const current = (await readById(db, rec!.id))!;
    const formats = await formatsForLayout(db, rec!.id);
    const spark = formats.get("spark")!;
    await commitWrite(db, clock, {
      layoutId: rec!.id,
      creating: false,
      currentN: current.n,
      currentLayout: current,
      currentFormats: formats,
      format: { kind: "updated", lineage: "spark", format: "spark/1", payload: { ...(spark.payload as object), magic: localMagic }, hasMagic: true },
      modified_at: current.modified_at,
      actor: current.owner,
      via: "discord",
      source: SOURCE,
      upstream: current.upstream,
    });
    const before = await eventsFor(rec!.id);

    // The SAME upstream content as before (still d1's board/keys). Absent
    // the magic-less projection, this would look like "content differs"
    // purely because the local side now has a `magic` field upstream's
    // never has.
    const result = await applyFetchedId(db, clock, "i11-notfollow", d1);
    expect(result.errors).toEqual([]);
    expect(await eventsFor(rec!.id)).toHaveLength(before.length); // no new event
    const after = await sparkOf(rec!.id);
    expect((after.payload as { magic?: unknown }).magic).toEqual(localMagic); // untouched
    expect(after.format).toBe("spark/1");
  });
});

// Link-approval-on-import (design/layout-db/23-geometry.md follow-up,
// LDB-MD3/MD5/MD9): cmini's own `link` field is carried onto the record as
// an already-APPROVED link -- the import itself counts as verification --
// for as long as the importer itself is the one who last decided the
// layout's link; an admin's own decision, once made, is never overridden.
describe("[LDB-MD3] [LDB-MD5] link-approval-on-import (23-geometry.md follow-up)", () => {
  it("[LDB-MD3] a fresh import with an https link auto-approves it (via: import:cmini, not queued)", async () => {
    const d = detail({ name: "LinkNew", user: "1000000000000000201", link: "https://example.com/a" });
    const result = await applyFetchedId(db, clock, "link-new", d);
    expect(result.errors).toEqual([]);

    const rec = await readByName(db, "LinkNew");
    expect(rec!.link).toBe("https://example.com/a");
    const events = await eventsFor(rec!.id);
    const linkEvent = events.find((e) => e.kind === "link_approved");
    expect(linkEvent).toBeDefined();
    expect(linkEvent!.via).toBe("import:cmini");
    expect(linkEvent!.actor).toBe("system:cmini-import");
  });

  it("[LDB-MD3] a following layout whose upstream link changes gets re-approved automatically", async () => {
    const d1 = detail({ name: "LinkChange", user: "1000000000000000202", link: "https://example.com/first" });
    await applyFetchedId(db, clock, "link-change", d1);
    expect((await readByName(db, "LinkChange"))!.link).toBe("https://example.com/first");

    const d2 = detail({ name: "LinkChange", user: "1000000000000000202", link: "https://example.com/second" });
    const result = await applyFetchedId(db, clock, "link-change", d2);
    expect(result.errors).toEqual([]);
    expect((await readByName(db, "LinkChange"))!.link).toBe("https://example.com/second");
  });

  it("[LDB-MD3] upstream dropping its link clears the approved one (link_cleared)", async () => {
    const d1 = detail({ name: "LinkDrop", user: "1000000000000000203", link: "https://example.com/gone-soon" });
    await applyFetchedId(db, clock, "link-drop", d1);
    const rec1 = await readByName(db, "LinkDrop");
    expect(rec1!.link).toBe("https://example.com/gone-soon");

    const d2 = detail({ name: "LinkDrop", user: "1000000000000000203" }); // no `link` field this tick
    await applyFetchedId(db, clock, "link-drop", d2);
    const rec2 = await readByName(db, "LinkDrop");
    expect(rec2!.link).toBeNull();
    const events = await eventsFor(rec2!.id);
    expect(events.find((e) => e.kind === "link_cleared")).toBeDefined();
  });

  it("[LDB-MD9] a non-https upstream link is skipped (import_error info event), never reaching layouts.link", async () => {
    const d = detail({ name: "LinkBad", user: "1000000000000000204", link: "http://example.com/insecure" });
    const result = await applyFetchedId(db, clock, "link-bad", d);
    expect(result.errors).toEqual([]);

    const rec = await readByName(db, "LinkBad");
    expect(rec!.link).toBeNull();
    const events = await eventsFor(rec!.id);
    expect(events.some((e) => e.kind === "link_approved")).toBe(false);
    expect(events.some((e) => e.kind === "import_error")).toBe(true);
  });

  it("[LDB-MD5] an admin-approved link is never overridden by a later import tick", async () => {
    const d1 = detail({ name: "LinkAdmin", user: "1000000000000000205", link: "https://example.com/imported" });
    await applyFetchedId(db, clock, "link-admin", d1);
    const rec1 = await readByName(db, "LinkAdmin");
    expect(rec1!.link).toBe("https://example.com/imported");

    // An admin hand-approves a DIFFERENT link, out of band.
    await eventsModule.appendLinkChange(db, clock, {
      layoutId: rec1!.id,
      kind: "link_approved",
      link: "https://example.com/admin-picked",
      actor: "moderator",
      via: "discord",
      admin: true,
      source: SOURCE,
    });

    // Upstream keeps changing its own link -- the import must leave the
    // admin's decision alone.
    const d2 = detail({ name: "LinkAdmin", user: "1000000000000000205", link: "https://example.com/upstream-changed-again" });
    const result = await applyFetchedId(db, clock, "link-admin", d2);
    expect(result.errors).toEqual([]);
    const rec2 = await readByName(db, "LinkAdmin");
    expect(rec2!.link).toBe("https://example.com/admin-picked"); // unchanged by the import
  });
});

describe("[LDB-I5] imported names are stored verbatim from the live snapshot", () => {
  const list = (listSnapshot as { layouts: { id: string; name: string }[] }).layouts;
  const full = (fullSnapshot as { layouts: RawUpstreamDetail[] }).layouts;
  const byName = new Map(full.map((d) => [d.name as string, d]));

  for (const id of ["io", "adnw", "02_we've_been_in_this_room_too_long"]) {
    it(`[LDB-I5] '${id}' imports with its exact upstream name`, async () => {
      const entry = list.find((e) => e.id === id);
      expect(entry).toBeDefined();
      const raw = byName.get(entry!.name);
      expect(raw).toBeDefined();

      const result = await applyFetchedId(db, clock, id, raw!);
      expect(result.errors).toEqual([]);

      const rec = await readByName(db, entry!.name);
      expect(rec).not.toBeNull();
      expect(rec!.name).toBe(entry!.name); // exact case/punctuation, not lowercased or transformed
    });
  }
});
