// [LDB-E1] Format PATCH edits (09-implementation-phase2.md §2.6, §3 T4):
// pure (never mutate the input), identity on their own projection
// (setFingermap(fingermapOf(p)) === p), and validity-preserving (every
// edit that returns a payload passes the format's own validate()).
// Generated per format x fixture -- the shared shape list
// (`validated-shapes.ts`) for the generic loop below, since a bare
// `listFormats()` (this file's convention pre-20-spark.md S1) would
// silently stop covering the cmini adapter once it left the registry;
// the four dedicated per-format blocks (board/magic, and mana2's own
// setFingermap, all excluded from the generic loop for reasons stated at
// each) keep their own tiny fixture loader, same as before.
import fs from "node:fs";
import path from "node:path";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { validatedShapes, fixturesIn } from "./validated-shapes.ts";
import * as spark1 from "../../formats/spark/1/index.ts";
import * as mana2_1 from "../../formats/mana2/1/index.ts";
import { parseRow, DIGIT_BY_FINGER } from "../../formats/mana2/1/translate.ts";

const FORMATS_DIR = path.resolve(import.meta.dirname, "..", "..", "formats");

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- a payload's exact shape is the format's own business
interface Fixture {
  stem: string;
  payload: any;
}

// Named-format lookup for the four dedicated blocks below (each pins one
// real format/adapter by name, not a loop over every registered one).
function fixturesFor(formatId: string): Fixture[] {
  const [name, major] = formatId.split("/") as [string, string];
  const dir = path.join(FORMATS_DIR, name, major, "fixtures");
  return fixturesIn(dir) as Fixture[];
}

// design/layout-db/23-geometry.md's duplicate-characters follow-up:
// `Payload.keys` is an array now (char optional). A char that appears on
// MORE than one entry is excluded from this map entirely -- `setFingermap`
// itself refuses a named char with more than one match (24-spark-wire-
// review.md finding 5), so "the identity map" can only ever cover chars it
// could actually round-trip.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function fingermapOf(p: any): Record<string, string> {
  const counts = new Map<string, number>();
  for (const k of p.keys as { char?: string; finger: string }[]) {
    if (k.char !== undefined) counts.set(k.char, (counts.get(k.char) ?? 0) + 1);
  }
  const out: Record<string, string> = {};
  for (const k of p.keys as { char?: string; finger: string }[]) {
    if (k.char !== undefined && counts.get(k.char) === 1) out[k.char] = k.finger;
  }
  return out;
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

const FINGERS = ["LP", "LR", "LM", "LI", "RI", "RM", "RR", "RP", "LT", "RT"];
// mana2/1's own `setFingermap` operates over `layout.fingers` ROW STRINGS,
// not a `p.keys` map (it has none) -- `fingermapOf`/the "not in keys"/
// "bad finger word" assertions below all assume spark/1's shape. Excluded
// here in favour of its own describe block (mana2/1 setFingermap, below),
// the same pattern this file already uses for board/magic (spark/1
// setBoard, spark/1 setMagic are their own blocks, never squeezed into
// this generic one). 21-formats.md D5 deleted the cmini adapter's own
// `edits.ts` entirely (a `cmini/1` record no longer exists to PATCH), so
// spark/1 is the only member of this generic loop now.
const EDIT_FORMATS = validatedShapes().filter((f) => f.edits !== undefined && f.id !== "mana2/1");

