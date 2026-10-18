// [LDB-F48..F50] design/alts/43-skip-magic-wire.md §1: skip magic on the
// wire. `magic_keys[].rules[].after` may be a 2-item array [a, b|null]
// (`[a, null]` = "after `a` and any one character"), and a magic key may
// default to {"kind":"skip_repeat"}. Rows with an array `inputs` are the
// any-middle tier; every string-only payload lowers exactly as before.
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import * as spark1 from "../../formats/spark/1/index.ts";
import type { Payload, Key } from "../../formats/spark/1/index.ts";
import { computeRows, findCollision, lower } from "../../formats/spark/1/magic.ts";
import { fromSpark } from "../../formats/mana2/1/translate.ts";
import { fromCmini } from "../../formats/adapters/cmini/translate.ts";
import type { Payload as CminiPayload } from "../../formats/adapters/cmini/index.ts";

const LEFT = ["LP", "LR", "LM", "LI"];
const RIGHT = ["RP", "RR", "RM", "RI"];
function baseKeys(): Key[] {
  return [..."abcdefghijklmnopqrst"].map((c, i) => ({ char: c, row: i % 3, col: i, finger: (i < 10 ? LEFT : RIGHT)[i % 4]! }));
}
function payloadWith(magic: Payload["magic"]): Payload {
  return { keys: baseKeys(), magic };
}
function charMap(p: Payload) {
  return Object.fromEntries(p.keys.filter((k) => k.char !== undefined).map((k) => [k.char!, { row: k.row, col: k.col, finger: k.finger }]));
}
const ok = (p: Payload) => spark1.validate(p);
function refusal(p: Payload) {
  const r = ok(p);
  expect(r.ok).toBe(false);
  return r.ok ? null : r.error;
}
// A rule with the given `after`, on magic key "k".
const rule = (after: unknown) => payloadWith({ magic_keys: [{ key: "k", rules: [{ after: after as string, emit: "z" }] }] });

describe("[LDB-F48] skip rule `after`: shape and code points", () => {
  it("[LDB-F48] accepts the string spelling, [a, null] and [a, b]", () => {
    expect(ok(rule("a"))).toEqual({ ok: true });
    expect(ok(rule("he"))).toEqual({ ok: true });
    expect(ok(rule(["a", null]))).toEqual({ ok: true });
    expect(ok(rule(["a", "b"]))).toEqual({ ok: true });
  });

  it("[LDB-F48] an astral code point is one code point", () => {
    expect(ok(rule(["\u{1F600}", null]))).toEqual({ ok: true });
  });

  it.each([
    [[null, "e"], "position 0"],
    [["h"], "after"],
    [["h", null, "e"], "after"],
    [["he", null], "position 0"],
    [["h", ""], "position 1"],
    [["h", "he"], "position 1"],
  ])("[LDB-F48] refuses %j with a path-naming message", (after, fragment) => {
    const err = refusal(rule(after));
    expect(err?.error).toBe("invalid_payload");
    expect(err?.path).toBe("/magic/magic_keys/0/rules/0/after");
    expect(String(err?.message)).toContain(fragment);
  });

  it("[LDB-F48] refuses non-string non-array shapes and the empty string", () => {
    expect(refusal(rule(5))?.error).toBe("invalid_payload");
    expect(refusal(rule(""))?.error).toBe("invalid_payload");
    expect(refusal(rule({ a: 1 }))?.error).toBe("invalid_payload");
  });

  it("[LDB-F48] schema is shape only: oneOf string / 2-item array", () => {
    const def = (spark1.schema as { $defs: Record<string, { properties: { after: { oneOf: Array<{ type: string; minItems?: number; maxItems?: number }> } } }> }).$defs.magicKeyRule!;
    const arr = def.properties.after.oneOf.find((o) => o.type === "array")!;
    expect([arr.minItems, arr.maxItems]).toEqual([2, 2]);
  });
});

describe("[LDB-F48] duplicates use the canonical context", () => {
  const dup = (a: unknown, b: unknown) => payloadWith({ magic_keys: [{ key: "k", rules: [{ after: a as string, emit: "x" }, { after: b as string, emit: "y" }] }] });
  it('[LDB-F48] "he" and ["h","e"] are duplicates', () => {
    expect(refusal(dup("he", ["h", "e"]))?.path).toBe("/magic/magic_keys/0/rules/1/after");
    expect(refusal(dup(["h", "e"], "he"))?.path).toBe("/magic/magic_keys/0/rules/1/after");
  });
  it('[LDB-F48] "h" and ["h", null] are not; two ["h", null] are', () => {
    expect(ok(dup("h", ["h", null]))).toEqual({ ok: true });
    expect(refusal(dup(["h", null], ["h", null]))?.path).toBe("/magic/magic_keys/0/rules/1/after");
  });
  it("[LDB-F48] a string holding U+0000 never equals [a, null]", () => {
    expect(ok(dup(["h", null], "h\u0000"))).toEqual({ ok: true });
  });
});

