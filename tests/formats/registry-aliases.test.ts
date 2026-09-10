// [LDB-F17] [LDB-F20] [LDB-F21] Registry-level invariants added by
// design/layout-db/20-spark.md S1: spark/1 stays lowerable to mana2/1
// (F17); the alias table (`ALIASES`/`resolveFormat`) and legacy-stored
// normalization (`LEGACY_STORED`/`storedAsSpark`) inside `translate()`
// (F20/F21's registry halves -- the full API-route matrices, write
// refusals and `?format=` alias resolution land in S2). Plain Node vitest
// (the "node" project, `vitest.config.ts`): these are pure `db/formats/`
// functions, no Worker/D1 needed.
import fs from "node:fs";
import path from "node:path";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import * as spark1 from "../../formats/spark/1/index.ts";
import * as cminiAdapter from "../../formats/adapters/cmini/index.ts";
import { ALIASES, resolveFormat, LEGACY_STORED, storedAsSpark, translate, get as getRegistered } from "../../formats/registry.ts";

const SPARK_FIXTURES_DIR = path.resolve(import.meta.dirname, "..", "..", "formats", "spark", "1", "fixtures");
const CMINI_FIXTURES_DIR = path.resolve(import.meta.dirname, "..", "..", "formats", "adapters", "cmini", "fixtures");

function isBaseFixtureFile(filename: string): boolean {
  if (!filename.endsWith(".json")) return false;
  return !filename.slice(0, -".json".length).includes(".");
}

function isHeld(v: unknown): v is { held: true } {
  return typeof v === "object" && v !== null && (v as { held?: unknown }).held === true;
}

const sparkFiles = fs.readdirSync(SPARK_FIXTURES_DIR).filter(isBaseFixtureFile).sort();
const cminiFiles = fs.readdirSync(CMINI_FIXTURES_DIR).filter(isBaseFixtureFile).sort();

describe("[LDB-F17] spark/1 stays lowerable to mana2/1", () => {
  it("the spark/1 fixture set is non-empty", () => {
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

describe("[LDB-F20] ALIASES / resolveFormat", () => {
  it("[LDB-F20] every ALIASES entry's target is reachable: a registered module, or the adapter special-case", () => {
    for (const [id, entry] of Object.entries(ALIASES)) {
      if (entry.target === "adapter:cmini") continue;
      expect(getRegistered(entry.target), `${id} -> ${entry.target}`).toBeDefined();
    }
  });

  it("[LDB-F20] akl/1 resolves to the SAME module spark/1 does, labelled akl/1", () => {
    const bySpark = resolveFormat("spark/1");
    const byAlias = resolveFormat("akl/1");
    expect(bySpark).toBeDefined();
    expect(byAlias).toBeDefined();
    expect(byAlias?.module).toBe(bySpark?.module);
    expect(byAlias?.label).toBe("akl/1");
  });

  it("[LDB-F20] cmini/1 has no registered FormatModule -- the adapter target isn't resolveFormat-reachable", () => {
    expect(resolveFormat("cmini/1")).toBeUndefined();
  });

  it("[LDB-F20] cmini/1 is marked write: refuse; akl/1 is marked write: store (S2 wires the actual behaviour)", () => {
    expect(ALIASES["cmini/1"]?.write).toBe("refuse");
    expect(ALIASES["akl/1"]?.write).toBe("store");
  });

  it("[LDB-F20] akl/1 stores byte-identical to spark/1 (LEGACY_STORED's akl/1 entry is the identity function)", () => {
    const fixture = JSON.parse(fs.readFileSync(path.join(SPARK_FIXTURES_DIR, sparkFiles[0]!), "utf8"));
    expect(LEGACY_STORED["akl/1"]!(fixture)).toEqual(fixture);
  });
});

describe("[LDB-F21] legacy-stored records normalize through storedAsSpark", () => {
  it("[LDB-F21] a record stored akl/1 reads identically, for every target, to its storedAsSpark twin", () => {
    const fixture = JSON.parse(fs.readFileSync(path.join(SPARK_FIXTURES_DIR, sparkFiles[0]!), "utf8"));
    const legacyRec = { format: "akl/1", payload: fixture };
    const twin = storedAsSpark("akl/1", fixture);
    for (const as of ["spark/1", "akl/1", "mana2/1", "cmini/1"]) {
      expect(translate(legacyRec, as)).toEqual(translate(twin, as));
    }
  });

  it("[LDB-F21] a record stored cmini/1 reads identically, for every target, to its storedAsSpark twin", () => {
    const payload = JSON.parse(fs.readFileSync(path.join(CMINI_FIXTURES_DIR, cminiFiles[0]!), "utf8"));
    const legacyRec = { format: "cmini/1", payload };
    const twin = storedAsSpark("cmini/1", payload);
    expect(twin.format).toBe("spark/1");
    for (const as of ["spark/1", "akl/1", "mana2/1", "cmini/1"]) {
      expect(translate(legacyRec, as)).toEqual(translate(twin, as));
    }
  });

  it("[LDB-F21] reading a cmini/1-stored record ?as=akl/1 equals fromCmini(payload) -- today's behaviour, unchanged", () => {
    const payload = JSON.parse(fs.readFileSync(path.join(CMINI_FIXTURES_DIR, cminiFiles[0]!), "utf8"));
    const result = translate({ format: "cmini/1", payload }, "akl/1");
    expect("payload" in result).toBe(true);
    if ("payload" in result) {
      expect(result.payload).toEqual(cminiAdapter.to["spark/1"]!(payload));
    }
  });

  it("[LDB-F21] storedAsSpark is the ONE conversion: LEGACY_STORED has exactly {akl/1, cmini/1}, nothing else", () => {
    expect(new Set(Object.keys(LEGACY_STORED))).toEqual(new Set(["akl/1", "cmini/1"]));
  });
});
