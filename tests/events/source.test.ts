// [LDB-P15] `source` against real D1: the replay/fold property shared with
// P11/MF-3 -- restated per-scope (21-formats.md §2.1): `layouts.source_*`
// equals the latest LAYOUT-scope write's source; each `layout_formats`
// row's `source_*` equals the latest write to THAT format's own source. A
// write to one scope never moves the other's `source` (MF-1's independence
// extended to this column). `appendInfo`/`appendLike` carry their own
// actor's source on the EVENT but never move either table's `source_*`.
// `tests/api/source-matrix.test.ts` covers the lane x verb x
// version-header matrix and the spoof matrix over real HTTP; this file is
// what actually touches `events`/`layouts`/`layout_formats` directly.
import { env } from "cloudflare:test";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import type { Bindings } from "../../src/env";
import { appendInfo, appendLike, commitWrite, sourceOfEvent, type CommitInput } from "../../src/core/events";
import { formatsForLayout, readById, type Source } from "../../src/core/records";
import { fixedClock } from "../../src/core/time";
import { ulid } from "ulidx";

const db = (env as unknown as Bindings).DB;
const clock = fixedClock("2026-09-10T00:00:00.000Z");

let uniqueCounter = 0;
function unique(): string {
  return `srcfold-${uniqueCounter++}`;
}

async function eventSourceCols(layoutId: string): Promise<{ source_client: string | null; source_version: string | null; via: string }[]> {
  const { results } = await db.prepare("SELECT source_client, source_version, via FROM events WHERE layout_id = ? ORDER BY seq ASC").bind(layoutId).all<{ source_client: string | null; source_version: string | null; via: string }>();
  return results;
}

function create(name: string, source: Source) {
  const input: CommitInput = {
    layoutId: ulid(),
    creating: true,
    currentN: 0,
    currentLayout: null,
    currentFormats: new Map(),
    layout: { kind: "created", name, owner: "owner-a", created_at: clock(), deleted: false },
    format: { kind: "format_added", lineage: "spark", format: "spark/1", payload: { v: 1 }, hasMagic: false },
    modified_at: clock(),
    actor: "owner-a",
    via: "discord",
    source,
    upstream: null,
  };
  return commitWrite(db, clock, input);
}

async function updateSpark(layoutId: string, source: Source, via: string, owner = "owner-a") {
  const current = await readById(db, layoutId);
  const formats = await formatsForLayout(db, layoutId);
  const input: CommitInput = {
    layoutId,
    creating: false,
    currentN: current!.n,
    currentLayout: current,
    currentFormats: formats,
    format: { kind: "updated", lineage: "spark", format: "spark/1", payload: { v: Math.random() }, hasMagic: false },
    modified_at: clock(),
    actor: owner,
    via,
    source,
    upstream: current!.upstream,
  };
  return commitWrite(db, clock, input);
}

async function rename(layoutId: string, name: string, source: Source, owner = "owner-a") {
  const current = await readById(db, layoutId);
  const formats = await formatsForLayout(db, layoutId);
  const input: CommitInput = {
    layoutId,
    creating: false,
    currentN: current!.n,
    currentLayout: current,
    currentFormats: formats,
    layout: { kind: "renamed", name, owner, created_at: current!.created_at, deleted: false },
    modified_at: clock(),
    actor: owner,
    via: "discord",
    source,
    upstream: current!.upstream,
  };
  return commitWrite(db, clock, input);
}

describe("[LDB-P15] source is a fold, per scope", () => {
  it("[LDB-P15] a create sets BOTH layouts.source and the format's own source to the same write's source", async () => {
    const name = unique();
    const first: Source = { client: "discord-app:app-1", version: "1.0.0" };
    const { layout, formats } = await create(name, first);
    expect(layout.source).toEqual(first);
    expect(formats.get("spark")!.source).toEqual(first);
  });

  it("[LDB-P15] a FORMAT-scope write moves that format's source only -- layouts.source is untouched", async () => {
    const name = unique();
    const first: Source = { client: "discord-app:app-1", version: "1.0.0" };
    const { layout: created } = await create(name, first);

    const second: Source = { client: "client:some-bot", version: null };
    const { layout, formats } = await updateSpark(created.id, second, "client:some-bot");
    expect(formats.get("spark")!.source).toEqual(second);
    expect(layout.source).toEqual(first); // unchanged -- this write never touched the layout scope
  });

  it("[LDB-P15] a LAYOUT-scope write moves layouts.source only -- the format's own source is untouched", async () => {
    const name = unique();
    const first: Source = { client: "discord-app:app-1", version: "1.0.0" };
    const { layout: created } = await create(name, first);

    const third: Source = { client: "discord-app:app-2", version: "2.0.0-rc" };
    const { layout, formats } = await rename(created.id, `${name}-renamed`, third);
    expect(layout.source).toEqual(third);
    expect(formats.get("spark")!.source).toEqual(first); // unchanged
  });

  it("[LDB-P15] appendInfo/appendLike carry their own actor's source on the EVENT but never move layouts.source_client/source_version", async () => {
    const name = unique();
    const createdSource: Source = { client: "discord-app:app-1", version: "1.0.0" };
    const { layout } = await create(name, createdSource);

    const infoSource: Source = { client: "system:cmini-import", version: null };
    await appendInfo(db, clock, { kind: "upstream_changed", layoutId: layout.id, actor: "system:cmini-import", via: "import:cmini", source: infoSource });

    const likeSource: Source = { client: "discord-app:app-3", version: "3.0.0" };
    await appendLike(db, clock, { kind: "liked", layoutId: layout.id, userId: "liker-1", via: "discord", source: likeSource });

    const rec = await readById(db, layout.id);
    expect(rec!.source).toEqual(createdSource);

    const rows = await eventSourceCols(layout.id);
    expect(rows.map((r) => ({ client: r.source_client, version: r.source_version }))).toEqual([
      { client: createdSource.client, version: createdSource.version },
      { client: createdSource.client, version: createdSource.version }, // the paired format_added event
      { client: infoSource.client, version: infoSource.version },
      { client: likeSource.client, version: likeSource.version },
    ]);
  });

  it("[LDB-P15] a fast-check property: a random sequence of format-scope writes always leaves that format's source equal to the LAST write's own", async () => {
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
            if (layoutId === undefined) {
              const { layout } = await create(name, source);
              layoutId = layout.id;
            } else {
              await updateSpark(layoutId, source, source.client);
            }
            last = source;
          }
          const formats = await formatsForLayout(db, layoutId!);
          expect(formats.get("spark")!.source).toEqual(last);
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