describe("[LDB-F48] lowering of array afters", () => {
  it("[LDB-F48] [a, null] lowers to a structured row and never replaces a one-back scaffold row", () => {
    const p = payloadWith({ magic_keys: [{ key: "k", default: { kind: "repeat" }, rules: [{ after: ["a", null], emit: "z" }] }] });
    expect(ok(p)).toEqual({ ok: true });
    const rows = lower(p.magic, charMap(p));
    expect(rows).toContainEqual({ inputs: ["a", null, "k"], output: ["a", null, "z"], type: "magic" });
    expect(rows).toContainEqual({ inputs: "ak", output: "aa", type: "repeat" }); // one-back scaffold stays
    expect(computeRows(p.magic, charMap(p)).find((r) => Array.isArray(r.inputs))?.from).toBe("magic_keys[0].rules[0]");
  });

  it("[LDB-F48] [a, b] lowers exactly like the string ab, replacing nothing it would not", () => {
    const viaArray = payloadWith({ magic_keys: [{ key: "k", default: { kind: "repeat" }, rules: [{ after: ["a", "b"], emit: "z" }] }] });
    const viaString = payloadWith({ magic_keys: [{ key: "k", default: { kind: "repeat" }, rules: [{ after: "ab", emit: "z" }] }] });
    expect(JSON.stringify(lower(viaArray.magic, charMap(viaArray)))).toBe(JSON.stringify(lower(viaString.magic, charMap(viaString))));
    expect(lower(viaArray.magic, charMap(viaArray))).toContainEqual({ inputs: "abk", output: "abz", type: "magic" });
  });

  it("[LDB-F48] a skip rule and a one-back rule on the same char coexist; no collision", () => {
    const p = payloadWith({ magic_keys: [{ key: "k", rules: [{ after: "a", emit: "x" }, { after: ["a", null], emit: "y" }] }] });
    expect(ok(p)).toEqual({ ok: true });
    const rows = lower(p.magic, charMap(p));
    expect(rows).toContainEqual({ inputs: "ak", output: "ax", type: "magic" });
    expect(rows).toContainEqual({ inputs: ["a", null, "k"], output: ["a", null, "y"], type: "magic" });
  });

  it("[LDB-F48] a skip row can never collide with a string row, even a raw one with underscores", () => {
    const p = payloadWith({ magic_keys: [{ key: "k", rules: [{ after: ["a", null], emit: "y" }] }], rules: [{ inputs: "a_k", output: "a_y" }] });
    expect(ok(p)).toEqual({ ok: true });
    expect(findCollision(computeRows(p.magic, charMap(p)))).toBeNull();
  });

  it("[LDB-F48] two skip rows on the same [a, null] from two keys sharing nothing do not collide; same key is refused earlier", () => {
    const p = payloadWith({ magic_keys: [{ key: "k", rules: [{ after: ["a", null], emit: "x" }] }, { key: "l", rules: [{ after: ["a", null], emit: "y" }] }] });
    expect(ok(p)).toEqual({ ok: true });
  });
});

