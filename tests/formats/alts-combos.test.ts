// [LDB-F44] design/alts/07-format.md (round 4, slice D): spark/1's two new
// additive optional top-level fields, `alts` and `combos`. Every rule 07
// states is exercised here, positive and negative, path-checked -- the same
// convention magic-aklgg-validation.test.ts uses for spark/1's other
// cross-field checks (schema.json can't express any of these; they all live
// in index.ts's validate()).
import { describe, expect, it } from "vitest";
import * as spark1 from "../../formats/spark/1/index.ts";
import type { Payload, Key, Alt, Combo } from "../../formats/spark/1/index.ts";

const KEYS: Key[] = [
  { char: "g", row: 1, col: 4, finger: "LM" },
  { char: "s", row: 1, col: 2, finger: "LM" }, // shares g's finger, deliberately -- see the "different finger" test
  { char: "e", row: 1, col: 3, finger: "LI" },
  { char: "n", row: 1, col: 6, finger: "RI" },
  { char: "f", row: 1, col: 7, finger: "RM" },
];

function payloadWith(extra: { alts?: Alt[]; combos?: Combo[] }): Payload {
  return { keys: KEYS, ...extra };
}

function refusal(extra: { alts?: Alt[]; combos?: Combo[] }) {
  const result = spark1.validate(payloadWith(extra));
  return result.ok ? null : { message: result.error.message, path: result.error.path };
}

describe("[LDB-F44] spark/1 alts", () => {
  it("[LDB-F44] a valid alt (when + except, different finger) validates", () => {
    const alts: Alt[] = [
      {
        key: "g",
        finger: "LI",
        when: [
          { text: "gs", at: 0 },
          { text: "g_s", at: 0 },
        ],
        except: [{ text: "egs", at: 1 }],
      },
    ];
    expect(spark1.validate(payloadWith({ alts })).ok).toBe(true);
  });

  it("[LDB-F44] alts[].key must be one of the layout's keys", () => {
    expect(refusal({ alts: [{ key: "z", finger: "RP", when: [{ text: "z", at: 0 }] }] })).toEqual({
      message: `alts[].key "z" is not one of this layout's keys`,
      path: "/alts/0/key",
    });
  });

  it("[LDB-F44] alts[].finger must differ from the key's own finger", () => {
    expect(refusal({ alts: [{ key: "g", finger: "LM", when: [{ text: "g", at: 0 }] }] })).toEqual({
      message: `alts[].finger "LM" for key "g" must differ from the key's own finger`,
      path: "/alts/0/finger",
    });
  });

  it("[LDB-F44] alts[].when must be non-empty", () => {
    expect(refusal({ alts: [{ key: "g", finger: "LI", when: [] }] })).toEqual({
      message: `alts[].when must be non-empty (key "g")`,
      path: "/alts/0/when",
    });
  });

  it("[LDB-F44] a pattern must be 1-5 code points", () => {
    expect(refusal({ alts: [{ key: "g", finger: "LI", when: [{ text: "abcdeg", at: 5 }] }] })).toEqual({
      message: `alts[].when/except text must be 1-5 code points, got "abcdeg"`,
      path: "/alts/0/when/0/text",
    });
  });

  it("[LDB-F44] a 5-char pattern with the key in the middle (reach 2,2) validates", () => {
    expect(spark1.validate(payloadWith({ alts: [{ key: "g", finger: "LI", when: [{ text: "abgde", at: 2 }] }] })).ok).toBe(
      true,
    );
  });

  it("[LDB-F44] a 4-char pattern with the key first (right reach 3) is refused", () => {
    expect(refusal({ alts: [{ key: "g", finger: "LI", when: [{ text: "gabc", at: 0 }] }] })).toEqual({
      message: `alts[].when/except text "gabc" reaches more than 2 positions from the key`,
      path: "/alts/0/when/0/text",
    });
  });

  it("[LDB-F44] an except pattern may be longer than its when", () => {
    expect(
      spark1.validate(
        payloadWith({
          alts: [
            {
              key: "g",
              finger: "LI",
              when: [{ text: "gs", at: 0 }],
              except: [{ text: "egsn", at: 1 }],
            },
          ],
        }),
      ).ok,
    ).toBe(true);
  });

  it("[LDB-F44] 'at' must be in range for the text", () => {
    expect(refusal({ alts: [{ key: "g", finger: "LI", when: [{ text: "g", at: 1 }] }] })).toEqual({
      message: `alts[].when/except 'at' (1) is out of range for text "g"`,
      path: "/alts/0/when/0/at",
    });
  });

  it("[LDB-F44] the text must have the key at 'at'", () => {
    expect(refusal({ alts: [{ key: "g", finger: "LI", when: [{ text: "gs", at: 1 }] }] })).toEqual({
      message: `alts[].when/except text "gs" does not have key "g" at position 1`,
      path: "/alts/0/when/0/at",
    });
  });

  it("[LDB-F44] no duplicate pattern within one alt's when ∪ except", () => {
    expect(
      refusal({
        alts: [
          {
            key: "g",
            finger: "LI",
            when: [{ text: "gs", at: 0 }],
            except: [{ text: "gs", at: 0 }],
          },
        ],
      }),
    ).toEqual({
      message: `duplicate alts[].when/except text "gs" for key "g"`,
      path: "/alts/0/except/0",
    });
  });

  it("[LDB-F44] two alts on the same key with different fingers may not have co-matching whens", () => {
    expect(
      refusal({
        alts: [
          { key: "g", finger: "LI", when: [{ text: "gs", at: 0 }] },
          { key: "g", finger: "RI", when: [{ text: "gs", at: 0 }] },
        ],
      }),
    ).toEqual({
      message: `alts[].key "g" has two fingerings ("LI", "RI") whose 'when' patterns co-match -- ambiguous which finger applies`,
      path: "/alts/1/when",
    });
  });

  it("[LDB-F44] a wildcard co-matches a literal at the same aligned position", () => {
    expect(
      refusal({
        alts: [
          { key: "g", finger: "LI", when: [{ text: "g_s", at: 0 }] },
          { key: "g", finger: "RI", when: [{ text: "gxs", at: 0 }] },
        ],
      }),
    ).not.toBeNull();
  });

  it("[LDB-F44] two alts on the same key with the SAME finger are unaffected by co-matching (not a fingering ambiguity)", () => {
    expect(
      spark1.validate(
        payloadWith({
          alts: [
            { key: "g", finger: "LI", when: [{ text: "gs", at: 0 }] },
            { key: "g", finger: "LI", when: [{ text: "gs", at: 0 }] },
          ],
        }),
      ).ok,
    ).toBe(true);
  });

  it("[LDB-F44] two alts on the same key with different fingers but non-co-matching whens (different reach) are fine", () => {
    expect(
      spark1.validate(
        payloadWith({
          alts: [
            { key: "g", finger: "LI", when: [{ text: "gs", at: 0 }] },
            { key: "g", finger: "RI", when: [{ text: "egs", at: 1 }] },
          ],
        }),
      ).ok,
    ).toBe(true);
  });
});

