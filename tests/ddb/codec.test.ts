// [LDB-DDB70] [LDB-DDB71] [LDB-DDB78] The row codec: rows -> items -> rows is the
// identity (canonical, ordered by primary key), and a consistent export of an
// imported store gives the rows back, spilled payloads included.
// Lanes that have not landed their schema are skipped with a reason; the main
// session removes the skips at merge.
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  canonicalString,
  compareValues,
  D1_TABLES,
  dumpToRows,
  exportRows,
  hasPrimaryData,
  importRows,
  itemsToRows,
  rowsToItems,
  scanItems,
  sortRows,
} from "../../src/store/ddb/codec";
import type { D1Row, D1TableName, LaneSchema, RowsByTable } from "../../src/store/ddb/contracts";
import { SCHEMAS } from "../../src/store/ddb/schema";
import { SPILL_BYTES } from "../../src/store/ddb/payload";
import { checkIndexes } from "../../src/store/ddb/checker";
import { withFaults } from "../../src/store/ddb/faults";
import { codecTuning } from "../../src/store/ddb/codec";
import { ddbHarness } from "../harness/ddb";
import { wipeTables } from "../harness/ddb-store";
import seed from "../fixtures/seed-upstream-100.dump.json" with { type: "json" };
import type { Dump } from "../../src/dump/write";

const ctx = { doc: ddbHarness.raw, tables: ddbHarness.tables, blobs: ddbHarness.blobs };

function laneReady(s: LaneSchema): boolean {
  try {
    s.toItems({ [s.tables[0]!]: [] });
    return true;
  } catch (e) {
    return !/not implemented yet/.test((e as Error).message);
  }
}
const ready = SCHEMAS.filter(laneReady);
const readyTables = new Set<D1TableName>(ready.flatMap((s) => [...s.tables]));
const skipReason = (lane: LaneSchema["lane"]) => `lane ${lane} schema not merged yet`;

function only(rows: RowsByTable, tables: Set<D1TableName>): RowsByTable {
  const out: RowsByTable = {};
  for (const t of Object.keys(rows) as D1TableName[]) if (tables.has(t)) out[t] = rows[t];
  return out;
}

const canon = (rows: RowsByTable): string =>
  canonicalString(Object.fromEntries((Object.keys(rows) as D1TableName[]).sort().map((t) => [t, sortRows(t, rows[t] ?? [])])));

function roundTrip(rows: RowsByTable): RowsByTable {
  const back = itemsToRows(rowsToItems(rows));
  return only(back, new Set(Object.keys(rows) as D1TableName[]));
}

const fixture = (): RowsByTable => only(dumpToRows(seed as unknown as Dump), readyTables);

describe("codec: compareValues", () => {
  it("[LDB-DDB70] orders NULL < numbers < text, text by UTF-8 bytes", () => {
    const sorted = ["b", "a", null, 10, 9, "é", "\u{1F600}", "B", "Ａ"].sort(compareValues);
    expect(sorted).toEqual([null, 9, 10, "B", "a", "b", "é", "Ａ", "\u{1F600}"]);
  });
});

// A generator of core-lane (lane G) rows with every column present, like fromItems returns.
const user = fc.constantFrom("100000000000000001", "100000000000000002", "100000000000000003");
const nullableStr = fc.option(fc.string({ maxLength: 8 }), { nil: null });
const iso = fc.integer({ min: 0, max: 40 }).map((n) => `2026-01-${String((n % 28) + 1).padStart(2, "0")}T00:00:${String(n % 60).padStart(2, "0")}.000Z`);

