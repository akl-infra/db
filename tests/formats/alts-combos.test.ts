// [LDB-F44] design/alts/07-format.md (round 4, slice D): spark/1's two new
// additive optional top-level fields, `alts` and `combos`. Every rule 07
// states is exercised here, positive and negative, path-checked -- the same
// convention magic-aklgg-validation.test.ts uses for spark/1's other
// cross-field checks (schema.json can't express most of these; they live
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

describe("[LDB-F44] spark/1 alts (one entry per ngram)", () => {
  it("[LDB-F44] valid ngrams validate: 3-char, wildcard middle, 2-char, several fingers", () => {
    const alts: Alt[] = [
      { ngram: "egs", fingers: { "0": "LP", "1": "LR" } },
      { ngram: "n_f", fingers: { "2": "RI" } },
      { ngram: "gs", fingers: { "1": "RP" } },
    ];
    expect(spark1.validate(payloadWith({ alts })).ok).toBe(true);
  });

  it("[LDB-F44] an ngram must be 2 or 3 code points: 1 is refused", () => {
    expect(refusal({ alts: [{ ngram: "g", fingers: { "0": "LI" } }] })).toEqual({
      message: `alts[].ngram must be 2 or 3 code points, got "g"`,
      path: "/alts/0/ngram",
    });
  });

  it("[LDB-F44] an ngram must be 2 or 3 code points: 4 is refused", () => {
    expect(refusal({ alts: [{ ngram: "egsn", fingers: { "0": "LP" } }] })).toEqual({
      message: `alts[].ngram must be 2 or 3 code points, got "egsn"`,
      path: "/alts/0/ngram",
    });
  });

  it("[LDB-F44] the empty ngram is refused", () => {
    expect(refusal({ alts: [{ ngram: "", fingers: { "0": "LP" } }] })?.path).toBe("/alts/0/ngram");
  });

  it("[LDB-F44] astral code points count once, not as UTF-16 units", () => {
    // two astral code points are a 2-code-point ngram (4 UTF-16 units): the
    // length check passes and the layout-key check is what refuses them.
    expect(refusal({ alts: [{ ngram: "\u{1F600}\u{1F601}", fingers: { "0": "LP" } }] })).toEqual({
      message: `alts[].ngram "\u{1F600}\u{1F601}" has "\u{1F600}", which is not one of this layout's keys`,
      path: "/alts/0/ngram",
    });
  });

  it("[LDB-F44] '_' at the start of a 3-code-point ngram is refused", () => {
    expect(refusal({ alts: [{ ngram: "_gs", fingers: { "1": "LI" } }] })).toEqual({
      message: `alts[].ngram "_gs" has a wildcard '_' at position 0; '_' is allowed only as the middle of a 3-code-point ngram`,
      path: "/alts/0/ngram",
    });
  });

  it("[LDB-F44] '_' at the end of a 3-code-point ngram is refused", () => {
    expect(refusal({ alts: [{ ngram: "gs_", fingers: { "0": "LI" } }] })).toEqual({
      message: `alts[].ngram "gs_" has a wildcard '_' at position 2; '_' is allowed only as the middle of a 3-code-point ngram`,
      path: "/alts/0/ngram",
    });
  });

  it("[LDB-F44] '_' in a 2-code-point ngram is refused (so is an all-wildcard ngram)", () => {
    expect(refusal({ alts: [{ ngram: "g_", fingers: { "0": "LI" } }] })?.path).toBe("/alts/0/ngram");
    expect(refusal({ alts: [{ ngram: "_g", fingers: { "1": "LI" } }] })?.path).toBe("/alts/0/ngram");
    expect(refusal({ alts: [{ ngram: "___", fingers: { "0": "LI" } }] })?.path).toBe("/alts/0/ngram");
    expect(refusal({ alts: [{ ngram: "__", fingers: { "0": "LI" } }] })?.path).toBe("/alts/0/ngram");
  });

  it("[LDB-F44] every non-wildcard code point must be one of the layout's keys", () => {
    expect(refusal({ alts: [{ ngram: "gzs", fingers: { "0": "LI" } }] })).toEqual({
      message: `alts[].ngram "gzs" has "z", which is not one of this layout's keys`,
      path: "/alts/0/ngram",
    });
    expect(refusal({ alts: [{ ngram: "g_z", fingers: { "0": "LI" } }] })).toEqual({
      message: `alts[].ngram "g_z" has "z", which is not one of this layout's keys`,
      path: "/alts/0/ngram",
    });
  });

  it("[LDB-F44] fingers must be non-empty (schema rule)", () => {
    const result = spark1.validate(payloadWith({ alts: [{ ngram: "gs", fingers: {} }] }));
    expect(result.ok).toBe(false);
    expect(result.ok ? null : result.error.path).toBe("/alts/0/fingers");
  });

  it("[LDB-F44] fingers is required (schema rule)", () => {
    const result = spark1.validate(payloadWith({ alts: [{ ngram: "gs" } as unknown as Alt] }));
    expect(result.ok).toBe(false);
    expect(result.ok ? null : result.error.path).toBe("/alts/0");
  });

  it("[LDB-F44] every old-shape field is an unknown property", () => {
    for (const extra of [{ key: "g" }, { finger: "LI" }, { when: [] }, { except: [] }, { guard: true }]) {
      const result = spark1.validate(payloadWith({ alts: [{ ngram: "gs", fingers: { "0": "LI" }, ...extra } as unknown as Alt] }));
      expect(result.ok, JSON.stringify(extra)).toBe(false);
    }
    // an old-shape entry has no ngram and is refused as a whole.
    const old = spark1.validate(
      payloadWith({ alts: [{ key: "g", finger: "LI", when: [{ text: "gs", at: 0 }] } as unknown as Alt] }),
    );
    expect(old.ok).toBe(false);
  });

  it("[LDB-F44] a fingers key must be an integer string", () => {
    expect(refusal({ alts: [{ ngram: "gs", fingers: { x: "LI" } }] })).toEqual({
      message: `alts[].fingers key "x" must be an integer string`,
      path: "/alts/0/fingers/x",
    });
    expect(refusal({ alts: [{ ngram: "gs", fingers: { "01": "LI" } }] })?.path).toBe("/alts/0/fingers/01");
    expect(refusal({ alts: [{ ngram: "gs", fingers: { "-1": "LI" } }] })?.path).toBe("/alts/0/fingers/-1");
    expect(refusal({ alts: [{ ngram: "gs", fingers: { "0.5": "LI" } }] })?.path).toBe("/alts/0/fingers/0.5");
  });

  it("[LDB-F44] a fingers key must be within the ngram's length", () => {
    expect(refusal({ alts: [{ ngram: "gs", fingers: { "2": "LI" } }] })).toEqual({
      message: `alts[].fingers key "2" is out of range for ngram "gs"`,
      path: "/alts/0/fingers/2",
    });
    expect(spark1.validate(payloadWith({ alts: [{ ngram: "egs", fingers: { "2": "LP" } }] })).ok).toBe(true);
  });

  it("[LDB-F44] a fingers key may not name the wildcard position", () => {
    expect(refusal({ alts: [{ ngram: "g_s", fingers: { "1": "LI" } }] })).toEqual({
      message: `alts[].fingers key "1" is the wildcard position of ngram "g_s"`,
      path: "/alts/0/fingers/1",
    });
  });

  it("[LDB-F44] a fingers value must be a valid finger", () => {
    expect(refusal({ alts: [{ ngram: "gs", fingers: { "0": "ZZ" } }] })).toEqual({
      message: `alts[].fingers value "ZZ" for position 0 is not a valid finger`,
      path: "/alts/0/fingers/0",
    });
  });

  it("[LDB-F44] a fingers value must differ from that character's own finger", () => {
    // g is LM, s is LM, e is LI.
    expect(refusal({ alts: [{ ngram: "gs", fingers: { "0": "LM" } }] })).toEqual({
      message: `alts[].fingers value "LM" for position 0 ("g") must differ from the key's own finger`,
      path: "/alts/0/fingers/0",
    });
    // the rule is per position's own character: LI differs from g's LM, equals e's own.
    expect(spark1.validate(payloadWith({ alts: [{ ngram: "ge", fingers: { "0": "LI" } }] })).ok).toBe(true);
    expect(refusal({ alts: [{ ngram: "ge", fingers: { "1": "LI" } }] })?.path).toBe("/alts/0/fingers/1");
  });

  it("[LDB-F44] checks run in order: a bad ngram is reported before a bad fingers entry", () => {
    expect(refusal({ alts: [{ ngram: "gzs", fingers: { x: "ZZ" } }] })?.path).toBe("/alts/0/ngram");
    expect(refusal({ alts: [{ ngram: "gs", fingers: { "5": "ZZ" } }] })?.path).toBe("/alts/0/fingers/5");
  });

  it("[LDB-F44] no two alts may share an ngram", () => {
    expect(
      refusal({
        alts: [
          { ngram: "gs", fingers: { "0": "LI" } },
          { ngram: "es", fingers: { "0": "LP" } },
          { ngram: "gs", fingers: { "1": "RP" } },
        ],
      }),
    ).toEqual({
      message: `duplicate alts[].ngram "gs"`,
      path: "/alts/2/ngram",
    });
  });

  it("[LDB-F44] ngrams that differ only by wildcard or order are distinct", () => {
    const alts: Alt[] = [
      { ngram: "gs", fingers: { "0": "LI" } },
      { ngram: "sg", fingers: { "0": "LI" } },
      { ngram: "g_s", fingers: { "0": "LI" } },
    ];
    expect(spark1.validate(payloadWith({ alts })).ok).toBe(true);
  });

  it("[LDB-F44] an error in a later alt names that alt's own index", () => {
    expect(refusal({ alts: [{ ngram: "gs", fingers: { "0": "LI" } }, { ngram: "nf", fingers: { "0": "RI" } }] })?.path).toBe(
      "/alts/1/fingers/0",
    );
  });

  it("[LDB-F44] a record with alts lowers to mana2/1 with the alts dropped (documented loss) and combos kept", () => {
    const payload = payloadWith({
      alts: [{ ngram: "gs", fingers: { "0": "LI" } }],
      combos: [{ keys: ["g", "s"], output: "th" }],
    });
    expect(spark1.validate(payload)).toEqual({ ok: true });
    expect(spark1.to["mana2/1"]!(payload)).toEqual({
      layout: { fingers: ["", "skip skip s e g skip n f"] },
      fingermap: ["", "0 0 2 3 2 0 6 7"],
      board: { isRowStaggered: true, rowOrColumnStagger: [0, 0.25, 0.75], mirrorLeftRowStagger: false, splitAngle: 0 },
      magic: { rules: [], magicKeys: null },
      layers: null,
      combos: [{ inputs: ["gs"], output: "th" }],
    });
  });

  it("[LDB-F44] a record without alts is untouched by the alts rules", () => {
    expect(spark1.validate(payloadWith({})).ok).toBe(true);
    expect(spark1.validate(payloadWith({ alts: [] })).ok).toBe(true);
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
    expect(spark1.hasAlts(payloadWith({ alts: [{ ngram: "gs", fingers: { "0": "LI" } }] }))).toBe(true);

    expect(spark1.hasCombos(payloadWith({}))).toBe(false);
    expect(spark1.hasCombos(payloadWith({ combos: [] }))).toBe(false);
    expect(spark1.hasCombos(payloadWith({ combos: [{ keys: ["g", "s"], output: "t" }] }))).toBe(true);
  });
});
