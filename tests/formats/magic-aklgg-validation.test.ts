// [LDB-F22] spark/1's magic validation accepts what akl.gg's gate
// (functions/_lib/rules.mjs `validateRuleSet`) accepts and refuses what it
// refuses (saltorbit 2026-09-11: "layoutdb validation right now should match
// aklgg validation"). spark/1 keeps two additions akl.gg has no shape for
// (`except[]`, the raw `rules[]` escape hatch); every other difference was
// removed:
//   - every key a rule set names (a magic key, a chiral key, a swap trigger
//     or member) must be one of the layout's keys -- added to both
//     validators together (saltorbit/aklgg#322, 2026-09-13), which is what
//     refuses adaptative-magic-sturdy's and jazz's upper-case swaps;
//   - a `null` chiral `same`/`opposite` reads as absent.
// design/layout-db/24-spark-wire-review.md round 2's resolution item 2:
// `notes`/`updated` are DROPPED from the payload entirely now (no writer
// ever produced them) -- the schema refuses them outright, a divergence
// from akl.gg's own gate (which still accepts them) that this file used to
// paper over by accepting them too.
// Generated coverage of the same rule, and the compile side (the same rows
// as akl.gg's compile), are the parity vectors: tests/formats/
// spark-parity-vectors.test.ts (LDB-F39) and bot/tests/magic/
// spark-parity.test.ts (LDB-B78).
import { describe, expect, it } from "vitest";
import * as spark1 from "../../formats/spark/1/index.ts";
import type { Payload, Key } from "../../formats/spark/1/index.ts";

const KEYS: Key[] = [
  { char: "a", row: 1, col: 0, finger: "LP" },
  { char: "b", row: 1, col: 1, finger: "LR" },
  { char: "c", row: 1, col: 2, finger: "LM" },
  { char: "d", row: 1, col: 3, finger: "LI" },
  { char: "h", row: 1, col: 6, finger: "RI" },
  { char: "i", row: 1, col: 7, finger: "RM" },
];

function check(magic: unknown, keys: Key[] = KEYS) {
  return spark1.validate({ keys, board: "ansi", magic } as unknown as Payload);
}

function refusal(magic: unknown, keys: Key[] = KEYS) {
  const result = check(magic, keys);
  return result.ok ? null : { message: result.error.message, path: result.error.path };
}

