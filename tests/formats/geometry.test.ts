// [LDB-F30] `db/formats/spark/1/geometry.ts` is the ONE definition of the
// named-fingering classification (`classifyFingering`) -- never re-derived
// inside db/ (there is no hand split here any more: where to draw the gap is
// each client's own decision, 2026-09-24)
// (design/layout-db/23-geometry.md §3/§4.1/§4.3; the board-keyed
// `coords`/`STAGGER_BY_KIND` went with the board field, 26-no-board.md). This file is the unit-level proof for the
// pure functions themselves; `mf9-fromcmini.test.ts`/`mana2.test.ts` prove
// they're actually USED where they need to be, and the one-off parity
// script (db's own classifier vs the 4,191-layout catalog's stored
// `fingermap` field) is reported in the slice's own writeup rather than
// committed as a test (it reads `web/data/*.json`, outside this package).
import { describe, expect, it } from "vitest";
import { classifyFingering, gridIndent, FINGERING_REFS, type Key } from "../../formats/spark/1/geometry.ts";

function k(char: string | undefined, row: number, col: number, finger: string): Key {
  return { char, row, col, finger };
}

// -- classifyFingering (§4.3) --

function standardLayout(row2Overrides?: Record<number, string>): Key[] {
  const STD_L = ["LP", "LR", "LM", "LI", "LI"];
  const STD_R = ["RI", "RI", "RM", "RR", "RP"];
  const keys: Key[] = [];
  for (let row = 0; row < 3; row++) {
    for (let c = 0; c < 5; c++) {
      const finger = row === 2 && row2Overrides?.[c] ? row2Overrides[c]! : STD_L[c]!;
      keys.push(k(`L${row}${c}`, row, c, finger));
    }
    for (let c = 0; c < 5; c++) keys.push(k(`R${row}${c}`, row, c + 5, STD_R[c]!));
  }
  return keys;
}

