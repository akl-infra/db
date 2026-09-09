// [LDB-F5] [LDB-F13] mana2/1 <-> akl/1 (12-implementation-phase5.md §2.5,
// which replaces 01-format.md §6.3). goldens.test.ts/mutations.test.ts/
// frozen.test.ts already cover this format generically (registry-driven --
// registering it in src/formats/registry.ts is what picked them up): every
// named/hand-written fixture validates and has frozen `.lowered.json`/
// `.akl-1.json`/`.cmini-1.json` goldens [LDB-F1] [LDB-F2] [LDB-F7]
// [LDB-F6], and the fingers/fingermap/duplicate-char/duplicate-inputs/
// combos mutation matrix is enforced [LDB-F1]. This file is what's left:
// the envelope over all 75 vendored layouts, the algorithm-row assertions
// §2.5 states by name, both round-trip directions, and the held-reasons
// enumeration.
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import * as akl1 from "../../formats/akl/1/index.ts";
import { computeRows } from "../../formats/akl/1/magic.ts";
import type { Payload as AklPayload, Board as AklBoard } from "../../formats/akl/1/index.ts";
import * as mana2_1 from "../../formats/mana2/1/index.ts";
import type { Payload as Mana2Payload } from "../../formats/mana2/1/index.ts";
import { parseRow } from "../../formats/mana2/1/translate.ts";

const VENDORED_DIR = path.resolve(import.meta.dirname, "..", "fixtures", "mana2-vendored");
const MANA2_FIXTURES_DIR = path.resolve(import.meta.dirname, "..", "..", "formats", "mana2", "1", "fixtures");
const AKL_FIXTURES_DIR = path.resolve(import.meta.dirname, "..", "..", "formats", "akl", "1", "fixtures");
const CMINI_FIXTURES_DIR = path.resolve(import.meta.dirname, "..", "..", "formats", "cmini", "1", "fixtures");

function isBaseFixtureFile(filename: string): boolean {
  if (!filename.endsWith(".json")) return false;
  return !filename.slice(0, -".json".length).includes(".");
}

function isHeldResult(v: unknown): v is { held: true; reason: string } {
  return typeof v === "object" && v !== null && (v as { held?: unknown }).held === true;
}

// -- half 1: the envelope -- every one of the 75 vendored layouts --

describe("every vendored mana2 layout -- the envelope (75 files)", () => {
  const files = fs.readdirSync(VENDORED_DIR).filter((f) => f.endsWith(".json")).sort();

  it("[LDB-F7] all 75 vendored layouts are present", () => {
    expect(files.length).toBe(75);
  });

  const heldVendoredFiles: string[] = [];
  for (const file of files) {
    const stem = file.slice(0, -".json".length);
    const payload = JSON.parse(fs.readFileSync(path.join(VENDORED_DIR, file), "utf8")) as Mana2Payload;

    if (stem === "d5") {
      // Verified by hand against core/load_layout.go (README.md has the
      // full trace): row 0's two `(<space repeat> $shift)` cells both
      // resolve without error (the loader never validates or uses their
      // outer second slot at all), so the row proceeds to its eight plain
      // words -- "g d m y y b f z" -- where the SECOND "y" collides with
      // the first. `addKeyToLayout`'s own duplicate-key check refuses
      // this BEFORE either tap-hold cell's held-ness would ever matter.
      // d5 is therefore refused, not held -- 12 §X2's plan assumed
      // otherwise; this is a verified correction, not a shortcut.
      it("[LDB-F1] d5: refused (duplicate 'y' on row 0, not held for its tap-hold content)", () => {
        const result = mana2_1.validate(payload);
        expect(result.ok).toBe(false);
        if (!result.ok) {
          expect(result.error.message).toBe("Duplicate keys are not allowed. If you need them, implement them through magic");
          expect(result.error.path).toBe("/layout/fingers/0");
        }
      });
      continue;
    }

    it(`[LDB-F1] ${stem} validates against mana2/1`, () => {
      expect(mana2_1.validate(payload).ok).toBe(true);
    });

    it(`[LDB-F1] ${stem}: to["akl/1"] succeeds (no vendored file besides d5 is held, 12 §0.5)`, () => {
      const check = mana2_1.validate(payload);
      if (!check.ok) return; // d5 handled above; nothing else fails here
      const translated = mana2_1.to["akl/1"]!(payload);
      if (isHeldResult(translated)) {
        heldVendoredFiles.push(stem);
        return;
      }
      expect(akl1.validate(translated as AklPayload).ok).toBe(true);
    });
  }

  it("[LDB-F13] no vendored file besides d5 is held -- an enumerated, empty list (12 §0.5's own table)", () => {
    expect(heldVendoredFiles).toEqual([]);
  });
});

