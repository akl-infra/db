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

describe("[LDB-F44] spark/1 alts (one entry per ngram: an array, null is the wildcard)", () => {
  const A = (ngram: (string | null)[], fingers: (string | null)[]): Alt => ({ ngram, fingers });

  function schemaOrRuleRefusal(alt: unknown) {
    const result = spark1.validate(payloadWith({ alts: [alt as Alt] }));
    return result.ok ? null : { message: result.error.message, path: String(result.error.path) };
  }

  it("[LDB-F44] valid ngrams validate: 3-item, null middle, 2-item", () => {
    const alts: Alt[] = [A(["e", "g", "s"], ["LP", "RP", "LR"]), A(["n", null, "f"], ["RR", null, "LI"]), A(["g", "s"], ["LP", "RP"])];
    expect(spark1.validate(payloadWith({ alts })).ok).toBe(true);
  });

  it("[LDB-F44] a literal \"_\" is just the underscore key, valid when the layout has it", () => {
    const withUnderscore: Payload = { keys: [...KEYS, { char: "_", row: 2, col: 1, finger: "RP" }], alts: [A(["g", "_"], ["LP", "RP"]), A(["g", "_", "s"], ["LP", "RR", "LI"])] };
    expect(spark1.validate(withUnderscore).ok).toBe(true);
    expect(refusal({ alts: [A(["g", "_"], ["LP", "RP"])] })).toEqual({
      message: `alts[].ngram ["g","_"] has "_", which is not one of this layout's keys`,
      path: "/alts/0/ngram",
    });
  });

  it("[LDB-F44] an ngram must have 2 or 3 items: 1 and 4 are refused (schema)", () => {
    expect(schemaOrRuleRefusal(A(["g"], ["LI"]))?.path.startsWith("/alts/0/ngram")).toBe(true);
    expect(schemaOrRuleRefusal(A(["e", "g", "s", "n"], ["LP", "LR", "LM", "LI"]))?.path.startsWith("/alts/0/ngram")).toBe(true);
    expect(schemaOrRuleRefusal(A([], []))?.path.startsWith("/alts/0/ngram")).toBe(true);
  });

  it("[LDB-F44] the old string ngram is refused (schema type)", () => {
    expect(schemaOrRuleRefusal({ ngram: "gs", fingers: ["LP", "LI"] })?.path.startsWith("/alts/0/ngram")).toBe(true);
    expect(schemaOrRuleRefusal({ ngram: "g_s", fingers: ["LP", "_", "LI"] })).not.toBeNull();
  });

  it("[LDB-F44] an item that is not a string or null is refused (schema)", () => {
    for (const item of [3, true, {}, [], ""]) {
      expect(schemaOrRuleRefusal({ ngram: ["g", item], fingers: ["LP", "LI"] })?.path.startsWith("/alts/0/ngram"), JSON.stringify(item)).toBe(true);
    }
  });

  it("[LDB-F44] a two-code-point string item is refused", () => {
    expect(refusal({ alts: [A(["g", "se"], ["LP", "LI"])] })).toEqual({
      message: `alts[].ngram ["g","se"] has "se" at position 1; each item must be exactly one code point or null`,
      path: "/alts/0/ngram",
    });
  });

  it("[LDB-F44] astral code points count once: a lone astral item passes the length rule, the key check refuses it", () => {
    expect(refusal({ alts: [A(["\u{1F600}", "\u{1F601}"], ["LP", "LP"])] })).toEqual({
      message: `alts[].ngram ["\u{1F600}","\u{1F601}"] has "\u{1F600}", which is not one of this layout's keys`,
      path: "/alts/0/ngram",
    });
  });

  it("[LDB-F44] null at the start or end of a 3-item ngram is refused", () => {
    expect(refusal({ alts: [A([null, "g", "s"], [null, "LI", "LM"])] })).toEqual({
      message: `alts[].ngram [null,"g","s"] has a wildcard null at position 0; null is allowed only as the middle of a 3-item ngram`,
      path: "/alts/0/ngram",
    });
    expect(refusal({ alts: [A(["g", "s", null], ["LI", "LM", null])] })).toEqual({
      message: `alts[].ngram ["g","s",null] has a wildcard null at position 2; null is allowed only as the middle of a 3-item ngram`,
      path: "/alts/0/ngram",
    });
  });

  it("[LDB-F44] null in a 2-item ngram is refused (so is an all-null ngram)", () => {
    expect(refusal({ alts: [A(["g", null], ["LI", null])] })?.path).toBe("/alts/0/ngram");
    expect(refusal({ alts: [A([null, "g"], [null, "LI"])] })?.path).toBe("/alts/0/ngram");
    expect(refusal({ alts: [A([null, null], [null, null])] })?.path).toBe("/alts/0/ngram");
    expect(refusal({ alts: [A([null, null, null], [null, null, null])] })?.path).toBe("/alts/0/ngram");
  });

  it("[LDB-F44] every non-null item must be one of the layout's keys", () => {
    expect(refusal({ alts: [A(["g", "z", "s"], ["LP", "LI", "LP"])] })).toEqual({
      message: `alts[].ngram ["g","z","s"] has "z", which is not one of this layout's keys`,
      path: "/alts/0/ngram",
    });
    expect(refusal({ alts: [A(["g", null, "z"], ["LP", null, "LP"])] })?.path).toBe("/alts/0/ngram");
  });

  it("[LDB-F44] fingers entries must be finger codes or null (schema rule)", () => {
    const bad: unknown[] = [["LI", "XX"], ["LI", 3], ["li", "LM"], ["", "LM"], "LILM", 5, []];
    for (const fingers of bad) {
      const result = spark1.validate(payloadWith({ alts: [{ ngram: ["g", "s"], fingers } as unknown as Alt] }));
      expect(result.ok, JSON.stringify(fingers)).toBe(false);
      expect(String(result.ok ? "" : result.error.path).startsWith("/alts/0/fingers"), JSON.stringify(fingers)).toBe(true);
    }
  });

  it("[LDB-F44] the string \"_\" is no longer a fingers entry", () => {
    expect(schemaOrRuleRefusal(A(["g", null, "s"], ["LI", "_", "LM"]))?.path.startsWith("/alts/0/fingers")).toBe(true);
    expect(schemaOrRuleRefusal(A(["g", "s"], ["_", "LI"]))?.path.startsWith("/alts/0/fingers")).toBe(true);
  });

  it("[LDB-F44] the old map form of fingers is refused (schema type)", () => {
    const result = spark1.validate(payloadWith({ alts: [{ ngram: ["g", "s"], fingers: { "0": "LI" } } as unknown as Alt] }));
    expect(result.ok).toBe(false);
    expect(result.ok ? null : result.error.path).toBe("/alts/0/fingers");
  });

  it("[LDB-F44] fingers is required (schema rule)", () => {
    const result = spark1.validate(payloadWith({ alts: [{ ngram: ["g", "s"] } as unknown as Alt] }));
    expect(result.ok).toBe(false);
    expect(result.ok ? null : result.error.path).toBe("/alts/0");
  });

  it("[LDB-F44] every old-shape field is an unknown property", () => {
    for (const extra of [{ key: "g" }, { finger: "LI" }, { when: [] }, { except: [] }, { guard: true }]) {
      const result = spark1.validate(payloadWith({ alts: [{ ngram: ["g", "s"], fingers: ["LP", "LI"], ...extra } as unknown as Alt] }));
      expect(result.ok, JSON.stringify(extra)).toBe(false);
    }
  });

  it("[LDB-F44] fingers must have one entry per ngram item", () => {
    expect(refusal({ alts: [A(["g", "s", "e"], ["LI", "LM"])] })).toEqual({
      message: `alts[].fingers ["LI","LM"] must have one entry per item of ngram ["g","s","e"] (3), got 2`,
      path: "/alts/0/fingers",
    });
    expect(refusal({ alts: [A(["g", "s"], ["LI", "LM", "LM"])] })?.path).toBe("/alts/0/fingers");
    expect(refusal({ alts: [A(["g", null, "s"], ["LI", null])] })?.path).toBe("/alts/0/fingers");
  });

  it("[LDB-F44] a null ngram position needs null at the same index in fingers", () => {
    expect(refusal({ alts: [A(["g", null, "s"], ["LI", "LM", "LI"])] })).toEqual({
      message: `alts[].fingers ["LI","LM","LI"] must have null at position 1, where ngram ["g",null,"s"] has its wildcard`,
      path: "/alts/0/fingers",
    });
  });

  it("[LDB-F44] null in fingers is refused anywhere the ngram has a literal", () => {
    expect(refusal({ alts: [A(["g", "s"], [null, "LI"])] })).toEqual({
      message: `alts[].fingers [null,"LI"] has null at position 0, where ngram ["g","s"] has "g"; null belongs only at the ngram's wildcard`,
      path: "/alts/0/fingers",
    });
    expect(refusal({ alts: [A(["g", null, "s"], ["LI", null, null])] })?.path).toBe("/alts/0/fingers");
  });

  it("[LDB-F44] a code equal to the key's own finger (no move) is valid, even for every position", () => {
    // g and s are LM, e is LI, n is RI.
    expect(spark1.validate(payloadWith({ alts: [A(["g", "s"], ["LM", "LM"])] })).ok).toBe(true);
    expect(spark1.validate(payloadWith({ alts: [A(["e", null, "n"], ["LI", null, "RI"])] })).ok).toBe(true);
  });

  it("[LDB-F44] every finger code is accepted at any position", () => {
    for (const code of ["LP", "LR", "LM", "LI", "RI", "RM", "RR", "RP", "LT", "RT"]) {
      expect(spark1.validate(payloadWith({ alts: [A(["g", "s"], [code, code])] })).ok, code).toBe(true);
    }
  });

  it("[LDB-F44] decided non-check: an alt may name a one-character combo's output key", () => {
    // akldb is permissive; the analyzers refuse this combination themselves.
    const payload = payloadWith({ alts: [A(["g", "s"], ["LP", "LI"])], combos: [{ keys: ["e", "n"], output: "g" }] });
    expect(spark1.validate(payload).ok).toBe(true);
  });

  it("[LDB-F44] checks run in order: a bad ngram is reported before a bad fingers array", () => {
    expect(refusal({ alts: [A(["g", "z", "s"], ["LP", "LI", "LM"])] })?.path).toBe("/alts/0/ngram");
    expect(refusal({ alts: [A(["g", "s"], ["LP", "LI", "LM"])] })?.path).toBe("/alts/0/fingers");
  });

  it("[LDB-F44] no two alts may share an ngram (element-wise, null equals null)", () => {
    expect(refusal({ alts: [A(["g", "s"], ["LP", "LI"]), A(["e", "s"], ["LP", "RP"]), A(["g", "s"], ["LR", "RP"])] })).toEqual({
      message: `duplicate alts[].ngram ["g","s"]`,
      path: "/alts/2/ngram",
    });
    expect(refusal({ alts: [A(["g", null, "s"], ["LP", null, "LI"]), A(["g", null, "s"], ["LR", null, "RP"])] })?.path).toBe("/alts/1/ngram");
  });

  it("[LDB-F44] ngrams that differ only by wildcard or order are distinct", () => {
    const alts: Alt[] = [A(["g", "s"], ["LP", "LI"]), A(["s", "g"], ["LP", "LI"]), A(["g", null, "s"], ["LP", null, "LI"]), A(["g", "e", "s"], ["LP", "LI", "LI"])];
    expect(spark1.validate(payloadWith({ alts })).ok).toBe(true);
  });

  it("[LDB-F44] an error in a later alt names that alt's own index", () => {
    expect(refusal({ alts: [A(["g", "s"], ["LP", "LI"]), A(["n", "f"], ["RI"])] })?.path).toBe("/alts/1/fingers");
  });

  it("[LDB-F44] a record with alts lowers to mana2/1 with the alts dropped (documented loss) and combos kept", () => {
    const payload = payloadWith({
      alts: [{ ngram: ["g", "s"], fingers: ["LP", "LI"] }],
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
    expect(spark1.hasAlts(payloadWith({ alts: [{ ngram: ["g", "s"], fingers: ["LP", "LI"] }] }))).toBe(true);

    expect(spark1.hasCombos(payloadWith({}))).toBe(false);
    expect(spark1.hasCombos(payloadWith({ combos: [] }))).toBe(false);
    expect(spark1.hasCombos(payloadWith({ combos: [{ keys: ["g", "s"], output: "t" }] }))).toBe(true);
  });
});
