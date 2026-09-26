// [LDB-I14] `core/upstream.ts` against real D1:
// `upstreamOf`'s plain field read (21-formats.md D12 deleted the legacy
// `import_map`/`legacyFollows` fallback this used to fall back to), the
// fold identity (the row's `upstream` equals the latest rev-bumping
// event's after.upstream, over EITHER scope -- MF-12; the fold's own id,
// LDB-P11, is retired -- 2026-09-26, the cmini importer removed -- but
// this coverage stays real, unretired code), and the system-writer race
// guard (its own id, LDB-P14, is retired the same way) -- now implemented
// by `commitWrite`'s own
// `layout_revs` PK on a stale `currentN`, with no separate `expectN` field
// (a stale base always collides on an already-committed row at that `n`).
// `tests/core/upstream.test.ts` covers `nextUpstream` itself as a pure
// function; this file is what actually touches the `layouts.upstream_*`
// columns and `events`.
import { env } from "cloudflare:test";
import type { Bindings } from "../../src/env";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { RevConflictError, commitWrite, type CommitInput } from "../../src/core/events";
import { formatsForLayout, readById, type Upstream } from "../../src/core/records";
import { fixedClock } from "../../src/core/time";
import { nextUpstream, upstreamOf } from "../../src/core/upstream";
import { ulid } from "ulidx";

const db = (env as unknown as Bindings).DB;
const clock = fixedClock("2026-09-10T00:00:00.000Z");
const USER_SOURCE = { client: "discord-app:test", version: null };
const IMPORT_SOURCE = { client: "system:cmini-import", version: null };

let uniqueCounter = 0;
function unique(): string {
  return `u${uniqueCounter++}`;
}

async function insertImportMapRow(upstreamId: string, layoutId: string): Promise<void> {
  await db.prepare("INSERT INTO import_map (upstream_id, layout_id) VALUES (?, ?)").bind(upstreamId, layoutId).run();
}

function createLayout(name: string, upstream: Upstream | null, isImport: boolean) {
  const input: CommitInput = {
    layoutId: ulid(),
    creating: true,
    currentN: 0,
    currentLayout: null,
    currentFormats: new Map(),
    layout: { kind: isImport ? "imported" : "created", name, owner: "owner-a", created_at: clock(), deleted: false },
    format: { kind: isImport ? "imported" : "format_added", lineage: "spark", format: "spark/1", payload: { v: 0 }, hasMagic: false },
    modified_at: clock(),
    actor: isImport ? "system:cmini-import" : "owner-a",
    via: isImport ? "import:cmini" : "discord",
    source: isImport ? IMPORT_SOURCE : USER_SOURCE,
    upstream,
  };
  return commitWrite(db, clock, input);
}

async function updateSpark(layoutId: string, currentN: number, payload: unknown, via: "discord" | "import:cmini", upstream: Upstream | null) {
  const currentLayout = await readById(db, layoutId);
  const currentFormats = await formatsForLayout(db, layoutId);
  const input: CommitInput = {
    layoutId,
    creating: false,
    currentN,
    currentLayout,
    currentFormats,
    format: { kind: via === "import:cmini" ? "imported" : "updated", lineage: "spark", format: "spark/1", payload, hasMagic: false },
    modified_at: clock(),
    actor: via === "import:cmini" ? "system:cmini-import" : "owner-a",
    via,
    source: via === "import:cmini" ? IMPORT_SOURCE : USER_SOURCE,
    upstream,
  };
  return commitWrite(db, clock, input);
}

describe("[LDB-I14] upstreamOf: a plain read of the layout's own field", () => {
  it("[LDB-I14] a non-null `upstream` field is returned as-is", async () => {
    const name = `field-wins-${unique()}`;
    const { layout } = await createLayout(name, { source: "cmini", id: "some-upstream", state: "forked" }, false);
    // An import_map row for the same upstream id changes nothing -- D12
    // deleted the legacy fallback that used to consult it.
    await insertImportMapRow("some-upstream", layout.id);
    const rec = await readById(db, layout.id);
    expect(await upstreamOf(db, rec!)).toEqual({ source: "cmini", id: "some-upstream", state: "forked" });
  });

  it("[LDB-I14] a null `upstream` field is null, whether or not an import_map row exists (D12: no more legacy fallback)", async () => {
    const name = `never-mapped-${unique()}`;
    const { layout } = await createLayout(name, null, false);
    await insertImportMapRow(`would-have-been-legacy-${unique()}`, layout.id);
    const rec = await readById(db, layout.id);
    expect(await upstreamOf(db, rec!)).toBeNull();
  });
});

