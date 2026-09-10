// [LDB-F19] Path composition (20-spark.md S5; 19-upcast.md round 2 §8's
// F17, renumbered here): `translate()`/`path()`/`walk()` walk
// legacy-normalize -> chain -> pinned cross edge -> chain; the result is
// held iff a step is held; `see` names the record's own NATIVE format;
// `can_translate_to` equals the set of formats `path()` reaches. Exercised
// through the stub lineage: `t/1 -> t/3` (up, 2 steps), `t/3 -> t/1`
// (down, 2 steps, held iff `c`), and a cross edge pinned at `t/2` (a
// NON-LATEST major of `t`, whose latest is `t/3`) reaching `u/1`.
import { describe, expect, it } from "vitest";
import { hasEdge, path, translate, walk } from "../../formats/registry.ts";
import { T1, T2, T3, U1 } from "./stub-lineage.ts";
import { registerForTest } from "../../formats/registry.ts";

function withStubLineage<T>(fn: () => T): T {
  const un1 = registerForTest(T1);
  const un2 = registerForTest(T2);
  const un3 = registerForTest(T3);
  const unU = registerForTest(U1);
  try {
    return fn();
  } finally {
    unU();
    un3();
    un2();
    un1();
  }
}

describe("[LDB-F19] same-lineage chain: t/1 -> t/3 and t/3 -> t/1", () => {
  it("[LDB-F19] t/1 -> t/3 (up, 2 steps) never holds and matches manual composition", () => {
    withStubLineage(() => {
      const p1 = { v: 1 as const, a: 9 };
      const result = walk("t/1", "t/3", p1);
      expect(result).toEqual({ v: 3, a: 9, b: 0, c: false });
      expect(T3.up!(T2.up!(p1))).toEqual(result);
    });
  });

  it("[LDB-F19] t/3 -> t/1 (down, 2 steps): held iff either step would lose something", () => {
    withStubLineage(() => {
      const clean = { v: 3 as const, a: 9, b: 0, c: false };
      expect(walk("t/3", "t/1", clean)).toEqual({ v: 1, a: 9 });

      const lossyC = { v: 3 as const, a: 9, b: 0, c: true };
      const heldC = walk("t/3", "t/1", lossyC);
      expect(heldC).toMatchObject({ held: true });

      const lossyB = { v: 3 as const, a: 9, b: 5, c: false };
      const heldB = walk("t/3", "t/1", lossyB);
      expect(heldB).toMatchObject({ held: true });
    });
  });

  it("[LDB-F19] translate() over the stub lineage: held iff a step holds, 'see' names the record's OWN format", () => {
    withStubLineage(() => {
      const rec = { format: "t/3", payload: { v: 3 as const, a: 1, b: 0, c: true } };
      const result = translate(rec, "t/1");
      expect(result).toMatchObject({ held: true, format: "t/1", see: "t/3" });
    });
  });
});

describe("[LDB-F19] a cross edge pinned at a NON-LATEST major (t/2, while t's latest is t/3) reaching u/1", () => {
  it("[LDB-F19] t/1 -> u/1: chains UP to t/2 first, then crosses", () => {
    withStubLineage(() => {
      const p1 = { v: 1 as const, a: 3 };
      const result = walk("t/1", "u/1", p1);
      expect(result).toEqual({ tag: "u", a: 3, b: 0 });
    });
  });

  it("[LDB-F19] t/3 -> u/1: chains DOWN to t/2 first (held iff that step would be), then crosses", () => {
    withStubLineage(() => {
      const clean = { v: 3 as const, a: 3, b: 2, c: false };
      expect(walk("t/3", "u/1", clean)).toEqual({ tag: "u", a: 3, b: 2 });

      const lossy = { v: 3 as const, a: 3, b: 2, c: true };
      expect(walk("t/3", "u/1", lossy)).toMatchObject({ held: true });
    });
  });

  it("[LDB-F19] hasEdge/'can_translate_to': t/1 and t/3 both structurally reach u/1 (the chain composes past the edge's own major); u/1 does not reach back", () => {
    withStubLineage(() => {
      expect(hasEdge("t/1", "u/1")).toBe(true);
      expect(hasEdge("t/2", "u/1")).toBe(true);
      expect(hasEdge("t/3", "u/1")).toBe(true);
      expect(hasEdge("u/1", "t/1")).toBe(false); // no registered edge the other way
    });
  });

  it("[LDB-F19] a lineage with no cross edge at all is a constant-held path, never throws", () => {
    withStubLineage(() => {
      // U1 has no `to` at all -- nothing reaches FROM u/1 to t.
      expect(path("u/1", "t/1")("anything")).toMatchObject({ held: true });
    });
  });
});
