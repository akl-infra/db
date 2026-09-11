// [LDB-F4] Lowering collisions (01-format.md §3, "D4"), as amended
// 2026-09-11 (saltorbit: "layoutdb validation rules for the spark format should
// match what we already have with aklgg"): rows produced by IDIOMS that
// share `inputs` are resolved exactly as akl.gg's compile resolves them
// (web/src/core/rules.ts `magicRulesFlatCompile`): phase order scaffold
// (magic keys) < chiral scaffold < explicit rules < adaptive swaps, the
// LAST row for an `inputs` wins. A collision a RAW `rules[]` row is part of
// is still refused, with `from` naming both sources and a `hint` naming the
// `except` entry that would remove it whenever the other side is a scaffold
// row (akl.gg has no raw rows, so nothing there to match).
//
// Structurally unreachable pairs (unchanged): repeat/default/explicit rows
// share `inputs = after + KEY` for one magic key, which has one `default`
// and at most one rule per `after`; two chiral keys end in different
// chars; a magic key and a chiral key are never the same char; two swaps
// sharing (trigger, member) are refused by validateMagicSemantics first.
// What CAN overlap is a magic/chiral key's own char reused as an adaptive
// swap member (the bunya pattern) or a raw rule's second char.
import { describe, expect, it } from "vitest";
import * as spark1 from "../../formats/spark/1/index.ts";
import type { Payload, Position } from "../../formats/spark/1/index.ts";

// A small layout wide enough for every case: A-J on the left hand (LP..LI
// cycling), K-T on the right (RP..RI cycling) -- chiral needs two real
// hands, everything else just needs real keys.
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

function payloadWith(magic: Payload["magic"]): Payload {
  return { keys: baseKeys(), magic };
}

// The idiom-overlap cases: validate() accepts, and the compiled rows carry
// exactly one row for `inputs`, the akl.gg winner.
function expectResolved(payload: Payload, inputs: string, output: string) {
  const result = spark1.validate(payload);
  expect(result).toEqual({ ok: true });
  const rows = spark1.compileMagic(payload).filter((r) => r.inputs === inputs);
  expect(rows.map((r) => r.output)).toEqual([output]);
}

function expectCollision(payload: Payload, expectFrom: [string, string] | "any", expectHint: { path: string; add: string } | "none" | "any" = "any") {
  const result = spark1.validate(payload);
  expect(result.ok).toBe(false);
  if (result.ok) return;
  expect(result.error.error).toBe("magic_collision");
  if (expectFrom !== "any") {
    expect([...(result.error.from as string[])].sort()).toEqual([...expectFrom].sort());
  }
  if (expectHint === "none") {
    expect(result.error.hint).toBeUndefined();
  } else if (expectHint !== "any") {
    expect(result.error.hint).toEqual(expectHint);
  }
}

