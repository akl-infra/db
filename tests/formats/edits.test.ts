// [LDB-E1] Format PATCH edits (09-implementation-phase2.md §2.6, §3 T4):
// pure (never mutate the input), identity on their own projection
// (setFingermap(fingermapOf(p)) === p), and validity-preserving (every
// edit that returns a payload passes the format's own validate()).
// Generated per format x fixture from the registry (like mutations.test.ts,
// same fixture-loading convention -- no cross-import, each *.test.ts here
// duplicates the small helper rather than sharing one).
import fs from "node:fs";
import path from "node:path";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { list as listFormats } from "../../src/formats/registry";
import * as akl1 from "../../formats/akl/1/index.ts";
import * as cmini1 from "../../formats/cmini/1/index.ts";

const FORMATS_DIR = path.resolve(import.meta.dirname, "..", "..", "formats");

function isBaseFixtureFile(filename: string): boolean {
  if (!filename.endsWith(".json")) return false;
  return !filename.slice(0, -".json".length).includes(".");
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- a payload's exact shape is the format's own business
interface Fixture {
  stem: string;
  payload: any;
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
      payload: JSON.parse(fs.readFileSync(path.join(dir, file), "utf8")) as unknown,
    }));
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function fingermapOf(p: any): Record<string, string> {
  return Object.fromEntries(Object.entries(p.keys as Record<string, { finger: string }>).map(([c, pos]) => [c, pos.finger]));
}

function isEditError(r: unknown): r is { error: { error: string; message: string; path?: string } } {
  return typeof r === "object" && r !== null && "error" in (r as object);
}

// Each format's own `edits.ts` exports its own nominally-distinct
// `EditResult` alias (`Payload | {error}`, where `Payload` is that
// format's own concrete interface) -- TS's negated-guard narrowing doesn't
// always collapse those back down cleanly at the call site through two
// re-exports (edits.ts -> index.ts -> here), so this generic unwrap does
// it explicitly instead of leaning on control-flow narrowing: asserts (via
// isEditError, so a real refusal still fails loudly) and casts.
function unwrap<T>(result: T | { error: unknown }): T {
  expect(isEditError(result)).toBe(false);
  return result as T;
}

const FINGERS = ["LP", "LR", "LM", "LI", "RI", "RM", "RR", "RP", "LT", "RT", "TB"];
const EDIT_FORMATS = listFormats().filter((f) => f.edits !== undefined);

describe("format edits (LDB-E1)", () => {
  for (const format of EDIT_FORMATS) {
    describe(format.id, () => {
      const edits = format.edits!;

      if (edits.setFingermap !== undefined) {
        for (const fixture of fixturesFor(format.id)) {
          it(`[LDB-E1] ${fixture.stem} setFingermap(fingermapOf(p)) is identity, pure, and valid`, () => {
            const before = structuredClone(fixture.payload);
            const map = fingermapOf(fixture.payload);
            const result = edits.setFingermap!(fixture.payload, map);
            expect(fixture.payload, "purity: input untouched").toEqual(before);
            expect(isEditError(result), "identity map is never refused").toBe(false);
            if (!isEditError(result)) {
              expect(result, "identity: setFingermap(fingermapOf(p)) === p").toEqual(fixture.payload);
              expect(format.validate(result).ok, "validity").toBe(true);
            }
          });
        }

        it("[LDB-E1] a fingermap naming a char not in keys -> invalid_payload at /keys/<c>", () => {
          const fixture = fixturesFor(format.id)[0]!;
          const ghost = "\u0001"; // a control character, never a real layout key across any fixture
          expect(ghost in fixture.payload.keys).toBe(false);
          const before = structuredClone(fixture.payload);
          const result = edits.setFingermap!(fixture.payload, { [ghost]: "LP" });
          expect(fixture.payload).toEqual(before); // purity even on refusal
          expect(result).toEqual({ error: { error: "invalid_payload", message: expect.any(String), path: `/keys/${ghost}` } });
        });

        it("[LDB-E1] a bad finger word is left to validate()'s re-run: error at /keys/<c>/finger", () => {
          const fixture = fixturesFor(format.id).find((f) => Object.keys(f.payload.keys).length > 0)!;
          const ch = Object.keys(fixture.payload.keys)[0]!;
          const result = edits.setFingermap!(fixture.payload, { [ch]: "NOT_A_FINGER" });
          expect(isEditError(result)).toBe(false);
          if (!isEditError(result)) {
            const validation = format.validate(result);
            expect(validation.ok).toBe(false);
            if (!validation.ok) {
              const pointer = `/keys/${ch}/finger`;
              expect([pointer, `/keys/${ch}`]).toContain(validation.error.path);
            }
          }
        });

        it("[LDB-E1] a partial fingermap changes exactly the named chars", () => {
          const fixture = fixturesFor(format.id).find((f) => Object.keys(f.payload.keys).length >= 2)!;
          const chars = Object.keys(fixture.payload.keys);
          const [changed, untouched] = [chars[0]!, chars[1]!];
          const newFinger = fixture.payload.keys[changed].finger === "LP" ? "RP" : "LP";
          const result = edits.setFingermap!(fixture.payload, { [changed]: newFinger });
          expect(isEditError(result)).toBe(false);
          if (!isEditError(result)) {
            expect(result.keys[changed].finger).toBe(newFinger);
            expect(result.keys[untouched]).toEqual(fixture.payload.keys[untouched]);
            for (const ch of chars) {
              if (ch === changed) continue;
              expect(result.keys[ch]).toEqual(fixture.payload.keys[ch]);
            }
          }
        });

        it("[LDB-E1] property: setFingermap then fingermapOf recovers the map, for random fingermaps over random keys", () => {
          fc.assert(
            fc.property(
              fc.uniqueArray(fc.string({ minLength: 1, maxLength: 1 }), { minLength: 1, maxLength: 6 }),
              fc.array(fc.constantFrom(...FINGERS), { minLength: 1, maxLength: 6 }),
              (chars, fingers) => {
                // eslint-disable-next-line @typescript-eslint/no-explicit-any
                const keys: Record<string, any> = {};
                chars.forEach((c, i) => {
                  keys[c] = { row: 0, col: i, finger: fingers[i % fingers.length] };
                });
                const base = format.id === "cmini/1" ? { board: "ortho" as const, keys } : { keys };
                const map: Record<string, string> = {};
                chars.forEach((c, i) => {
                  map[c] = fingers[(i + 1) % fingers.length]!;
                });
                const before = structuredClone(base);
                const result = edits.setFingermap!(base, map);
                expect(base).toEqual(before); // purity
                expect(isEditError(result)).toBe(false);
                if (!isEditError(result)) {
                  expect(fingermapOf(result)).toEqual(map);
                }
              },
            ),
            { numRuns: 100 },
          );
        });
      }
    });
  }
});

