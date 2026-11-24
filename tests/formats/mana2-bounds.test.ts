// [LDB-F72] spark/1 -> mana2/1 holds what mana2/1 cannot write, up front and in
// O(keys): a huge `col` (one skip token per empty column otherwise), six key
// rows (mana2's `fingers` holds five), a key that is not one token
// ("{}"), and a control character (a combo key naming a key mana2 lacks).
// No wall-clock assertions: the work is bounded by counting pushes.
import { describe, expect, it } from "vitest";
import * as spark1 from "../../formats/spark/1/index.ts";
import * as mana2_1 from "../../formats/mana2/1/index.ts";
import { translate } from "../../formats/registry.ts";
import { fromSpark, fromSparkOrHeld, MANA2_MAX_COLS } from "../../formats/mana2/1/translate.ts";
import type { Payload as SparkPayload } from "../../formats/spark/1/index.ts";

const base = (): SparkPayload => ({
  keys: [
    { char: "a", row: 0, col: 0, finger: "LP" },
    { char: "b", row: 0, col: 1, finger: "LR" },
  ],
});

function expectHeld(p: SparkPayload): { held: true; reason: string } {
  expect(spark1.validate(p).ok).toBe(true); // spark/1 itself stores it
  const r = fromSparkOrHeld(p) as { held?: true; reason: string };
  expect(r.held).toBe(true);
  const viaRegistry = translate({ format: "spark/1", payload: p }, "mana2/1");
  expect("held" in viaRegistry && viaRegistry.held).toBe(true);
  expect(() => fromSpark(p)).toThrow(/no mana2\/1 form/);
  return r as { held: true; reason: string };
}

describe("[LDB-F72] spark/1 -> mana2/1 refuses what mana2/1 cannot hold", () => {
  it.each([1e9, 1e308, MANA2_MAX_COLS, 4_000_000])("[LDB-F72] col %s is held without building a row per column", (col) => {
    const p = base();
    p.keys.push({ char: "c", row: 0, col, finger: "RP" });
    const orig = Array.prototype.push;
    let pushes = 0;
    Array.prototype.push = function (this: unknown[], ...items: unknown[]) {
      pushes++;
      return orig.apply(this, items);
    };
    try {
      expectHeld(p);
    } finally {
      Array.prototype.push = orig;
    }
    expect(pushes).toBeLessThan(200); // a loop over `col` would push millions of tokens
  });

  it("[LDB-F72] the widest accepted column still translates and validates", () => {
    const p = base();
    p.keys.push({ char: "c", row: 0, col: MANA2_MAX_COLS - 1, finger: "RP" });
    const r = fromSparkOrHeld(p);
    expect("held" in r).toBe(false);
    expect(mana2_1.validate(r).ok).toBe(true);
  });

  it("[LDB-F72] six rows (-1..4) is held; five rows (-1..3) is not", () => {
    const six = base();
    six.keys.push({ char: "1", row: -1, col: 0, finger: "LP" }, { char: "z", row: 4, col: 0, finger: "LP" });
    expectHeld(six);
    const five = base();
    five.keys.push({ char: "1", row: -1, col: 0, finger: "LP" }, { char: "z", row: 3, col: 0, finger: "LP" });
    const r = fromSparkOrHeld(five);
    expect("held" in r).toBe(false);
    expect(mana2_1.validate(r).ok).toBe(true);
  });

  it("[LDB-F72] thumb keys do not count towards the five rows", () => {
    const p = base();
    p.keys.push({ char: "1", row: -1, col: 0, finger: "LP" }, { char: "z", row: 3, col: 0, finger: "LP" }, { char: "t", row: 4, col: 0, finger: "LT" });
    const r = fromSparkOrHeld(p);
    expect("held" in r).toBe(false);
    expect(mana2_1.validate(r).ok).toBe(true);
  });

  it.each(["{}", "@nathrema", "ab"])("[LDB-F72] a multi-code-point key %j is held", (char) => {
    const p = base();
    p.keys.push({ char, row: 0, col: 2, finger: "LM" });
    expect(expectHeld(p).reason).toContain(JSON.stringify(char));
  });

  it("[LDB-F72] a multi-code-point key is held on a thumb too", () => {
    const p = base();
    p.keys.push({ char: "{}", row: 1, col: 0, finger: "LT" });
    expectHeld(p);
  });

  it.each(["\f", "\t", "\n", "\u00a0", "\u2028"])("[LDB-F72] a whitespace key %j, and a combo naming it, is held", (ch) => {
    const key = base();
    key.keys.push({ char: ch, row: 0, col: 2, finger: "LM" });
    expect(spark1.validate(key).ok).toBe(true);
    expectHeld(key);

    const combo = base();
    combo.keys.push({ char: ch, row: 0, col: 2, finger: "LM" });
    combo.combos = [{ keys: ["a", ch], output: "x" }];
    expect(spark1.validate(combo).ok).toBe(true);
    expectHeld(combo);
  });

  it.each(["\u0001", "\u0085"])("[LDB-F72] a control character %j that is not whitespace is one token and translates to a payload mana2/1 accepts", (ch) => {
    const p = base();
    p.keys.push({ char: ch, row: 0, col: 2, finger: "LM" });
    p.combos = [{ keys: ["a", ch], output: "x" }];
    const r = fromSparkOrHeld(p);
    expect("held" in r).toBe(false);
    expect(mana2_1.validate(r).ok).toBe(true);
  });

  it("[LDB-F72] space is still a key and a combo key", () => {
    const p = base();
    p.keys.push({ char: " ", row: 3, col: 0, finger: "LT" });
    p.combos = [{ keys: ["a", " "], output: "x" }];
    const r = fromSparkOrHeld(p);
    expect("held" in r).toBe(false);
    expect(mana2_1.validate(r).ok).toBe(true);
  });
});
