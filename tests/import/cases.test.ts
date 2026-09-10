// [LDB-I2] [LDB-I4] [LDB-I5] One `it` per row of 07 §6 S5's case table,
// asserting the exact events appended (kind, rev, via, actor, detail), the
// `layouts` row, `import_map` and `likes`.
import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import type { Bindings } from "../../src/env";
import { appendWrite } from "../../src/core/events";
import { readById, readByName } from "../../src/core/records";
import { fixedClock } from "../../src/core/time";
import { applyFetchedId } from "../../src/import/apply";
import type { RawUpstreamDetail } from "../../src/import/upstream";
import listSnapshot from "../fixtures/upstream-100/list.json" with { type: "json" };
import fullSnapshot from "../fixtures/upstream-100/full.json" with { type: "json" };

const db = (env as unknown as Bindings).DB;
const clock = fixedClock("2026-06-01T00:00:00.000Z");

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

async function eventsFor(layoutId: string): Promise<
  { seq: number; kind: string; rev: number | null; actor: string; via: string; detail_json: string | null }[]
> {
  const { results } = await db
    .prepare(
      "SELECT seq, kind, rev, actor, via, detail_json FROM events WHERE layout_id = ? ORDER BY seq ASC",
    )
    .bind(layoutId)
    .all<{ seq: number; kind: string; rev: number | null; actor: string; via: string; detail_json: string | null }>();
  return results;
}

async function likeIds(layoutId: string): Promise<string[]> {
  const { results } = await db.prepare("SELECT user_id FROM likes WHERE layout_id = ?").bind(layoutId).all<{ user_id: string }>();
  return results.map((r) => r.user_id).sort();
}

// Flips a record to "not following upstream" without changing its content
// (a phase-2-shaped human edit) -- setup for the not-following case rows.
// `modified_at` defaults to the record's own current value so this doesn't
// itself introduce a content diff against an unmutated upstream detail
// (`project()`'s comparison includes modified_at, likes excluded only).
async function humanTouch(rec: { id: string; name: string; owner: string; format: string; payload: unknown; modified_at: string }) {
  await appendWrite(db, clock, {
    kind: "updated",
    layoutId: rec.id,
    name: rec.name,
    owner: rec.owner,
    modified_at: rec.modified_at,
    format: rec.format,
    payload: rec.payload,
    actor: rec.owner,
    via: "discord",
  });
}