// -- half 2: algorithm-row assertions, §2.5's own examples, exact --

describe("algorithm rows (12-implementation-phase5.md §2.5, exact)", () => {
  function load(name: string): Mana2Payload {
    return JSON.parse(fs.readFileSync(path.join(MANA2_FIXTURES_DIR, `${name}.json`), "utf8"));
  }
  function akl(name: string): AklPayload {
    const t = mana2_1.to["akl/1"]!(load(name));
    if (isHeldResult(t)) throw new Error(`${name} unexpectedly held: ${t.reason}`);
    return t as AklPayload;
  }

  it("hours: e at {row:3,col:5,finger:RT}, space at {row:3,col:4,finger:LT}", () => {
    const a = akl("001-hours");
    expect(a.keys["e"]).toEqual({ row: 3, col: 5, finger: "RT" });
    expect(a.keys[" "]).toEqual({ row: 3, col: 4, finger: "LT" });
  });

  it("chantries: l {row:3,col:3,finger:LT}, h {row:3,col:4,finger:LT}", () => {
    const a = akl("006-chantries");
    expect(a.keys["l"]).toEqual({ row: 3, col: 3, finger: "LT" });
    expect(a.keys["h"]).toEqual({ row: 3, col: 4, finger: "LT" });
  });

  it("stand_iso: free[0] = {row:2,col:5,finger:LI}", () => {
    const a = akl("003-stand_iso");
    expect(a.free).toContainEqual({ row: 2, col: 5, finger: "LI" });
  });

  it("cyclone: row 2 col 0 is 'k' with LR", () => {
    const a = akl("008-cyclone");
    expect(a.keys["k"]).toMatchObject({ row: 2, col: 0, finger: "LR" });
  });

  it("graphite: columns reach 11", () => {
    const a = akl("002-graphite");
    const maxCol = Math.max(...Object.values(a.keys).map((k) => k.col), ...(a.free ?? []).map((k) => k.col));
    expect(maxCol).toBe(11);
  });

  it("whirl: colstag with 10 entries", () => {
    const a = akl("004-whirl");
    expect(a.board?.kind).toBe("colstag");
    expect(a.board?.stagger).toHaveLength(10);
  });

  it("bunya: ortho", () => {
    const a = akl("005-bunya");
    expect(a.board).toEqual({ kind: "ortho", cmini: "ortho" });
  });

  it("904-dup-rules: keeps the last rule", () => {
    const t = akl("904-dup-rules");
    expect(t.magic?.rules).toEqual([{ inputs: "th", output: "te", type: "raw" }]);
  });

  const heldCases: Array<[string, string]> = [
    ["900-held-combos", "combos have no akl/1 idiom"],
    ["903-held-sixthumbs", "more than five keys on one thumb"],
    ["906-held-taphold", "tap-hold token has no akl/1 idiom"],
    ["907-held-directional", "directional token has no akl/1 idiom"],
    ["908-held-stagger-mismatch", "rowstag stagger entries past the third must equal the third"],
  ];
  for (const [name, reason] of heldCases) {
    it(`${name}: held -- ${reason}`, () => {
      const t = mana2_1.to["akl/1"]!(load(name));
      expect(isHeldResult(t)).toBe(true);
      if (isHeldResult(t)) expect(t.reason).toBe(reason);
    });
  }

  const hatchCases: Array<[string, string, unknown]> = [
    ["901-splitangle-hatch", "splitAngle", 15],
    ["902-mirror-hatch", "mirrorLeftRowStagger", true],
  ];
  for (const [name, field, value] of hatchCases) {
    it(`${name}: NOT held -- x.mana2 hatch carries board.${field} (12 §2.5's decision, this format's override)`, () => {
      const a = akl(name);
      expect(isHeldResult(a)).toBe(false);
      expect((a.x as { mana2?: Record<string, unknown> } | undefined)?.mana2?.[field]).toBe(value);
    });
  }

  it("905-colstag-zeros: derives to ortho", () => {
    const a = akl("905-colstag-zeros");
    expect(a.board).toEqual({ kind: "ortho", cmini: "ortho" });
  });
});

