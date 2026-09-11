// [LDB-D5] db/scripts/drill-verify.mjs's pure helpers -- the shape it
// expects `GET /v1/layouts/:id?format=F` to match (built from
// `src/core/records.ts`'s own `fullWire()`, imported rather than
// reimplemented) and the per-layout grouping it walks the dump's
// `layout_formats`/`likes` tables with. The HTTP-walking half
// (`checkOne`/`main`) is exercised for real by `tests/drill/run-sh.test.ts`'s
// end-to-end run against a served Worker.
//
// 21-formats.md (several formats per layout): a layout's payload moved off
// `layouts` onto one `layout_formats` row per lineage, so `expectedFromRecord`
// now takes the layout's OWN format rows plus which one is being requested
// (mirroring the live route's `?format=` requirement) instead of reading
// `rec.format`/`rec.payload_json`/`rec.rev` directly off the layout row.
import { describe, expect, it } from "vitest";
// drill-verify.mjs is a plain script (no .d.ts) -- typed locally the same
// way tests/tools/codeowners.test.ts's own `.mjs` import is.
// @ts-expect-error -- see above
import { expectedFromRecord, formatsByLayoutFromDump, likesByLayoutFromDump, pool } from "../../scripts/drill-verify.mjs";

const LAYOUT_BASE = {
  id: "01ARZ3NDEKTSV4RRFFQ69G5FAV",
  name: "test-layout",
  owner: "184412255822020608",
  n: 2,
  layout_rev: 1,
  created_at: "2026-01-01T00:00:00.000Z",
  modified_at: "2026-01-02T00:00:00.000Z",
  deleted: 0,
  like_count: 2,
};

const FORMAT_ROW = {
  layout_id: "01ARZ3NDEKTSV4RRFFQ69G5FAV",
  lineage: "spark",
  format: "spark/1",
  rev: 2,
  created_at: "2026-01-01T00:00:00.000Z",
  modified_at: "2026-01-02T00:00:00.000Z",
  payload_json: '{"keys":{"a":1}}',
  has_magic: 1,
  source_client: "discord-app:12345",
  source_version: "1.2.3",
};

describe("[LDB-D5] drill-verify.mjs -- expectedFromRecord", () => {
  it("[LDB-D5] converts a raw dump LayoutDbRow + its own FormatDbRow rows to the route's ?format= response shape", () => {
    const rec = {
      ...LAYOUT_BASE,
      upstream_source: "cmini",
      upstream_id: "test-layout",
      upstream_state: "following",
      source_client: "discord-app:99999", // layout-scope source: independent of the format row's own
      source_version: "9.9.9",
    };
    expect(expectedFromRecord(rec, [FORMAT_ROW], "spark/1", ["u1", "u2"])).toEqual({
      id: "01ARZ3NDEKTSV4RRFFQ69G5FAV",
      name: "test-layout",
      owner: "184412255822020608",
      layout_rev: 1,
      created_at: "2026-01-01T00:00:00.000Z",
      modified_at: "2026-01-02T00:00:00.000Z",
      deleted: false,
      like_count: 2,
      upstream: { source: "cmini", id: "test-layout", state: "following" },
      formats: {
        "spark/1": {
          rev: 2,
          created_at: "2026-01-01T00:00:00.000Z",
          modified_at: "2026-01-02T00:00:00.000Z",
          has_magic: true,
          source: { client: "discord-app:12345", version: "1.2.3" },
        },
      },
      format: "spark/1",
      payload: { keys: { a: 1 } },
      likes: ["u1", "u2"],
    });
  });

  it("[LDB-D5] a layout with SEVERAL stored formats: each is requested and reported independently, the others still listed under 'formats'", () => {
    const rec = { ...LAYOUT_BASE };
    const second = { ...FORMAT_ROW, lineage: "t", format: "t/1", rev: 1, payload_json: '{"v":1,"a":9}', has_magic: 0 };
    const expected = expectedFromRecord(rec, [FORMAT_ROW, second], "t/1", []);
    expect(expected.format).toBe("t/1");
    expect(expected.payload).toEqual({ v: 1, a: 9 });
    expect(Object.keys(expected.formats).sort()).toEqual(["spark/1", "t/1"]);
  });

  it("[LDB-D5] requesting a format the layout doesn't have throws (a drill bug, never a silent pass)", () => {
    const rec = { ...LAYOUT_BASE };
    expect(() => expectedFromRecord(rec, [FORMAT_ROW], "mana2/1", [])).toThrow();
  });

  // 20-spark.md S3s (LDB-D1/D5 amended again): a dump written before this
  // slice's migration has no `source_client`/`source_version` keys at all
  // -- same "absent == present-and-NULL" treatment as `upstream_*`. Format
  // rows always postdate F2's own migration, so only the LAYOUT row's
  // source is exercised here.
  it("[LDB-D5] [LDB-P15] a pre-0005 layout row (no source_client key at all) is unaffected -- layout-level source isn't part of the wire at all, only each format's own", () => {
    const rec = { ...LAYOUT_BASE, id: "01ARZ3NDEKTSV4RRFFQ69G5FAX", name: "old-shape-source" };
    const fmt = { ...FORMAT_ROW, layout_id: rec.id, source_client: null, source_version: null };
    expect(expectedFromRecord(rec, [fmt], "spark/1", []).formats["spark/1"]).toMatchObject({ source: null });
  });

  // 20-spark.md S3a (LDB-D1/D5 amended): a dump written before 0005 has no
  // `upstream_*` keys on its raw layout row at all -- `expectedFromRecord`
  // must treat that exactly like present-and-NULL, not throw or misreport.
  it("[LDB-D5] [LDB-P11] a pre-0005 dump row (no upstream_* keys at all) yields upstream: null", () => {
    const rec = { ...LAYOUT_BASE, id: "01ARZ3NDEKTSV4RRFFQ69G5FAX", name: "old-shape" };
    const fmt = { ...FORMAT_ROW, layout_id: rec.id };
    expect(expectedFromRecord(rec, [fmt], "spark/1", [])).toMatchObject({ upstream: null });
  });

  it("[LDB-D5] a tombstoned record (deleted: 1) round-trips deleted: true, not skipped or special-cased", () => {
    const rec = { ...LAYOUT_BASE, id: "01ARZ3NDEKTSV4RRFFQ69G5FAW", name: "dead-layout", deleted: 1 };
    const fmt = { ...FORMAT_ROW, layout_id: rec.id, has_magic: 0 };
    expect(expectedFromRecord(rec, [fmt], "spark/1", [])).toMatchObject({ deleted: true });
    expect(expectedFromRecord(rec, [fmt], "spark/1", []).formats["spark/1"]).toMatchObject({ has_magic: false });
  });
});

