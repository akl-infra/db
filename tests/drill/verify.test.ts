// [LDB-D5] db/scripts/drill-verify.mjs's pure helpers -- the shape it
// expects `GET /v1/layouts/:id` to match (mirroring src/routes/
// layouts.ts's own `{...sansPayload(rec), likes, payload}` response) and
// the per-layout likes grouping it walks the dump with. The HTTP-walking
// half (`checkOne`/`main`) is exercised for real by
// `tests/drill/run-sh.test.ts`'s end-to-end run against a served Worker.
import { describe, expect, it } from "vitest";
// drill-verify.mjs is a plain script (no .d.ts) -- typed locally the same
// way tests/tools/codeowners.test.ts's own `.mjs` import is.
// @ts-expect-error -- see above
import { expectedFromRecord, likesByLayoutFromDump, pool } from "../../scripts/drill-verify.mjs";

describe("[LDB-D5] drill-verify.mjs -- expectedFromRecord", () => {
  it("[LDB-D5] converts a raw dump LayoutDbRow (0/1 booleans, payload_json a string) to the route's response shape", () => {
    const rec = {
      id: "01ARZ3NDEKTSV4RRFFQ69G5FAV",
      name: "test-layout",
      owner: "184412255822020608",
      rev: 2,
      created_at: "2026-01-01T00:00:00.000Z",
      modified_at: "2026-01-02T00:00:00.000Z",
      deleted: 0,
      format: "akl/1",
      payload_json: '{"keys":{"a":1}}',
      like_count: 2,
      has_magic: 1,
      upstream_source: "cmini",
      upstream_id: "test-layout",
      upstream_state: "following",
      source_client: "discord-app:12345",
      source_version: "1.2.3",
    };
    expect(expectedFromRecord(rec, ["u1", "u2"])).toEqual({
      id: "01ARZ3NDEKTSV4RRFFQ69G5FAV",
      name: "test-layout",
      owner: "184412255822020608",
      rev: 2,
      created_at: "2026-01-01T00:00:00.000Z",
      modified_at: "2026-01-02T00:00:00.000Z",
      deleted: false,
      like_count: 2,
      has_magic: true,
      format: "akl/1",
      upstream: { source: "cmini", id: "test-layout", state: "following" },
      source: { client: "discord-app:12345", version: "1.2.3" },
      likes: ["u1", "u2"],
      payload: { keys: { a: 1 } },
    });
  });

  // 20-spark.md S3s (LDB-D1/D5 amended again): a dump written before this
  // slice's migration has no `source_client`/`source_version` keys at all
  // -- same "absent == present-and-NULL" treatment as `upstream_*`.
  it("[LDB-D5] [LDB-P15] a pre-0005 dump row (no source_client key at all) yields source: null", () => {
    const rec = {
      id: "01ARZ3NDEKTSV4RRFFQ69G5FAX",
      name: "old-shape-source",
      owner: "184412255822020608",
      rev: 1,
      created_at: "2026-01-01T00:00:00.000Z",
      modified_at: "2026-01-01T00:00:00.000Z",
      deleted: 0,
      format: "akl/1",
      payload_json: "{}",
      like_count: 0,
      has_magic: 0,
    };
    expect(expectedFromRecord(rec, [])).toMatchObject({ source: null });
  });

  // 20-spark.md S3a (LDB-D1/D5 amended): a dump written before 0005 has no
  // `upstream_*` keys on its raw rows at all -- `expectedFromRecord` must
  // treat that exactly like present-and-NULL, not throw or misreport.
  it("[LDB-D5] [LDB-P11] a pre-0005 dump row (no upstream_* keys at all) yields upstream: null", () => {
    const rec = {
      id: "01ARZ3NDEKTSV4RRFFQ69G5FAX",
      name: "old-shape",
      owner: "184412255822020608",
      rev: 1,
      created_at: "2026-01-01T00:00:00.000Z",
      modified_at: "2026-01-01T00:00:00.000Z",
      deleted: 0,
      format: "akl/1",
      payload_json: "{}",
      like_count: 0,
      has_magic: 0,
    };
    expect(expectedFromRecord(rec, [])).toMatchObject({ upstream: null });
  });

  it("[LDB-D5] a tombstoned record (deleted: 1) round-trips deleted: true, not skipped or special-cased", () => {
    const rec = {
      id: "01ARZ3NDEKTSV4RRFFQ69G5FAW",
      name: "dead-layout",
      owner: "184412255822020608",
      rev: 1,
      created_at: "2026-01-01T00:00:00.000Z",
      modified_at: "2026-01-01T00:00:00.000Z",
      deleted: 1,
      format: "akl/1",
      payload_json: "{}",
      like_count: 0,
      has_magic: 0,
    };
    expect(expectedFromRecord(rec, [])).toMatchObject({ deleted: true, has_magic: false });
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
