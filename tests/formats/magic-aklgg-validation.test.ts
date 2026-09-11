// [LDB-F22] spark/1's magic validation accepts what akl.gg's gate
// (functions/_lib/rules.mjs `validateRuleSet`) accepts and refuses what it
// refuses (saltorbit 2026-09-11: "layoutdb validation right now should match
// aklgg validation"). spark/1 keeps two additions akl.gg has no shape for
// (`except[]`, the raw `rules[]` escape hatch); every other difference was
// removed:
//   - the keys a rule set names need not be on the layout
//     (adaptative-magic-sturdy's and jazz's upper-case swaps; issue #321
//     would add the check to both validators together);
//   - `notes`/`updated` are accepted as strings;
//   - a `null` chiral `same`/`opposite` reads as absent.
// The compile side (the same rows as akl.gg's compile, over generated rule
// sets) is bot/tests/magic/spark-parity.test.ts (LDB-B78).
import { describe, expect, it } from "vitest";
import * as spark1 from "../../formats/spark/1/index.ts";
import type { Payload, Position } from "../../formats/spark/1/index.ts";

const KEYS: Record<string, Position> = {
  a: { row: 1, col: 0, finger: "LP" },
  b: { row: 1, col: 1, finger: "LR" },
  c: { row: 1, col: 2, finger: "LM" },
  d: { row: 1, col: 3, finger: "LI" },
  h: { row: 1, col: 6, finger: "RI" },
  i: { row: 1, col: 7, finger: "RM" },
};

function check(magic: unknown) {
  return spark1.validate({ keys: KEYS, magic } as unknown as Payload);
}

describe("spark/1 magic validation == akl.gg's gate (LDB-F22)", () => {
  it("[LDB-F22] a magic key, chiral key, swap trigger or swap member need not be on the layout", () => {
    expect(check({ magic_keys: [{ key: "*", default: "repeat_previous" }] })).toEqual({ ok: true });
    expect(check({ chiral_keys: [{ key: "#", same: "repeat_previous" }] })).toEqual({ ok: true });
    expect(check({ adaptive_swaps: [{ trigger: "C", swap: ["M", "K"] }] })).toEqual({ ok: true });
    expect(check({ adaptive_swaps: [{ trigger: "a", swap: ["M", "d"] }] })).toEqual({ ok: true });
  });

  it("[LDB-F22] adaptative-magic-sturdy's published rules validate verbatim, and its off-layout swaps compile as akl.gg compiles them", () => {
    const magic = {
      adaptive_swaps: [
        { swap: ["M", "K"], trigger: "C" },
        { swap: ["P", "L"], trigger: "M" },
      ],
      chiral_keys: [],
      magic_keys: [{ default: "repeat_previous", key: "*", rules: [{ after: "a", output: "ao" }] }],
    };
    expect(check(magic)).toEqual({ ok: true });
    const rows = spark1.compileMagic({ keys: KEYS, magic } as unknown as Payload);
    expect(rows.filter((r) => r.inputs === "CM" || r.inputs === "CK").map((r) => [r.inputs, r.output]).sort()).toEqual([
      ["CK", "CM"],
      ["CM", "CK"],
    ]);
  });

  it("[LDB-F22] notes and updated are accepted as strings and refused as anything else", () => {
    expect(check({ magic_keys: [{ key: "a", default: "none" }], notes: "Real rules, supplied by the author", updated: "2026-08-12" })).toEqual({ ok: true });
    for (const bad of [{ notes: 3 }, { updated: null }, { notes: ["x"] }]) {
      expect(check({ magic_keys: [{ key: "a" }], ...bad }).ok).toBe(false);
    }
  });

  it("[LDB-F22] a null chiral same/opposite reads as absent: accepted, compiles nothing for that side; both null is refused like both absent", () => {
    const one = { chiral_keys: [{ key: "h", same: null, opposite: "repeat_previous" }] };
    expect(check(one)).toEqual({ ok: true });
    const rows = spark1.compileMagic({ keys: KEYS, magic: one } as unknown as Payload);
    const sameHand = rows.filter((r) => r.inputs === "ih"); // i and h are both right-hand
    expect(sameHand).toEqual([]);
    expect(rows.find((r) => r.inputs === "ah")?.output).toBe("aa"); // opposite hand, repeat_previous
    expect(check({ chiral_keys: [{ key: "h", same: null, opposite: null }] }).ok).toBe(false);
    expect(check({ chiral_keys: [{ key: "h" }] }).ok).toBe(false);
  });

  it("[LDB-F22] every refusal akl.gg's gate makes is still made", () => {
    const refused: unknown[] = [
      { magic_keys: [{ key: "ab" }] }, // key not a single character
      { magic_keys: [{ key: "a", default: "sometimes" }] }, // default not a sentinel or one character
      { magic_keys: [{ key: "a", rules: [{ after: "b", output: "bx" }, { after: "b", output: "by" }] }] }, // duplicate after
      { magic_keys: [{ key: "a", rules: [{ after: "b", output: "b" }] }] }, // output shorter than two
      { magic_keys: [{ key: "a", rules: [{ after: "b", output: "cb" }] }] }, // output doesn't start with after
      { magic_keys: [{ key: "a" }], chiral_keys: [{ key: "a", same: "x" }] }, // magic and chiral at once
      { chiral_keys: [{ key: "h", same: "x" }, { key: "h", same: "y" }] }, // duplicate chiral key
      { chiral_keys: [{ key: "h", same: "" }] }, // empty same
      { adaptive_swaps: [{ trigger: "a", swap: ["b", "b"] }] }, // swap names one character twice
      { adaptive_swaps: [{ trigger: "a", swap: ["b", "c"] }, { trigger: "a", swap: ["b", "d"] }] }, // (trigger, member) twice
      { adaptive_swaps: [{ trigger: "ab", swap: ["b", "c"] }] }, // trigger not a single character
      { magic_keys: [{ key: "a", chiral_rules: [] }] }, // the retired chiral_rules sub-shape
    ];
    for (const magic of refused) expect(check(magic).ok, JSON.stringify(magic)).toBe(false);
  });
});
