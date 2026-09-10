// [LDB-F15] `lower()` matches the site's compile on two more counts (found
// live via scripts/verify_magic_migration.py against production on
// neon/neon_colstag/stingray/tenders/jeep/rosewood/tanglewood/twister,
// 2026-09-10):
//
//   1. A magic key's board-char scaffold (repeat_previous or a literal
//      default) excludes EVERY magic key's own char and EVERY chiral key's
//      own char -- the site's `web/src/core/magicScaffold.ts` builds one
//      GLOBAL `special` set from `magic_keys[]`/`chiral_keys[]` and shares
//      it across every key's scaffold, not "just this key's own char".
//   2. A chiral key's scaffold enumerates EVERY layout key with a
//      resolvable hand, the chiral key's OWN char included -- same hand as
//      itself, so it always takes `same` (never `opposite`), producing a
//      self row (`web/src/core/rules.ts`'s chiral loop, `for (const k of
//      keys)`, no self-exclusion).
//
// A frozen row that only the (correctly narrowed) scaffold used to
// reproduce -- auditor's real, historical `b*->bb` ('b' its own magic
// key) -- still round-trips: `liftRules` promotes it into an EXPLICIT
// `magic_keys[].rules[]` override, verified end to end against that real
// fixture by lift.test.ts/roundtrip.test.ts. This file is the synthetic,
// narrowly-targeted counterpart: the existing LDB-F8 property test
// generator builds every construct from an EXCLUSIVE character partition
// on purpose (collision-free by construction), so it never places a
// magic/chiral key's own char as another key's `after` -- it cannot
// exercise this invariant at all, hence dedicated tests here.
import { describe, expect, it } from "vitest";
import { computeRows, findCollision, liftRules, type MagicIntent } from "../../formats/akl/1/magic.ts";
import type { Position } from "../../formats/akl/1/index.ts";

const LEFT = ["LP", "LR", "LM", "LI"];
const RIGHT = ["RP", "RR", "RM", "RI"];
function baseKeys(): Record<string, Position> {
  const chars = [..."abcdefghijklmnopqrst"];
  const keys: Record<string, Position> = {};
  chars.forEach((c, i) => {
    const left = i < 10;
    const fingers = left ? LEFT : RIGHT;
    keys[c] = { row: i % 3, col: i, finger: fingers[i % 4]! };
  });
  return keys;
}

describe("magic scaffold excludes every special char, not just its own (LDB-F15)", () => {
  it("[LDB-F15] a repeat_previous magic key's scaffold skips another magic key's own char", () => {
    const magic: MagicIntent = {
      magic_keys: [
        { key: "*", default: "repeat_previous" },
        { key: "b", default: "none", rules: [{ after: "r", output: "r." }] },
      ],
    };
    const rows = computeRows(magic, baseKeys());
    expect(rows.find((r) => r.inputs === "b*")).toBeUndefined(); // 'b' is itself a magic key -- excluded
    expect(rows.find((r) => r.inputs === "a*")).toEqual({ inputs: "a*", output: "aa", type: "repeat", from: "magic_keys[0]" }); // an ordinary board char still scaffolds normally
  });

  it("[LDB-F15] a literal-default magic key's scaffold skips a chiral key's own char", () => {
    const magic: MagicIntent = {
      magic_keys: [{ key: "*", default: "z" }],
      chiral_keys: [{ key: "c", same: "x", opposite: "y" }],
    };
    const rows = computeRows(magic, baseKeys());
    expect(rows.find((r) => r.inputs === "c*")).toBeUndefined(); // 'c' is itself a chiral key -- excluded
    expect(rows.find((r) => r.inputs === "a*")).toEqual({ inputs: "a*", output: "az", type: "default:z", from: "magic_keys[0]" });
  });

  it("[LDB-F15] an explicit magic_keys[].rules[] entry still fires unconditionally, even at another special key's char", () => {
    const magic: MagicIntent = {
      magic_keys: [
        { key: "*", default: "repeat_previous", rules: [{ after: "b", output: "bq" }] },
        { key: "b", default: "none", rules: [{ after: "r", output: "r." }] },
      ],
    };
    const rows = computeRows(magic, baseKeys());
    expect(rows.find((r) => r.inputs === "b*")).toEqual({ inputs: "b*", output: "bq", type: "magic", from: "magic_keys[0].rules[0]" });
    expect(findCollision(rows)).toBeNull(); // not a collision either -- there's no scaffold row on 'b*' left to collide with
  });

  it("[LDB-F15] except still governs every remaining board char (unaffected by the wider special-char exclusion)", () => {
    const magic: MagicIntent = {
      magic_keys: [{ key: "*", default: "repeat_previous", except: ["a"] }],
    };
    const rows = computeRows(magic, baseKeys());
    expect(rows.find((r) => r.inputs === "a*")).toBeUndefined();
    expect(rows.find((r) => r.inputs === "d*")).toEqual({ inputs: "d*", output: "dd", type: "repeat", from: "magic_keys[0]" });
  });
});

