// [LDB-MIR1] [LDB-MIR2] The tee codec (src/mirror/record.ts): decodeTee(encodeTee(x)) deep-equals x for every argument and
// result type the port uses, the encoding survives a JSON round trip, and user JSON can never be read as a tag.
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { decodeTee, encodeTee, RecordedClock, replayClock, TEE_SIG_HEADER, TEE_TS_HEADER } from "../../src/mirror/record";

function viaJson(x: unknown): unknown {
  return JSON.parse(JSON.stringify(encodeTee(x)));
}

const leaf = fc.oneof(
  fc.constant(null),
  fc.constant(undefined),
  fc.boolean(),
  fc.string(),
  fc.integer(),
  fc.double({ noNaN: false }),
  fc.uint8Array({ maxLength: 40 }),
  fc.date({ noInvalidDate: true }),
);
// Keys include the tag-shaped ones on purpose.
const key = fc.oneof(fc.string({ maxLength: 8 }), fc.constantFrom("$map", "$set", "$bytes", "$u", "$obj", "$clock", "$num", "$date", "__proto__", "$x"));
const value: fc.Arbitrary<unknown> = fc.letrec((tie) => ({
  v: fc.oneof(
    { depthSize: "small", maxDepth: 4 },
    leaf,
    fc.array(tie("v"), { maxLength: 5 }),
    fc.dictionary(key, tie("v"), { maxKeys: 5 }),
    fc.array(fc.tuple(tie("v"), tie("v")), { maxLength: 4 }).map((kv) => new Map(kv)),
    fc.array(tie("v"), { maxLength: 4 }).map((xs) => new Set(xs)),
  ),
})).v;

describe("the tee codec", () => {
  it("[LDB-MIR2] decodeTee(encodeTee(x)) deep-equals x, through JSON, for arbitrary values", () => {
    fc.assert(
      fc.property(value, (x) => {
        expect(decodeTee(viaJson(x))).toEqual(x);
      }),
      { numRuns: 500 },
    );
  });

  it("keeps the exact numbers and the undefined properties plain JSON would lose", () => {
    const x = { a: undefined, b: NaN, c: -0, d: Infinity, e: [undefined, 1], f: new Uint8Array([0, 255, 7]), g: new Map([[undefined, new Set([1, 2])]]) };
    const back = decodeTee(viaJson(x)) as typeof x;
    expect(Object.keys(back)).toEqual(Object.keys(x));
    expect(Object.is(back.c, -0)).toBe(true);
    expect(back.b).toBeNaN();
    expect(back.d).toBe(Infinity);
    expect(back.e).toEqual([undefined, 1]);
    expect(back.f).toEqual(new Uint8Array([0, 255, 7]));
    expect([...back.g.entries()]).toEqual([[undefined, new Set([1, 2])]]);
  });

  it("[LDB-MIR1] encodes the pinned tags as pinned, and the headers are the pinned names", () => {
    expect([TEE_TS_HEADER, TEE_SIG_HEADER]).toEqual(["X-Akldb-Tee-Ts", "X-Akldb-Tee-Sig"]);
    expect(encodeTee(new Map([["k", 1]]))).toEqual({ $map: [["k", 1]] });
    expect(encodeTee(new Set([1]))).toEqual({ $set: [1] });
    expect(encodeTee(new Uint8Array([104, 105]))).toEqual({ $bytes: "aGk=" });
    expect(encodeTee(undefined)).toEqual({ $u: 1 });
    expect(encodeTee({ plain: "json", n: [1, null, "x"] })).toEqual({ plain: "json", n: [1, null, "x"] });
  });

  it("user JSON shaped like a tag is escaped, never interpreted", () => {
    for (const evil of [{ $map: [["a", 1]] }, { $u: 1 }, { $bytes: "AAAA" }, { $clock: ["x"] }, { $obj: [] }, JSON.parse('{"__proto__": {"polluted": 1}}') as unknown]) {
      const back = decodeTee(viaJson(evil));
      expect(back).toEqual(evil);
      expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    }
  });

  it("a Clock's recorded values replay in order and the replay refuses extra reads", () => {
    const rc = decodeTee({ $clock: ["a", "b"] });
    expect(rc).toBeInstanceOf(RecordedClock);
    const clock = replayClock(rc as RecordedClock);
    expect([clock(), clock()]).toEqual(["a", "b"]);
    expect(() => clock()).toThrow(/recorded 2/);
  });

  it("refuses what it cannot represent exactly", () => {
    expect(() => encodeTee(() => 1)).toThrow();
    expect(() => encodeTee(new (class Foo {})())).toThrow();
    expect(() => encodeTee(10n)).toThrow();
    expect(() => decodeTee({ $nope: 1 })).toThrow();
  });
});
