// [LDB-F52] formats/spark/1/withhold.ts: the pure function that turns a
// spark/1 payload into its 1.28 shape. [LDB-F53] skip-and-read: what a
// client reading the withheld payload compiles is a subset of what the full
// payload compiles, exactly (never a row the full payload would not have).
import { describe, expect, it } from "vitest";
import * as spark1 from "../../formats/spark/1/index.ts";
import { usesSkip, withholdSkip } from "../../formats/spark/1/withhold.ts";
import { SKIP_PAYLOADS } from "../fixtures/skip-payloads.ts";

const key = (r: { inputs: unknown; output: unknown }) => JSON.stringify([r.inputs, r.output]);

describe("[LDB-F52] withholdSkip", () => {
  it("[LDB-F52] returns the same object, withheld false, when nothing uses skip", () => {
    const p = { keys: [], magic: { magic_keys: [{ key: "k", default: { kind: "char", char: "e" }, rules: [{ after: "h", emit: "e" }] }], chiral_keys: [{ key: "c", same: { kind: "repeat" } }] } };
    const out = withholdSkip(p);
    expect(out.withheld).toBe(false);
    expect(out.payload).toBe(p);
    expect(withholdSkip({ keys: [] }).withheld).toBe(false);
    expect(usesSkip(p)).toBe(false);
  });

  it("[LDB-F52] removes a skip_repeat default, keeps the key and its other fields", () => {
    const p = { keys: [], magic: { magic_keys: [{ key: "k", default: { kind: "skip_repeat" }, rules: [{ after: "h", emit: "e" }], except: ["x"] }] } };
    const out = withholdSkip(p);
    expect(out.withheld).toBe(true);
    expect(out.payload).toEqual({ keys: [], magic: { magic_keys: [{ key: "k", rules: [{ after: "h", emit: "e" }], except: ["x"] }] } });
    expect(p.magic.magic_keys[0]!.default).toEqual({ kind: "skip_repeat" }); // input untouched
  });

  it("[LDB-F52] removes array-`after` rules, keeps string ones in order, leaves an emptied rules array empty", () => {
    const p = { keys: [], magic: { magic_keys: [{ key: "k", rules: [{ after: "a", emit: "b" }, { after: ["a", null], emit: "c" }, { after: ["a", "b"], emit: "d" }, { after: "ab", emit: "e" }] }, { key: "j", rules: [{ after: ["a", null], emit: "c" }] }] } };
    expect(withholdSkip(p).payload).toEqual({ keys: [], magic: { magic_keys: [{ key: "k", rules: [{ after: "a", emit: "b" }, { after: "ab", emit: "e" }] }, { key: "j", rules: [] }] } });
  });

  it("[LDB-F52] removes chiral keys with skip: true entirely, keeps the others", () => {
    const p = { keys: [], magic: { chiral_keys: [{ key: "a", same: { kind: "repeat" } }, { key: "b", skip: true, same: { kind: "repeat" } }], adaptive_swaps: [] } };
    expect(withholdSkip(p).payload).toEqual({ keys: [], magic: { chiral_keys: [{ key: "a", same: { kind: "repeat" } }], adaptive_swaps: [] } });
  });

  it("[LDB-F52] changes nothing outside magic (keys, alts, combos, other magic fields)", () => {
    const p = { keys: [{ char: "a" }], alts: [{ ngram: ["a", "b"], fingers: ["LI", "LM"] }], combos: [{ keys: ["a", "b"], output: "c" }], magic: { magic_keys: [{ key: "k", default: { kind: "skip_repeat" } }], adaptive_swaps: [{ trigger: "a", swap: ["a", "b"] }], rules: [] } };
    const out = withholdSkip(p).payload as typeof p;
    expect(out.keys).toBe(p.keys);
    expect(out.alts).toBe(p.alts);
    expect(out.combos).toBe(p.combos);
    expect(out.magic.adaptive_swaps).toBe(p.magic.adaptive_swaps);
  });

  it("[LDB-F52] is idempotent and never throws on input that is not payload-shaped", () => {
    for (const { payload } of SKIP_PAYLOADS) {
      const once = withholdSkip(payload);
      expect(once.withheld).toBe(true);
      const twice = withholdSkip(once.payload);
      expect(twice.withheld).toBe(false);
      expect(twice.payload).toBe(once.payload);
    }
    for (const junk of [null, undefined, 3, "x", [], {}, { magic: null }, { magic: { magic_keys: "x", chiral_keys: [null, 1, { skip: true }] } }]) {
      expect(() => withholdSkip(junk)).not.toThrow();
    }
  });
});

describe("[LDB-F53] skip-and-read: compile(withhold(p)) is an exact subset of compile(p)", () => {
  it("[LDB-F53] over every skip vector, the withheld payload validates and compiles to rows the full payload compiles to", () => {
    expect(SKIP_PAYLOADS.length).toBeGreaterThanOrEqual(7);
    for (const { name, payload } of SKIP_PAYLOADS) {
      const full = new Set(spark1.compileMagic(payload).map(key));
      const { payload: reduced, withheld } = withholdSkip(payload);
      expect(withheld, name).toBe(true);
      expect(spark1.validate(reduced).ok, `${name}: validate`).toBe(true);
      const rows = spark1.compileMagic(reduced);
      for (const r of rows) expect(full.has(key(r)), `${name}: row ${key(r)}`).toBe(true);
      // and what is gone is exactly the skip rows: every remaining row is a string row
      for (const r of rows) expect(typeof r.inputs, name).toBe("string");
    }
  });
});
