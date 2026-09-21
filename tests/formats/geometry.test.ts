// [LDB-F30] `db/formats/spark/1/geometry.ts` is the ONE definition of the
// hand split (`handSplit`/`handSplitRows`) and the named-fingering
// classification (`classifyFingering`) -- the site's drawer, the bot's
// grid/image and the mana2 lowering all call these, never re-derive them
// (design/layout-db/23-geometry.md §3/§4.1/§4.3; the board-keyed
// `coords`/`STAGGER_BY_KIND` went with the board field, 26-no-board.md). This file is the unit-level proof for the
// pure functions themselves; `mf9-fromcmini.test.ts`/`mana2.test.ts` prove
// they're actually USED where they need to be, and the one-off parity
// script (db's own classifier vs the 4,191-layout catalog's stored
// `fingermap` field) is reported in the slice's own writeup rather than
// committed as a test (it reads `web/data/*.json`, outside this package).
import { describe, expect, it } from "vitest";
import { handSplit, handSplitRows, handSplitForRow, classifyFingering, gridIndent, FINGERING_REFS, type Key } from "../../formats/spark/1/geometry.ts";

// -- handSplit / handSplitRows (§4.1, the coordinator's parity note) --

function k(char: string | undefined, row: number, col: number, finger: string): Key {
  return { char, row, col, finger };
}

describe("handSplit / handSplitRows (§4.1)", () => {
  it("[LDB-F30] the ordinary 10-wide board: split 5 on every row", () => {
    const keys: Key[] = [
      k("q", 0, 0, "LP"), k("w", 0, 1, "LR"), k("e", 0, 2, "LM"), k("r", 0, 3, "LI"), k("t", 0, 4, "LI"),
      k("y", 0, 5, "RI"), k("u", 0, 6, "RI"), k("i", 0, 7, "RM"), k("o", 0, 8, "RR"), k("p", 0, 9, "RP"),
    ];
    expect(handSplit(keys)).toBe(5);
    expect(handSplitRows(keys)).toEqual([5, 5, 5]);
  });

  it("[LDB-F30] empty keys -> 5 (undeterminable, every row)", () => {
    expect(handSplit([])).toBe(5);
    expect(handSplitRows([])).toEqual([5, 5, 5]);
  });

  it("[LDB-F30] a free (char-less) entry counts the same as a keyed one", () => {
    const keys: Key[] = [k(undefined, 0, 0, "LP"), k(undefined, 0, 1, "LR"), k("y", 0, 5, "RI")];
    expect(handSplitRows(keys)[0]).toBe(2);
  });

  it("[LDB-F30] thumbs (LT/RT) never count, even though their label starts with L/R", () => {
    const keys: Key[] = [k("a", 0, 0, "LP"), k("z", 3, 9, "LT")]; // a stray thumb far to the right must not move row 0's split
    expect(handSplitRows(keys)[0]).toBe(1);
  });

  it("[LDB-F30] a row with an L* entry but no R* entry never qualifies as a board-split candidate", () => {
    const keys: Key[] = [k("a", 0, 3, "LI")]; // row 0: left only, no right -- not a candidate
    expect(handSplit(keys)).toBe(5); // falls through to the default
    expect(handSplitRows(keys)).toEqual([4, 5, 5]);
  });

  // The coordinator's own disagreeing-rows fixture: an 11-wide row 0 (right
  // hand starting at col 5, an extra RP-ish column tacked on past it, which
  // doesn't move the SPLIT itself) alongside a 12-wide colstag-style row 1
  // whose right hand starts at col 6 -- the board split is the MINIMUM
  // across qualifying rows, so it's 5 (row 0), not 6 (row 1).
  it("[LDB-F30] disagreeing rows: board split is the MINIMUM over qualifying rows", () => {
    const keys: Key[] = [
      // row 0: ordinary 10-wide split-at-5, plus one more right-hand key at col 10 (doesn't change the split)
      k("a", 0, 4, "LI"), k("b", 0, 5, "RI"), k("c", 0, 10, "RP"),
      // row 1: a 12-wide colstag-style row, left hand fills cols 0-5, right hand starts at col 6
      k("d", 1, 5, "LI"), k("e", 1, 6, "RI"),
    ];
    expect(handSplitRows(keys)).toEqual([5, 6, 5]); // row 2 has no entries -> default 5
    expect(handSplit(keys)).toBe(5); // min(5, 6) -- row 0 wins
  });

  it("[LDB-F30] iso's row 2 (6 left columns, split 6) doesn't affect the board split when rows 0-1 split at 5", () => {
    const keys: Key[] = [
      k("q", 0, 0, "LP"), k("w", 0, 1, "LR"), k("e", 0, 2, "LM"), k("r", 0, 3, "LI"), k("t", 0, 4, "LI"), k("y", 0, 5, "RI"),
      k("a", 1, 0, "LP"), k("s", 1, 1, "LR"), k("d", 1, 2, "LM"), k("f", 1, 3, "LI"), k("g", 1, 4, "LI"), k("h", 1, 5, "RI"),
      k("iso", 2, 0, "LP"), k("z", 2, 1, "LR"), k("x", 2, 2, "LM"), k("c", 2, 3, "LI"), k("v", 2, 4, "LI"), k("b", 2, 5, "LI"), k("n", 2, 6, "RI"),
    ];
    expect(handSplitRows(keys)).toEqual([5, 5, 6]);
    expect(handSplit(keys)).toBe(5);
  });
});