describe("[LDB-F44] spark/1 combos", () => {
  it("[LDB-F44] a valid combo validates", () => {
    expect(spark1.validate(payloadWith({ combos: [{ keys: ["g", "s"], output: "th" }] })).ok).toBe(true);
  });

  it("[LDB-F44] combos[].keys must each be one of the layout's keys", () => {
    expect(refusal({ combos: [{ keys: ["g", "z"], output: "t" }] })).toEqual({
      message: `combos[].keys "z" is not one of this layout's keys`,
      path: "/combos/0/keys/1",
    });
  });

  it("[LDB-F44] combos[].keys must name two distinct characters", () => {
    expect(refusal({ combos: [{ keys: ["g", "g"], output: "t" }] })).toEqual({
      message: `combos[].keys must name two distinct characters, got "g" twice`,
      path: "/combos/0/keys",
    });
  });

  it("[LDB-F44] no duplicate unordered keys pair across combos", () => {
    expect(
      refusal({
        combos: [
          { keys: ["g", "s"], output: "t" },
          { keys: ["s", "g"], output: "d" },
        ],
      }),
    ).toEqual({
      message: `combos entries collide on the same pair of keys ("s", "g")`,
      path: "/combos/1/keys",
    });
  });

  it("[LDB-F44] combos[].output must be 1-2 code points", () => {
    expect(refusal({ combos: [{ keys: ["g", "s"], output: "abc" }] })).toEqual({
      message: `combos[].output must be 1-2 code points, got "abc"`,
      path: "/combos/0/output",
    });
  });

  it("[LDB-F44] no duplicate output across combos", () => {
    expect(
      refusal({
        combos: [
          { keys: ["g", "s"], output: "th" },
          { keys: ["e", "n"], output: "th" },
        ],
      }),
    ).toEqual({
      message: `duplicate combos[].output "th"`,
      path: "/combos/1/output",
    });
  });

  it("[LDB-F44] output chars need not be keys", () => {
    expect(spark1.validate(payloadWith({ combos: [{ keys: ["g", "s"], output: "zz" }] })).ok).toBe(true);
  });

  it("[LDB-F44] empty arrays are accepted, same as magic's own sub-arrays", () => {
    expect(spark1.validate(payloadWith({ alts: [], combos: [] })).ok).toBe(true);
  });
});

describe("[LDB-F44] hasAlts/hasCombos", () => {
  it("[LDB-F44] hasAlts/hasCombos are false when absent or empty, true when non-empty", () => {
    expect(spark1.hasAlts(payloadWith({}))).toBe(false);
    expect(spark1.hasAlts(payloadWith({ alts: [] }))).toBe(false);
    expect(spark1.hasAlts(payloadWith({ alts: [{ key: "g", finger: "LI", when: [{ text: "g", at: 0 }] }] }))).toBe(true);

    expect(spark1.hasCombos(payloadWith({}))).toBe(false);
    expect(spark1.hasCombos(payloadWith({ combos: [] }))).toBe(false);
    expect(spark1.hasCombos(payloadWith({ combos: [{ keys: ["g", "s"], output: "t" }] }))).toBe(true);
  });
});