const coreRows: fc.Arbitrary<RowsByTable> = fc
  .record({
    n: fc.integer({ min: 0, max: 6 }),
    names: fc.array(fc.string({ minLength: 1, maxLength: 10 }), { minLength: 6, maxLength: 6 }),
    deleted: fc.array(fc.constantFrom(0, 1), { minLength: 6, maxLength: 6 }),
    lineages: fc.array(fc.subarray(["spark/1", "mana2/1", "akl/1"], { minLength: 0 }), { minLength: 6, maxLength: 6 }),
    likers: fc.array(fc.subarray(["100000000000000001", "100000000000000002", "100000000000000003"]), { minLength: 6, maxLength: 6 }),
    owner: fc.array(user, { minLength: 6, maxLength: 6 }),
    ev: fc.integer({ min: 0, max: 12 }),
    at: iso,
    kinds: fc.array(fc.constantFrom("created", "updated", "liked", "deleted"), { minLength: 12, maxLength: 12 }),
    detail: nullableStr,
    state: fc.array(fc.string({ minLength: 1, maxLength: 6 }), { maxLength: 3 }),
  })
  .map((g) => {
    const rows: Record<string, D1Row[]> = { layouts: [], layout_formats: [], layout_revs: [], likes: [], events: [], import_state: [], import_map: [] };
    for (let i = 0; i < g.n; i++) {
      const id = `LAYOUT${i}`;
      const name = `${g.names[i]!.replace(/[^\x20-\x7e]/g, "x")}-${i}`;
      rows.layouts!.push({
        id, name, owner: g.owner[i], n: i + 1, layout_rev: 1, created_at: g.at, modified_at: g.at, deleted: g.deleted[i],
        like_count: g.likers[i]!.length, like_adjust: 0, link: null, upstream_source: null, upstream_id: null, upstream_state: null,
        source_client: null, source_version: null,
      });
      rows.import_map!.push({ upstream_id: `up${i}`, layout_id: id, upstream_name: g.detail, upstream_modified_at: null });
      for (const [k, lineage] of g.lineages[i]!.entries()) {
        const payload_json = JSON.stringify({ k, text: "x".repeat(k * 10) });
        rows.layout_formats!.push({
          layout_id: id, lineage, format: lineage, rev: k + 1, created_at: g.at, modified_at: g.at, payload_json, has_magic: 0, has_alts: k % 2,
          has_combos: 0, source_client: null, source_version: null,
        });
        rows.layout_revs!.push({ layout_id: id, n: k + 1, lineage, rev: k + 1, event_seq: k + 1, format: lineage, payload_json });
      }
      rows.layout_revs!.push({ layout_id: id, n: 0, lineage: null, rev: 1, event_seq: 1, format: null, payload_json: null });
      for (const u of g.likers[i]!) rows.likes!.push({ layout_id: id, user_id: u, at: g.at, via: "test" });
    }
    for (let s = 1; s <= g.ev; s++) {
      const layout = g.n > 0 && s % 3 !== 0 ? `LAYOUT${s % g.n}` : null;
      rows.events!.push({
        seq: s, at: g.at, kind: g.kinds[s - 1], layout_id: layout, name: layout === null ? null : "n", owner: layout === null ? null : "o", format: null, rev: null,
        actor: `actor${s % 2}`, via: "t", admin: 0, detail_json: g.detail, before_json: null, after_json: null, source_client: null, source_version: null,
      });
    }
    g.state.forEach((k, i) => rows.import_state!.push({ key: `${k}${i}`, value: `v${i}` }));
    return { ...rows, layouts_head: [{ id: 1, live: rows.layouts!.filter((l) => l.deleted === 0).length }] } as RowsByTable;
  });

describe("codec: round trip", () => {
  it.skipIf(!readyTables.has("layouts"))("[LDB-DDB70] core rows survive rows -> items -> rows (property)", () => {
    fc.assert(
      fc.property(coreRows, (rows) => {
        expect(canon(roundTrip(rows))).toBe(canon(rows));
      }),
      { numRuns: 200 },
    );
  });

  it.skipIf(!readyTables.has("layouts"))("[LDB-DDB70] the 100-layout seed dump (every table of every ready lane) round-trips", () => {
    const rows = fixture();
    expect(rows.layouts).toHaveLength(100);
    expect(rows.events).toHaveLength(539);
    expect(canon(roundTrip(rows))).toBe(canon(rows));
  });

  it("[LDB-DDB70] rows come back ordered by primary key, every table present", () => {
    const back = itemsToRows({ main: [], ephemeral: [] });
    expect(Object.keys(back).sort()).toEqual(Object.keys(D1_TABLES).sort());
  });

  it.skipIf(!readyTables.has("layouts"))("[LDB-DDB70] two live layouts whose names fold together are refused, not merged", () => {
    const base = fixture().layouts![0]!;
    const rows: RowsByTable = { layouts: [{ ...base, id: "A", name: "Same", deleted: 0 }, { ...base, id: "B", name: "sAME", deleted: 0 }], layout_formats: [] };
    expect(() => rowsToItems(rows)).toThrow(/two rows imply item/);
    // a tombstone does not claim the name
    expect(() => rowsToItems({ ...rows, layouts: [{ ...rows.layouts![0]!, deleted: 0 }, { ...rows.layouts![1]!, deleted: 1 }] })).not.toThrow();
  });

  it("[LDB-DDB70] a table the codec does not know is an error", () => {
    expect(() => rowsToItems({ nope: [] } as unknown as RowsByTable)).toThrow(/unknown table/);
  });
});