// -- board (cmini/1): board.cmini wins; otherwise derived from board.kind
// via the same rule to["cmini/1"] uses (01 §6.2) -- EXCEPT a hint-less
// colstag board, which to["cmini/1"] silently defaults to "ortho" (a
// documented translation loss) but an explicit board PATCH refuses
// outright (09 §3 T4).
describe("cmini/1 setBoard (LDB-E1)", () => {
  const BASE_CMINI_PAYLOAD = { board: "ortho" as const, keys: {} };

  for (const fixture of fixturesFor("akl/1")) {
    it(`[LDB-E1] ${fixture.stem}'s board -> the word to["cmini/1"] derives (or the documented colstag refusal)`, () => {
      const before = structuredClone(BASE_CMINI_PAYLOAD);
      const result = cmini1.edits!.setBoard!(BASE_CMINI_PAYLOAD, fixture.payload.board);
      expect(BASE_CMINI_PAYLOAD).toEqual(before); // purity

      const hasHint = fixture.payload.board?.cmini !== undefined;
      const isHintlessColstag = !hasHint && fixture.payload.board?.kind === "colstag";
      if (isHintlessColstag) {
        expect(isEditError(result)).toBe(true);
        if (isEditError(result)) expect(result.error.error).toBe("unsupported_for_format");
      } else {
        const payload = unwrap<{ board: unknown }>(result);
        const expectedWord = (akl1.to["cmini/1"]!(fixture.payload) as { board: unknown }).board;
        expect(payload.board).toBe(expectedWord);
        expect(cmini1.validate(payload).ok).toBe(true);
      }
    });
  }

  it("[LDB-E1] 900-colstag has no board.cmini hint (the fixture this refusal exercises)", () => {
    const colstag = fixturesFor("akl/1").find((f) => f.stem === "900-colstag")!;
    expect(colstag.payload.board.kind).toBe("colstag");
    expect(colstag.payload.board.cmini).toBeUndefined();
  });
});

// -- board (akl/1): the board vocabulary is akl/1's own, validated as a
// whole by the pipeline's validate() re-run.
describe("akl/1 setBoard (LDB-E1)", () => {
  for (const fixture of fixturesFor("akl/1")) {
    it(`[LDB-E1] ${fixture.stem} setBoard(p.board) is identity and pure`, () => {
      const before = structuredClone(fixture.payload);
      const result = akl1.edits!.setBoard!(fixture.payload, fixture.payload.board);
      expect(fixture.payload).toEqual(before); // purity
      expect(isEditError(result)).toBe(false);
      if (!isEditError(result)) {
        expect(result).toEqual(fixture.payload);
        expect(akl1.validate(result).ok).toBe(true);
      }
    });
  }
});

// -- magic (akl/1 only -- cmini/1 has no setMagic, so PATCH{magic} on a
// cmini/1 record is refused before edits.ts is even asked; that half of
// the invariant is tests/api/patch.test.ts's `unsupported_for_format`
// case, not a format-level property).
describe("akl/1 setMagic (LDB-E1)", () => {
  for (const fixture of fixturesFor("akl/1")) {
    it(`[LDB-E1] ${fixture.stem}: lower(setMagic(p, m)) === lower({...p, magic: m})`, () => {
      const m = fixture.payload.magic; // reuse the fixture's own magic (or undefined) as `m`
      const before = structuredClone(fixture.payload);
      const result = akl1.edits!.setMagic!(fixture.payload, m);
      expect(fixture.payload).toEqual(before); // purity
      const payload = unwrap<Parameters<typeof akl1.lower>[0]>(result);
      expect(akl1.lower(payload)).toEqual(akl1.lower({ ...fixture.payload, magic: m }));
    });
  }
});