describe("[LDB-F49] skip_repeat default", () => {
  const SPECIAL = new Set(["k"]);
  const boardChars = (excl: string[] = []) => baseKeys().map((k) => k.char!).filter((c) => !SPECIAL.has(c) && !excl.includes(c));

  it("[LDB-F49] scaffolds [c, null, key] -> [c, null, c] for every board char, in code point order, no space row", () => {
    const p = payloadWith({ magic_keys: [{ key: "k", default: { kind: "skip_repeat" } }] });
    expect(ok(p)).toEqual({ ok: true });
    const rows = lower(p.magic, charMap(p));
    expect(rows).toEqual(boardChars().sort().map((c) => ({ inputs: [c, null, "k"], output: [c, null, c], type: "skip_repeat" })));
    expect(computeRows(p.magic, charMap(p))[0]!.from).toBe("magic_keys[0]");
  });

  it("[LDB-F49] a space key on the board still gets no row (whitespace never scaffolds)", () => {
    const p = payloadWith({ magic_keys: [{ key: "k", default: { kind: "skip_repeat" } }] });
    p.keys.push({ char: " ", row: 3, col: 5, finger: "LT" });
    expect(lower(p.magic, charMap(p)).some((r) => Array.isArray(r.inputs) && r.inputs[0] === " ")).toBe(false);
  });

  it("[LDB-F49] honours except and other magic/chiral keys, like repeat", () => {
    const p = payloadWith({ magic_keys: [{ key: "k", default: { kind: "skip_repeat" }, except: ["b"] }, { key: "m", default: { kind: "repeat" } }] });
    const rows = computeRows(p.magic, charMap(p)).filter((r) => r.from === "magic_keys[0]");
    const firsts = rows.map((r) => (r.inputs as (string | null)[])[0]);
    expect(firsts).not.toContain("b");
    expect(firsts).not.toContain("k");
    expect(firsts).not.toContain("m");
    expect(firsts).toContain("a");
    // the char set equals what a repeat default scaffolds
    const rep = computeRows({ magic_keys: [{ key: "k", default: { kind: "repeat" }, except: ["b"] }, { key: "m", default: { kind: "repeat" } }] }, charMap(p)).filter((r) => r.from === "magic_keys[0]");
    expect(rep.map((r) => (r.inputs as string)[0])).toEqual(firsts);
  });

  it("[LDB-F49] an explicit [c, null] rule replaces the scaffold row; a string rule does not", () => {
    const p = payloadWith({ magic_keys: [{ key: "k", default: { kind: "skip_repeat" }, rules: [{ after: ["a", null], emit: "z" }, { after: "b", emit: "y" }] }] });
    expect(ok(p)).toEqual({ ok: true });
    const rows = lower(p.magic, charMap(p));
    expect(rows.filter((r) => Array.isArray(r.inputs) && r.inputs[0] === "a")).toEqual([{ inputs: ["a", null, "k"], output: ["a", null, "z"], type: "magic" }]);
    expect(rows).toContainEqual({ inputs: ["b", null, "k"], output: ["b", null, "b"], type: "skip_repeat" });
    expect(rows).toContainEqual({ inputs: "bk", output: "by", type: "magic" });
  });

  it("[LDB-F49] a mixed key (skip_repeat default + string rules) lowers both tiers", () => {
    const p = payloadWith({ magic_keys: [{ key: "k", default: { kind: "skip_repeat" }, rules: [{ after: "h", emit: "e" }] }] });
    const rows = lower(p.magic, charMap(p));
    expect(rows.filter((r) => typeof r.inputs === "string")).toEqual([{ inputs: "hk", output: "he", type: "magic" }]);
    expect(rows.filter((r) => Array.isArray(r.inputs)).length).toBe(boardChars().length);
  });

  it("[LDB-F49] two magic keys with skip_repeat do not collide (different key in the row)", () => {
    const p = payloadWith({ magic_keys: [{ key: "k", default: { kind: "skip_repeat" } }, { key: "m", default: { kind: "skip_repeat" } }] });
    expect(ok(p)).toEqual({ ok: true });
  });

  it("[LDB-F49] a raw rule on a skip_repeat key's one-back inputs is not a collision (different tier)", () => {
    const p = payloadWith({ magic_keys: [{ key: "k", default: { kind: "skip_repeat" } }], rules: [{ inputs: "ak", output: "ax" }] });
    expect(ok(p)).toEqual({ ok: true });
  });

  it("[LDB-F49] isScaffold recognises the rows via their `from`", async () => {
    const { isScaffold } = await import("../../formats/spark/1/magic.ts");
    const p = payloadWith({ magic_keys: [{ key: "k", default: { kind: "skip_repeat" } }] });
    expect(computeRows(p.magic, charMap(p)).every((r) => isScaffold(r.from))).toBe(true);
  });

  it("[LDB-F49] a chiral key refuses skip_repeat for same and opposite (schema and semantics)", () => {
    for (const side of ["same", "opposite"] as const) {
      const p = payloadWith({ chiral_keys: [{ key: "k", [side]: { kind: "skip_repeat" } }] });
      const err = refusal(p);
      expect(err?.error).toBe("invalid_payload");
    }
    const chiral = (spark1.schema as { $defs: Record<string, { oneOf: Array<{ properties: { kind: { const: string } } }> }> }).$defs.chiralValue!;
    expect(chiral.oneOf.map((o) => o.properties.kind.const)).toEqual(["repeat", "char"]);
  });

  it("[LDB-F49] a default that is some other kind is still refused", () => {
    const p = payloadWith({ magic_keys: [{ key: "k", default: { kind: "nope" } as never }] });
    expect(refusal(p)?.error).toBe("invalid_payload");
  });
});

describe("[LDB-F50] mana2/1 export drops skip rows, keeps the rest", () => {
  it("[LDB-F50] array-inputs rows (skip rules and skip_repeat scaffolds) are dropped", () => {
    const p = payloadWith({
      magic_keys: [
        { key: "k", default: { kind: "skip_repeat" }, rules: [{ after: "h", emit: "e" }, { after: ["a", null], emit: "z" }] },
        { key: "m", default: { kind: "repeat" } },
      ],
    });
    expect(ok(p)).toEqual({ ok: true });
    const out = fromSpark(p);
    const rules = out.magic!.rules ?? [];
    expect(rules).toContainEqual({ inputs: "hk", output: "he" });
    expect(rules).toContainEqual({ inputs: "am", output: "aa" });
    expect(rules.every((r) => typeof r.inputs === "string" && !r.inputs.includes("\u0000"))).toBe(true);
    const string = lower(p.magic, charMap(p)).filter((r) => typeof r.inputs === "string");
    expect(rules.map((r) => r.inputs)).toEqual(string.map((r) => r.inputs));
  });
});