describe("import case table (07 §6 S5)", () => {
  it("[LDB-I2] [LDB-I4] case 1: new id, name free -> imported, mapped, likes seeded", async () => {
    const d = detail({ name: "Case1-Free", user: "1000000000000000001", likes: ["1000000000000000011", "1000000000000000012"] });
    const result = await applyFetchedId(db, clock, "case1", d);
    expect(result.errors).toEqual([]);

    const rec = await readByName(db, "Case1-Free");
    expect(rec).not.toBeNull();
    expect(rec!.owner).toBe("1000000000000000001");
    expect(rec!.rev).toBe(1);

    const map = await importMapRow("case1");
    expect(map?.layout_id).toBe(rec!.id);

    const events = await eventsFor(rec!.id);
    expect(events).toHaveLength(3); // imported + 2 liked
    expect(events[0]).toMatchObject({ kind: "imported", rev: 1, actor: "system:cmini-import", via: "import:cmini" });
    expect(JSON.parse(events[0]!.detail_json!)).toEqual({ source: "cmini", upstream_id: "case1" });
    expect(events.slice(1).map((e) => e.kind)).toEqual(["liked", "liked"]);
    expect(await likeIds(rec!.id)).toEqual(["1000000000000000011", "1000000000000000012"]);
  });

  it("[LDB-I2] case 2: new id, name held by a live LOCAL record with the SAME owner -> mapped, informational only", async () => {
    const owner = "2000000000000000001";
    const { record: existing } = await appendWrite(db, clock, {
      kind: "created",
      name: "Case2-Shared",
      owner,
      modified_at: clock(),
      format: "cmini/1",
      payload: { board: "ortho", keys: {} },
      actor: owner,
      via: "discord",
    });

    const d = detail({ name: "Case2-Shared", user: owner });
    const result = await applyFetchedId(db, clock, "case2", d);
    expect(result.errors).toEqual([]);

    const map = await importMapRow("case2");
    expect(map?.layout_id).toBe(existing.id);

    const events = await eventsFor(existing.id);
    expect(events).toHaveLength(2); // created (setup) + upstream_changed
    expect(events[1]).toMatchObject({ kind: "upstream_changed", rev: null, actor: "system:cmini-import", via: "import:cmini" });

    // the existing record itself is untouched (still rev 1, still its own content)
    const after = await readById(db, existing.id);
    expect(after!.rev).toBe(1);
    expect(after!.owner).toBe(owner);
  });

  it("[LDB-I2] case 3: new id, name held by a DIFFERENT owner -> shadowed import + import_conflict on the existing record", async () => {
    const existingOwner = "3000000000000000001";
    const upstreamOwner = "3000000000000000002";
    const { record: existing } = await appendWrite(db, clock, {
      kind: "created",
      name: "Case3-Clash",
      owner: existingOwner,
      modified_at: clock(),
      format: "cmini/1",
      payload: { board: "ortho", keys: {} },
      actor: existingOwner,
      via: "discord",
    });

    const d = detail({ name: "Case3-Clash", user: upstreamOwner, likes: ["3000000000000000099"] });
    const result = await applyFetchedId(db, clock, "case3", d);
    expect(result.errors).toEqual([]);

    // the existing record got an import_conflict info event, nothing else
    const existingEvents = await eventsFor(existing.id);
    expect(existingEvents).toHaveLength(2);
    expect(existingEvents[1]).toMatchObject({ kind: "import_conflict", rev: null, actor: "system:cmini-import", via: "import:cmini" });
    expect(JSON.parse(existingEvents[1]!.detail_json!)).toMatchObject({ upstream_id: "case3", upstream_name: "Case3-Clash", conflicts_with: existing.id });

    // a NEW shadowed record was created under a free name
    const shadow = await readByName(db, "Case3-Clash~cmini");
    expect(shadow).not.toBeNull();
    expect(shadow!.owner).toBe(upstreamOwner);
    const map = await importMapRow("case3");
    expect(map?.layout_id).toBe(shadow!.id);
    const shadowEvents = await eventsFor(shadow!.id);
    expect(shadowEvents[0]).toMatchObject({ kind: "imported", rev: 1 });
    expect(JSON.parse(shadowEvents[0]!.detail_json!)).toMatchObject({ shadowed: { upstream_name: "Case3-Clash" } });
    expect(await likeIds(shadow!.id)).toEqual(["3000000000000000099"]);
  });

  it("[LDB-I2] case 3: a second collision picks ~cmini2", async () => {
    const ownerA = "3100000000000000001";
    const ownerB = "3100000000000000002";
    const ownerC = "3100000000000000003";
    await appendWrite(db, clock, {
      kind: "created", name: "Case3b-Clash", owner: ownerA, modified_at: clock(),
      format: "cmini/1", payload: { board: "ortho", keys: {} }, actor: ownerA, via: "discord",
    });
    // pre-occupy the first shadow slot too
    await appendWrite(db, clock, {
      kind: "created", name: "Case3b-Clash~cmini", owner: ownerB, modified_at: clock(),
      format: "cmini/1", payload: { board: "ortho", keys: {} }, actor: ownerB, via: "discord",
    });

    const d = detail({ name: "Case3b-Clash", user: ownerC });
    const result = await applyFetchedId(db, clock, "case3b", d);
    expect(result.errors).toEqual([]);

    const shadow2 = await readByName(db, "Case3b-Clash~cmini2");
    expect(shadow2).not.toBeNull();
    expect(shadow2!.owner).toBe(ownerC);
  });

  it("[LDB-I2] [LDB-I4] case 4: mapped + following + content differs -> imported (rev+1), tombstone revived", async () => {
    const owner = "4000000000000000001";
    const d1 = detail({ name: "Case4-Content", user: owner, board: "ortho", keys: {} });
    await applyFetchedId(db, clock, "case4", d1);
    const before = await readByName(db, "Case4-Content");
    expect(before!.rev).toBe(1);

    const d2 = detail({ name: "Case4-Content", user: owner, board: "angle", keys: {}, modified_at: "2026-02-01T00:00:00Z" });
    const result = await applyFetchedId(db, clock, "case4", d2);
    expect(result.errors).toEqual([]);

    const after = await readById(db, before!.id);
    expect(after!.rev).toBe(2);
    expect((after!.payload as { board: string }).board).toBe("angle");

    const events = await eventsFor(before!.id);
    expect(events.map((e) => e.kind)).toEqual(["imported", "imported"]);
    expect(events[1]).toMatchObject({ kind: "imported", rev: 2, actor: "system:cmini-import", via: "import:cmini" });
  });

  it("[LDB-I2] case 4b: mapped + following + upstream re-created the layout (created_at moved) -> imported, our created_at follows", async () => {
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
    expect(after!.rev).toBe(2);
    expect(after!.created_at).toBe("2026-03-01T00:00:00Z");
    expect(after!.modified_at).toBe("2026-03-01T00:00:00Z");

    // and a third identical tick is quiet again (LDB-I1)
    const again = await applyFetchedId(db, clock, "case4b", d2);
    expect(again.errors).toEqual([]);
    expect((await readById(db, before!.id))!.rev).toBe(2);
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
    expect(after!.rev).toBe(1); // no content write

    const events = await eventsFor(rec!.id);
    expect(events.map((e) => e.kind)).toEqual(["imported", "liked", "liked", "liked", "unliked"]);
    expect(await likeIds(rec!.id)).toEqual(["5000000000000000012", "5000000000000000013"]);
  });

  it("[LDB-I2] case 6: mapped + NOT following + content differs -> upstream_changed info, record untouched, not repeated", async () => {
    const owner = "6000000000000000001";
    const d1 = detail({ name: "Case6-NotFollow", user: owner, board: "ortho" });
    await applyFetchedId(db, clock, "case6", d1);
    const rec = await readByName(db, "Case6-NotFollow");
    await humanTouch({ id: rec!.id, name: rec!.name, owner: rec!.owner, format: rec!.format, payload: rec!.payload, modified_at: rec!.modified_at });

    const d2 = detail({ name: "Case6-NotFollow", user: owner, board: "angle" });
    const result = await applyFetchedId(db, clock, "case6", d2);
    expect(result.errors).toEqual([]);

    const after = await readById(db, rec!.id);
    expect((after!.payload as { board: string }).board).toBe("ortho"); // untouched by the info event

    const events = await eventsFor(rec!.id);
    expect(events.map((e) => e.kind)).toEqual(["imported", "updated", "upstream_changed"]);
    expect(events[2]).toMatchObject({ rev: null, actor: "system:cmini-import", via: "import:cmini" });

    // repeat: the SAME upstream content again -> no new event
    const result2 = await applyFetchedId(db, clock, "case6", d2);
    expect(result2.errors).toEqual([]);
    const eventsAfterRepeat = await eventsFor(rec!.id);
    expect(eventsAfterRepeat).toHaveLength(3);
  });

  it("[LDB-I2] case 7: mapped + NOT following + likes differ -> union only, never unlike", async () => {
    const owner = "7000000000000000001";
    const d1 = detail({ name: "Case7-Union", user: owner, likes: ["7000000000000000011"] });
    await applyFetchedId(db, clock, "case7", d1);
    const rec = await readByName(db, "Case7-Union");
    await humanTouch({ id: rec!.id, name: rec!.name, owner: rec!.owner, format: rec!.format, payload: rec!.payload, modified_at: rec!.modified_at });
    // a local-only like, absent upstream -- must survive the union
    await db.prepare("INSERT INTO likes (layout_id, user_id, at) VALUES (?, ?, ?)").bind(rec!.id, "7000000000000000099", clock()).run();

    const d2 = detail({ name: "Case7-Union", user: owner, likes: ["7000000000000000011", "7000000000000000022"] });
    const result = await applyFetchedId(db, clock, "case7", d2);
    expect(result.errors).toEqual([]);

    expect(await likeIds(rec!.id)).toEqual(["7000000000000000011", "7000000000000000022", "7000000000000000099"]);
    const events = await eventsFor(rec!.id);
    // imported + its own seeded like (7...011), then the human touch, then
    // exactly one new liked event for 7...022 -- nothing removed
    expect(events.map((e) => e.kind)).toEqual(["imported", "liked", "updated", "liked"]);
    expect(events[3]).toMatchObject({ kind: "liked", actor: "7000000000000000022" });
  });

  it("[LDB-I2] [LDB-I4] case 8: delete (404) while following -> upstream_deleted WRITE, name released", async () => {
    const owner = "8000000000000000001";
    const d1 = detail({ name: "Case8-Delete", user: owner });
    await applyFetchedId(db, clock, "case8", d1);
    const rec = await readByName(db, "Case8-Delete");

    const result = await applyFetchedId(db, clock, "case8", "notfound");
    expect(result.errors).toEqual([]);

    const after = await readById(db, rec!.id);
    expect(after!.deleted).toBe(true);
    expect(after!.rev).toBe(2);
    expect(await readByName(db, "Case8-Delete")).toBeNull(); // name released

    const events = await eventsFor(rec!.id);
    expect(events[1]).toMatchObject({ kind: "upstream_deleted", rev: 2, actor: "system:cmini-import", via: "import:cmini" });

    // a new record may now claim the freed name
    const { record: reclaimed } = await appendWrite(db, clock, {
      kind: "created", name: "Case8-Delete", owner: "someone-else", modified_at: clock(),
      format: "cmini/1", payload: { board: "ortho", keys: {} }, actor: "someone-else", via: "discord",
    });
    expect(reclaimed.name).toBe("Case8-Delete");
  });

  it("[LDB-I2] case 9: delete while NOT following -> upstream_deleted info once, record stays live", async () => {
    const owner = "9000000000000000001";
    const d1 = detail({ name: "Case9-Delete", user: owner });
    await applyFetchedId(db, clock, "case9", d1);
    const rec = await readByName(db, "Case9-Delete");
    await humanTouch({ id: rec!.id, name: rec!.name, owner: rec!.owner, format: rec!.format, payload: rec!.payload, modified_at: rec!.modified_at });

    const result = await applyFetchedId(db, clock, "case9", "notfound");
    expect(result.errors).toEqual([]);

    const after = await readById(db, rec!.id);
    expect(after!.deleted).toBe(false); // still live

    const events = await eventsFor(rec!.id);
    expect(events.map((e) => e.kind)).toEqual(["imported", "updated", "upstream_deleted"]);
    expect(events[2]).toMatchObject({ rev: null, actor: "system:cmini-import", via: "import:cmini" });

    // idempotent: a second 404 tick doesn't duplicate the info event
    await applyFetchedId(db, clock, "case9", "notfound");
    expect(await eventsFor(rec!.id)).toHaveLength(3);
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

// M1 (design/layout-db/17-magic-ownership.md §4): cmini's magic is never
// akl.gg's -- these two describes are LDB-I10/I11's own tagged coverage,
// alongside `tests/import/strip.test.ts` (the one-time strip route) and
// `tests/import/diff-unit.test.ts`/`tests/import/tick.test.ts` (the
// change-detection projection).
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
    expect((rec!.payload as { magic?: unknown }).magic).toBeUndefined();
    expect(rec!.has_magic).toBe(false);
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
    expect(after!.rev).toBe(1); // no write at all -- upstream adding magic is invisible to change detection
    expect(await eventsFor(rec!.id)).toHaveLength(before.length);
    expect((after!.payload as { magic?: unknown }).magic).toBeUndefined();
  });
});

