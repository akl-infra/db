// [LDB-I14] [LDB-P11] [LDB-P14] `core/upstream.ts` against real D1:
// `upstreamOf`'s field-vs-legacy-fallback precedence (the `import_map`
// dimension of I14's own matrix), the fold identity (P11: the row's
// `upstream` equals the latest rev-bumping event's `after.upstream`, and a
// pre-0005-shaped row falls back to the legacy rule), and `expectRev`'s
// race guard (P14). `tests/core/upstream.test.ts` covers `nextUpstream`
// itself as a pure function; this file is what actually touches the
// `layouts.upstream_*` columns and `events`.
import { env } from "cloudflare:test";
import type { Bindings } from "../../src/env";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { RevConflictError, appendWrite } from "../../src/core/events";
import { readById, type Upstream } from "../../src/core/records";
import { fixedClock } from "../../src/core/time";
import { nextUpstream, upstreamOf } from "../../src/core/upstream";

const db = (env as unknown as Bindings).DB;
const clock = fixedClock("2026-09-10T00:00:00.000Z");

let uniqueCounter = 0;
function unique(): string {
  return `u${uniqueCounter++}`;
}

async function insertImportMapRow(upstreamId: string, layoutId: string): Promise<void> {
  await db.prepare("INSERT INTO import_map (upstream_id, layout_id) VALUES (?, ?)").bind(upstreamId, layoutId).run();
}

describe("[LDB-I14] upstreamOf: field vs. legacy fallback, the import_map dimension", () => {
  it("[LDB-I14] a non-null `upstream` field wins outright -- ignores import_map/legacyFollows entirely, even when they'd disagree", async () => {
    const name = `field-wins-${unique()}`;
    const { record } = await appendWrite(db, clock, {
      upstream: { source: "cmini", id: "some-upstream", state: "forked" },
      kind: "created",
      name,
      owner: "owner-a",
      modified_at: clock(),
      format: "cmini/1",
      payload: { v: 1 },
      actor: "owner-a",
      via: "discord",
      source: { client: "discord-app:test", version: null },
    });
    // A contradicting import_map row -- if the fallback were consulted at
    // all, this record would read "following". It must not be: the field
    // is non-null.
    await insertImportMapRow("some-upstream", record.id);
    const rec = await readById(db, record.id);
    expect(await upstreamOf(db, rec!)).toEqual({ source: "cmini", id: "some-upstream", state: "forked" });
  });

  it("[LDB-I14] null field + import_map row + legacyFollows true -> the legacy fallback answers 'following'", async () => {
    const name = `legacy-following-${unique()}`;
    const { record } = await appendWrite(db, clock, {
      upstream: null, // pre-0005 shape: no field ever written
      kind: "imported",
      name,
      owner: "owner-a",
      modified_at: clock(),
      format: "cmini/1",
      payload: { v: 1 },
      actor: "system:cmini-import",
      via: "import:cmini", // legacyFollows' own rule: latest rev-bumping event's via
      source: { client: "system:cmini-import", version: null },
    });
    await insertImportMapRow("legacy-up-1", record.id);
    const rec = await readById(db, record.id);
    expect(await upstreamOf(db, rec!)).toEqual({ source: "cmini", id: "legacy-up-1", state: "following" });
  });

  it("[LDB-I14] null field + import_map row + legacyFollows false -> 'forked' (mapped but not following IS forked, not null -- an import_map row alone answers 'does the importer own this record', never 'is there a link at all')", async () => {
    const name = `legacy-not-following-${unique()}`;
    const { record } = await appendWrite(db, clock, {
      upstream: null,
      kind: "created", // via: discord -- legacyFollows answers false
      name,
      owner: "owner-a",
      modified_at: clock(),
      format: "cmini/1",
      payload: { v: 1 },
      actor: "owner-a",
      via: "discord",
      source: { client: "discord-app:test", version: null },
    });
    await insertImportMapRow("legacy-up-2", record.id);
    const rec = await readById(db, record.id);
    expect(await upstreamOf(db, rec!)).toEqual({ source: "cmini", id: "legacy-up-2", state: "forked" });
  });

  it("[LDB-I14] null field + no import_map row at all -> null", async () => {
    const name = `never-mapped-${unique()}`;
    const { record } = await appendWrite(db, clock, {
      upstream: null,
      kind: "created",
      name,
      owner: "owner-a",
      modified_at: clock(),
      format: "cmini/1",
      payload: { v: 1 },
      actor: "owner-a",
      via: "discord",
      source: { client: "discord-app:test", version: null },
    });
    const rec = await readById(db, record.id);
    expect(await upstreamOf(db, rec!)).toBeNull();
  });
});