describe("codec: dumpToRows", () => {
  const rows = dumpToRows(seed as unknown as Dump);
  it("[LDB-DDB78] gives restoreSql's rows: head tables as D1's triggers leave them, defaults filled, like_adjust 0", () => {
    const dump = seed as unknown as Dump;
    expect(rows.layouts).toHaveLength(dump.records.length);
    expect(rows.layouts!.every((r) => r.like_adjust === 0)).toBe(true);
    expect(rows.layouts_head).toEqual([{ id: 1, live: dump.records.filter((r) => r.deleted === 0).length }]);
    expect(rows.authors_head).toEqual([{ id: 1, version: dump.meta.authors_version, modified_at: dump.meta.authors_modified_at, count: dump.authors.length }]);
    expect(rows.events).toHaveLength(dump.meta.seq);
    expect(rows.layout_formats!.every((r) => r.has_alts === 0 || r.has_alts === 1)).toBe(true);
    expect(Object.keys(rows.layouts![0]!)).toEqual([...D1_TABLES.layouts.columns]);
    for (const t of ["nonces", "ratelimit", "auth_cache", "idempotency", "modqueue_notifications", "discord_pending_actions"] as const) expect(rows[t]).toBeUndefined();
  });
  it("[LDB-DDB78] a column an old dump lacks takes the column default (likes.via, authors.name_source, wpm review_version)", () => {
    const old = { ...(seed as unknown as Dump), likes: [{ layout_id: "L", user_id: "U", at: "t" }], authors: [{ user_id: "U", name: "n", first_seen_at: "t", last_seen_at: "t" }], wpm_submissions: undefined } as unknown as Dump;
    const r = dumpToRows(old);
    expect(r.likes![0]!.via).toBe("import:cmini");
    expect(r.authors![0]!.name_source).toBe("import");
    expect(r.wpm_submissions).toEqual([]);
  });
});

describe("codec: export and import on DynamoDB Local", () => {
  it.skipIf(!readyTables.has("layouts"))("[LDB-DDB71] importRows then exportRows gives the seed rows back, ordered by primary key", async () => {
    await wipeTables(ctx);
    const rows = fixture();
    await importRows(ctx, rows);
    const back = await exportRows(ctx);
    expect(canon(only(back, new Set(Object.keys(rows) as D1TableName[])))).toBe(canon(rows));
    expect(back.layouts!.map((r) => r.id)).toEqual([...back.layouts!.map((r) => r.id as string)].sort());
    expect((await scanItems(ctx)).main.length).toBeGreaterThan(rows.layouts!.length);
  });

  it.skipIf(!readyTables.has("layouts"))("[LDB-DDB71] import refuses a store that already holds layouts or events", async () => {
    await wipeTables(ctx);
    const rows = fixture();
    await importRows(ctx, rows);
    expect(await hasPrimaryData(ctx)).toBe(true);
    await expect(importRows(ctx, rows)).rejects.toThrow(/empty store/);
    await importRows(ctx, rows, { allowNonEmpty: true }); // explicit, idempotent
    await wipeTables(ctx);
    expect(await hasPrimaryData(ctx)).toBe(false);
  });

  it.skipIf(!readyTables.has("layouts"))("[LDB-DDB71] a payload over the spill limit goes to a blob and comes back inline, byte for byte", async () => {
    await wipeTables(ctx);
    const rows = fixture();
    const big = JSON.stringify({ pad: "é".repeat(SPILL_BYTES) });
    const f = rows.layout_formats![0]!;
    rows.layout_formats![0] = { ...f, payload_json: big };
    const r = rows.layout_revs![0]!;
    rows.layout_revs![0] = { ...r, payload_json: big };
    await importRows(ctx, rows);
    const stored = (await scanItems(ctx)).main;
    expect(JSON.stringify(stored)).not.toContain("éééééééé"); // not inline in any item
    const back = await exportRows(ctx);
    expect(canon(only(back, new Set(Object.keys(rows) as D1TableName[])))).toBe(canon(rows));
    await wipeTables(ctx);
  });

  it.skipIf(!readyTables.has("layouts"))("[LDB-DDB71] import and export ride out injected conflicts, throttles and 5xx (idempotent per chunk), reads included", async () => {
    await wipeTables(ctx);
    const realSleep = codecTuning.sleep;
    codecTuning.sleep = async () => {};
    try {
      const rows = fixture();
      const flaky = { ...ctx, doc: withFaults(ddbHarness.raw, { rate: 0.4, seed: 11, reads: true, tables: ctx.tables }) };
      await importRows(flaky, rows);
      const back = await exportRows(flaky);
      expect(canon(only(back, new Set(Object.keys(rows) as D1TableName[])))).toBe(canon(rows));
      expect(flaky.doc.faultStats().injected.TransactionConflict + flaky.doc.faultStats().injected.Throttling).toBeGreaterThan(0);
      // a persistent failure is not swallowed
      const dead = { ...ctx, doc: withFaults(ddbHarness.raw, { rate: 1, seed: 1 }) };
      await expect(importRows({ ...dead }, rows, { allowNonEmpty: true })).rejects.toThrow();
    } finally {
      codecTuning.sleep = realSleep;
      await wipeTables(ctx);
    }
  });

  it.skipIf(!readyTables.has("layouts"))("[LDB-DDB71] importRows with replace has restoreSql's semantics: what a restore empties is replaced, the rest stays", async () => {
    await wipeTables(ctx);
    const rows = fixture();
    await importRows(ctx, rows);
    const smaller = { ...rows, layouts: rows.layouts!.slice(0, 3), layout_formats: [], layout_revs: [], likes: [], events: [], import_map: [], layouts_head: [{ id: 1, live: 3 }] };
    await expect(importRows(ctx, smaller)).rejects.toThrow(/empty store/);
    await importRows(ctx, smaller, { replace: true });
    const back = await exportRows(ctx);
    expect(back.layouts).toHaveLength(3);
    expect(back.events).toHaveLength(0);
    expect(back.likes).toHaveLength(0);
    expect(back.layouts_head).toEqual([{ id: 1, live: 3 }]);
    expect((await checkIndexes(ctx)).problems).toEqual([]);
    await wipeTables(ctx);
  });

  it("[LDB-DDB71] bookkeeping items (STATE/migrations) are not rows", async () => {
    await wipeTables(ctx);
    await ctx.doc.send(new (await import("@aws-sdk/lib-dynamodb")).PutCommand({ TableName: ctx.tables.main, Item: { pk: "STATE", sk: "migrations", applied: {} } }));
    expect((await scanItems(ctx)).main).toEqual([]);
    expect((await exportRows(ctx)).import_state).toEqual([]);
    await wipeTables(ctx);
  });
});

