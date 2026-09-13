// [LDB-F39] compileMagic over db/formats/spark/1/fixtures/parity-vectors
// .json still equals each vector's own frozen `expected` -- the DB-side
// twin of bot's LDB-B78 (bot/tests/magic/spark-parity.test.ts), which
// checks the SAME committed file against `@akl/core/rules`'s
// `magicRulesFlatCompile` instead.
//
// 2026-09-13 (saltorbit: "the bot is a third-party client of the layout DB
// like any other"): bot/ no longer imports this package at all (LDB-B6),
// so the parity property test that used to run live, importing BOTH
// compilers in one process, no longer has anywhere to live in one place.
// `db/scripts/gen-spark-parity-vectors.mjs` now generates 300 seeded
// fast-check cases (the SAME generator shape the old bot-side property
// test ran) and freezes them here, `expected` computed once, by this
// package's own `compileMagic`. Bot keeps a hand-refreshed copy
// (`bot/tests/fixtures/spark-parity-vectors.json`) and checks its own
// compiler against it. THIS test is what stops the DB side from drifting
// away from its own published vectors -- an edit to `compileMagic`,
// `computeRows` or `resolveRows` that changes behavior on any of these 300
// cases fails here immediately, in the same tree as the change, rather
// than only surfacing the next time someone happens to re-run the bot's
// copy against a regenerated file.
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
  expected: Row[];
}

const VECTORS_PATH = path.resolve(import.meta.dirname, "..", "..", "formats", "spark", "1", "fixtures", "parity-vectors.json");
const VECTORS = JSON.parse(fs.readFileSync(VECTORS_PATH, "utf8")) as Vector[];

function rowSet(rows: { inputs: string; output: string }[]): string[] {
  return rows.map((r) => JSON.stringify([r.inputs, r.output])).sort();
}

describe("spark/1 compileMagic vs its own frozen parity vectors (LDB-F39, twin of bot LDB-B78)", () => {
  it("[LDB-F39] loads a non-trivial, non-empty set of golden vectors", () => {
    expect(VECTORS.length).toBeGreaterThan(0);
    expect(VECTORS.some((v) => v.expected.length > 0)).toBe(true);
  });

  it("[LDB-F39] compileMagic reproduces every frozen vector's own expected row set", () => {
    for (const [i, vector] of VECTORS.entries()) {
      const payload: Payload = { keys: vector.keys, board: "ansi", magic: vector.magic };
      const validation = spark1.validate(payload);
      expect(validation.ok, `vector #${i}: validate()`).toBe(true);
      const actual = spark1.compileMagic(payload);
      expect(rowSet(actual), `vector #${i}: row set`).toEqual(rowSet(vector.expected));
    }
  });
});