describe("[LDB-D5] drill-verify.mjs -- likesByLayoutFromDump", () => {
  it("[LDB-D5] groups by layout_id, preserving dump order (already user_id-ascending per src/dump/write.ts's pager)", () => {
    const map = likesByLayoutFromDump([
      { layout_id: "L1", user_id: "u1", at: "t" },
      { layout_id: "L1", user_id: "u2", at: "t" },
      { layout_id: "L2", user_id: "u3", at: "t" },
    ]);
    expect(map.get("L1")).toEqual(["u1", "u2"]);
    expect(map.get("L2")).toEqual(["u3"]);
    expect(map.get("L3")).toBeUndefined();
  });

  it("[LDB-D5] an empty likes table produces an empty map", () => {
    expect(likesByLayoutFromDump([]).size).toBe(0);
  });
});

describe("[LDB-D5] drill-verify.mjs -- formatsByLayoutFromDump", () => {
  it("[LDB-D5] groups layout_formats rows by layout_id", () => {
    const map = formatsByLayoutFromDump([
      { layout_id: "L1", lineage: "spark", format: "spark/1" },
      { layout_id: "L1", lineage: "t", format: "t/1" },
      { layout_id: "L2", lineage: "spark", format: "spark/1" },
    ]);
    expect(map.get("L1")).toHaveLength(2);
    expect(map.get("L2")).toHaveLength(1);
    expect(map.get("L3")).toBeUndefined();
  });

  it("[LDB-D5] an empty layout_formats table produces an empty map", () => {
    expect(formatsByLayoutFromDump([]).size).toBe(0);
  });
});

describe("[LDB-D5] drill-verify.mjs -- pool (bounded concurrency)", () => {
  it("[LDB-D5] visits every item exactly once and preserves result order regardless of completion order", async () => {
    const items = [50, 10, 30, 5, 40];
    const results = await pool(items, 2, async (n: number) => {
      await new Promise((r) => setTimeout(r, n));
      return n * 2;
    });
    expect(results).toEqual([100, 20, 60, 10, 80]);
  });

  it("[LDB-D5] never runs more than `limit` callbacks concurrently", async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    const items = Array.from({ length: 20 }, (_, i) => i);
    await pool(items, 4, async (n: number) => {
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((r) => setTimeout(r, 5));
      inFlight--;
      return n;
    });
    expect(maxInFlight).toBeLessThanOrEqual(4);
  });

  it("[LDB-D5] handles an empty item list", async () => {
    expect(await pool([], 4, async (n: number) => n)).toEqual([]);
  });
});
