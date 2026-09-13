// [LDB-F1] [LDB-F2] [LDB-F7] Generated from the shared shape list (every
// registered format plus the unregistered cmini adapter, `validated-
// shapes.ts`) + the fixture directories, not hand-picked: adding a format
// or a fixture adds test rows here for free (07 §6 S2).
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { validatedShapes, getFormat, fixturesIn } from "./validated-shapes.ts";

describe("format goldens", () => {
  for (const format of validatedShapes()) {
    describe(format.id, () => {
      const fixtures = fixturesIn(format.fixturesDir);

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
            expect(format.compile(fixture.payload)).toEqual(expected);
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
            // Every `to[...]` TARGET here is a registered format (the
            // cmini adapter is never itself a target) -- `getFormat`
            // (the Worker registry wrapper) resolves it, aliases included.
            const targetFormat = getFormat(target);
            expect(targetFormat).toBeDefined();
            // design/layout-db/23-geometry.md §4.4-3 (LDB-F27): the ONE
            // known real exception -- cmini/1's 010-test12222 has a
            // thumb-labelled key physically on a finger row, so its
            // `to["spark/1"]` golden (frozen above, exact by design) fails
            // spark/1's OWN stricter validate() on purpose (LDB-F23 still
            // holds: the multiset itself is exact). See
            // tests/formats/cmini-envelope.test.ts's dedicated case.
            if (format.id === "cmini/1" && target === "spark/1" && fixture.stem === "010-test12222") {
              expect(targetFormat?.validate(translated).ok).toBe(false);
              return;
            }
            expect(targetFormat?.validate(translated).ok).toBe(true);
          });
        }
      }
    });
  }
});
