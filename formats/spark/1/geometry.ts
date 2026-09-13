// spark/1's board geometry (design/layout-db/23-geometry.md §3/§4, LDB-F30):
// ONE definition of physical coordinates, the hand split and the named
// fingering classification -- the site's drawer, the bot's grid/image and
// the mana2 lowering all call these, never re-derive them. "Infer once, at
// the door; store it explicitly; never infer at read time" (§3): `board` is
// one of four words (§4.1), the fingering name is a pure derived label
// (§4.3), never stored.
//
// Self-contained like every other file in this format package (07 §5): no
// import of src/formats/registry.ts, explicit `.ts` extensions so
// scripts/goldens.mjs can resolve this with plain Node ESM. `Key` (the
// unified keys-array entry, char/row/col/finger) is declared structurally
// here rather than imported from `./index.ts` at runtime, so this module has
// zero runtime dependencies of its own -- index.ts imports VALUES from here,
// never the reverse.

export const KINDS = ["ansi", "iso", "ortho", "colstag"] as const;
export type Board = (typeof KINDS)[number];

// One entry per PHYSICAL position (design/layout-db/23-geometry.md's
// duplicate-characters follow-up, folded into this round rather than done
// as a separate pass): `char` absent means a free position (spark/1's old
// separate `free` array is gone -- one list). `char` present may repeat
// across entries (the same letter on two positions) -- callers that need
// "the" position for a character (magic lookups) work off a layout where
// every MAGIC-REFERENCED char is validated unique first (index.ts's
// `validateMagicKeysUnique`); a plain duplicate letter with no magic
// reference is fine and carries no such guarantee.
export interface Key {
  char?: string;
  row: number;
  col: number;
  finger: string;
}

// §4.1's table: the stagger is a fixed function of the kind, nothing in the
// record overrides it. `ansi`: cmini's row-staggered ANSI shape (row 1 a
// quarter key right, row 2 three-quarters). `iso`: row 2 shifts LEFT a
// quarter key instead of right -- z (col 1) lands at 0.75, exactly its ANSI
// spot; only the new ISO key at col 0 (x = -0.25) is new. `ortho`/`colstag`:
// flat -- colstag's per-column amounts have no place in this fixed,
// per-ROW table (the word is for renderers/readers, not stagger amounts,
// §4.1: "colstag does not get to set stagger").
export const STAGGER_BY_KIND: Record<Board, [number, number, number]> = {
  ansi: [0, 0.25, 0.75],
  iso: [0, 0.25, -0.25],
  ortho: [0, 0, 0],
  colstag: [0, 0, 0],
};

// coords: physical (x, y) of a (row, col) on a given board kind. Rows past 2
// reuse row 2's own offset (there is no row-3+ entry in STAGGER_BY_KIND --
// the thumb row and any number row both sit at whatever offset row 2 uses).
export function coords(kind: Board, row: number, col: number): { x: number; y: number } {
  const stagger = STAGGER_BY_KIND[kind];
  const rowIdx = Math.min(row, 2);
  return { x: col + stagger[rowIdx]!, y: row };
}

// §4.1: "for each finger row, the gap sits after the last column whose key
// has a left-hand finger (L*)"; DEFAULT_SPLIT (5) when a row has no L* key
// at all (undeterminable -- the ordinary 10-wide-board case, where this
// always agrees with the fixed col4|col5 boundary every legacy reader used).
const DEFAULT_SPLIT = 5;

// handSplitRows: per finger row (0..max(2, highest row seen)), 1 + the max
// column among ALL entries (a free position counts too -- it has a finger,
// §4.1: "keys and free positions") whose finger starts with 'L' -- thumbs
// (LT/RT) are excluded even though their label also starts with 'L'/'R'
// (§4.1: "not thumbs"). DEFAULT_SPLIT when a row has no L* entry at all.
// Exported separately from `handSplit` (the board split, below) for a
// lowering that needs the PER-ROW value (`classifyFingering` here; the
// coordinator's own parity note keeps these two as separate calls, matching
// the site's port -- LDB-F30, one definition, numerically identical).
export function handSplitRows(keys: Key[]): number[] {
  const maxRow = Math.max(2, ...keys.map((p) => p.row));
  const rows: number[] = [];
  for (let row = 0; row <= maxRow; row++) {
    let maxLeftCol = -1;
    for (const p of keys) {
      if (p.row !== row || p.finger === "LT" || p.finger === "RT") continue;
      if (p.finger.startsWith("L")) maxLeftCol = Math.max(maxLeftCol, p.col);
    }
    rows.push(maxLeftCol >= 0 ? maxLeftCol + 1 : DEFAULT_SPLIT);
  }
  return rows;
}

// handSplit: THE board's hand split -- the minimum, over finger rows (row
// <= 2) that have BOTH an L* entry and an R* entry, of that row's local
// split (`handSplitRows`); DEFAULT_SPLIT (5) when no row qualifies,
// including an entirely empty layout. Returns the bare number (not an
// object) to match the site's own port number-for-number (LDB-F30).
export function handSplit(keys: Key[]): number {
  const maxRow = Math.max(2, ...keys.map((p) => p.row));
  const candidates: number[] = [];
  for (let row = 0; row <= Math.min(2, maxRow); row++) {
    let maxLeftCol = -1;
    let hasRight = false;
    for (const p of keys) {
      if (p.row !== row || p.finger === "LT" || p.finger === "RT") continue;
      if (p.finger.startsWith("L")) maxLeftCol = Math.max(maxLeftCol, p.col);
      else if (p.finger.startsWith("R")) hasRight = true;
    }
    if (maxLeftCol >= 0 && hasRight) candidates.push(maxLeftCol + 1);
  }
  return candidates.length > 0 ? Math.min(...candidates) : DEFAULT_SPLIT;
}