describe("spark/1 magic validation == akl.gg's gate (LDB-F22)", () => {
  it("[LDB-F22] a magic key, chiral key, swap trigger or swap member must be on the layout", () => {
    expect(refusal({ magic_keys: [{ key: "*", default: { kind: "repeat" } }] })).toEqual({
      message: `magic_keys[].key "*" is not one of this layout's keys`,
      path: "/magic/magic_keys/0/key",
    });
    expect(refusal({ chiral_keys: [{ key: "#", same: { kind: "repeat" } }] })).toEqual({
      message: `chiral_keys[].key "#" is not one of this layout's keys`,
      path: "/magic/chiral_keys/0/key",
    });
    expect(refusal({ adaptive_swaps: [{ trigger: "C", swap: ["a", "b"] }] })).toEqual({
      message: `adaptive_swaps[].trigger "C" is not one of this layout's keys`,
      path: "/magic/adaptive_swaps/0/trigger",
    });
    expect(refusal({ adaptive_swaps: [{ trigger: "a", swap: ["b", "M"] }] })).toEqual({
      message: `adaptive_swaps[].swap member "M" is not one of this layout's keys`,
      path: "/magic/adaptive_swaps/0/swap",
    });
    // The same shapes with every named key on the layout are accepted.
    expect(check({ magic_keys: [{ key: "a", default: { kind: "repeat" } }] })).toEqual({ ok: true });
    expect(check({ chiral_keys: [{ key: "h", same: { kind: "repeat" } }] })).toEqual({ ok: true });
    expect(check({ adaptive_swaps: [{ trigger: "c", swap: ["a", "b"] }, { trigger: "a", swap: ["b", "d"] }] })).toEqual({ ok: true });
  });

  it("[LDB-F22] adaptative-magic-sturdy's upper-case swaps are refused; lower-cased, as published after #322's fix, they validate and compile", () => {
    const keys: Key[] = [...KEYS, { char: "m", row: 0, col: 2, finger: "LM" }, { char: "k", row: 2, col: 2, finger: "LM" }, { char: "*", row: 0, col: 6, finger: "RI" }];
    const published = (swap: (s: string) => string) => ({
      adaptive_swaps: [{ swap: [swap("M"), swap("K")], trigger: swap("C") }],
      chiral_keys: [],
      magic_keys: [{ default: { kind: "repeat" }, key: "*", rules: [{ after: "a", output: "ao" }] }],
    });
    expect(refusal(published((s) => s), keys)?.message).toBe(`adaptive_swaps[].trigger "C" is not one of this layout's keys`);
    const lower = published((s) => s.toLowerCase());
    expect(check(lower, keys)).toEqual({ ok: true });
    const rows = spark1.compileMagic({ keys, magic: lower } as unknown as Payload);
    expect(rows.filter((r) => r.inputs === "cm" || r.inputs === "ck").map((r) => [r.inputs, r.output]).sort()).toEqual([
      ["ck", "cm"],
      ["cm", "ck"],
    ]);
  });

  it("[LDB-F22] notes and updated are refused -- dropped entirely (24-spark-wire-review.md round 2 item 2)", () => {
    expect(check({ magic_keys: [{ key: "a" }], notes: "Real rules, supplied by the author", updated: "2026-08-12" }).ok).toBe(false);
    for (const bad of [{ notes: "x" }, { updated: "2026-08-12" }, { notes: 3 }, { updated: null }, { notes: ["x"] }]) {
      expect(check({ magic_keys: [{ key: "a" }], ...bad }).ok).toBe(false);
    }
  });

  it("[LDB-F22] a null chiral same/opposite reads as absent: accepted, compiles nothing for that side; both null is refused like both absent", () => {
    const one = { chiral_keys: [{ key: "h", same: null, opposite: { kind: "repeat" } }] };
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
      { magic_keys: [{ key: "a", default: "sometimes" }] }, // default not a tagged {repeat:true}/{char:<c>} shape (a bare string, even a single character, is refused by the schema now)
      { magic_keys: [{ key: "a", rules: [{ after: "b", output: "bx" }, { after: "b", output: "by" }] }] }, // duplicate after
      { magic_keys: [{ key: "a", rules: [{ after: "b", output: "b" }] }] }, // output shorter than two
      { magic_keys: [{ key: "a", rules: [{ after: "b", output: "cb" }] }] }, // output doesn't start with after
      { magic_keys: [{ key: "a" }], chiral_keys: [{ key: "a", same: { kind: "char", char: "x" } }] }, // magic and chiral at once
      { chiral_keys: [{ key: "h", same: { kind: "char", char: "x" } }, { key: "h", same: { kind: "char", char: "y" } }] }, // duplicate chiral key
      { chiral_keys: [{ key: "h", same: { kind: "char", char: "" } }] }, // empty char (same/opposite use the same tagged union as magic_keys[].default now -- no bare-string same/opposite left to be "empty")
      { adaptive_swaps: [{ trigger: "a", swap: ["b", "b"] }] }, // swap names one character twice
      { adaptive_swaps: [{ trigger: "a", swap: ["b", "c"] }, { trigger: "a", swap: ["b", "d"] }] }, // (trigger, member) twice
      { adaptive_swaps: [{ trigger: "ab", swap: ["b", "c"] }] }, // trigger not a single character
      { magic_keys: [{ key: "a", chiral_rules: [] }] }, // the retired chiral_rules sub-shape
      { adaptive_swaps: [{ trigger: "C", swap: ["M", "K"] }] }, // off-layout trigger and members (#322)
    ];
    for (const magic of refused) expect(check(magic).ok, JSON.stringify(magic)).toBe(false);
  });
});