// ---------------------------------------------------------------------------
// rehost --target ddb (scripts/rehost.mjs), against DynamoDB Local
// ---------------------------------------------------------------------------
// @ts-expect-error -- rehost.mjs is a plain script (no .d.ts), as in tests/tools/rehost-guard.test.ts
import * as rehostModule from "../../scripts/rehost.mjs";
import * as codecLib from "../../src/store/ddb/codec";
import { createDocClient } from "../../src/store/ddb/client";
import { createTables, deleteTables } from "../../src/store/ddb/tables";
import { runMigrations } from "../../src/store/ddb/migrate";

const rehost = rehostModule as {
  checkDdbWipeFlag(populated: boolean, force: boolean, wipe: string | null, main: string): string | null;
  checkDdbSeqLoss(populated: boolean, stored: number, dumpSeq: number, acceptLoss: boolean): string | null;
  rehostIntoDdb(opts: Record<string, unknown>, lib: Record<string, unknown>): Promise<{ layout_count: number; author_count: number; seq: number; migrations_ran: string[] }>;
  loadDdbLib(): Promise<Record<string, unknown>>;
  fsBlobs(dir: string): { get(k: string): Promise<unknown>; put(k: string, b: string): Promise<void> };
  RehostRefusal: new (m: string) => Error;
};

