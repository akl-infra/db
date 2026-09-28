// [LDB-I28] docs/decisions/23-geometry.md §4.6a: `relabelMagicThumbKeys`,
// the pure rule the one-off admin pass (`POST /v1/admin/relabel-magic-
// thumbs`, exercised end to end in tests/api/admin.test.ts) applies over
// an already-stored spark/1 `keys` array. Node project (no D1 needed) --
// same split as canonical.test.ts's own.
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { relabelMagicThumbKeys } from "../../src/core/relabelMagicThumbs";
import type { Key } from "../../formats/spark/1/geometry";

describe("[LDB-I28] relabelMagicThumbKeys", () => {
  it("[LDB-I28] `@` at row 3 col 6 (>= 5) relabels LP -> RT; magikarp's own shape (both `@` and `*`) relabels both", () => {
    const keys: Key[] = [
      { char: "a", row: 0, col: 0, finger: "LP" },
      { char: "@", row: 3, col: 6, finger: "LP" },
    ];
    const { keys: out, relabeled } = relabelMagicThumbKeys(keys);
    expect(out.find((k) => k.char === "@")).toEqual({ char: "@", row: 3, col: 6, finger: "RT" });
    expect(out.find((k) => k.char === "a")).toBe(keys[0]); // untouched entry is the SAME object (order-preserving, no needless copy)
    expect(relabeled).toEqual([{ key: "@", row: 3, col: 6, from: "LP", to: "RT" }]);

    const magikarp: Key[] = [
      { char: "*", row: 3, col: 6, finger: "LP" },
      { char: "@", row: 3, col: 7, finger: "RP" },
    ];
    const magikarpResult = relabelMagicThumbKeys(magikarp);
    expect(magikarpResult.keys.find((k) => k.char === "*")!.finger).toBe("RT");
    expect(magikarpResult.keys.find((k) => k.char === "@")!.finger).toBe("RT");
    expect(magikarpResult.relabeled).toEqual([
      { key: "*", row: 3, col: 6, from: "LP", to: "RT" },
      { key: "@", row: 3, col: 7, from: "RP", to: "RT" },
    ]);
  });

  it("[LDB-I28] col < 5 relabels to LT, col >= 5 relabels to RT -- both sides of the column boundary", () => {
    const keys: Key[] = [
      { char: "@", row: 3, col: 3, finger: "RP" },
      { char: "*", row: 4, col: 6, finger: "LP" },
    ];
    const { keys: out, relabeled } = relabelMagicThumbKeys(keys);
    expect(out.find((k) => k.char === "@")!.finger).toBe("LT");
    expect(out.find((k) => k.char === "*")!.finger).toBe("RT");
    expect(relabeled).toEqual([
      { key: "@", row: 3, col: 3, from: "RP", to: "LT" },
      { key: "*", row: 4, col: 6, from: "LP", to: "RT" },
    ]);
  });

  it("[LDB-I28] rows 0-2 (the alpha block, #398) are never touched even for a magic char with a non-thumb finger", () => {
    const keys: Key[] = [{ char: "@", row: 2, col: 6, finger: "RP" }];
    const { keys: out, relabeled } = relabelMagicThumbKeys(keys);
    expect(out).toEqual(keys);
    expect(out[0]).toBe(keys[0]);
    expect(relabeled).toEqual([]);
  });

  it("[LDB-I28] a genuine extra finger row is untouched -- keyed off the CHAR, never the row alone (horifreq's digit row, scuare-style, whirl-30's `k`)", () => {
    const keys: Key[] = [
      { char: "2", row: 3, col: 0, finger: "LP" },
      { char: "8", row: 3, col: 6, finger: "RP" },
      { char: "k", row: 4, col: 1, finger: "LP" },
    ];
    const { keys: out, relabeled } = relabelMagicThumbKeys(keys);
    expect(out).toEqual(keys);
    expect(relabeled).toEqual([]);
  });

  it("[LDB-I28] a `free` position (no char) can never match, by construction", () => {
    const keys: Key[] = [{ row: 3, col: 6, finger: "LP" } as Key];
    const { keys: out, relabeled } = relabelMagicThumbKeys(keys);
    expect(out).toEqual(keys);
    expect(relabeled).toEqual([]);
  });

  it("[LDB-I28] an already-thumb-labelled magic key (LT/RT/TB) is left alone -- nothing left to relabel on a repeat pass", () => {
    const keys: Key[] = [
      { char: "@", row: 3, col: 6, finger: "RT" },
      { char: "*", row: 3, col: 2, finger: "TB" },
    ];
    const { keys: out, relabeled } = relabelMagicThumbKeys(keys);
    expect(out).toEqual(keys);
    expect(relabeled).toEqual([]);
  });

  it("[LDB-I28] property: the output multiset of (row, col) is unchanged, and every relabelled finger is always LT or RT", () => {
    const keyArb: fc.Arbitrary<Key> = fc.record({
      char: fc.option(fc.constantFrom("@", "*", "a", "b", "2", "k"), { nil: undefined }),
      row: fc.integer({ min: -1, max: 5 }),
      col: fc.integer({ min: 0, max: 9 }),
      finger: fc.constantFrom("LP", "RP", "LR", "RR", "LM", "RM", "LI", "RI", "LT", "RT", "TB"),
    });
    fc.assert(
      fc.property(fc.array(keyArb, { maxLength: 8 }), (keys) => {
        const { keys: out, relabeled } = relabelMagicThumbKeys(keys);
        expect(out.map((k) => [k.row, k.col]).sort()).toEqual(keys.map((k) => [k.row, k.col]).sort());
        for (const r of relabeled) expect(["LT", "RT"]).toContain(r.to);
      }),
    );
  });
});
