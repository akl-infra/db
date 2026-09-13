// [SITE-17] author-name resolution falls back to the id and never throws
// on an unknown id -- property test over `resolveAuthorName`, the pure
// function `src/lib/authorNames.ts`'s reactive `authorName()` wraps.
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { resolveAuthorName } from "../../src/lib/authorNames.ts";

const idArb = fc.string({ minLength: 1, maxLength: 24 });
const nameArb = fc.string({ minLength: 1, maxLength: 64 });

describe("[SITE-17] resolveAuthorName", () => {
  it("never throws for any map/id combination, including null/undefined/empty", () => {
    fc.assert(
      fc.property(fc.dictionary(idArb, nameArb), fc.oneof(idArb, fc.constant(null), fc.constant(undefined), fc.constant("")), (entries, id) => {
        const map = new Map(Object.entries(entries));
        expect(() => resolveAuthorName(map, id)).not.toThrow();
      }),
    );
  });

  it("falls back to the raw id whenever the id is not a key in the map", () => {
    fc.assert(
      fc.property(fc.dictionary(idArb, nameArb), idArb, (entries, id) => {
        const map = new Map(Object.entries(entries));
        fc.pre(!map.has(id));
        expect(resolveAuthorName(map, id)).toBe(id);
      }),
    );
  });

  it("resolves to the mapped name whenever the id IS a key in the map", () => {
    fc.assert(
      fc.property(fc.dictionary(idArb, nameArb, { minKeys: 1 }), (entries) => {
        const map = new Map(Object.entries(entries));
        const [id, name] = [...map.entries()][0]!;
        expect(resolveAuthorName(map, id)).toBe(name);
      }),
    );
  });

  it("null, undefined and empty-string ids resolve to the empty string, never a map lookup", () => {
    const map = new Map([["", "should never match"]]);
    expect(resolveAuthorName(map, null)).toBe("");
    expect(resolveAuthorName(map, undefined)).toBe("");
    expect(resolveAuthorName(map, "")).toBe("");
  });
});