describe("chiral scaffold includes the chiral key's own char (LDB-F15)", () => {
  it("[LDB-F15] same-hand self row: chiral key + itself takes `same` (same hand as itself, trivially)", () => {
    const magic: MagicIntent = { chiral_keys: [{ key: "c", same: "x", opposite: "y" }] };
    const rows = computeRows(magic, baseKeys());
    expect(rows.find((r) => r.inputs === "cc")).toEqual({ inputs: "cc", output: "cx", type: "chiral", from: "chiral_keys[0]" });
  });

  it("[LDB-F15] self row doubles under repeat_previous, same as any other char", () => {
    const magic: MagicIntent = { chiral_keys: [{ key: "c", same: "repeat_previous", opposite: "y" }] };
    const rows = computeRows(magic, baseKeys());
    expect(rows.find((r) => r.inputs === "cc")).toEqual({ inputs: "cc", output: "cc", type: "chiral", from: "chiral_keys[0]" });
  });

  it("[LDB-F15] no self row when only `opposite` is set -- the self case is always same-hand, which has no value to emit", () => {
    const magic: MagicIntent = { chiral_keys: [{ key: "c", opposite: "y" }] };
    const rows = computeRows(magic, baseKeys());
    expect(rows.find((r) => r.inputs === "cc")).toBeUndefined();
  });

  it("[LDB-F15] a magic key's own char is still a perfectly good chiral scaffold char -- specialChars does not apply to chiral", () => {
    const magic: MagicIntent = {
      magic_keys: [{ key: "b", default: "none", rules: [{ after: "r", output: "r." }] }],
      chiral_keys: [{ key: "c", same: "x", opposite: "y" }],
    };
    const rows = computeRows(magic, baseKeys());
    // 'b' and 'c' are on the left hand (LEFT fingers, index < 10) -- same hand as 'c' itself.
    expect(rows.find((r) => r.inputs === "bc")).toEqual({ inputs: "bc", output: "bx", type: "chiral", from: "chiral_keys[0]" });
  });

  it("[LDB-F15] except on the chiral key suppresses its own self row too", () => {
    const magic: MagicIntent = { chiral_keys: [{ key: "c", same: "x", opposite: "y", except: ["c"] }] };
    const rows = computeRows(magic, baseKeys());
    expect(rows.find((r) => r.inputs === "cc")).toBeUndefined();
  });
});