// -- half 3: mana2 -> akl -> mana2, every valid vendored file + every
// non-held hand fixture, identity under normalizeMana2() (§2.5's own
// definition, implemented exactly) --

function tokensOf(row: string | undefined): string[] {
  return (row ?? "").trim().split(/\s+/).filter((t) => t.length > 0);
}

function cellCount(row: string): number {
  const parsed = parseRow(row);
  return "message" in parsed ? tokensOf(row).length : parsed.length;
}

// §2.5's last paragraph, verbatim: trim each row; drop fingermap digits
// past the row's own cell count; drop stagger entries past the rows
// (rowstag) / width (colstag); treat `layers: null`/`magicKeys: null`/
// `mirrorLeftRowStagger: false`/`splitAngle: 0` as absent; key order (a
// plain JS object comparison already ignores property order -- only array
// order is significant, and no array here is reordered by this function).
function normalizeMana2(m: Mana2Payload): unknown {
  const fingers = m.layout.fingers.map((r) => tokensOf(r).join(" "));
  const thumbs = m.layout.thumbs?.map((r) => tokensOf(r).join(" "));
  const fingermap = m.fingermap.map((row, y) => {
    const n = cellCount(m.layout.fingers[y] ?? "");
    return tokensOf(row).slice(0, n).join(" ");
  });
  const isRowStaggered = m.board.isRowStaggered;
  const width = m.layout.fingers.length === 0 ? 0 : Math.max(...m.layout.fingers.map((r) => cellCount(r)));
  const staggerLimit = isRowStaggered ? m.layout.fingers.length : width;
  const stagger = m.board.rowOrColumnStagger.slice(0, staggerLimit);

  const board: Record<string, unknown> = { isRowStaggered, rowOrColumnStagger: stagger };
  if (m.board.mirrorLeftRowStagger) board.mirrorLeftRowStagger = true;
  if (m.board.splitAngle) board.splitAngle = m.board.splitAngle;

  const out: Record<string, unknown> = { layout: { fingers }, fingermap, board };
  if (thumbs && thumbs.some((t) => t.length > 0)) (out.layout as Record<string, unknown>).thumbs = thumbs;
  if (m.magic) {
    const rules = m.magic.rules ?? [];
    const magic: Record<string, unknown> = {};
    if (rules.length > 0) magic.rules = rules;
    if (m.magic.magicKeys != null) magic.magicKeys = m.magic.magicKeys;
    if (Object.keys(magic).length > 0) out.magic = magic;
  }
  if (m.combos && m.combos.length > 0) out.combos = m.combos;
  if (m.layers != null) out.layers = m.layers;
  return out;
}

describe("mana2/1 -> akl/1 -> mana2/1 (every non-held fixture, modulo normalizeMana2())", () => {
  const vendored = fs.readdirSync(VENDORED_DIR).filter((f) => f.endsWith(".json") && f !== "d5.json").sort();
  const named = fs.readdirSync(MANA2_FIXTURES_DIR).filter(isBaseFixtureFile).sort();

  for (const [dir, files] of [
    [VENDORED_DIR, vendored],
    [MANA2_FIXTURES_DIR, named],
  ] as const) {
    for (const file of files) {
      const stem = file.slice(0, -".json".length);
      const m = JSON.parse(fs.readFileSync(path.join(dir, file), "utf8")) as Mana2Payload;
      const check = mana2_1.validate(m);
      if (!check.ok) continue; // shouldn't happen here; the envelope test above is the authority
      // Two hand fixtures are DESIGNED to be lossy, not round-trip clean
      // -- `904-dup-rules` (last-wins dedup at the FIRST hop discards the
      // earlier duplicate forever) and `905-colstag-zeros` (an all-zero
      // colstag collapses to "ortho", which comes back isRowStaggered:
      // true, not the original false -- the same asymmetry documented for
      // `board.kind: "ortho"` generally). Both are asserted exactly, by
      // name, in the "algorithm rows" describe block above; excluded here
      // so this generic loop's identity claim stays true for what it
      // actually claims.
      if (stem === "904-dup-rules" || stem === "905-colstag-zeros") continue;
      const translated = mana2_1.to["akl/1"]!(m);
      if (isHeldResult(translated)) continue; // held fixtures have no round trip to check here (algorithm-row assertions cover them)

      it(`[LDB-F5] ${stem}: identity under normalizeMana2()`, () => {
        const akl = translated as AklPayload;
        expect(akl1.validate(akl).ok).toBe(true);
        const back = mana2_1.from["akl/1"]!(akl);
        expect(normalizeMana2(back)).toEqual(normalizeMana2(m));
      });
    }
  }
});