describe("[LDB-P11] upstream is a fold", () => {
  it("[LDB-P11] the row's `upstream` equals the latest rev-bumping event's after.upstream, through a following -> forked transition", async () => {
    const name = `fold-${unique()}`;
    const initial: Upstream = { source: "cmini", id: "fold-up-1", state: "following" };
    const created = await appendWrite(db, clock, {
      upstream: initial,
      kind: "imported",
      name,
      owner: "owner-a",
      modified_at: clock(),
      format: "cmini/1",
      payload: { v: 1 },
      actor: "system:cmini-import",
      via: "import:cmini",
      source: { client: "system:cmini-import", version: null },
    });
    expect(created.record.upstream).toEqual(initial);
    let rec = await readById(db, created.record.id);
    expect(rec!.upstream).toEqual(initial);

    // A user PUT-shaped write forks it -- LDB-I14.
    const prior = await upstreamOf(db, rec!);
    const forkedUpstream = nextUpstream(prior, "updated", "discord");
    const updated = await appendWrite(db, clock, {
      upstream: forkedUpstream,
      kind: "updated",
      layoutId: rec!.id,
      name,
      owner: "owner-a",
      modified_at: clock(),
      format: "cmini/1",
      payload: { v: 2 },
      actor: "owner-a",
      via: "discord",
      source: { client: "discord-app:test", version: null },
    });
    expect(updated.record.upstream).toEqual({ ...initial, state: "forked" });
    rec = await readById(db, updated.record.id);
    expect(rec!.upstream).toEqual({ ...initial, state: "forked" });
    // The field wins from here on -- `upstreamOf` agrees with the row.
    expect(await upstreamOf(db, rec!)).toEqual(rec!.upstream);
  });

  it("[LDB-P11] a pre-0005-shaped row (upstream_* NULL, as any dump written before this slice restores it) falls back to the legacy rule", async () => {
    // Mirrors `dump/restore.ts`'s NULL-on-old-shape behaviour without
    // going through a real dump/restore round trip (that's rehost.test.ts
    // and drill/verify.test.ts's job) -- this only needs the column state.
    const name = `pre-0005-${unique()}`;
    const { record } = await appendWrite(db, clock, {
      upstream: null,
      kind: "imported",
      name,
      owner: "owner-a",
      modified_at: clock(),
      format: "cmini/1",
      payload: { v: 1 },
      actor: "system:cmini-import",
      via: "import:cmini",
      source: { client: "system:cmini-import", version: null },
    });
    await insertImportMapRow("pre-0005-up", record.id);
    const rec = await readById(db, record.id);
    expect(rec!.upstream).toBeNull(); // exactly what a restored old-shape dump reads back
    expect(await upstreamOf(db, rec!)).toEqual({ source: "cmini", id: "pre-0005-up", state: "following" });
  });
});