describe("liftRules promotes an orphaned special-char-after row into an explicit override (LDB-F15)", () => {
  it("[LDB-F15] auditor's shape: a repeat row at another magic key's own char lifts as an explicit rule, not a default", () => {
    const keys = baseKeys();
    const original: MagicIntent = {
      magic_keys: [
        { key: "*", default: "repeat_previous" },
        { key: "b", default: "none", rules: [{ after: "r", output: "r." }] },
      ],
    };
    // A REAL lower() of this idiom (today's, already fixed) never carries
    // 'b*' at all -- 'b' is excluded from '*''s scaffold. Auditor's own
    // frozen upstream snapshot is exactly this shape PLUS that one extra
    // historical row (07 §5.1): simulate it by adding 'b*' back in by
    // hand, the same genuine leftover-from-history case lift.test.ts/
    // roundtrip.test.ts verify against the real fixture.
    const rows = computeRows(original, keys).map(({ inputs, output, type }) => ({ inputs, output, type }));
    expect(rows.find((r) => r.inputs === "b*")).toBeUndefined(); // sanity: confirms the scenario this test sets up
    rows.push({ inputs: "b*", output: "bb", type: "repeat" });

    const { lifted, leftovers } = liftRules(rows, keys);
    expect(leftovers).toEqual([]);
    const star = lifted.magic_keys.find((m) => m.key === "*")!;
    expect(star.default).toBe("repeat_previous");
    expect(star.rules).toEqual([{ after: "b", output: "bb" }]); // NOT folded into the default -- 'b' is excluded from '*''s scaffold now
    const b = lifted.magic_keys.find((m) => m.key === "b")!;
    expect(b.default).toBe("none");
    expect(b.rules).toEqual([{ after: "r", output: "r." }]);

    // Round trip: relowering the lifted idiom reproduces the exact same
    // (inputs, output) set, just with 'b*' now tagged "magic" instead of
    // "repeat" -- the SAME relabeling lift.test.ts/roundtrip.test.ts
    // tolerate for the real auditor fixture (LDB-F8).
    const relowered = computeRows({ magic_keys: lifted.magic_keys }, keys);
    const asPairs = (list: { inputs: string; output: string }[]) => new Set(list.map((r) => `${r.inputs}=${r.output}`));
    expect(asPairs(relowered)).toEqual(asPairs(rows));
    expect(relowered.find((r) => r.inputs === "b*")).toMatchObject({ output: "bb", type: "magic" });
  });

  it("[LDB-F15] the promoted row is never a leftover, and does not disturb an unrelated same-key literal default", () => {
    const keys = baseKeys();
    const rows = [
      { inputs: "a*", output: "az", type: "default:z" },
      { inputs: "b*", output: "bz", type: "default:z" }, // 'b' special, still consistent with the SAME default 'z'
      { inputs: "rb", output: "r.", type: "magic" },
    ];
    const { lifted, leftovers } = liftRules(rows, keys);
    expect(leftovers).toEqual([]);
    const star = lifted.magic_keys.find((m) => m.key === "*")!;
    expect(star.default).toBe("z");
    expect(star.rules).toEqual([{ after: "b", output: "bz" }]);
  });
});

describe("findCollision under the wider scaffold (LDB-F15)", () => {
  it("[LDB-F15] a chiral self row collides with a raw rule on the same inputs; the except hint actually resolves it", () => {
    const magic: MagicIntent = {
      chiral_keys: [{ key: "c", same: "x", opposite: "y" }],
      rules: [{ inputs: "cc", output: "cz" }],
    };
    const rows = computeRows(magic, baseKeys());
    const collision = findCollision(rows);
    expect(collision).not.toBeNull();
    expect(collision!.inputs).toBe("cc");
    expect(collision!.hint).toEqual({ path: "chiral_keys[0].except", add: "c" });

    // Applying the hint actually removes the collision (unlike LDB-F14's
    // word-start row, this scaffold source DOES honour `except`).
    const fixed: MagicIntent = { ...magic, chiral_keys: [{ key: "c", same: "x", opposite: "y", except: ["c"] }] };
    expect(findCollision(computeRows(fixed, baseKeys()))).toBeNull();
  });

  it("[LDB-F15] a special-char scaffold row can no longer exist to collide with anything -- the promoted explicit rule collides like any other explicit rule instead (no hint)", () => {
    const magic: MagicIntent = {
      magic_keys: [
        { key: "*", default: "repeat_previous", rules: [{ after: "b", output: "bq" }] },
        { key: "b", default: "none", rules: [{ after: "r", output: "r." }] },
      ],
      rules: [{ inputs: "b*", output: "bz" }],
    };
    const rows = computeRows(magic, baseKeys());
    const collision = findCollision(rows);
    expect(collision).not.toBeNull();
    expect([...collision!.from].sort()).toEqual(["magic_keys[0].rules[0]", "rules[0]"]);
    expect(collision!.hint).toBeUndefined(); // neither side is a scaffold row
  });
});
