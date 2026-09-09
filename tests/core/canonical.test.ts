// [LDB-C2] canonical() is key-order invariant and lossless.
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { canonical } from "../../src/core/canonical";

// Restricted to the shapes upstream ever sends (0.1/§2): strings, integers,
// booleans, null, nested arrays/objects. Integers (not `float`) sidestep
// -0/NaN/Infinity, which are edge cases canonical() doesn't promise to
// round-trip (JSON itself can't represent NaN/Infinity, and -0 vs 0 is a
// distinction JSON.stringify already erases upstream of canonical()).
const jsonValue: fc.Arbitrary<unknown> = fc.letrec((tie) => ({
  leaf: fc.oneof(fc.constant(null), fc.boolean(), fc.integer(), fc.string()),
  value: fc.oneof(
    { maxDepth: 3 },
    tie("leaf"),
    fc.array(tie("value"), { maxLength: 4 }),
    fc.dictionary(fc.string(), tie("value"), { maxKeys: 4 }),
  ),
})).value;

// Recursively rebuilds `v` with every object's keys re-inserted in a
// different (deterministic, seed-derived) order. Array element order is
// untouched -- canonical()'s promise is object-key-order invariance only.
function shuffleKeys(v: unknown, seed: number): unknown {
  if (v === null || typeof v !== "object") return v;
  if (Array.isArray(v)) return v.map((item, i) => shuffleKeys(item, seed * 31 + i + 1));
  let s = (seed >>> 0) || 1;
  const rand = () => {
    s = (s * 1103515245 + 12345) & 0x7fffffff;
    return s / 0x7fffffff;
  };
  const entries = Object.entries(v as Record<string, unknown>);
  for (let i = entries.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    const tmp = entries[i]!;
    entries[i] = entries[j]!;
    entries[j] = tmp;
  }
  return Object.fromEntries(entries.map(([k, val], i) => [k, shuffleKeys(val, seed * 31 + i + 1)]));
}

describe("canonical()", () => {
  it("[LDB-C2] is invariant to object key order", () => {
    fc.assert(
      fc.property(jsonValue, fc.integer(), (v, seed) => {
        expect(canonical(v)).toBe(canonical(shuffleKeys(v, seed)));
      }),
    );
  });

  it("[LDB-C2] is lossless: JSON.parse(canonical(x)) deep-equals x", () => {
    fc.assert(
      fc.property(jsonValue, (v) => {
        expect(JSON.parse(canonical(v))).toEqual(v);
      }),
    );
  });

  it("[LDB-C2] survives quotes, backslashes, U+2028/U+2029 and astral characters", () => {
    const quote = String.fromCharCode(34); // "
    const backslash = String.fromCharCode(92); // \
    const lineSep = String.fromCharCode(0x2028); // U+2028 LINE SEPARATOR
    const paraSep = String.fromCharCode(0x2029); // U+2029 PARAGRAPH SEPARATOR
    const astral = "\u{1F600}";
    const tricky = [
      `a ${quote}quoted${quote} value`,
      `back${backslash}slash`,
      `line${lineSep}separator`,
      `para${paraSep}separator`,
      `astral: ${astral}`,
      `mixed: ${quote}${backslash}${lineSep}${astral}`,
    ];
    for (const s of tricky) {
      const v = { s, nested: { s }, arr: [s] };
      expect(JSON.parse(canonical(v))).toEqual(v);
    }
  });
});