describe("[LDB-F48] cmini import never yields an array row", () => {
  it("[LDB-F48] fromCmini output carries only string afters and string raw rows", () => {
    const dir = path.resolve(import.meta.dirname, "..", "..", "formats", "adapters", "cmini", "fixtures");
    const stems = fs.readdirSync(dir).filter((f) => /^\d+-[^.]+\.json$/.test(f));
    let withMagic = 0;
    for (const f of stems) {
      const out = fromCmini(JSON.parse(fs.readFileSync(path.join(dir, f), "utf8")) as CminiPayload);
      const m = out.magic;
      if (!m) continue;
      withMagic++;
      for (const mk of m.magic_keys ?? []) {
        expect(mk.default === undefined || mk.default.kind !== "skip_repeat").toBe(true);
        for (const r of mk.rules ?? []) expect(typeof r.after).toBe("string");
      }
      for (const r of m.rules ?? []) {
        expect(typeof r.inputs).toBe("string");
        expect(typeof r.output).toBe("string");
      }
    }
    expect(withMagic).toBeGreaterThan(3);
  });
});

describe("[LDB-F48] a skip rule's characters are magic-named (LDB-F33)", () => {
  it("[LDB-F48] refuses [a, null] / [a, b] when a or b sits on more than one position, as a string `after` does", () => {
    const dup = (after: unknown, ch: string) => {
      const p = rule(after);
      p.keys.push({ char: ch, row: 3, col: 0, finger: "LP" });
      return p;
    };
    expect(refusal(dup(["a", null], "a"))?.error).toBe("magic_needs_unique_key");
    expect(refusal(dup(["a", "b"], "b"))?.error).toBe("magic_needs_unique_key");
    expect(refusal(dup("a", "a"))?.error).toBe("magic_needs_unique_key");
    expect(ok(dup(["a", null], "c"))).toEqual({ ok: true }); // the null names nothing
  });
});

describe("[LDB-F51] skip chiral keys (design/alts/43 section 2e)", () => {
  const chiralPayload = (ck: Record<string, unknown>) => payloadWith({ chiral_keys: [{ key: "k", ...ck } as never] });
  it("[LDB-F51] accepts skip: true, refuses any other value", () => {
    expect(ok(chiralPayload({ same: { kind: "repeat" }, opposite: { kind: "char", char: "z" }, skip: true }))).toEqual({ ok: true });
    for (const bad of [false, "yes", 1, null]) expect(ok(chiralPayload({ same: { kind: "repeat" }, skip: bad })).ok, String(bad)).toBe(false);
  });
  it("[LDB-F51] compiles to any-middle rows by the hand of each board character, repeat = that character; except honoured; plain chiral unchanged", () => {
    const p = chiralPayload({ same: { kind: "repeat" }, opposite: { kind: "char", char: "z" }, skip: true, except: ["b"] });
    const keys = charMap(p);
    const rows = computeRows(p.magic, keys).filter((r) => r.from === "chiral_keys[0]");
    const kHand = keys["k"]!.finger[0];
    expect(rows.length).toBe(Object.keys(keys).length - 1); // every board character but the except'ed one
    for (const r of rows) {
      expect(Array.isArray(r.inputs)).toBe(true);
      const [c, mid, key] = r.inputs as [string, null, string];
      expect([mid, key]).toEqual([null, "k"]);
      expect(r.output).toEqual([c, null, keys[c]!.finger[0] === kHand ? c : "z"]);
    }
    expect(rows.some((r) => (r.inputs as string[])[0] === "b")).toBe(false);
    const plain = computeRows(chiralPayload({ same: { kind: "repeat" }, opposite: { kind: "char", char: "z" } }).magic, keys).filter((r) => r.from === "chiral_keys[0]");
    expect(plain.every((r) => typeof r.inputs === "string")).toBe(true);
    expect(ok(p)).toEqual({ ok: true });
  });
  it("[LDB-F51] ?as=mana2/1 drops the skip chiral rows (no wildcard in mana2)", () => {
    const p = chiralPayload({ same: { kind: "repeat" }, skip: true });
    const out = fromSpark(p) as { magic: { rules: { inputs: unknown }[] } };
    expect(out.magic.rules.every((r) => typeof r.inputs === "string")).toBe(true);
  });
});
