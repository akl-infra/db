// [LDB-MD28] formats/spark/1/fixtures/refused-vectors.json (Stage 4 F-db): one whole-payload refusal per refusal class, frozen with
// the error CODE, message and path spark1.validate() answers. The file is what a client (the bot's validator, akl.gg's gate) copies
// to prove it refuses what akldb refuses; THIS test is what stops akldb drifting from its own published refusals. Regenerate with
// `npm run gen-spark-parity-vectors` (`--check` recomputes in memory and diffs). API 1.38 (LDB-F71) cases stay accepted.
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import * as spark1 from "../../formats/spark/1/index.ts";

interface Refused {
  name: string;
  payload: unknown;
  refused: { error: string; message: string; path: string };
}
const FILE = path.resolve(import.meta.dirname, "..", "..", "formats", "spark", "1", "fixtures", "refused-vectors.json");
const VECTORS = JSON.parse(fs.readFileSync(FILE, "utf8")) as Refused[];

describe("[LDB-MD28] spark/1 refused vectors", () => {
  it("[LDB-MD28] the file is non-trivial, names are unique, and it spans several error codes and top-level paths", () => {
    expect(VECTORS.length).toBeGreaterThanOrEqual(30);
    expect(new Set(VECTORS.map((v) => v.name)).size).toBe(VECTORS.length);
    expect(new Set(VECTORS.map((v) => v.refused.error)).size).toBeGreaterThanOrEqual(2);
    for (const root of ["/keys", "/magic", "/alts", "/combos"]) expect(VECTORS.some((v) => v.refused.path.startsWith(root)), root).toBe(true);
  });

  for (const v of VECTORS) {
    it(`[LDB-MD28] refuses: ${v.name}`, () => {
      const r = spark1.validate(v.payload);
      expect(r.ok).toBe(false);
      if (!r.ok) expect({ error: r.error.error, message: r.error.message, path: r.error.path }).toEqual(v.refused);
    });
  }

  it("[LDB-MD28] [LDB-F71] off-layout alt literals and a space swap trigger are accepted, not refused", () => {
    const keys = [{ char: "a", row: 1, col: 0, finger: "LP" }, { char: "b", row: 1, col: 1, finger: "LR" }];
    expect(spark1.validate({ keys, alts: [{ ngram: ["∞"], fingers: ["LP"] }, { ngram: ['"'], fingers: ["LR"] }] })).toEqual({ ok: true });
    expect(spark1.validate({ keys, magic: { adaptive_swaps: [{ trigger: " ", swap: ["a", "b"] }] } })).toEqual({ ok: true });
  });
});
