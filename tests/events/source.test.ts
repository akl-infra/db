// [LDB-P15] `source` against real D1: the replay/fold property shared
// with P11 ("the record's source equals its latest rev-bumping event's"),
// that `appendInfo`/`appendLike` carry their own actor's source on the
// EVENT but never move `layouts.source_client`/`source_version` (mirrors
// how they never move `upstream`/`rev` either), and `sourceOfEvent`'s
// `legacy:<via>` fallback for a pre-0005-shaped event row.
// `tests/api/source-matrix.test.ts` covers the lane x verb x
// version-header matrix and the spoof matrix over real HTTP; this file is
// what actually touches `events`/`layouts` directly.
import { env } from "cloudflare:test";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import type { Bindings } from "../../src/env";
import { appendInfo, appendLike, appendWrite, sourceOfEvent } from "../../src/core/events";
import { readById, type Source } from "../../src/core/records";
import { fixedClock } from "../../src/core/time";

const db = (env as unknown as Bindings).DB;
const clock = fixedClock("2026-09-10T00:00:00.000Z");

let uniqueCounter = 0;
function unique(): string {
  return `srcfold-${uniqueCounter++}`;
}

async function eventSourceCols(layoutId: string): Promise<{ source_client: string | null; source_version: string | null; via: string }[]> {
  const { results } = await db
    .prepare("SELECT source_client, source_version, via FROM events WHERE layout_id = ? ORDER BY seq ASC")
    .bind(layoutId)
    .all<{ source_client: string | null; source_version: string | null; via: string }>();
  return results;
}

describe("[LDB-P15] source is a fold", () => {
  it("[LDB-P15] the row's `source` equals the latest rev-bumping event's after.source, through several writes", async () => {
    const name = unique();
    const first: Source = { client: "discord-app:app-1", version: "1.0.0" };
    const created = await appendWrite(db, clock, {
      upstream: null,
      kind: "created",
      name,
      owner: "owner-a",
      modified_at: clock(),
      format: "spark/1",
      payload: { v: 1 },
      actor: "owner-a",
      via: "discord",
      source: first,
    });
    expect(created.record.source).toEqual(first);
    let rec = await readById(db, created.record.id);
    expect(rec!.source).toEqual(first);

    const second: Source = { client: "client:some-bot", version: null };
    const updated = await appendWrite(db, clock, {
      upstream: null,
      kind: "updated",
      layoutId: rec!.id,
      name,
      owner: "owner-a",
      modified_at: clock(),
      format: "spark/1",
      payload: { v: 2 },
      actor: "owner-a",
      via: "client:some-bot",
      source: second,
    });
    expect(updated.record.source).toEqual(second);
    rec = await readById(db, updated.record.id);
    expect(rec!.source).toEqual(second);

    const third: Source = { client: "discord-app:app-2", version: "2.0.0-rc" };
    const updated2 = await appendWrite(db, clock, {
      upstream: null,
      kind: "updated",
      layoutId: rec!.id,
      name,
      owner: "owner-b",
      modified_at: clock(),
      format: "spark/1",
      payload: { v: 3 },
      actor: "owner-b",
      via: "discord",
      source: third,
    });
    expect(updated2.record.source).toEqual(third);
    rec = await readById(db, updated2.record.id);
    expect(rec!.source).toEqual(third);
  });

  it("[LDB-P15] appendInfo/appendLike carry their own actor's source on the EVENT but never move layouts.source_client/source_version", async () => {
    const name = unique();
    const createdSource: Source = { client: "discord-app:app-1", version: "1.0.0" };
    const { record } = await appendWrite(db, clock, {
      upstream: null,
      kind: "created",
      name,
      owner: "owner-a",
      modified_at: clock(),
      format: "spark/1",
      payload: { v: 1 },
      actor: "owner-a",
      via: "discord",
      source: createdSource,
    });

    const infoSource: Source = { client: "system:cmini-import", version: null };
    await appendInfo(db, clock, { kind: "upstream_changed", layoutId: record.id, actor: "system:cmini-import", via: "import:cmini", source: infoSource });

    const likeSource: Source = { client: "discord-app:app-3", version: "3.0.0" };
    await appendLike(db, clock, { kind: "liked", layoutId: record.id, userId: "liker-1", via: "discord", source: likeSource });

    // The record's own fold is UNCHANGED by either -- still the create's.
    const rec = await readById(db, record.id);
    expect(rec!.source).toEqual(createdSource);

    // But each event carries ITS OWN actor's source, not the record's.
    const rows = await eventSourceCols(record.id);
    expect(rows.map((r) => ({ client: r.source_client, version: r.source_version }))).toEqual([
      { client: createdSource.client, version: createdSource.version },
      { client: infoSource.client, version: infoSource.version },
      { client: likeSource.client, version: likeSource.version },
    ]);
  });

  it("[LDB-P15] a fast-check property: a random sequence of rev-bumping writes always leaves the record's source equal to the LAST write's own", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(
          fc.record({
            client: fc.oneof(fc.constant("discord-app:app-x"), fc.constant("client:bot-y"), fc.constant("system:migration")),
            version: fc.option(fc.string({ minLength: 1, maxLength: 8 }).filter((s) => /^[A-Za-z0-9]+$/.test(s)), { nil: null }),
          }),
          { minLength: 1, maxLength: 6 },
        ),
        async (sources) => {
          const name = unique();
          let layoutId: string | undefined;
          let last: Source | undefined;
          for (const source of sources) {
            const write = await appendWrite(db, clock, {
              upstream: null,
              kind: layoutId === undefined ? "created" : "updated",
              layoutId,
              name,
              owner: "owner-fc",
              modified_at: clock(),
              format: "spark/1",
              payload: { n: Math.random() },
              actor: "owner-fc",
              via: "discord",
              source,
            });
            layoutId = write.record.id;
            last = source;
          }
          const rec = await readById(db, layoutId!);
          expect(rec!.source).toEqual(last);
        },
      ),
      { numRuns: 15 },
    );
  });
});

describe("[LDB-P15] sourceOfEvent: the legacy fallback for a pre-0005-shaped row", () => {
  it("[LDB-P15] source_client === null -> {client: 'legacy:'+via, version: null}, regardless of source_version", () => {
    expect(sourceOfEvent({ source_client: null, source_version: null, via: "import:cmini" })).toEqual({
      client: "legacy:import:cmini",
      version: null,
    });
    // A NULL source_client is the pre-0005 signal on its own -- a stray
    // non-null source_version alongside it (shouldn't happen in practice,
    // `appendWrite` always sets both together) still yields the legacy
    // fallback, never a mixed shape.
    expect(sourceOfEvent({ source_client: null, source_version: "1.0.0", via: "discord" })).toEqual({
      client: "legacy:discord",
      version: null,
    });
  });

  it("[LDB-P15] source_client present -> read verbatim, version included even when null", () => {
    expect(sourceOfEvent({ source_client: "discord-app:1", source_version: "1.0.0", via: "discord" })).toEqual({
      client: "discord-app:1",
      version: "1.0.0",
    });
    expect(sourceOfEvent({ source_client: "system:cmini-import", source_version: null, via: "import:cmini" })).toEqual({
      client: "system:cmini-import",
      version: null,
    });
  });
});
