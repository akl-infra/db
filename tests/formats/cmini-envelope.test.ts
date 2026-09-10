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
    // snapshot doesn't cover).
    it(`[LDB-I13] '${detail.name}': fromCmini(payload) validates as spark`, () => {
      const payload = payloadFrom(detail) as cmini1.Payload;
      const sparkPayload = fromCmini(payload);
      const result = spark.validate(sparkPayload);
      expect(result.ok, !result.ok ? result.error.message : undefined).toBe(true);
    });
  }
});
