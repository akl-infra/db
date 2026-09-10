// [LDB-I10] `stripCminiMagic` (M1, design/layout-db/17-magic-ownership.md
// §4): the one-time admin pass that removes cmini's magic from records
// imported before LDB-I10/I11 landed. Every record here is seeded the same
// way `tests/import/cases.test.ts`'s own LDB-I11 tests simulate "legacy
// magic" -- a direct `appendWrite` carrying `magic` in the payload, since
// today's import path (`applyNew`/`applyMapped`) can never write one itself.
import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import type { Bindings } from "../../src/env";
import { appendWrite } from "../../src/core/events";
import { readById, readByName } from "../../src/core/records";
import { fixedClock } from "../../src/core/time";
import { applyFetchedId } from "../../src/import/apply";
import { stripCminiMagic } from "../../src/import/strip";
import type { RawUpstreamDetail } from "../../src/import/upstream";

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

async function eventsFor(layoutId: string): Promise<{ seq: number; kind: string; rev: number | null; actor: string; via: string; detail_json: string | null }[]> {
  const { results } = await db
    .prepare("SELECT seq, kind, rev, actor, via, detail_json FROM events WHERE layout_id = ? ORDER BY seq ASC")
    .bind(layoutId)
    .all<{ seq: number; kind: string; rev: number | null; actor: string; via: string; detail_json: string | null }>();
  return results;
}

// Imports a fresh record (case 1, no magic -- LDB-I10) then directly writes
// legacy magic onto it via `appendWrite` (`via: import:cmini`, so it keeps
// following upstream) -- exactly the "imported before M1" state the strip
// route exists to clean up.
async function seedLegacyMagicRecord(name: string, owner: string, upstreamId: string, magic: unknown[]): Promise<{ id: string }> {
  const d = detail({ name, user: owner });
  await applyFetchedId(db, clock, upstreamId, d);
  const rec = await readByName(db, name);
  await appendWrite(db, clock, {
      upstream: null,
    kind: "imported",
    layoutId: rec!.id,
    name: rec!.name,
    owner: rec!.owner,
    modified_at: rec!.modified_at,
    format: "cmini/1",
    payload: { ...(rec!.payload as object), magic },
    actor: "system:cmini-import",
    via: "import:cmini",
    detail: { source: "cmini", upstream_id: upstreamId },
    hasMagic: true,
  });
  return { id: rec!.id };
}

describe("stripCminiMagic", () => {
  it("[LDB-I10] strips a following record's legacy magic: an 'imported' rev bump, magic-less payload, has_magic false", async () => {
    const magic = [{ inputs: "n*", output: "nn", type: "repeat" }];
    const { id } = await seedLegacyMagicRecord("Strip-Following", "9200000000000000001", "strip-following", magic);

    const result = await stripCminiMagic(db, clock);
    expect(result.stripped).toBe(1);

    const after = await readById(db, id);
    expect((after!.payload as { magic?: unknown }).magic).toBeUndefined();
    expect(after!.has_magic).toBe(false);
    expect((after!.payload as { board: string }).board).toBe("ortho"); // everything else untouched

    const events = await eventsFor(id);
    expect(events.map((e) => e.kind)).toEqual(["imported", "imported", "imported"]);
    const last = events[events.length - 1]!;
    expect(last).toMatchObject({ actor: "system:cmini-import", via: "import:cmini" });
    expect(JSON.parse(last.detail_json!)).toEqual({
      source: "cmini",
      upstream_id: "strip-following",
      reason: "magic_stripped",
    });
  });

  it("[LDB-I10] idempotent: a second call finds nothing left to strip", async () => {
    const magic = [{ inputs: "s*", output: "ss", type: "repeat" }];
    await seedLegacyMagicRecord("Strip-Idempotent", "9200000000000000002", "strip-idempotent", magic);

    const first = await stripCminiMagic(db, clock);
    expect(first.stripped).toBe(1);
    const second = await stripCminiMagic(db, clock);
    expect(second.stripped).toBe(0);
  });

  it("[LDB-I10] a record that no longer follows upstream keeps its magic -- never this route's to touch", async () => {
    const magic = [{ inputs: "e*", output: "ee", type: "repeat" }];
    const { id } = await seedLegacyMagicRecord("Strip-NotFollowing", "9200000000000000003", "strip-notfollowing", magic);
    const rec = await readById(db, id);

    // A human edit takes the record off upstream (`via: discord`) without
    // touching its magic.
    await appendWrite(db, clock, {
      upstream: null,
      kind: "updated",
      layoutId: id,
      name: rec!.name,
      owner: rec!.owner,
      modified_at: rec!.modified_at,
      format: "cmini/1",
      payload: rec!.payload,
      actor: rec!.owner,
      via: "discord",
      hasMagic: true, // content (magic included) is unchanged from `rec!.payload`
    });

    const result = await stripCminiMagic(db, clock);
    expect(result.stripped).toBe(0);

    const after = await readById(db, id);
    expect((after!.payload as { magic?: unknown }).magic).toEqual(magic); // untouched
    expect(after!.has_magic).toBe(true);
  });

  it("[LDB-I10] a record with no magic is never touched", async () => {
    const d = detail({ name: "Strip-Clean", user: "9200000000000000004" });
    await applyFetchedId(db, clock, "strip-clean", d);
    const rec = await readByName(db, "Strip-Clean");
    const eventsBefore = await eventsFor(rec!.id);

    const result = await stripCminiMagic(db, clock);
    expect(result.stripped).toBe(0);
    expect(await eventsFor(rec!.id)).toHaveLength(eventsBefore.length);
  });

  it("[LDB-I10] strips more than one eligible record in a single call", async () => {
    const magicA = [{ inputs: "t*", output: "tt", type: "repeat" }];
    const magicB = [{ inputs: "l*", output: "ll", type: "repeat" }];
    const a = await seedLegacyMagicRecord("Strip-Multi-A", "9200000000000000005", "strip-multi-a", magicA);
    const b = await seedLegacyMagicRecord("Strip-Multi-B", "9200000000000000006", "strip-multi-b", magicB);

    const result = await stripCminiMagic(db, clock);
    expect(result.stripped).toBe(2);

    const afterA = await readById(db, a.id);
    const afterB = await readById(db, b.id);
    expect((afterA!.payload as { magic?: unknown }).magic).toBeUndefined();
    expect((afterB!.payload as { magic?: unknown }).magic).toBeUndefined();
  });
});
