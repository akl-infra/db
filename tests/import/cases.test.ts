// [LDB-I2] [LDB-I4] [LDB-I5] One `it` per row of 07 §6 S5's case table,
// restated for 21-formats.md §2.2: the importer touches the layout's own
// fields (name/owner/created_at) and lineage `spark` ONLY, one event per
// scope actually changed. A create is layout+format together (two events);
// a name/owner/created_at-only change is a LAYOUT-scope event; a
// payload-only change is a FORMAT-scope event; both together append one of
// each, in one batch.
import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import type { Bindings } from "../../src/env";
import { commitWrite, type CommitInput } from "../../src/core/events";
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

    const d2 = detail({ name: "Case4-Content", user: owner, board: "angle", keys: {}, modified_at: "2026-02-01T00:00:00Z" });
    const result = await applyFetchedId(db, clock, "case4", d2);
    expect(result.errors).toEqual([]);

    const after = await readById(db, before!.id);
    expect(after!.layout_rev).toBe(1); // untouched -- this write never touched the layout scope
    const spark = await sparkOf(before!.id);
    expect(spark.rev).toBe(2);
    expect(spark.format).toBe("spark/1");
    expect((spark.payload as { board: unknown }).board).toEqual(fromCmini(d2 as unknown as CminiPayload).board);

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

  it("[LDB-I2] case 5: mapped + following + ONLY likes differ -> like diff, no content write", async () => {
    const owner = "5000000000000000001";
    const d1 = detail({ name: "Case5-Likes", user: owner, likes: ["5000000000000000011", "5000000000000000012"] });
    await applyFetchedId(db, clock, "case5", d1);
    const rec = await readByName(db, "Case5-Likes");
    expect(await likeIds(rec!.id)).toEqual(["5000000000000000011", "5000000000000000012"]);

    // same content, likes changed: 11 removed, 13 added
    const d2 = detail({ name: "Case5-Likes", user: owner, likes: ["5000000000000000012", "5000000000000000013"] });
    const result = await applyFetchedId(db, clock, "case5", d2);
    expect(result.errors).toEqual([]);

    const after = await readById(db, rec!.id);
    expect(after!.layout_rev).toBe(1); // no content write
    expect((await sparkOf(rec!.id)).rev).toBe(1);

    const events = await eventsFor(rec!.id);
    expect(events.map((e) => e.kind)).toEqual(["imported", "imported", "liked", "liked", "liked", "unliked"]);
    expect(await likeIds(rec!.id)).toEqual(["5000000000000000012", "5000000000000000013"]);
  });

  it("[LDB-I2] case 6: mapped + NOT following + content differs -> upstream_changed info, record untouched, not repeated", async () => {
    const owner = "6000000000000000001";
    const d1 = detail({ name: "Case6-NotFollow", user: owner, board: "ortho" });
    await applyFetchedId(db, clock, "case6", d1);
    const rec = await readByName(db, "Case6-NotFollow");
    await humanTouch(rec!.id);

    const d2 = detail({ name: "Case6-NotFollow", user: owner, board: "angle" });
    const result = await applyFetchedId(db, clock, "case6", d2);
    expect(result.errors).toEqual([]);

    const spark = await sparkOf(rec!.id);
    // still d1's board, untouched by the info event.
    expect((spark.payload as { board: unknown }).board).toEqual(fromCmini(d1 as unknown as CminiPayload).board);

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