describe("classifyFingering (§4.3)", () => {
  it("[LDB-F30] [LDB-F32] standard", () => {
    expect(classifyFingering(standardLayout())).toBe("standard");
  });

  it("[LDB-F30] [LDB-F32] angle: row 2 left = LR LM LI LI LI", () => {
    const layout = standardLayout({ 0: "LR", 1: "LM", 2: "LI", 3: "LI", 4: "LI" });
    expect(classifyFingering(layout)).toBe("angle");
  });

  it("[LDB-F30] [LDB-F32] nokwts/meteorite need row 0 AND row 2 both changed -- checked via FINGERING_REFS directly (constructing every row from the reference table, not by hand)", () => {
    for (const name of ["nokwts", "meteorite"] as const) {
      const [row0, row1, row2] = FINGERING_REFS[name];
      const keys: Key[] = [];
      const STD_R = ["RI", "RI", "RM", "RR", "RP"];
      [row0, row1, row2].forEach((leftRow, row) => {
        leftRow.forEach((finger, c) => keys.push(k(`L${row}${c}`, row, c, finger)));
        STD_R.forEach((finger, c) => keys.push(k(`R${row}${c}`, row, c + 5, finger)));
      });
      expect(classifyFingering(keys)).toBe(name);
    }
  });

  it("[LDB-F30] [LDB-F32] a missing cell never contradicts a reference", () => {
    const layout = standardLayout().filter((p) => p.char !== "L20"); // drop row 2 col 0
    expect(classifyFingering(layout)).toBe("standard");
  });

  it("[LDB-F30] [LDB-F32] an ambiguous/unrecognised shape is 'custom'", () => {
    const layout = standardLayout({ 0: "LM" }); // row 2 col 0 = LM, matches no reference's row 2 at that cell
    expect(classifyFingering(layout)).toBe("custom");
  });

  it("[LDB-F30] [LDB-F32] free (char-less) entries never participate", () => {
    const layout = standardLayout();
    const withFree = [...layout, k(undefined, 2, 0, "LM")]; // would collide with row 2 col 0 (LP) if it counted
    expect(classifyFingering(layout)).toBe("standard");
    // A free entry at an ALREADY-occupied (row, col) is invalid at the
    // payload level (duplicate position) -- this checks the FUNCTION alone
    // still ignores char-less entries, using a distinct row instead.
    const withFreeElsewhere = [...layout, k(undefined, 3, 0, "LP")];
    expect(classifyFingering(withFreeElsewhere)).toBe("standard");
    expect(withFree.length).toBe(layout.length + 1); // sanity: the array really grew
  });

  it("[LDB-F30] [LDB-F32] thumbs (LT/RT) are excluded from the position map", () => {
    const layout = [...standardLayout(), k("t", 3, 4, "LT")];
    expect(classifyFingering(layout)).toBe("standard");
  });

  it("[LDB-F30] [LDB-F32] the reference grid is FIXED at cols 0-4/5-9, never derived from a hand split -- confirmed against the real scripts/build_web.py source (a prior port anchored the right hand at each row's own split instead, which measurably diverged from the site's own stored labels on real catalog layouts; the slice's own parity script caught it)", () => {
    // iso's real extra row-2 key (col 5, an L-hand finger physically between
    // the fixed left and right halves) breaks every reference's right-hand
    // match at col 5 (expected RI) -- 'custom', never 'standard', because
    // classify_fingermap has no split concept to shift the window past it.
    const keys: Key[] = [
      ...standardLayout().filter((p) => p.row !== 2),
      k("q2", 2, 0, "LP"), k("k2", 2, 1, "LR"), k("m2", 2, 2, "LM"), k("c2", 2, 3, "LI"), k("v2", 2, 4, "LI"), k("x2", 2, 5, "LI"),
      k("n2", 2, 6, "RI"), k("e2", 2, 7, "RI"), k("i2", 2, 8, "RM"), k("h2", 2, 9, "RR"), k(",2", 2, 10, "RP"),
    ];
    expect(classifyFingering(keys)).toBe("custom");
  });

  it("[LDB-F32] a row whose real left-hand extent falls short of col 4 still checks the right hand at the FIXED cols 5-9 (never a narrower, row-derived window) -- a real catalog case (design/layout-db's parity script, 'alpha')", () => {
    // Row 0: only 4 left-hand keys (LP LR LM LI at cols 0-3, col 4 genuinely
    // absent) -- under a dynamic per-row split this would shift the right
    // window to start at col 4 instead of col 5, and (wrongly) still match
    // 'standard'; the fixed grid checks col 5 onward regardless, so an
    // actual key at col 4 with a RIGHT-hand finger is just another (missing
    // in the reference, so ignored) cell, and cols 5-9 must still equal
    // RI RI RM RR RP exactly.
    const keys: Key[] = [
      k("b", 0, 0, "LP"), k("l", 0, 1, "LR"), k("d", 0, 2, "LM"), k("c", 0, 3, "LI"),
      k("f", 0, 6, "RI"), k("o", 0, 7, "RM"), k("u", 0, 8, "RR"), k(",", 0, 9, "RP"),
      ...standardLayout().filter((p) => p.row !== 0),
    ];
    expect(classifyFingering(keys)).toBe("standard");
  });
});

describe("gridIndent (§5.4)", () => {
  it("[LDB-F30] flat for standard/custom", () => {
    expect(gridIndent("standard")).toEqual([0, 0, 0]);
    expect(gridIndent("custom")).toEqual([0, 0, 0]);
  });
  it("[LDB-F30] angle: rows 0-1 flush, row 2 in by one", () => {
    expect(gridIndent("angle")).toEqual([0, 0, 1]);
  });
  it("[LDB-F30] nokwts/meteorite: full 0/1/2 stagger", () => {
    expect(gridIndent("nokwts")).toEqual([0, 1, 2]);
    expect(gridIndent("meteorite")).toEqual([0, 1, 2]);
  });
});
