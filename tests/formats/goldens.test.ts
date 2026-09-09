// [LDB-F1] [LDB-F2] [LDB-F7] Generated from the registry + the fixture
// directories, not hand-picked: adding a format or a fixture adds test rows
// here for free (07 §6 S2).
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { get as getFormat, list as listFormats } from "../../src/formats/registry";

const FORMATS_DIR = path.resolve(import.meta.dirname, "..", "..", "formats");

// Base fixture files are `NNN-<id>.json`; goldens are `NNN-<id>.lowered.json`
// / `NNN-<id>.<to-format>.json` -- one extra "." segment distinguishes them.
function isBaseFixtureFile(filename: string): boolean {
  if (!filename.endsWith(".json")) return false;
  return !filename.slice(0, -".json".length).includes(".");
}

interface Fixture {
  stem: string; // "NNN-<id>", no extension
  dir: string;
  payload: unknown;
}

function fixturesFor(formatId: string): Fixture[] {
  const [name, major] = formatId.split("/") as [string, string];
  const dir = path.join(FORMATS_DIR, name, major, "fixtures");
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter(isBaseFixtureFile)
    .sort()
    .map((file) => ({
      stem: file.slice(0, -".json".length),
      dir,
      payload: JSON.parse(fs.readFileSync(path.join(dir, file), "utf8")) as unknown,
    }));
}

describe("format goldens", () => {
  for (const format of listFormats()) {
    describe(format.id, () => {
      const fixtures = fixturesFor(format.id);

      it(`[LDB-F7] ${format.id} has at least one fixture`, () => {
        expect(fixtures.length).toBeGreaterThan(0);
      });

      for (const fixture of fixtures) {
        it(`[LDB-F1] ${fixture.stem} validates against ${format.id}`, () => {
          const result = format.validate(fixture.payload);
          expect(result.ok).toBe(true);
        });

        const loweredFile = path.join(fixture.dir, `${fixture.stem}.lowered.json`);
        if (fs.existsSync(loweredFile)) {
          it(`[LDB-F2] ${fixture.stem}: lower() matches its frozen golden`, () => {
            const expected = JSON.parse(fs.readFileSync(loweredFile, "utf8"));
            expect(format.lower(fixture.payload)).toEqual(expected);
          });
        }

        for (const target of Object.keys(format.to)) {
          const goldenFile = path.join(fixture.dir, `${fixture.stem}.${target.replace("/", "-")}.json`);

          it(`[LDB-F7] ${fixture.stem}: to["${target}"] matches its frozen golden`, () => {
            expect(fs.existsSync(goldenFile)).toBe(true);
            const expected = JSON.parse(fs.readFileSync(goldenFile, "utf8"));
            const translated = format.to[target]!(fixture.payload);
            expect(translated).toEqual(expected);
          });

          it(`[LDB-F7] ${fixture.stem}: to["${target}"]'s output validates there`, () => {
            const translated = format.to[target]!(fixture.payload);
            // A per-payload Held (07 §5) carries no payload to validate --
            // fixtures with a frozen `.<to>.json` golden are never Held for
            // that target, but the check stays honest about the contract.
            if (translated !== null && typeof translated === "object" && (translated as { held?: unknown }).held === true) {
              return;
            }
            const targetFormat = getFormat(target);
            expect(targetFormat).toBeDefined();
            expect(targetFormat?.validate(translated).ok).toBe(true);
          });
        }
      }
    });
  }
});
