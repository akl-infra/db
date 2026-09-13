// [LDB-F11] Every live upstream detail (the frozen 100-layout snapshot)
// validates as cmini/1, and `hasMagic` agrees with upstream's own
// `has_magic` flag from the list. This is the format's envelope check: the
// measured facts in 07 §0.1 are exactly what this snapshot contains, so a
// green run here is "the schema really does hold what cmini holds".
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import * as cmini1 from "../../formats/adapters/cmini/index";
import { fromCmini } from "../../formats/adapters/cmini/translate";
import * as spark from "../../formats/spark/1/index";

const SNAPSHOT_DIR = path.resolve(import.meta.dirname, "..", "fixtures", "upstream-100");

interface UpstreamListEntry {
  id: string;
  name: string;
  has_magic?: boolean;
}

interface UpstreamDetail {
  name: string;
  user: string;
  likes?: string[];
  created_at: string;
  modified_at: string;
  [k: string]: unknown;
}

const RECORD_FIELDS = new Set(["name", "user", "likes", "created_at", "modified_at"]);

function payloadFrom(detail: UpstreamDetail): unknown {
  const payload: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(detail)) {
    if (!RECORD_FIELDS.has(k)) payload[k] = v;
  }
  return payload;
}

describe("cmini/1 envelope over the live snapshot", () => {
  const list: UpstreamListEntry[] = JSON.parse(fs.readFileSync(path.join(SNAPSHOT_DIR, "list.json"), "utf8")).layouts;
  const full: UpstreamDetail[] = JSON.parse(fs.readFileSync(path.join(SNAPSHOT_DIR, "full.json"), "utf8")).layouts;
  const listByName = new Map(list.map((l) => [l.name, l]));

  it("the snapshot is non-empty", () => {
    expect(full.length).toBeGreaterThan(0);
  });

  for (const detail of full) {
    const listEntry = listByName.get(detail.name);

    it(`[LDB-F11] '${detail.name}': validates as cmini/1`, () => {
      const payload = payloadFrom(detail);
      const result = cmini1.validate(payload);
      expect(result.ok).toBe(true);
    });

    it(`[LDB-F11] '${detail.name}': hasMagic matches upstream's has_magic`, () => {
      expect(listEntry).toBeDefined();
      const payload = payloadFrom(detail) as cmini1.Payload;
      expect(cmini1.hasMagic(payload)).toBe(Boolean(listEntry?.has_magic));
    });

    // 20-spark.md S3b (LDB-I13): "every live upstream detail's `fromCmini`
    // validates as spark" -- the importer and the D12 diff both rely on
    // `fromCmini` never producing a payload their own `parseUpstreamRaw`/
    // `applyNew` would reject; this is the live proof over the frozen
    // snapshot (the daily diff's `invalidUpstream` line is the same
    // invariant's runtime guard against a future upstream detail this
    // snapshot doesn't cover). design/layout-db/23-geometry.md §4.4-3
    // (LDB-F27) is the ONE known, real exception in this snapshot:
    // 'test12222' has a thumb-labelled key physically on a finger row
    // (0-2) -- `fromCmini` preserves the (row, col, finger) multiset
    // exactly (LDB-F23) rather than inventing a fix, so its projection
    // fails spark/1's OWN (stricter) validate() by design. LDB-I13's own
    // text anticipates exactly this ("a detail that's schema-valid per
    // cmini/1 but fails spark's own semantic validate"): the live daily
    // diff (`tests/upstream-diff.test.ts`) reports it as `invalidUpstream`
    // rather than throwing, and this test asserts that SAME specific
    // failure rather than papering over it as a generic "still valid".
    it(`[LDB-I13] '${detail.name}': fromCmini(payload) validates as spark`, () => {
      const payload = payloadFrom(detail) as cmini1.Payload;
      const sparkPayload = fromCmini(payload);
      const result = spark.validate(sparkPayload);
      if (detail.name === "test12222") {
        expect(result.ok).toBe(false);
        if (!result.ok) expect(result.error.message).toContain("is a thumb -- it can't sit on row");
        return;
      }
      expect(result.ok, !result.ok ? result.error.message : undefined).toBe(true);
    });
  }
});