// §4.3's four references, left hand only (cols 0-4) -- the right hand is
// always RI RI RM RR RP at a FIXED cols 5-9, exactly `scripts/build_web.py`'s
// `_build_fingermap_refs()` (`enumerate(right, start=5)`, never derived from
// `handSplitRows`) -- confirmed against the real Python source by the
// slice's own parity script (db/formats/spark/1's own writeup): an earlier
// draft of this port anchored the right hand at each row's OWN handSplit
// column instead, which reads as a reasonable generalization but is NOT
// what the site actually does, and measurably diverged on real catalog
// layouts whose left-hand extent falls short of col 4 on some row (`alpha`,
// e.g.) -- classify_fingermap has no such generalization; a 10-wide board
// is baked into the four reference tables.
const STD_L = ["LP", "LR", "LM", "LI", "LI"];
const STD_R = ["RI", "RI", "RM", "RR", "RP"];
const ANG_L = ["LR", "LM", "LI", "LI", "LI"]; // angle mod row 2 (pinky absent)
const NKW_R0 = ["LP", "LR", "LM", "LM", "LI"]; // nokwts row 0 (col 3 = middle)
const NKW_L2 = ["LP", "LR", "LI", "LI", "LI"]; // nokwts row 2 (index on cols 2-4)

export type NamedFingering = "standard" | "angle" | "nokwts" | "meteorite";
export type Fingering = NamedFingering | "custom";

// [row0, row1, row2] left-hand references, ported byte-for-byte from
// scripts/build_web.py's `_build_fingermap_refs()` (web/src/core/
// geometry.ts's `FINGERMAP_REFS` is the other port -- all three must agree,
// LDB-F30 archlint: no second definition. This module is now the ONE place;
// the site/pipeline ports are expected to call it once the pipeline slice
// (order-of-work step 4) lands).
export const FINGERING_REFS: Record<NamedFingering, [string[], string[], string[]]> = {
  standard: [STD_L, STD_L, STD_L],
  angle: [STD_L, STD_L, ANG_L],
  nokwts: [NKW_R0, STD_L, NKW_L2],
  meteorite: [NKW_R0, STD_L, ANG_L],
};

// classifyFingering: build_web.py's `classify_fingermap`, exactly -- a
// FIXED 3x10 grid (rows 0-2, cols 0-9: cols 0-4 the left-hand reference,
// cols 5-9 always RI RI RM RR RP, never derived from handSplitRows/handSplit
// -- see the reference table's own comment above). Missing cells (no key at
// that row/col) never contradict a reference; a layout matching exactly one
// reference is named that; zero or several matches (ambiguous, e.g. every
// named row absent) is 'custom' (the site's 'other'). Thumbs (LT/RT) are
// excluded from the position map, same as the python's `p.finger not in
// ('LT', 'RT')`. A key OUTSIDE this fixed 3x10 grid (row >= 3, or col >= 10
// on an iso/wider row) is simply never looked at either way, same as the
// python (`ref.items()` only ever names (row, col) pairs inside the grid).
export function classifyFingering(keys: Key[]): Fingering {
  // Only CHARACTER entries participate (build_web.py's `classify_fingermap`
  // reads `ll.keys.values()` -- cmini's own char map, never a free
  // position); a free position (no `char`) is skipped here even though
  // `handSplit`/`handSplitRows` count it.
  const pos = new Map<string, string>();
  for (const p of keys) {
    if (p.char === undefined || p.finger === "LT" || p.finger === "RT") continue;
    pos.set(`${p.row},${p.col}`, p.finger);
  }

  const matches: NamedFingering[] = [];
  for (const name of Object.keys(FINGERING_REFS) as NamedFingering[]) {
    const ref = FINGERING_REFS[name];
    let ok = true;
    for (let row = 0; row < 3 && ok; row++) {
      const leftRow = ref[row]!;
      for (let c = 0; c < 5; c++) {
        const f = pos.get(`${row},${c}`);
        if (f !== undefined && f !== leftRow[c]) {
          ok = false;
          break;
        }
      }
      if (!ok) break;
      for (let c = 0; c < 5; c++) {
        const f = pos.get(`${row},${5 + c}`);
        if (f !== undefined && f !== STD_R[c]) {
          ok = false;
          break;
        }
      }
    }
    if (ok) matches.push(name);
  }
  return matches.length === 1 ? matches[0]! : "custom";
}

// gridIndent: §5.4's text-grid look, as a pure function of the derived
// fingering alone (the board word never changes the ascii grid). Flat
// (0/0/0) for standard/custom/anything else; `angle` is rows 0-1 flush, row
// 2 in by one; `nokwts`/`meteorite` are the full 0/1/2 stagger (saltorbit:
// "meteorite, like aguacero, should present more like [nokwts]"). The ISO
// out-dent (row 2 sticking out left by one cell) is the bot's own concern,
// layered on top of this, not part of this function (§5.4's own note).
export function gridIndent(fingering: Fingering): [number, number, number] {
  switch (fingering) {
    case "angle":
      return [0, 0, 1];
    case "nokwts":
    case "meteorite":
      return [0, 1, 2];
    default:
      return [0, 0, 0];
  }
}
