// [LDB-F14] `lower()` emits the same word-start row the site's compiler
// does (web/src/core/rules.ts's `magicRulesFlatCompile`, I-153): a magic
// key whose `default` is a LITERAL character also gets a
// `{inputs: ' '+key, output: ' '+default}` row, because word-initial text
// has no preceding board character for the ordinary scaffold to enumerate.
// Verified here against the site's own condition (rules.ts lines ~280-300):
// `repeat_previous` gets none, `except` does NOT suppress it (the site has
// no such list to consult), an explicit `magic_keys[].rules[]` entry for
// `after: ' '` DOES replace it (same carve-out every board char gets), and
// the row participates in collision detection like any other scaffold row.
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

function spaceRow(rows: ReturnType<typeof computeRows>, key: string) {
  return rows.find((r) => r.inputs === " " + key);
}

describe("magic word-start row (LDB-F14)", () => {
  it("[LDB-F14] a literal default gets a ' '+key -> ' '+default row, type default:<c>, from the key's own scaffold", () => {
    const magic: MagicIntent = { magic_keys: [{ key: "k", default: "y" }] };
    const rows = computeRows(magic, baseKeys());
    const row = spaceRow(rows, "k");
    expect(row).toEqual({ inputs: " k", output: " y", type: "default:y", from: "magic_keys[0]" });
  });

  it("[LDB-F14] repeat_previous gets NO word-start row (repeating a space types text nobody analyzes)", () => {
    const magic: MagicIntent = { magic_keys: [{ key: "k", default: "repeat_previous" }] };
    const rows = computeRows(magic, baseKeys());
    expect(spaceRow(rows, "k")).toBeUndefined();
  });

  it("[LDB-F14] default: 'none' gets no word-start row", () => {
    const magic: MagicIntent = { magic_keys: [{ key: "k", default: "none" }] };
    const rows = computeRows(magic, baseKeys());
    expect(spaceRow(rows, "k")).toBeUndefined();
  });

  it("[LDB-F14] except does NOT suppress the word-start row -- unlike every board-char row, the site has no except to consult for it", () => {
    const magic: MagicIntent = { magic_keys: [{ key: "k", default: "y", except: [" ", "a"] }] };
    const rows = computeRows(magic, baseKeys());
    // 'a' IS suppressed (an ordinary board char, except honoured as usual)...
    expect(rows.find((r) => r.inputs === "ak")).toBeUndefined();
    // ...but the word-start row survives even though ' ' is listed in except.
    expect(spaceRow(rows, "k")).toEqual({ inputs: " k", output: " y", type: "default:y", from: "magic_keys[0]" });
  });

  it("[LDB-F14] an explicit magic_keys[].rules[] entry for after=' ' REPLACES the word-start row (same carve-out as any board char)", () => {
    const magic: MagicIntent = {
      magic_keys: [{ key: "k", default: "y", rules: [{ after: " ", output: " q" }] }],
    };
    const rows = computeRows(magic, baseKeys());
    const wordStartRows = rows.filter((r) => r.inputs === " k");
    expect(wordStartRows).toHaveLength(1);
    expect(wordStartRows[0]).toEqual({ inputs: " k", output: " q", type: "magic", from: "magic_keys[0].rules[0]" });
    // Not a collision either -- validated the same way board-char explicit overrides are (collisions.test.ts).
    expect(findCollision(rows)).toBeNull();
  });

  it("[LDB-F14] a raw rule on ' '+key collides with the word-start row like any other row, WITHOUT a hint (except can't fix it)", () => {
    const magic: MagicIntent = {
      magic_keys: [{ key: "k", default: "y" }],
      rules: [{ inputs: " k", output: " z" }],
    };
    const rows = computeRows(magic, baseKeys());
    const collision = findCollision(rows);
    expect(collision).not.toBeNull();
    expect(collision!.inputs).toBe(" k");
    expect([...collision!.from].sort()).toEqual(["magic_keys[0]", "rules[0]"]);
    expect(collision!.hint).toBeUndefined(); // NOT { path: "magic_keys[0].except", add: " " } -- that hint would be a lie
  });

  it("[LDB-F14] except: [' '] does not remove the raw-rule collision either (except never governs this row)", () => {
    const magic: MagicIntent = {
      magic_keys: [{ key: "k", default: "y", except: [" "] }],
      rules: [{ inputs: " k", output: " z" }],
    };
    const rows = computeRows(magic, baseKeys());
    expect(findCollision(rows)).not.toBeNull();
  });

  it("[LDB-F14] two magic keys with different literal defaults each get their own word-start row, independently", () => {
    const magic: MagicIntent = {
      magic_keys: [
        { key: "k", default: "y" },
        { key: "l", default: "z" },
      ],
    };
    const rows = computeRows(magic, baseKeys());
    expect(spaceRow(rows, "k")).toMatchObject({ output: " y" });
    expect(spaceRow(rows, "l")).toMatchObject({ output: " z" });
    expect(findCollision(rows)).toBeNull();
  });

  it("[LDB-F14] a layout where ' ' is itself a genuine key does not double-emit the row (guarded against duplication)", () => {
    const keys = { ...baseKeys(), " ": { row: 3, col: 0, finger: "LT" } };
    const magic: MagicIntent = { magic_keys: [{ key: "k", default: "y" }] };
    const rows = computeRows(magic, keys as Record<string, Position>);
    const wordStartRows = rows.filter((r) => r.inputs === " k");
    expect(wordStartRows).toHaveLength(1); // from the ordinary board-char loop, not duplicated by the dedicated push
    expect(wordStartRows[0]!.type).toBe("default:y");
  });

  it("[LDB-F14] [LDB-F8] liftRules absorbs the word-start row back into the idiom -- no leftover, default recovered exactly", () => {
    const keys = baseKeys();
    const magic: MagicIntent = { magic_keys: [{ key: "k", default: "y" }] };
    const rows = computeRows(magic, keys);
    const { lifted, leftovers } = liftRules(
      rows.map(({ inputs, output, type }) => ({ inputs, output, type })),
      keys,
    );
    expect(leftovers).toEqual([]);
    expect(lifted.magic_keys).toEqual([{ key: "k", default: "y", rules: [] }]);
  });

  it("[LDB-F14] [LDB-F8] liftRules absorbs the word-start row even when it is the ONLY row for that key (every board char excepted)", () => {
    const keys = baseKeys();
    const boardChars = Object.keys(keys).filter((c) => c !== "k");
    const magic: MagicIntent = { magic_keys: [{ key: "k", default: "y", except: boardChars }] };
    const rows = computeRows(magic, keys);
    expect(rows).toEqual([{ inputs: " k", output: " y", type: "default:y", from: "magic_keys[0]" }]);
    const { lifted, leftovers } = liftRules(
      rows.map(({ inputs, output, type }) => ({ inputs, output, type })),
      keys,
    );
    expect(leftovers).toEqual([]);
    expect(lifted.magic_keys).toEqual([{ key: "k", default: "y", rules: [] }]);
  });
});