// -- half 4: akl/1 -> mana2/1 -> akl/1, every akl/1 AND cmini/1(-derived)
// fixture: identity OFF the thumb row (12 §5's own invariant wording),
// with the enumerated thumb re-anchoring asserted exactly, not skipped --

function expectedBoard(board: AklBoard | undefined, _numMainRows: number): AklBoard {
  // ortho (or board absent) -> fromAkl's isRowStaggered:true, all-zero
  // stagger -> toAkl's OWN all-zero-collapses-to-ortho rule (12 §2.5's
  // table: "isRowStaggered: true, stagger all zero -> board: {kind:ortho,
  // cmini:ortho}") gives back EXACTLY "ortho" again -- a fully lossless
  // hop for this corner, not the asymmetric "becomes rowstag+zeros" loss
  // an earlier round of this format had before that all-zero rule existed.
  if (board === undefined || board.kind === "ortho") {
    return { kind: "ortho", cmini: "ortho" };
  }
  if (board.kind === "colstag") {
    const out: AklBoard = { kind: "colstag" };
    if (board.stagger) out.stagger = board.stagger;
    return out;
  }
  const out: AklBoard = { kind: "rowstag" };
  if (board.stagger) {
    const first3 = board.stagger.slice(0, 3);
    out.stagger = first3;
    if (first3.length === 3 && first3[0] === 0 && first3[1] === 0.25 && first3[2] === 0.75) out.cmini = "stagger";
  }
  return out;
}

function expectedMagic(p: AklPayload): AklPayload["magic"] {
  const rows = computeRows(p.magic, p.keys);
  if (rows.length === 0) return undefined;
  return { rules: rows.map((r) => ({ inputs: r.inputs, output: r.output, type: "raw" })) };
}

interface ThumbEntry {
  col: number;
  row: number;
  char?: string;
}

function isThumbFinger(f: string): boolean {
  return f === "LT" || f === "RT" || f === "TB";
}