describe("[LDB-P14] expectRev closes the system-writer/user-write race", () => {
  it("[LDB-P14] a system write with a stale expectRev throws RevConflictError before touching the row, and the user's write survives", async () => {
    const name = `race-${unique()}`;
    const { record } = await appendWrite(db, clock, {
      upstream: { source: "cmini", id: "race-up-1", state: "following" },
      kind: "imported",
      name,
      owner: "owner-a",
      modified_at: clock(),
      format: "cmini/1",
      payload: { v: 0 },
      actor: "system:cmini-import",
      via: "import:cmini",
      source: { client: "system:cmini-import", version: null },
    });
    const staleRev = record.rev; // what a system writer read BEFORE the user's write below landed

    // The user's write lands first (rev 1 -> 2), forking the record.
    const userWrite = await appendWrite(db, clock, {
      upstream: { source: "cmini", id: "race-up-1", state: "forked" },
      kind: "updated",
      layoutId: record.id,
      name,
      owner: "owner-a",
      modified_at: clock(),
      format: "cmini/1",
      payload: { v: "user" },
      actor: "owner-a",
      via: "discord",
      source: { client: "discord-app:test", version: null },
    });
    expect(userWrite.record.rev).toBe(2);

    // The system writer's own re-read, built from the STALE `staleRev`,
    // must be refused before it ever lands -- not silently accepted at a
    // NEW target rev (which is exactly what would happen without
    // `expectRev`: `appendWrite` always re-reads `current` fresh and just
    // advances one past whatever it finds).
    await expect(
      appendWrite(db, clock, {
        upstream: { source: "cmini", id: "race-up-1", state: "following" },
        kind: "imported",
        layoutId: record.id,
        name,
        owner: "owner-a",
        modified_at: clock(),
        format: "cmini/1",
        payload: { v: "stale-system-write" },
        actor: "system:cmini-import",
        via: "import:cmini",
        source: { client: "system:cmini-import", version: null },
        expectRev: staleRev,
      }),
    ).rejects.toThrow(RevConflictError);

    const finalRec = await readById(db, record.id);
    expect(finalRec!.rev).toBe(2); // unchanged by the rejected system write
    expect(finalRec!.payload).toEqual({ v: "user" }); // the user's edit, never clobbered
    expect(finalRec!.upstream).toEqual({ source: "cmini", id: "race-up-1", state: "forked" }); // stays forked
  });

  it("[LDB-P14] a system write whose expectRev IS current commits normally", async () => {
    const name = `race-ok-${unique()}`;
    const { record } = await appendWrite(db, clock, {
      upstream: { source: "cmini", id: "race-up-2", state: "following" },
      kind: "imported",
      name,
      owner: "owner-a",
      modified_at: clock(),
      format: "cmini/1",
      payload: { v: 0 },
      actor: "system:cmini-import",
      via: "import:cmini",
      source: { client: "system:cmini-import", version: null },
    });
    const { record: updated } = await appendWrite(db, clock, {
      upstream: { source: "cmini", id: "race-up-2", state: "following" },
      kind: "imported",
      layoutId: record.id,
      name,
      owner: "owner-a",
      modified_at: clock(),
      format: "cmini/1",
      payload: { v: 1 },
      actor: "system:cmini-import",
      via: "import:cmini",
      source: { client: "system:cmini-import", version: null },
      expectRev: record.rev,
    });
    expect(updated.rev).toBe(2);
    expect(updated.payload).toEqual({ v: 1 });
  });

  // [LDB-P14] property: random interleavings of a system writer's
  // (potentially stale) read/write pair against a burst of user writes.
  // Whatever order they land in, a system write only ever succeeds when
  // its `expectRev` is STILL current at the moment it runs; it never
  // clobbers a user write that beat it there, and the record's rev only
  // ever advances by exactly the writes that actually committed.
  it("[LDB-P14] property: a system write commits iff its expectRev is still current when it runs", async () => {
    await fc.assert(
      fc.asyncProperty(fc.integer({ min: 0, max: 5 }), async (userWritesBeforeSystemWrite) => {
        const name = `race-prop-${unique()}`;
        const { record: created } = await appendWrite(db, clock, {
          upstream: { source: "cmini", id: "race-prop-up", state: "following" },
          kind: "imported",
          name,
          owner: "owner-a",
          modified_at: clock(),
          format: "cmini/1",
          payload: { v: 0 },
          actor: "system:cmini-import",
          via: "import:cmini",
          source: { client: "system:cmini-import", version: null },
        });
        const systemReadRev = created.rev; // the system writer's own "read", taken now

        let lastUserPayload: unknown = null;
        let expectedRev = created.rev;
        for (let i = 0; i < userWritesBeforeSystemWrite; i++) {
          const rec = await readById(db, created.id);
          const prior = await upstreamOf(db, rec!);
          const { record: r } = await appendWrite(db, clock, {
            upstream: nextUpstream(prior, "updated", "discord"),
            kind: "updated",
            layoutId: created.id,
            name,
            owner: "owner-a",
            modified_at: clock(),
            format: "cmini/1",
            payload: { v: `user-${i}` },
            actor: "owner-a",
            via: "discord",
            source: { client: "discord-app:test", version: null },
          });
          lastUserPayload = r.payload;
          expectedRev = r.rev;
        }

        const attempt = appendWrite(db, clock, {
          upstream: nextUpstream({ source: "cmini", id: "race-prop-up", state: "following" }, "imported", "import:cmini"),
          kind: "imported",
          layoutId: created.id,
          name,
          owner: "owner-a",
          modified_at: clock(),
          format: "cmini/1",
          payload: { v: "system" },
          actor: "system:cmini-import",
          via: "import:cmini",
          source: { client: "system:cmini-import", version: null },
          expectRev: systemReadRev,
        });

        if (userWritesBeforeSystemWrite === 0) {
          // Nothing moved the rev since the system writer's read -- its
          // write commits normally.
          const { record: sysRecord } = await attempt;
          expect(sysRecord.rev).toBe(expectedRev + 1);
          expect(sysRecord.payload).toEqual({ v: "system" });
        } else {
          // At least one user write landed first -- the system writer's
          // stale expectRev must be refused, and the record must still
          // show the LAST user write, untouched.
          await expect(attempt).rejects.toThrow(RevConflictError);
          const finalRec = await readById(db, created.id);
          expect(finalRec!.rev).toBe(expectedRev);
          expect(finalRec!.payload).toEqual(lastUserPayload);
        }
      }),
      { numRuns: 20 },
    );
  });
});
