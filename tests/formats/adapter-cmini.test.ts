// [LDB-F7] spark/1's own `to` map no longer lists `cmini/1` (20-spark.md
// S1 decision: cmini is reached only through the registry's adapter
// alias, never a plain `to[...]` entry on spark itself) -- so unlike the
// cmini adapter's OWN goldens (`validate`/`rows()`/`to["spark/1"]`, which
// `goldens.test.ts`'s restored `validated-shapes.ts`-driven loop covers
// generically, the same way it always covered them when cmini/1 was
// still registered), a spark/1 fixture's `toCmini` golden has nowhere
// generic to be checked from spark's side. This file is exactly that one
// remaining gap: every spark/1 fixture with a `.cmini-1.json` golden,
// checked against the cmini adapter's `from["spark/1"]` (toCmini)
// directly.
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import * as cminiAdapter from "../../formats/adapters/cmini/index.ts";

const SPARK_FIXTURES_DIR = path.resolve(import.meta.dirname, "..", "..", "formats", "spark", "1", "fixtures");

function isBaseFixtureFile(filename: string): boolean {
  if (!filename.endsWith(".json")) return false;
  return !filename.slice(0, -".json".length).includes(".");
}

describe("cmini adapter goldens (spark/1 -> toCmini, the one direction not covered generically)", () => {
  const sparkFiles = fs.readdirSync(SPARK_FIXTURES_DIR).filter(isBaseFixtureFile).sort();

  it("[LDB-F7] the spark/1 fixture set is non-empty", () => {
    expect(sparkFiles.length).toBeGreaterThan(0);
  });

  for (const file of sparkFiles) {
    const stem = file.slice(0, -".json".length);
    const payload = JSON.parse(fs.readFileSync(path.join(SPARK_FIXTURES_DIR, file), "utf8"));
    const cminiGolden = path.join(SPARK_FIXTURES_DIR, `${stem}.cmini-1.json`);
    if (!fs.existsSync(cminiGolden)) continue; // a spark-native fixture with no cmini golden (e.g. one using x/colstag) is out of scope here

    it(`[LDB-F7] ${stem}: toCmini matches its frozen golden (.cmini-1.json, unchanged)`, () => {
      const expected = JSON.parse(fs.readFileSync(cminiGolden, "utf8"));
      expect(cminiAdapter.from["spark/1"]!(payload)).toEqual(expected);
    });

    it(`[LDB-F7] ${stem}: toCmini's output validates against the cmini adapter`, () => {
      const translated = cminiAdapter.from["spark/1"]!(payload);
      expect(cminiAdapter.validate(translated).ok).toBe(true);
    });
  }
});