describe("[LDB-I11] an import write preserves the record's own magic byte-for-byte", () => {
  it("[LDB-I11] case 4: a real upstream content change carries the record's pre-existing (legacy) magic forward untouched", async () => {
    const owner = "1100000000000000003";
    const d1 = detail({ name: "I11-Legacy", user: owner, board: "ortho", keys: {} });
    await applyFetchedId(db, clock, "i11-legacy", d1);
    const rec = await readByName(db, "I11-Legacy");

    // Simulate a record imported BEFORE M1 landed: still following upstream
    // (`via: import:cmini`), but its stored payload already carries cmini's
    // magic -- today's imports never write this (LDB-I10), so the only way
    // a followed record has magic at all is a legacy write like this one
    // (exactly what `POST /v1/admin/import/strip-cmini-magic` targets).
    const legacyMagic = [{ inputs: "n*", output: "nn", type: "repeat" }];
    await appendWrite(db, clock, {
      kind: "imported",
      layoutId: rec!.id,
      name: rec!.name,
      owner: rec!.owner,
      modified_at: rec!.modified_at,
      format: "cmini/1",
      payload: { ...(rec!.payload as object), magic: legacyMagic },
      actor: "system:cmini-import",
      via: "import:cmini",
      detail: { source: "cmini", upstream_id: "i11-legacy" },
      hasMagic: true,
    });

    // A REAL upstream content change (board differs) -- case 4 fires.
    const d2 = detail({ name: "I11-Legacy", user: owner, board: "angle", keys: {}, modified_at: "2026-02-01T00:00:00Z" });
    const result = await applyFetchedId(db, clock, "i11-legacy", d2);
    expect(result.errors).toEqual([]);

    const after = await readById(db, rec!.id);
    expect((after!.payload as { board: string }).board).toBe("angle"); // upstream's new content landed
    expect((after!.payload as { magic?: unknown }).magic).toEqual(legacyMagic); // magic carried forward byte-for-byte
    expect(after!.has_magic).toBe(true);

    const events = await eventsFor(rec!.id);
    expect(events.map((e) => e.kind)).toEqual(["imported", "imported", "imported"]);
  });

  it("[LDB-I11] a not-following record's own local magic is never reported as an upstream difference", async () => {
    const owner = "1100000000000000004";
    const d1 = detail({ name: "I11-NotFollow", user: owner, board: "ortho" });
    await applyFetchedId(db, clock, "i11-notfollow", d1);
    const rec = await readByName(db, "I11-NotFollow");
    await humanTouch({ id: rec!.id, name: rec!.name, owner: rec!.owner, format: rec!.format, payload: rec!.payload, modified_at: rec!.modified_at });

    // The owner's own record now carries local magic (M2-shaped: akl.gg's
    // own rules on an akl/1 record -- simulated directly here since cmini/1
    // has no write idiom for `magic` yet, formats/cmini/1/index.ts's own
    // comment on `edits`).
    const localMagic = [{ inputs: "s*", output: "ss", type: "repeat" }];
    await appendWrite(db, clock, {
      kind: "updated",
      layoutId: rec!.id,
      name: rec!.name,
      owner: rec!.owner,
      modified_at: rec!.modified_at,
      format: "cmini/1",
      payload: { ...(rec!.payload as object), magic: localMagic },
      actor: rec!.owner,
      via: "discord",
    });
    const before = await eventsFor(rec!.id);

    // The SAME upstream content as before (still d1's board/keys). Absent
    // the magic-less projection, this would look like "content differs"
    // purely because the local side now has a `magic` field upstream's
    // never has -- spamming an `upstream_changed` info event every daily
    // pass for content that, from cmini's point of view, never changed.
    const result = await applyFetchedId(db, clock, "i11-notfollow", d1);
    expect(result.errors).toEqual([]);
    expect(await eventsFor(rec!.id)).toHaveLength(before.length); // no new event
    const after = await readById(db, rec!.id);
    expect((after!.payload as { magic?: unknown }).magic).toEqual(localMagic); // untouched
  });
});

describe("[LDB-I5] imported names are stored verbatim from the live snapshot", () => {
  const list = (listSnapshot as { layouts: { id: string; name: string }[] }).layouts;
  const full = (fullSnapshot as { layouts: RawUpstreamDetail[] }).layouts;
  const byName = new Map(full.map((d) => [d.name as string, d]));

  // Plain `it()` calls, not `it.each` -- tests/tools/invariants.test.ts
  // (LDB-T1) scans literal `it("[LDB-*] ...")`/`test("[LDB-*] ...")` calls
  // for tags; an `it.each(...)("title", fn)` call's title never matches
  // that scan (there's no `it("...")` text for it to find).
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
