// [SITE-17] author-name resolution falls back to the id and never throws
// on an unknown id -- property test over `resolveAuthorName`, the pure
// function `src/lib/authorNames.ts`'s reactive `authorName()` wraps.
import fc from "fast-check";
import { afterEach, describe, expect, it, vi } from "vitest";
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

// [SITE-17] regression: `GET /v1/authors` is an id-keyed OBJECT
// (`{ "<user_id>": "<name>" }`, `?by=id` -- db/src/routes/authors.ts:19-23),
// never an array. A `getAuthors()` typed as `Author[]` parsed the real
// response wrong and threw inside `for...of`, caught during this slice's
// own Chrome QA against the real DB (an uncaught rejection, since
// `loadAuthorNames()` only guards the FETCH, not what it does with the
// body). Pinned here so it can't quietly come back.
describe("[SITE-17] loadAuthorNames() reads the real /v1/authors shape", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("requests ?by=id and builds the cache directly from the id-keyed object", async () => {
    vi.resetModules();
    vi.stubGlobal(
      "fetch",
      vi.fn((input: RequestInfo | URL) => {
        const url = typeof input === "string" ? input : input.toString();
        expect(url).toBe("/api/v1/authors?by=id");
        return Promise.resolve(new Response(JSON.stringify({ "184412255822020608": "saltorbit" }), { status: 200, headers: { "Content-Type": "application/json" } }));
      }),
    );
    const mod = await import("../../src/lib/authorNames.ts");
    await mod.loadAuthorNames();
    expect(mod.authorName("184412255822020608")).toBe("saltorbit");
    expect(mod.authorName("some-other-id")).toBe("some-other-id"); // still falls back
  });
});