// Non-thumb keys/free/board/lower(magic) are identity; thumb keys
// re-anchor by `col < 4.5` into mana2's compact convention and back out
// at fixed columns 4/5 (§2.5's own thumb formula) -- NOT the same
// row/col they started at, and never `TB` again (mana2 has no such
// finger). Predicted here by literally re-deriving what `fromAkl`'s own
// grouping+sort+re-anchor step produces, then feeding it through
// `toAkl`'s own reverse formula -- the exact mechanism, not a guess.
function adjustForMana2RoundTrip(a: AklPayload): AklPayload {
  const mainEntries: Array<{ row: number; col: number; char?: string; finger: string }> = [];
  const left: ThumbEntry[] = [];
  const right: ThumbEntry[] = [];

  for (const [ch, pos] of Object.entries(a.keys)) {
    if (isThumbFinger(pos.finger)) (pos.col < 4.5 ? left : right).push({ col: pos.col, row: pos.row, char: ch });
    else mainEntries.push({ row: pos.row, col: pos.col, char: ch, finger: pos.finger });
  }
  for (const pos of a.free ?? []) {
    if (isThumbFinger(pos.finger)) (pos.col < 4.5 ? left : right).push({ col: pos.col, row: pos.row });
    else mainEntries.push({ row: pos.row, col: pos.col, finger: pos.finger });
  }

  const numMainRows = Math.max(mainEntries.length === 0 ? 0 : Math.max(...mainEntries.map((e) => e.row)) + 1, 1);
  const maxCol = mainEntries.length === 0 ? -1 : Math.max(...mainEntries.map((e) => e.col));
  const thumbRow = numMainRows;
  const sortSide = (side: ThumbEntry[]): ThumbEntry[] => [...side].sort((x, y) => (x.col !== y.col ? x.col - y.col : x.row - y.row));

  // Exactly `fromAkl`'s own main-row grid: every column 0..maxCol that
  // has neither a key nor a `free` entry becomes a "skip" cell (finger
  // digit 0 = LP, since there is no finger to report); an EXISTING
  // `free` entry is ALSO a "skip" cell (its own finger is what gets
  // reported). Trailing skip cells (from either source, indistinguishable
  // once lowered to a token string) are trimmed -- so a column past the
  // row's LAST REAL KEY simply vanishes, key or gap alike, and a
  // surviving gap-or-free cell reappears as a NEW `free` entry (finger LP
  // for a pure gap, the original finger for a genuine `free` entry).
  const outKeys: AklPayload["keys"] = {};
  const outFree: AklPayload["keys"][string][] = [];
  for (let r = 0; r < numMainRows; r++) {
    const byCol = new Map<number, { char?: string; finger: string }>();
    for (const e of mainEntries) if (e.row === r) byCol.set(e.col, { char: e.char, finger: e.finger });
    let width = 0;
    for (let c = 0; c <= maxCol; c++) {
      const e = byCol.get(c);
      if (e && e.char !== undefined) width = c + 1;
    }
    for (let c = 0; c < width; c++) {
      const e = byCol.get(c);
      if (e && e.char !== undefined) outKeys[e.char] = { row: r, col: c, finger: e.finger };
      else outFree.push({ row: r, col: c, finger: e ? e.finger : "LP" });
    }
  }

  sortSide(left).forEach((e, i) => {
    const col = 4 - (sortSide(left).length - 1 - i);
    if (e.char === undefined) outFree.push({ row: thumbRow, col, finger: "LT" });
    else outKeys[e.char] = { row: thumbRow, col, finger: "LT" };
  });
  sortSide(right).forEach((e, j) => {
    const col = 5 + j;
    if (e.char === undefined) outFree.push({ row: thumbRow, col, finger: "RT" });
    else outKeys[e.char] = { row: thumbRow, col, finger: "RT" };
  });

  const numMainRowsForBoard = numMainRows;
  const board = expectedBoard(a.board, numMainRowsForBoard);
  const out: AklPayload = { keys: outKeys, board };
  if (outFree.length > 0) out.free = outFree;
  const magic = expectedMagic(a);
  if (magic) out.magic = magic;
  // `fromAkl` never leaves mirrorLeftRowStagger/splitAngle/magicKeys/
  // layers unset on the mana2 payload it produces (defaults when no
  // x.mana2 hint exists to prefer instead), so the very next `toAkl` call
  // always finds them present and captures them into a NEW `x.mana2` --
  // even though none of this format's own akl/1 fixtures ever had one.
  // README.md documents this as the deliberate mirror image of a
  // genuinely mana2-sourced record's `x.mana2` surviving on purpose.
  out.x = { mana2: { mirrorLeftRowStagger: false, splitAngle: 0, magicKeys: null, layers: null } };
  return out;
}

// `010-test12222` ("both thumbs; thumb fingers on rows 0-2", 07 §5.3) is
// the one real fixture whose round trip is NOT a clean identity: re-
// anchoring its thumb-fingered keys by `col < 4.5` puts more than five of
// them on one mana2 thumb side -- HELD ("more than five keys on one
// thumb"), verified by hand. Every other fixture (including every
// hand-authored one, and every OTHER cmini-derived one -- several, like
// `crescent`/`sanrie-cmini-test2`, exercise the grid-gap-fill and
// trailing-skip-trim rules `adjustForMana2RoundTrip` itself implements)
// gets the full exact-identity assertion, not a guess or a skip.
function assertMana2RoundTrip(stem: string, a: AklPayload): void {
  expect(akl1.validate(a).ok).toBe(true);
  const m = mana2_1.from["akl/1"]!(a);
  expect(mana2_1.validate(m).ok).toBe(true);
  const back = mana2_1.to["akl/1"]!(m);

  if (stem === "010-test12222") {
    expect(isHeldResult(back)).toBe(true);
    if (isHeldResult(back)) expect(back.reason).toBe("more than five keys on one thumb");
    return;
  }
  expect(isHeldResult(back)).toBe(false);
  expect(back).toEqual(adjustForMana2RoundTrip(a));
}