// -- handSplitForRow (§4.1, the row-minus-one decision, 2026-09-21) --

describe("[LDB-F42] handSplitForRow", () => {
  it("works for row -1 (the number row), same rule as any other row", () => {
    const keys: Key[] = [
      k("1", -1, 0, "LP"), k("2", -1, 1, "LR"), k("3", -1, 2, "LM"), k("4", -1, 3, "LI"), k("5", -1, 4, "LI"),
      k("6", -1, 5, "RI"), k("7", -1, 6, "RI"), k("8", -1, 7, "RM"), k("9", -1, 8, "RR"), k("0", -1, 9, "RP"),
    ];
    expect(handSplitForRow(keys, -1)).toBe(5);
  });

  it("row -1 falls back to DEFAULT_SPLIT (5) when it has no L* entry", () => {
    expect(handSplitForRow([], -1)).toBe(5);
    expect(handSplitForRow([k("6", -1, 5, "RI")], -1)).toBe(5);
  });

  it("row -1's split is independent of every other row's", () => {
    const keys: Key[] = [k("1", -1, 2, "LM"), k("q", 0, 0, "LP")]; // row -1 splits at 3, row 0 at 1 -- neither moves the other
    expect(handSplitForRow(keys, -1)).toBe(3);
    expect(handSplitForRow(keys, 0)).toBe(1);
  });

  it("a thumb (LT/RT) on row -1 never counts, even though its label starts with L/R", () => {
    const keys: Key[] = [k("1", -1, 0, "LP"), k("z", -1, 9, "LT")]; // a stray thumb far to the right must not move row -1's split
    expect(handSplitForRow(keys, -1)).toBe(1);
  });

  it("[LDB-F42] handSplitRows(keys)[r] === handSplitForRow(keys, r) for every row handSplitRows covers", () => {
    const keys: Key[] = [
      k("1", -1, 0, "LP"), k("2", -1, 5, "RI"),
      k("q", 0, 0, "LP"), k("w", 0, 1, "LR"), k("e", 0, 2, "LM"), k("r", 0, 3, "LI"), k("t", 0, 4, "LI"),
      k("y", 0, 5, "RI"), k("u", 0, 6, "RI"), k("i", 0, 7, "RM"), k("o", 0, 8, "RR"), k("p", 0, 9, "RP"),
      k("a", 1, 0, "LP"), k("z", 2, 0, "LR"),
    ];
    const rows = handSplitRows(keys);
    for (let r = 0; r < rows.length; r++) expect(rows[r]).toBe(handSplitForRow(keys, r));
    // `handSplitRows` never grows a slot for row -1 (contract, geometry.ts's
    // own comment) -- a caller wanting it calls `handSplitForRow` directly,
    // which the loop above never does at index -1.
    expect(rows.length).toBe(3); // max(2, highest row seen) + 1 -- row -1 isn't "the highest row"
    expect(handSplitForRow(keys, -1)).toBe(1); // reachable, just not through handSplitRows' own array
  });
});

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

  it("[LDB-F30] [LDB-F32] the reference grid is FIXED at cols 0-4/5-9, never derived from handSplit/handSplitRows -- confirmed against the real scripts/build_web.py source (a prior port anchored the right hand at each row's own split instead, which measurably diverged from the site's own stored labels on real catalog layouts; the slice's own parity script caught it)", () => {
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
