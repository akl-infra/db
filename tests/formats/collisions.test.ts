// [LDB-F4] Lowering collisions (01-format.md §3, "D4") are refused, never
// resolved, with `from` naming both sources and a `hint` naming the
// `except` entry that would remove the collision whenever one side is a
// scaffold row.
//
// The brief matrix is {repeat scaffold, default:<c> scaffold, explicit
// rule, chiral scaffold, adaptive half, raw rule}². Most of the 36 cells
// are STRUCTURALLY UNREACHABLE, not skipped for convenience -- worth
// spelling out once, here, rather than silently:
//   - repeat scaffold, default:<c> scaffold and explicit rule all share
//     the shape `inputs = after + KEY`, where KEY is a specific magic
//     key's own char. Two of them can only collide by sharing that KEY --
//     but a single magic_keys[] entry has exactly one `default` (so
//     "repeat vs default" on the same key is a contradiction in terms) and
//     at most one rule per `after` (a second explicit rule for the same
//     `after` is `duplicate rule.after`, refused by validateMagicSemantics
//     BEFORE the collision check ever runs) -- so repeat×default,
//     repeat×repeat, default×default, explicit×explicit and any of the
//     three against a DIFFERENT magic key's version of itself cannot
//     collide at all. The one live interaction inside this group is
//     "explicit rule on key K, after A" vs "K's own scaffold row for A" --
//     tested below as the documented NON-collision (the explicit rule
//     replaces the scaffold row).
//   - chiral scaffold vs itself: same reasoning (a second chiral_keys[]
//     entry needs a different `key`, so its rows always end in a different
//     char). A magic key and a chiral key can never be the same char
//     either (validated separately), so magic-scaffold × chiral-scaffold
//     cannot collide.
//   - adaptive × adaptive: two swaps sharing a (trigger, member) pair is
//     `adaptive_swaps entries collide`, again caught by
//     validateMagicSemantics before the collision check runs.
// What CAN collide is a magic/chiral key's own char being reused as an
// ADAPTIVE SWAP MEMBER or a RAW RULE's literal second char (the bunya
// pattern this format's own design doc walks through), or two raw rules
// sharing a literal `inputs` outright. That's the matrix below.
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

describe("magic_collision matrix (LDB-F4)", () => {
  // -- {repeat, default:<c>, explicit} scaffold/override vs adaptive half --
  // 'a' is the trigger; 'k' is BOTH the magic key's own char and one of the
  // adaptive swap's members -- the bunya pattern (01 §3).

  it("[LDB-F4] repeat scaffold x adaptive half collide; hint excepts the scaffold", () => {
    const payload = payloadWith({
      magic_keys: [{ key: "k", default: "repeat_previous" }],
      adaptive_swaps: [{ trigger: "a", swap: ["k", "b"] }],
    });
    expectCollision(payload, ["magic_keys[0]", "adaptive_swaps[0]"], { path: "magic_keys[0].except", add: "a" });
  });

  it("[LDB-F4] default:<c> scaffold x adaptive half collide; hint excepts the scaffold", () => {
    const payload = payloadWith({
      magic_keys: [{ key: "k", default: "z" }],
      adaptive_swaps: [{ trigger: "a", swap: ["k", "b"] }],
    });
    expectCollision(payload, ["magic_keys[0]", "adaptive_swaps[0]"], { path: "magic_keys[0].except", add: "a" });
  });

  it("[LDB-F4] explicit rule x adaptive half collide; no hint (neither side is a scaffold row)", () => {
    const payload = payloadWith({
      magic_keys: [{ key: "k", default: "none", rules: [{ after: "a", output: "az" }] }],
      adaptive_swaps: [{ trigger: "a", swap: ["k", "b"] }],
    });
    expectCollision(payload, ["magic_keys[0].rules[0]", "adaptive_swaps[0]"], "none");
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

  it("[LDB-F4] chiral scaffold x adaptive half collide; hint excepts the scaffold", () => {
    const payload = payloadWith({
      chiral_keys: [{ key: "k", same: "z", opposite: "y" }],
      adaptive_swaps: [{ trigger: "a", swap: ["k", "b"] }],
    });
    expectCollision(payload, ["chiral_keys[0]", "adaptive_swaps[0]"], { path: "chiral_keys[0].except", add: "a" });
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