describe("rehost --target ddb", () => {
  const endpoint = process.env.AKLDB_DDB_ENDPOINT ?? `http://127.0.0.1:${process.env.AKLDB_DDB_PORT ?? 18307}`;
  // The seed dump cut down to its first 12 layouts (everything that hangs off them), so each restore is quick.
  const dump = ((): Dump => {
    const d = seed as unknown as Dump;
    const ids = new Set(d.records.slice(0, 12).map((r) => r.id));
    const events = d.events.filter((e) => e.layout_id === null || ids.has(e.layout_id));
    return {
      ...d,
      records: d.records.filter((r) => ids.has(r.id)),
      layout_formats: d.layout_formats.filter((r) => ids.has(r.layout_id)),
      layout_revs: d.layout_revs.filter((r) => ids.has(r.layout_id)),
      likes: d.likes.filter((r) => ids.has(r.layout_id)),
      import_map: d.import_map.filter((r) => ids.has(r.layout_id)),
      events,
      meta: { ...d.meta, seq: events.reduce((m, e) => Math.max(m, e.seq), 0) },
    };
  })();
  // Lanes that have not landed cannot import their tables yet: restrict the rows to the ready ones.
  const lib = {
    createDocClient, createTables, deleteTables, importRows, hasPrimaryData, exportRows, runMigrations,
    storedSeq: codecLib.storedSeq,
    dumpToRows: (d: Dump) => only(dumpToRows(d), readyTables),
  };
  const opts = (over: Record<string, unknown> = {}) => ({ endpoint, mainTable: ctx.tables.main, ephemeralTable: ctx.tables.ephemeral, blobs: ctx.blobs, dump, ...over });

  it("[LDB-DDB77] the two guards: a populated store needs --force and the literal --wipe; a store ahead of the dump needs --accept-loss", () => {
    expect(rehost.checkDdbWipeFlag(false, false, null, "m")).toBeNull();
    expect(rehost.checkDdbWipeFlag(true, false, null, "m")).toMatch(/already holds/);
    expect(rehost.checkDdbWipeFlag(true, true, null, "m")).toMatch(/--wipe=m/);
    expect(rehost.checkDdbWipeFlag(true, true, "other", "m")).toMatch(/--wipe=m/);
    expect(rehost.checkDdbWipeFlag(true, true, "m", "m")).toBeNull();
    expect(rehost.checkDdbSeqLoss(false, 99, 1, false)).toBeNull();
    expect(rehost.checkDdbSeqLoss(true, 5, 5, false)).toBeNull();
    expect(rehost.checkDdbSeqLoss(true, 6, 5, false)).toMatch(/lose 1 event/);
    expect(rehost.checkDdbSeqLoss(true, 6, 5, true)).toBeNull();
  });

  it.skipIf(!readyTables.has("layouts"))("[LDB-DDB77] restores the seed dump into an empty store, runs migrations, and refuses a second run without --force --wipe", async () => {
    await wipeTables(ctx);
    const summary = await rehost.rehostIntoDdb(opts(), lib);
    expect(summary).toMatchObject({ layout_count: dump.records.filter((r) => r.deleted === 0).length, seq: dump.meta.seq });
    expect(summary.migrations_ran.length).toBeGreaterThan(0);
    await expect(rehost.rehostIntoDdb(opts(), lib)).rejects.toThrow(/already holds/);
    await expect(rehost.rehostIntoDdb(opts({ force: true }), lib)).rejects.toThrow(/--wipe=/);
    await expect(rehost.rehostIntoDdb(opts({ force: true, wipe: "wrong" }), lib)).rejects.toThrow(/--wipe=/);
  });

  it.skipIf(!readyTables.has("layouts"))("[LDB-DDB77] a forced restore over a store that is ahead of the dump loses history only with --accept-loss, and then replaces the store", async () => {
    const older = { ...dump, meta: { ...dump.meta, seq: dump.meta.seq - 10 } } as Dump;
    await expect(rehost.rehostIntoDdb(opts({ dump: older, force: true, wipe: ctx.tables.main }), lib)).rejects.toThrow(/lose 10 event/);
    expect((await exportRows(ctx)).events).toHaveLength(dump.events.length); // refused: nothing was touched
    const again = await rehost.rehostIntoDdb(opts({ force: true, wipe: ctx.tables.main }), lib); // same seq: allowed
    expect(again.seq).toBe(dump.meta.seq);
    await rehost.rehostIntoDdb(opts({ dump: older, force: true, wipe: ctx.tables.main, acceptLoss: true }), lib);
    expect(canon(only(await exportRows(ctx), new Set(Object.keys(lib.dumpToRows(dump)) as D1TableName[])))).toBe(canon(lib.dumpToRows(dump)));
    await wipeTables(ctx);
  });

  it("[LDB-DDB77] the CLI bundles the codec for plain Node (esbuild) and the filesystem blob store round-trips", async () => {
    const built = await rehost.loadDdbLib();
    for (const name of ["createDocClient", "createTables", "dumpToRows", "importRows", "hasPrimaryData", "exportRows", "storedSeq", "runMigrations"]) {
      expect(typeof built[name], name).toBe("function");
    }
    const os = await import("node:os");
    const fs = await import("node:fs");
    const dir = fs.mkdtempSync(`${os.tmpdir()}/rehost-blobs-`);
    const store = rehost.fsBlobs(dir);
    expect(await store.get("payloads/abc")).toBeNull();
    await store.put("payloads/abc", '{"x":1}');
    const got = (await store.get("payloads/abc")) as { body: ReadableStream<Uint8Array> };
    expect(await new Response(got.body).text()).toBe('{"x":1}');
    fs.rmSync(dir, { recursive: true });
  });
});
