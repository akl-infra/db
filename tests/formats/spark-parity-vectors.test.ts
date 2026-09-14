// [LDB-F39] compileMagic over db/formats/spark/1/fixtures/parity-vectors
// .json still equals each vector's own frozen `expected`, and validate()
// still refuses each refused vector with its own frozen `refused` error --
// the DB-side twin of bot's LDB-B78 (bot/tests/magic/spark-parity.test.ts),
// which checks the SAME committed file against `@akl/core/rules`'s
// `magicRulesFlatCompile` and `validateRuleSet` instead.
//
// 2026-09-13 (saltorbit: "the bot is a third-party client of the layout DB
// like any other"): bot/ no longer imports this package at all (LDB-B6),
// so the parity property test that used to run live, importing BOTH
// compilers in one process, no longer has anywhere to live in one place.
// `db/scripts/gen-spark-parity-vectors.mjs` now generates 300 seeded
// fast-check cases (the SAME generator shape the old bot-side property
// test ran) and freezes them here, `expected` computed once, by this
// package's own `compileMagic`, plus 60 refused cases (a valid rule set
// with one key that isn't on the layout, LDB-F22). Bot keeps a
// hand-refreshed copy (`bot/tests/fixtures/spark-parity-vectors.json`) and
// checks its own compiler and validator against it. THIS test is what
// stops the DB side from drifting away from its own published vectors --
// an edit to `compileMagic`, `computeRows`, `resolveRows` or validation
// that changes behavior on any of these cases fails here immediately, in
// the same tree as the change, rather than only surfacing the next time
// someone happens to re-run the bot's copy against a regenerated file.
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import * as spark1 from "../../formats/spark/1/index.ts";
import type { Payload, Key, MagicIntent } from "../../formats/spark/1/index.ts";

interface Row {
  inputs: string;
  output: string;
  type?: string;
}
interface Vector {
  keys: Key[];
  magic: MagicIntent;
  expected?: Row[];
  refused?: { message: string; path: string };
}

const VECTORS_PATH = path.resolve(import.meta.dirname, "..", "..", "formats", "spark", "1", "fixtures", "parity-vectors.json");
const VECTORS = JSON.parse(fs.readFileSync(VECTORS_PATH, "utf8")) as Vector[];
const ACCEPTED = VECTORS.filter((v) => v.expected !== undefined);
const REFUSED = VECTORS.filter((v) => v.refused !== undefined);

function rowSet(rows: { inputs: string; output: string }[]): string[] {
  return rows.map((r) => JSON.stringify([r.inputs, r.output])).sort();
}

describe("spark/1 compileMagic vs its own frozen parity vectors (LDB-F39, twin of bot LDB-B78)", () => {
  it("[LDB-F39] loads a non-trivial, non-empty set of golden vectors, each either accepted or refused", () => {
    expect(ACCEPTED.length).toBeGreaterThan(0);
    expect(ACCEPTED.some((v) => v.expected!.length > 0)).toBe(true);
    expect(ACCEPTED.length + REFUSED.length).toBe(VECTORS.length);
    expect(VECTORS.every((v) => (v.expected === undefined) !== (v.refused === undefined))).toBe(true);
  });

  it("[LDB-F39] compileMagic reproduces every accepted vector's own expected row set", () => {
    for (const [i, vector] of ACCEPTED.entries()) {
      const payload: Payload = { keys: vector.keys, magic: vector.magic };
      const validation = spark1.validate(payload);
      expect(validation.ok, `vector #${i}: validate()`).toBe(true);
      const actual = spark1.compileMagic(payload);
      expect(rowSet(actual), `vector #${i}: row set`).toEqual(rowSet(vector.expected!));
    }
  });

  it("[LDB-F39][LDB-F22] validate() refuses every refused vector with its own frozen error, and they cover all four named-key positions", () => {
    for (const [i, vector] of REFUSED.entries()) {
      const validation = spark1.validate({ keys: vector.keys, magic: vector.magic } as Payload);
      expect(validation.ok, `refused vector #${i}`).toBe(false);
      if (validation.ok) continue;
      expect({ message: validation.error.message, path: validation.error.path }, `refused vector #${i}`).toEqual(vector.refused);
    }
    const positions = new Set(REFUSED.map((v) => v.refused!.message.split(" ")[0]));
    expect([...positions].sort()).toEqual(["adaptive_swaps[].swap", "adaptive_swaps[].trigger", "chiral_keys[].key", "magic_keys[].key"]);
  });
});