describe("akl/1 -> mana2/1 -> akl/1 (every akl/1 fixture, thumb re-anchoring asserted exactly)", () => {
  const files = fs.readdirSync(AKL_FIXTURES_DIR).filter(isBaseFixtureFile).sort();

  it("the akl/1 fixture set is non-empty", () => {
    expect(files.length).toBeGreaterThan(0);
  });

  for (const file of files) {
    const stem = file.slice(0, -".json".length);
    const a = JSON.parse(fs.readFileSync(path.join(AKL_FIXTURES_DIR, file), "utf8")) as AklPayload;
    it(`[LDB-F5] '${stem}': identity off the thumb row`, () => assertMana2RoundTrip(stem, a));
  }

  it("test12222: rows 0-2 thumb fingers re-anchor toward cols 4/5 before hitting the >5-per-side held limit", () => {
    const a = JSON.parse(fs.readFileSync(path.join(AKL_FIXTURES_DIR, "010-test12222.json"), "utf8")) as AklPayload;
    const hadThumbOffMainRows = Object.values(a.keys).some((k) => isThumbFinger(k.finger) && k.row < 3);
    expect(hadThumbOffMainRows).toBe(true);
    const held = mana2_1.to["akl/1"]!(mana2_1.from["akl/1"]!(a));
    expect(isHeldResult(held)).toBe(true); // see MESSY_STEMS's comment -- this fixture has >5 keys on one re-anchored thumb side
  });

  it("adept: TB re-anchors by column, never TB again", () => {
    const a = JSON.parse(fs.readFileSync(path.join(AKL_FIXTURES_DIR, "009-adept.json"), "utf8")) as AklPayload;
    const hadTb = Object.values(a.keys).some((k) => k.finger === "TB") || (a.free ?? []).some((k) => k.finger === "TB");
    expect(hadTb).toBe(true);
    const back = mana2_1.to["akl/1"]!(mana2_1.from["akl/1"]!(a)) as AklPayload;
    const stillTb = Object.values(back.keys).some((k) => k.finger === "TB") || (back.free ?? []).some((k) => k.finger === "TB");
    expect(stillTb).toBe(false);
  });
});

describe("akl/1 -> mana2/1 -> akl/1 (every cmini-derived fixture, via the cmini/1 -> akl/1 golden)", () => {
  const files = fs.readdirSync(CMINI_FIXTURES_DIR).filter((f) => f.endsWith(".akl-1.json")).sort();

  for (const file of files) {
    const stem = file.slice(0, -".akl-1.json".length);
    const a = JSON.parse(fs.readFileSync(path.join(CMINI_FIXTURES_DIR, file), "utf8")) as AklPayload;

    it(`[LDB-F5] cmini-derived '${stem}': identity off the thumb row`, () => {
      if (akl1.validate(a).ok !== true) return; // a held/incomplete golden shape; nothing to assert here
      assertMana2RoundTrip(stem, a);
    });
  }
});

// -- §6.8: a mana2 record read ?as=cmini/1 carries keys[" "] when the file
// had a `space` token --

describe("§6.8: space -> \" \" survives to ?as=cmini/1", () => {
  it("001-hours (a real 'space' thumb token) carries keys[\" \"] via to[\"cmini/1\"]", () => {
    const m = JSON.parse(fs.readFileSync(path.join(MANA2_FIXTURES_DIR, "001-hours.json"), "utf8")) as Mana2Payload;
    const cmini = mana2_1.to["cmini/1"]!(m) as { keys: Record<string, unknown> };
    expect(cmini.keys).toHaveProperty(" ");
  });
});
