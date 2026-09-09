// [LDB-F10] `x` (01-format.md §2's free-form, client-namespaced escape
// hatch) survives validate + identity translation verbatim when it's under
// the 16 KB canonical cap, and is refused with `path: "/x"` when it's over;
// `x.keymaxx` (or any non-`cmini` key) is dropped by `to["cmini/1"]`, only
// `x.cmini` ever crosses that translation (the roundtrip.test.ts fixture
// half of this same invariant runs the akl/1 fixture set, including
// 902-x.json, which this format-agnostic property complements).
import fs from "node:fs";
import path from "node:path";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import * as akl1 from "../../formats/akl/1/index.ts";
import type { Payload } from "../../formats/akl/1/index.ts";

const FIXTURE = path.resolve(import.meta.dirname, "..", "..", "formats", "akl", "1", "fixtures", "902-x.json");

// Minimal always-valid base payload (no magic, ortho board) -- only `x`
// varies across cases.
function basePayload(x?: unknown): Payload {
  return {
    keys: { a: { row: 0, col: 0, finger: "LP" }, b: { row: 0, col: 1, finger: "LR" } },
    board: { kind: "ortho" },
    ...(x !== undefined ? { x: x as Record<string, unknown> } : {}),
  };
}

// A canonical-JSON size estimate matching akl/1/index.ts's own
// `canonicalBytes` closely enough for the property below: sorted keys, no
// whitespace. Not imported (format modules stay self-contained, 07 §5) --
// duplicated the same way index.ts itself duplicates it from
// src/core/canonical.ts, for the same reason.
function canonicalSize(v: unknown): number {
  function stringify(node: unknown): string {
    if (node === undefined) return "null";
    if (node === null || typeof node !== "object") return JSON.stringify(node);
    if (Array.isArray(node)) return "[" + node.map((item) => (item === undefined ? "null" : stringify(item))).join(",") + "]";
    const obj = node as Record<string, unknown>;
    const keys = Object.keys(obj)
      .filter((k) => obj[k] !== undefined)
      .sort();
    return "{" + keys.map((k) => JSON.stringify(k) + ":" + stringify(obj[k])).join(",") + "}";
  }
  return new TextEncoder().encode(stringify(v)).length;
}

describe("x (LDB-F10)", () => {
  it("property: random x <= 16 KB canonical survives validate + identity", () => {
    fc.assert(
      fc.property(fc.dictionary(fc.string({ maxLength: 20 }), fc.jsonValue({ maxDepth: 2 }), { maxKeys: 30 }), (x) => {
        fc.pre(canonicalSize(x) <= 16 * 1024);
        const payload = basePayload(x);
        const result = akl1.validate(payload);
        expect(result.ok).toBe(true);
        // Identity: nothing about `x` is touched by validate(); the same
        // object read back (the registry's identity path, LDB-F3) is
        // byte-for-byte what was written.
        expect(payload.x).toEqual(x);
      }),
      { numRuns: 100 },
    );
  });

  it("[LDB-F10] x over 16 KB canonical is refused with path: \"/x\"", () => {
    const big = { blob: "x".repeat(17 * 1024) };
    expect(canonicalSize(big)).toBeGreaterThan(16 * 1024);
    const result = akl1.validate(basePayload(big));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.path).toBe("/x");
      expect(result.error.error).toBe("invalid_payload");
    }
  });

  it("x exactly at the 16 KB boundary is accepted, one byte over is refused", () => {
    // Binary-search-free: build a string payload, measure its real
    // canonical size, then trim/pad by the exact overage/margin -- avoids
    // hardcoding an off-by-one against canonicalSize's own JSON framing.
    const probe = { blob: "" };
    const overhead = canonicalSize(probe);
    const budget = 16 * 1024 - overhead;
    const atLimit = { blob: "x".repeat(budget) };
    expect(canonicalSize(atLimit)).toBe(16 * 1024);
    expect(akl1.validate(basePayload(atLimit)).ok).toBe(true);

    const overLimit = { blob: "x".repeat(budget + 1) };
    expect(canonicalSize(overLimit)).toBe(16 * 1024 + 1);
    const result = akl1.validate(basePayload(overLimit));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.path).toBe("/x");
  });

  it("[LDB-F10] to[\"cmini/1\"] drops x.keymaxx; only x.cmini would have survived", () => {
    const payload = JSON.parse(fs.readFileSync(FIXTURE, "utf8")) as Payload;
    expect(payload.x).toHaveProperty("keymaxx");
    expect(payload.x?.["cmini"]).toBeUndefined(); // 902-x.json's own point: x.cmini absent

    const cmini = akl1.to["cmini/1"]!(payload);
    expect(cmini).not.toHaveProperty("x");
    expect(cmini).not.toHaveProperty("keymaxx");
    // No cmini idiom for keymaxx and no x.cmini to copy out -- tag/blame/
    // combos/link are all absent too (01 §6.2).
    expect(cmini.tag).toBeUndefined();
    expect(cmini.blame).toBeUndefined();
  });

  it("x.cmini DOES survive to[\"cmini/1\"] as the record-level fields it names", () => {
    const payload = basePayload({ cmini: { tag: "cmini", blame: "dmini" }, keymaxx: { note: "dropped" } });
    const cmini = akl1.to["cmini/1"]!(payload);
    expect(cmini.tag).toBe("cmini");
    expect(cmini.blame).toBe("dmini");
    expect(cmini).not.toHaveProperty("keymaxx");
  });
});
