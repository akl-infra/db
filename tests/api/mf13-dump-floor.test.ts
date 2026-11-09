// [MF-13 = LDB-D7] design/layout-db/21-formats.md §2.1/§4 (restates
// LDB-B10 with two tables): "Every table in a dump is at or past the
// dump's `meta.seq`, so booting from the dump and draining the feed from
// `meta.seq` equals the live state." `buildDump` (src/dump/write.ts)
// enforces this by construction: it reads `meta` FIRST, then every table
// page in one `Promise.all` -- never the reverse, and never concurrently
// with `meta`'s own read -- so nothing a table page carries can predate
// `meta.seq`'s snapshot instant, and anything landing between the two
// reads simply shows up in the tables ALREADY (ahead of the floor,
// never behind it).
//
// Proven here by forcing exactly that race: `readHead()` (the one query
// `computeMeta` awaits before any table page starts) is intercepted so a
// second write lands the instant it resolves, strictly between the
// `meta` read and the `Promise.all` of table pages. The dump's own
// `events`/`layout_formats`/`layouts` rows for that layout are then
// folded (MF-3's own `foldLayout`) and checked against both (a) the
// dump's own `records`/`layout_formats` rows (self-consistency: the
// tables already reflect the injected write) and (b) the live DB state
// after the test (boot-from-dump equals live, with no drain needed at
// all since the injected write's seq is already inside the dump).
import { env, store, testStore } from "../harness";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Bindings } from "../../src/env";
import { commitWrite, foldLayout, rowToEvent, type CommitInput, type Event } from "../../src/core/events";
import { formatsForLayout, readById, rowToLayout, type LayoutDbRow } from "../../src/core/records";
import { fixedClock } from "../../src/core/time";
import { ulid } from "ulidx";
import { buildDumpChecked } from "../../src/dump/write";
import * as etagModule from "../../src/core/etag";

const bindings = env as unknown as Bindings;
const clock = fixedClock("2026-07-19T00:00:00.000Z");
const OWNER = "owner-mf13";

let uniqueCounter = 0;
function uniqueName(prefix: string): string {
  return `${prefix}-${uniqueCounter++}`;
}

async function seed(): Promise<{ id: string; layoutRev: number }> {
  const input: CommitInput = {
    layoutId: ulid(),
    creating: true,
    currentN: 0,
    currentLayout: null,
    currentFormats: new Map(),
    layout: { kind: "created", name: uniqueName("mf13"), owner: OWNER, created_at: clock(), deleted: false },
    format: { kind: "format_added", lineage: "spark", format: "spark/1", payload: { keys: [] }, hasMagic: false },
    modified_at: clock(),
    actor: OWNER,
    via: "discord",
    source: { client: "discord-app:test", version: null },
    upstream: null,
  };
  const { layout } = await commitWrite(store, clock, input);
  return { id: layout.id, layoutRev: layout.layout_rev };
}

async function headSeqNow(): Promise<number> {
  const events = await testStore.rows<{ seq: number }>("events");
  return Math.max(0, ...events.map((e) => e.seq));
}

async function revsMapFor(layoutId: string): Promise<Map<string, { format: string | null; payload: unknown }>> {
  const results = await testStore.rows<{ lineage: string | null; rev: number; format: string | null; payload_json: string | null }>("layout_revs", { layout_id: layoutId });
  const out = new Map<string, { format: string | null; payload: unknown }>();
  for (const r of results) {
    out.set(`${r.lineage ?? ""} ${r.rev}`, { format: r.format, payload: r.payload_json === null ? undefined : (JSON.parse(r.payload_json) as unknown) });
  }
  return out;
}