describe("format edits (LDB-E1)", () => {
  for (const format of EDIT_FORMATS) {
    describe(format.id, () => {
      const edits = format.edits!;
      const fixtures = fixturesIn(format.fixturesDir) as Fixture[];

      if (edits.setFingermap !== undefined) {
        for (const fixture of fixtures) {
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

        it("[LDB-E1] a fingermap naming a char not in keys -> invalid_payload at /keys", () => {
          const fixture = fixtures[0]!;
          const ghost = ""; // a control character, never a real layout key across any fixture
          expect((fixture.payload.keys as { char?: string }[]).some((k) => k.char === ghost)).toBe(false);
          const before = structuredClone(fixture.payload);
          const result = edits.setFingermap!(fixture.payload, { [ghost]: "LP" });
          expect(fixture.payload).toEqual(before); // purity even on refusal
          expect(result).toEqual({ error: { error: "invalid_payload", message: expect.any(String), path: "/keys" } });
        });

        it("[LDB-E1] a fingermap naming a char on more than one position is refused (24-spark-wire-review.md finding 5) -- can't tell which one you mean", () => {
          const fixture = fixtures[0]!;
          const dupChar = ""; // a control character, never real -- appended twice on purpose
          const withDup = { ...fixture.payload, keys: [...fixture.payload.keys, { char: dupChar, row: 4, col: 20, finger: "LP" }, { char: dupChar, row: 4, col: 21, finger: "RP" }] };
          const result = edits.setFingermap!(withDup, { [dupChar]: "LP" });
          expect(result).toEqual({ error: { error: "invalid_payload", message: expect.any(String), path: "/keys" } });
        });

        it("[LDB-E1] a bad finger word is left to validate()'s re-run", () => {
          const fixture = fixtures.find((f) => (f.payload.keys as { char?: string }[]).some((k) => k.char !== undefined))!;
          const keys = fixture.payload.keys as { char?: string; finger: string }[];
          const ch = keys.find((k) => k.char !== undefined)!.char!;
          const result = edits.setFingermap!(fixture.payload, { [ch]: "NOT_A_FINGER" });
          expect(isEditError(result)).toBe(false);
          if (!isEditError(result)) {
            const validation = format.validate(result);
            expect(validation.ok).toBe(false);
          }
        });

        it("[LDB-E1] a partial fingermap changes exactly the named chars", () => {
          const fixture = fixtures.find((f) => (f.payload.keys as { char?: string }[]).filter((k) => k.char !== undefined).length >= 2)!;
          const keys = fixture.payload.keys as { char?: string; row: number; col: number; finger: string }[];
          const chars = keys.filter((k) => k.char !== undefined).map((k) => k.char!);
          const [changed, untouched] = [chars[0]!, chars[1]!];
          const changedBefore = keys.find((k) => k.char === changed)!;
          const newFinger = changedBefore.finger === "LP" ? "RP" : "LP";
          const result = edits.setFingermap!(fixture.payload, { [changed]: newFinger });
          expect(isEditError(result)).toBe(false);
          if (!isEditError(result)) {
            const resultKeys = result.keys as { char?: string; row: number; col: number; finger: string }[];
            expect(resultKeys.find((k) => k.char === changed)!.finger).toBe(newFinger);
            expect(resultKeys.find((k) => k.char === untouched)).toEqual(keys.find((k) => k.char === untouched));
            for (const ch of chars) {
              if (ch === changed) continue;
              expect(resultKeys.find((k) => k.char === ch)).toEqual(keys.find((k) => k.char === ch));
            }
          }
        });

        it("[LDB-E1] property: setFingermap then fingermapOf recovers the map, for random fingermaps over random keys", () => {
          fc.assert(
            fc.property(
              fc.uniqueArray(fc.string({ minLength: 1, maxLength: 1 }), { minLength: 1, maxLength: 6 }),
              fc.array(fc.constantFrom(...FINGERS), { minLength: 1, maxLength: 6 }),
              (chars, fingers) => {
                const keys = chars.map((c, i) => ({ char: c, row: 0, col: i, finger: fingers[i % fingers.length]! }));
                const base = { keys };
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

// 21-formats.md D5 deleted the cmini adapter's own `edits.ts` (`setBoard`
// included) along with the rest of the cmini export -- a `cmini/1` record
// no longer exists to PATCH, so there is no "cmini/1 setBoard" block here
// any more.

// -- board (spark/1): the board vocabulary is spark/1's own, validated as
// a whole by the pipeline's validate() re-run.
describe("spark/1 setBoard (LDB-E1)", () => {
  for (const fixture of fixturesFor("spark/1")) {
    it(`[LDB-E1] ${fixture.stem} setBoard(p.board) is identity and pure`, () => {
      const before = structuredClone(fixture.payload);
      const result = spark1.edits!.setBoard!(fixture.payload, fixture.payload.board);
      expect(fixture.payload).toEqual(before); // purity
      expect(isEditError(result)).toBe(false);
      if (!isEditError(result)) {
        expect(result).toEqual(fixture.payload);
        expect(spark1.validate(result).ok).toBe(true);
      }
    });
  }
});

// -- magic (spark/1 -- the only format PATCH{magic} was ever going to
// touch: cmini/1 never had a setMagic, and D5 deleted it entirely).
describe("spark/1 setMagic (LDB-E1)", () => {
  for (const fixture of fixturesFor("spark/1")) {
    it(`[LDB-E1] ${fixture.stem}: lower(setMagic(p, m)) === lower({...p, magic: m})`, () => {
      const m = fixture.payload.magic; // reuse the fixture's own magic (or undefined) as `m`
      const before = structuredClone(fixture.payload);
      const result = spark1.edits!.setMagic!(fixture.payload, m);
      expect(fixture.payload).toEqual(before); // purity
      const payload = unwrap<Parameters<typeof spark1.compileMagic>[0]>(result);
      expect(spark1.compileMagic(payload)).toEqual(spark1.compileMagic({ ...fixture.payload, magic: m }));
    });
  }
});

// -- mana2/1 setFingermap: its own block (excluded from the generic loop
// above) because a char here names a `layout.fingers` ROW CELL, found via
// `parseRow`, not a `p.keys` map entry -- mana2/1 has none.
const DIGIT_TO_FINGER = Object.fromEntries(Object.entries(DIGIT_BY_FINGER).map(([f, d]) => [d, f]));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function mana2FingermapOf(p: any): Record<string, string> {
  const out: Record<string, string> = {};
  for (let y = 0; y < p.layout.fingers.length; y++) {
    const parsed = parseRow(p.layout.fingers[y]);
    if ("message" in parsed) continue;
    const digits = (p.fingermap[y] ?? "").trim().split(/\s+/).filter(Boolean);
    for (const { index, resolution } of parsed) {
      if (resolution.tap === undefined) continue; // skip, or a construct with no resolved tap
      const finger = DIGIT_TO_FINGER[Number(digits[index])];
      if (finger) out[resolution.tap] = finger;
    }
  }
  return out;
}

// `setFingermap` rebuilds a changed row's fingermap string from its own
// re-split digit tokens (single-space-joined) rather than patching the
// original text in place -- a real vendored file's LEADING whitespace
// (several rows use it to visually suggest the row's physical rightward
// shift, e.g. hours.jsonc's row 1/2) carries no data (translate.ts's own
// header comment: the loader's tokeniser collapses any run of whitespace
// identically), so this is not a loss, just a re-rendering -- canonicalised
// away here the same way `mana2.test.ts`'s own round-trip checks do.
function canonicalizeMana2Rows(p: mana2_1.Payload): unknown {
  const clone = structuredClone(p);
  const canon = (s: string | undefined) => (s ?? "").trim().split(/\s+/).filter(Boolean).join(" ");
  clone.layout.fingers = clone.layout.fingers.map(canon);
  if (clone.layout.thumbs) clone.layout.thumbs = clone.layout.thumbs.map(canon);
  clone.fingermap = clone.fingermap.map(canon);
  return clone;
}

describe("mana2/1 setFingermap (LDB-E1)", () => {
  const fixtures = fixturesFor("mana2/1");

  for (const fixture of fixtures) {
    it(`[LDB-E1] ${fixture.stem} setFingermap(fingermapOf(p)) is identity, pure, and valid`, () => {
      const before = structuredClone(fixture.payload);
      const map = mana2FingermapOf(fixture.payload);
      const result = mana2_1.edits!.setFingermap!(fixture.payload, map);
      expect(fixture.payload, "purity: input untouched").toEqual(before);
      expect(isEditError(result), "identity map is never refused").toBe(false);
      if (!isEditError(result)) {
        expect(canonicalizeMana2Rows(result as mana2_1.Payload), "identity: setFingermap(fingermapOf(p)) === p, modulo row whitespace").toEqual(canonicalizeMana2Rows(fixture.payload));
        expect(mana2_1.validate(result).ok, "validity").toBe(true);
      }
    });
  }

  it("[LDB-E1] a fingermap naming a char not in any fingers row -> invalid_payload at /layout/fingers", () => {
    const fixture = fixtures.find((f) => f.stem === "001-hours")!;
    const ghost = String.fromCharCode(1); // a control character, never a real layout key across any fixture
    const before = structuredClone(fixture.payload);
    const result = mana2_1.edits!.setFingermap!(fixture.payload, { [ghost]: "LP" });
    expect(fixture.payload).toEqual(before); // purity even on refusal
    expect(result).toEqual({ error: { error: "invalid_payload", message: expect.any(String), path: "/layout/fingers" } });
  });

  it("[LDB-E1] a partial fingermap changes exactly the named char's digit", () => {
    const fixture = fixtures.find((f) => f.stem === "001-hours")!;
    const map = mana2FingermapOf(fixture.payload);
    const chars = Object.keys(map);
    const [changed, untouched] = [chars[0]!, chars[1]!];
    const newFinger = map[changed] === "LP" ? "RP" : "LP";
    const result = mana2_1.edits!.setFingermap!(fixture.payload, { [changed]: newFinger });
    expect(isEditError(result)).toBe(false);
    if (!isEditError(result)) {
      const afterMap = mana2FingermapOf(result);
      expect(afterMap[changed]).toBe(newFinger);
      expect(afterMap[untouched]).toBe(map[untouched]);
    }
  });

  it("[LDB-E1] property: setFingermap then fingermapOf recovers the map, for random single-row layouts", () => {
    const digitByFinger: Record<string, number> = { LP: 0, LR: 1, LM: 2, LI: 3, LT: 4, RT: 5, RI: 6, RM: 7, RR: 8, RP: 9 };
    const nonThumbFingers = FINGERS.filter((f) => f !== "LT" && f !== "RT");
    fc.assert(
      fc.property(
        fc.uniqueArray(
          fc.string({ minLength: 1, maxLength: 1 }).filter((s) => !["skip", "space"].includes(s) && !/[()<>$\s]/.test(s)),
          { minLength: 1, maxLength: 6 },
        ),
        fc.array(fc.constantFrom(...nonThumbFingers), { minLength: 1, maxLength: 6 }),
        (chars, fingers) => {
          const row = chars.join(" ");
          const digits = chars.map((_, i) => digitByFinger[fingers[i % fingers.length]!]).join(" ");
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const base: any = { layout: { fingers: [row] }, fingermap: [digits], board: { isRowStaggered: true, rowOrColumnStagger: [0] } };
          const map: Record<string, string> = {};
          chars.forEach((c, i) => {
            map[c] = fingers[(i + 1) % fingers.length]!;
          });
          const before = structuredClone(base);
          const result = mana2_1.edits!.setFingermap!(base, map);
          expect(base).toEqual(before); // purity
          expect(isEditError(result)).toBe(false);
          if (!isEditError(result)) {
            expect(mana2FingermapOf(result)).toEqual(map);
          }
        },
      ),
      { numRuns: 100 },
    );
  });
});