describe("upstream is a fold", () => {
  it("[MF-12] the row's `upstream` equals the latest rev-bumping event's after.upstream, through a following -> forked transition on a FORMAT-scope write", async () => {
    const name = `fold-${unique()}`;
    const initial: Upstream = { source: "cmini", id: "fold-up-1", state: "following" };
    const { layout: created } = await createLayout(name, initial, true);
    expect(created.upstream).toEqual(initial);
    let rec = await readById(db, created.id);
    expect(rec!.upstream).toEqual(initial);

    // A user write to the SPARK format forks it -- MF-12: spark is a
    // touching lineage.
    const prior = await upstreamOf(db, rec!);
    const forkedUpstream = nextUpstream(prior, "discord", true);
    const { layout: updated } = await updateSpark(created.id, rec!.n, { v: 2 }, "discord", forkedUpstream);
    expect(updated.upstream).toEqual({ ...initial, state: "forked" });
    rec = await readById(db, updated.id);
    expect(rec!.upstream).toEqual({ ...initial, state: "forked" });
    expect(await upstreamOf(db, rec!)).toEqual(rec!.upstream);
  });

  it("a row with a NULL `upstream` field reads null, even with an import_map row (21-formats.md D12: the legacy fallback is gone)", async () => {
    const name = `null-upstream-${unique()}`;
    const { layout } = await createLayout(name, null, true);
    await insertImportMapRow(`would-have-been-legacy-${unique()}`, layout.id);
    const rec = await readById(db, layout.id);
    expect(rec!.upstream).toBeNull();
    expect(await upstreamOf(db, rec!)).toBeNull();
  });
});

describe("a stale base closes the system-writer/user-write race", () => {
  it("a system write built from a stale `n` throws RevConflictError before landing, and the user's write survives", async () => {
    const name = `race-${unique()}`;
    const { layout: created } = await createLayout(name, { source: "cmini", id: "race-up-1", state: "following" }, true);
    const staleN = created.n; // what a system writer read BEFORE the user's write below landed

    // The user's write lands first, forking the layout.
    const { formats: _f1 } = await updateSpark(created.id, created.n, { v: "user" }, "discord", { source: "cmini", id: "race-up-1", state: "forked" });

    // The system writer's own attempt, built from the STALE `staleN`, must
    // be refused before it ever lands -- not silently accepted at a NEW
    // target `n` (which is exactly what would happen without this guard).
    await expect(updateSpark(created.id, staleN, { v: "stale-system-write" }, "import:cmini", { source: "cmini", id: "race-up-1", state: "following" })).rejects.toThrow(RevConflictError);

    const finalRec = await readById(db, created.id);
    const finalFormats = await formatsForLayout(db, created.id);
    expect(finalFormats.get("spark")!.payload).toEqual({ v: "user" }); // the user's edit, never clobbered
    expect(finalRec!.upstream).toEqual({ source: "cmini", id: "race-up-1", state: "forked" }); // stays forked
  });

  it("a system write whose base `n` IS current commits normally", async () => {
    const name = `race-ok-${unique()}`;
    const { layout: created } = await createLayout(name, { source: "cmini", id: "race-up-2", state: "following" }, true);
    const { formats } = await updateSpark(created.id, created.n, { v: 1 }, "import:cmini", { source: "cmini", id: "race-up-2", state: "following" });
    expect(formats.get("spark")!.rev).toBe(2);
    expect(formats.get("spark")!.payload).toEqual({ v: 1 });
  });

  // [LDB-P14] property: random interleavings of a system writer's
  // (potentially stale) read/write pair against a burst of user writes.
  // Whatever order they land in, a system write only ever succeeds when
  // its base `n` is STILL current at the moment it runs; it never clobbers
  // a user write that beat it there.
  it("property: a system write commits iff its base `n` is still current when it runs", async () => {
    await fc.assert(
      fc.asyncProperty(fc.integer({ min: 0, max: 5 }), async (userWritesBeforeSystemWrite) => {
        const name = `race-prop-${unique()}`;
        const { layout: created } = await createLayout(name, { source: "cmini", id: "race-prop-up", state: "following" }, true);
        const systemReadN = created.n; // the system writer's own "read", taken now

        let lastUserPayload: unknown = null;
        let currentN = created.n;
        for (let i = 0; i < userWritesBeforeSystemWrite; i++) {
          const rec = await readById(db, created.id);
          const prior = await upstreamOf(db, rec!);
          const { layout: l, formats } = await updateSpark(created.id, currentN, { v: `user-${i}` }, "discord", nextUpstream(prior, "discord", true));
          lastUserPayload = formats.get("spark")!.payload;
          currentN = l.n;
        }

        const attempt = updateSpark(created.id, systemReadN, { v: "system" }, "import:cmini", nextUpstream({ source: "cmini", id: "race-prop-up", state: "following" }, "import:cmini", true));

        if (userWritesBeforeSystemWrite === 0) {
          const { formats } = await attempt;
          expect(formats.get("spark")!.payload).toEqual({ v: "system" });
        } else {
          await expect(attempt).rejects.toThrow(RevConflictError);
          const finalFormats = await formatsForLayout(db, created.id);
          expect(finalFormats.get("spark")!.payload).toEqual(lastUserPayload);
        }
      }),
      { numRuns: 20 },
    );
  });
});