describe("magic_collision matrix (LDB-F4, amended: idiom overlaps resolve as akl.gg does)", () => {
  // -- {repeat, default:<c>, explicit} scaffold/override vs adaptive half --
  // 'a' is the trigger; 'k' is BOTH the magic key's own char and one of the
  // adaptive swap's members -- the bunya pattern (01 §3).

  it("[LDB-F4] repeat scaffold x adaptive half: resolved, the swap wins (akl.gg's order)", () => {
    const payload = payloadWith({
      magic_keys: [{ key: "k", default: "repeat_previous" }],
      adaptive_swaps: [{ trigger: "a", swap: ["k", "b"] }],
    });
    // scaffold would be ak -> aa; the swap's k-half emits what b would: ab
    expectResolved(payload, "ak", "ab");
  });

  it("[LDB-F4] default:<c> scaffold x adaptive half: resolved, the swap wins", () => {
    const payload = payloadWith({
      magic_keys: [{ key: "k", default: "z" }],
      adaptive_swaps: [{ trigger: "a", swap: ["k", "b"] }],
    });
    expectResolved(payload, "ak", "ab");
  });

  it("[LDB-F4] explicit rule x adaptive half: resolved, the swap wins", () => {
    const payload = payloadWith({
      magic_keys: [{ key: "k", default: "none", rules: [{ after: "a", output: "az" }] }],
      adaptive_swaps: [{ trigger: "a", swap: ["k", "b"] }],
    });
    expectResolved(payload, "ak", "ab");
  });

  // -- {repeat, default:<c>, explicit} vs a raw rule naming the same inputs --

  it("[LDB-F4] repeat scaffold x raw rule collide; hint excepts the scaffold", () => {
    const payload = payloadWith({
      magic_keys: [{ key: "k", default: "repeat_previous" }],
      rules: [{ inputs: "ak", output: "az" }],
    });
    expectCollision(payload, ["magic_keys[0]", "rules[0]"], { path: "magic_keys[0].except", add: "a" });
  });

  it("[LDB-F4] default:<c> scaffold x raw rule collide; hint excepts the scaffold", () => {
    const payload = payloadWith({
      magic_keys: [{ key: "k", default: "z" }],
      rules: [{ inputs: "ak", output: "ay" }],
    });
    expectCollision(payload, ["magic_keys[0]", "rules[0]"], { path: "magic_keys[0].except", add: "a" });
  });

  it("[LDB-F4] explicit rule x raw rule collide; no hint", () => {
    const payload = payloadWith({
      magic_keys: [{ key: "k", default: "none", rules: [{ after: "a", output: "az" }] }],
      rules: [{ inputs: "ak", output: "ay" }],
    });
    expectCollision(payload, ["magic_keys[0].rules[0]", "rules[0]"], "none");
  });

  // -- an explicit rule on the SAME key/after as its own scaffold: NOT a
  // collision (01 §3: it replaces the scaffold row) --

  it("[LDB-F4] repeat scaffold + an explicit override for the SAME after: not a collision", () => {
    const payload = payloadWith({
      magic_keys: [{ key: "k", default: "repeat_previous", rules: [{ after: "a", output: "az" }] }],
    });
    const result = spark1.validate(payload);
    expect(result.ok).toBe(true);
  });

  it("[LDB-F4] default:<c> scaffold + an explicit override for the SAME after: not a collision", () => {
    const payload = payloadWith({
      magic_keys: [{ key: "k", default: "z", rules: [{ after: "a", output: "aq" }] }],
    });
    const result = spark1.validate(payload);
    expect(result.ok).toBe(true);
  });

  // -- chiral scaffold vs adaptive half / raw rule --

  it("[LDB-F4] chiral scaffold x adaptive half: resolved, the swap wins", () => {
    const payload = payloadWith({
      chiral_keys: [{ key: "k", same: "z", opposite: "y" }],
      adaptive_swaps: [{ trigger: "a", swap: ["k", "b"] }],
    });
    expectResolved(payload, "ak", "ab");
  });

  it("[LDB-F4] gallyoid's shape (single-char default key vs several swaps on it): every overlap resolved, the swaps win", () => {
    const payload = payloadWith({
      magic_keys: [{ key: "d", default: "d", rules: [{ after: "b", output: "bl" }] }],
      adaptive_swaps: [
        { trigger: "t", swap: ["h", "d"] },
        { trigger: "s", swap: ["h", "d"] },
        { trigger: "c", swap: ["h", "d"] },
      ],
    });
    for (const t of ["t", "s", "c"]) expectResolved(payload, `${t}d`, `${t}h`);
    expectResolved(payload, "ed", "ed"); // no swap there: the scaffold row stays
    expectResolved(payload, "bd", "bl"); // the explicit rule beats the scaffold
  });

  it("[LDB-F4] chiral scaffold x raw rule collide; hint excepts the scaffold", () => {
    const payload = payloadWith({
      chiral_keys: [{ key: "k", same: "z", opposite: "y" }],
      rules: [{ inputs: "ak", output: "aq" }],
    });
    expectCollision(payload, ["chiral_keys[0]", "rules[0]"], { path: "chiral_keys[0].except", add: "a" });
  });

  // -- adaptive half vs raw rule; raw rule vs raw rule --

  it("[LDB-F4] adaptive half x raw rule collide; no hint (neither is a scaffold)", () => {
    const payload = payloadWith({
      adaptive_swaps: [{ trigger: "a", swap: ["k", "b"] }],
      rules: [{ inputs: "ak", output: "az" }],
    });
    expectCollision(payload, ["adaptive_swaps[0]", "rules[0]"], "none");
  });

  it("[LDB-F4] raw rule x raw rule collide (two rows claim one `inputs`); no hint", () => {
    const payload = payloadWith({
      rules: [
        { inputs: "ak", output: "az" },
        { inputs: "ak", output: "ay" },
      ],
    });
    expectCollision(payload, ["rules[0]", "rules[1]"], "none");
  });

  // -- except removes the collision --

  it("[LDB-F4] except removes the repeat-scaffold/adaptive-half collision (bunya)", () => {
    const payload = payloadWith({
      magic_keys: [{ key: "k", default: "repeat_previous", except: ["a"] }],
      adaptive_swaps: [{ trigger: "a", swap: ["k", "b"] }],
    });
    const result = spark1.validate(payload);
    expect(result.ok).toBe(true);
  });

  it("[LDB-F4] except removes the default-scaffold/raw-rule collision", () => {
    const payload = payloadWith({
      magic_keys: [{ key: "k", default: "z", except: ["a"] }],
      rules: [{ inputs: "ak", output: "ay" }],
    });
    const result = spark1.validate(payload);
    expect(result.ok).toBe(true);
  });
});
