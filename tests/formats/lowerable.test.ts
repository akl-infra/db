// [LDB-F17] db/tests/formats/lowerable.test.ts -- spark/1 stays lowerable
// to mana2/1 (design/layout-db/20-spark.md S1; mana2 is how every stats
// path gets numbers, plan §2.5). Ported out of the deleted
// `registry-aliases.test.ts` (git show b1b3ee387:db/tests/formats/
// registry-aliases.test.ts) when 21-formats.md F1 deleted that file's
// other subjects (the alias table, legacy-stored normalization) -- this
// invariant's own subject was untouched by D5/D10/D12, so it gets its own
// home instead of being retired along with the file that used to carry it
// (retiring an invariant because its test file moved would invert the
// covenant). Plain Node vitest (the "node" project, `vitest.config.ts`):
// these are pure `db/formats/` functions, no Worker/D1 needed.
import fs from "node:fs";
import path from "node:path";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import * as spark1 from "../../formats/spark/1/index.ts";

const SPARK_FIXTURES_DIR = path.resolve(import.meta.dirname, "..", "..", "formats", "spark", "1", "fixtures");

// LDB-F39 (2026-09-13): `parity-vectors.json` is a LIST of 300 golden
// vectors (`scripts/gen-spark-parity-vectors.mjs`), not a single base
// Payload -- excluded here the same way `tests/formats/validated-shapes.ts`
// excludes it from its own (separately-duplicated, self-contained-test
// posture) copy of this function.
function isBaseFixtureFile(filename: string): boolean {
  if (!filename.endsWith(".json")) return false;
  if (filename === "parity-vectors.json") return false;
  return !filename.slice(0, -".json".length).includes(".");
}

function isHeld(v: unknown): v is { held: true } {
  return typeof v === "object" && v !== null && (v as { held?: unknown }).held === true;
}

const sparkFiles = fs.readdirSync(SPARK_FIXTURES_DIR).filter(isBaseFixtureFile).sort();

describe("[LDB-F17] spark/1 stays lowerable to mana2/1", () => {
  it("[LDB-F17] the spark/1 fixture set is non-empty", () => {
    expect(sparkFiles.length).toBeGreaterThan(0);
  });

  for (const file of sparkFiles) {
    const stem = file.slice(0, -".json".length);
    const payload = JSON.parse(fs.readFileSync(path.join(SPARK_FIXTURES_DIR, file), "utf8"));

    it(`[LDB-F17] ${stem}: to["mana2/1"] is never held`, () => {
      expect(spark1.validate(payload).ok).toBe(true);
      const translated = spark1.to["mana2/1"]!(payload);
      expect(isHeld(translated)).toBe(false);
    });
  }

  it("[LDB-F17] property: random single-field finger mutations that still validate are never held either", () => {
    const base = JSON.parse(fs.readFileSync(path.join(SPARK_FIXTURES_DIR, sparkFiles[0]!), "utf8"));
    const chars = Object.keys(base.keys);
    const fingers = ["LP", "LR", "LM", "LI", "LT", "RT", "RI", "RM", "RR", "RP"];
    fc.assert(
      fc.property(fc.constantFrom(...chars), fc.constantFrom(...fingers), (ch, finger) => {
        const mutated = structuredClone(base);
        mutated.keys[ch] = { ...mutated.keys[ch], finger };
        fc.pre(spark1.validate(mutated).ok);
        const translated = spark1.to["mana2/1"]!(mutated);
        expect(isHeld(translated)).toBe(false);
      }),
      { numRuns: 100 },
    );
  });
});