describe("[MF-13 = LDB-D7] the dump floor: tables are never behind meta.seq", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("[MF-13] [LDB-D7] a rename injected between readHead() and the table pages is caught and the dump is re-read: floor and tables agree at the new head", async () => {
    const seeded = await seed();
    const seqBeforeInjection = await headSeqNow();

    const originalReadHead = etagModule.readHead;
    let seqAfterInjection: number | null = null;
    let injected = false;
    const spy = vi.spyOn(etagModule, "readHead").mockImplementation(async (...args: Parameters<typeof originalReadHead>) => {
      const head = await originalReadHead(...args);
      if (injected) return head; // only the first attempt is disturbed
      injected = true;
      // Land a write the instant `computeMeta`'s one query resolves --
      // strictly between `meta`'s read and the table pages' own reads
      // (buildDump's `Promise.all` hasn't started yet).
      const current = await readById(store, seeded.id);
      const currentFormats = await formatsForLayout(store, seeded.id);
      const renameInput: CommitInput = {
        layoutId: seeded.id,
        creating: false,
        currentN: current!.n,
        currentLayout: current,
        currentFormats,
        layout: { kind: "renamed", name: uniqueName("mf13-renamed"), owner: OWNER, created_at: current!.created_at, deleted: false },
        modified_at: clock(),
        actor: OWNER,
        via: "discord",
        source: { client: "discord-app:test", version: null },
        upstream: null,
      };
      await commitWrite(store, clock, renameInput);
      seqAfterInjection = await headSeqNow();
      return head; // the head captured BEFORE the injected write -- meta.seq stays at the old floor
    });

    // [LDB-ST2] The disturbed first read is detected (headSeq moved past the stale meta.seq) and the dump is read again, so the
    // floor it reports is now the NEW head and the tables are exactly at it: not behind (MF-13) and, since the validate-and-retry,
    // not ahead either.
    const built = await buildDumpChecked(bindings, clock);
    const dump = built.dump;
    spy.mockRestore();
    expect(built.attempts).toBe(2);
    expect(built.settled).toBe(true);

    expect(seqAfterInjection).not.toBeNull();
    expect(seqAfterInjection!).toBeGreaterThan(seqBeforeInjection);
    // The race really happened (the first read's floor was the old seq); the dump that came back is the second read.
    expect(dump.meta.seq).toBe(seqAfterInjection);
    expect(dump.meta.seq).toBeGreaterThan(seqBeforeInjection);

    const layoutEvents: Event[] = dump.events.filter((e) => e.layout_id === seeded.id).map(rowToEvent);
    expect(layoutEvents.length).toBe(3); // created, format_added, renamed
    expect(Math.max(...layoutEvents.map((e) => e.seq))).toBe(seqAfterInjection);

    const revs = new Map<string, { format: string | null; payload: unknown }>();
    for (const r of dump.layout_revs.filter((r) => r.layout_id === seeded.id)) {
      revs.set(`${r.lineage ?? ""} ${r.rev}`, { format: r.format, payload: r.payload_json === null ? undefined : (JSON.parse(r.payload_json) as unknown) });
    }
    const folded = foldLayout(layoutEvents, revs);
    expect(folded).not.toBeNull();

    // (a) self-consistency: the dump's OWN `records`/`layout_formats` rows
    // already match a fold of the dump's OWN `events` -- the injected
    // write isn't a floating loose end the tables forgot.
    const dumpRecordRow = dump.records.find((r) => r.id === seeded.id);
    expect(dumpRecordRow).toBeDefined();
    const { n: _n, ...dumpLayoutSansN } = rowToLayout(dumpRecordRow!);
    expect(folded!.layout).toEqual(dumpLayoutSansN);

    // (b) boot-from-dump equals live: the same fold matches the ACTUAL
    // live `layouts` row after the test, with no drain step needed at all
    // (the injected write is already inside the dump's own tables).
    const liveRow = (await testStore.row("layouts", { id: seeded.id })) as unknown as LayoutDbRow | null;
    const { n: _n2, ...liveSansN } = rowToLayout(liveRow!);
    expect(folded!.layout).toEqual(liveSansN);
  });
});
