// [LDB-F5] [LDB-F6] [LDB-F7] mana2/1 <-> akl/1 (01-format.md §6.3).
// goldens.test.ts/mutations.test.ts already cover this format generically
// (registry-driven -- registering it in src/formats/registry.ts is what
// picked them up, no changes needed there): every fixture validates
// [LDB-F1] [LDB-F7], `.lowered.json`/`.akl-1.json` goldens are frozen
// [LDB-F2] [LDB-F7], the fingers/fingermap/duplicate-char/duplicate-inputs
// mutation matrix is enforced [LDB-F1] [LDB-F4], and frozen.test.ts
// [LDB-F6] covers this format's schema/fixtures the same way it covers
// every other one. This file is what's left: the two round-trip
// directions, the JSONC reader, and `d5.jsonc`'s documented exclusion.
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import * as akl1 from "../../formats/akl/1/index.ts";
import { computeRows } from "../../formats/akl/1/magic.ts";
import type { Payload as AklPayload, Board as AklBoard, Position as AklPosition } from "../../formats/akl/1/index.ts";
import * as mana2_1 from "../../formats/mana2/1/index.ts";
import type { Payload as Mana2Payload } from "../../formats/mana2/1/index.ts";
import { parseJsonc, stripJsonc } from "../../formats/mana2/1/jsonc.ts";

const MANA2_FIXTURES_DIR = path.resolve(import.meta.dirname, "..", "..", "formats", "mana2", "1", "fixtures");
const AKL_FIXTURES_DIR = path.resolve(import.meta.dirname, "..", "..", "formats", "akl", "1", "fixtures");

function isBaseFixtureFile(filename: string): boolean {
  if (!filename.endsWith(".json")) return false;
  return !filename.slice(0, -".json".length).includes(".");
}

// -- half 1: every vendored mana2 layout (mana2/1's own fixtures) validates --

describe("every vendored mana2 layout validates", () => {
  const files = fs.readdirSync(MANA2_FIXTURES_DIR).filter(isBaseFixtureFile).sort();

  it("74 vendored layouts are fixtured (75 minus d5.jsonc -- see below)", () => {
    expect(files.length).toBe(74);
  });

  for (const file of files) {
    const stem = file.slice(0, -".json".length);
    it(`[LDB-F1] ${stem} validates against mana2/1`, () => {
      const payload = JSON.parse(fs.readFileSync(path.join(MANA2_FIXTURES_DIR, file), "utf8"));
      expect(mana2_1.validate(payload).ok).toBe(true);
    });
  }
});

// -- d5.jsonc: the JSONC reader parses it, but validate() refuses it --
// (README.md "d5.jsonc is excluded from this format's fixtures"): its
// `layout.fingers`/`thumbs` use an undocumented tap-hold/directional
// mini-language (`(<space repeat> $shift)`, `u (i $numbers)`) that breaks
// this format's row-shape agreement (14 whitespace-split tokens on row 0
// against 10 fingermap tokens -- the OPPOSITE direction from the five real
// "extra padding" fixtures this format's row-shape rule was widened for)
// and its duplicate-char rule (the bracketed group, and the literal "y",
// each appear twice on row 0).
describe("d5.jsonc -- parses, but refused (out of scope)", () => {
  const raw = fs.readFileSync(path.join(MANA2_FIXTURES_DIR, "999-d5.jsonc"), "utf8");

  it("the JSONC reader parses it without throwing", () => {
    expect(() => parseJsonc(raw)).not.toThrow();
  });

  it("[LDB-F1] validate() refuses it, naming the row-shape mismatch", () => {
    const payload = parseJsonc(raw);
    const result = mana2_1.validate(payload);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.error).toBe("invalid_payload");
      expect(result.error.path).toBe("/fingermap/0"); // row 0's fingermap has 10 entries, fewer than fingers row 0's 14 tokens
    }
  });
});

// -- half 2: mana2/1 -> akl/1 -> mana2/1, every vendored fixture (LOSSLESS,
// modulo JSON object key order AND row-string whitespace -- x.mana2 is what
// makes the DATA exact rather than "modulo documented losses"; translate.ts's
// own header comment has the reasoning for why whitespace itself is not
// data at all: a single vs double space between tokens, and a row's leading
// whitespace, carry no column information (core/load_layout.go's own
// tokeniser -- strings.Fields -- collapses exactly the same way), so
// `fromAkl`'s canonical single-space-joined output is not lossy here, it is
// the SAME row re-rendered. `rowTokens(...).join(" ")` on both sides is
// this test's own re-tokenisation, not this format's -- `to`/`from` never
// normalise a row string in place (LDB-F2: `lower()`/translations are pure
// functions of the PARSED payload, not of its formatting).
function tokensOf(row: string | undefined): string[] {
  return (row ?? "").trim().split(/\s+/).filter((t) => t.length > 0);
}

function canonicalRow(row: string | undefined): string {
  return tokensOf(row).join(" ");
}

// `to["akl/1"]` only ever reads a fingermap row's FIRST `fingers-row-token-
// count` entries (README.md/translate.ts: "unused padding, not a gap") --
// any extra trailing digits (five real vendored fixtures have them:
// cyclone row 2, knightest/standlight row 1, nystyc row 2, vigil row 2) are
// never stored anywhere and so never come back. Trimmed here to the SAME
// length before comparing, on the fingermap side only.
function canonicalizeRows(m: Mana2Payload): Mana2Payload {
  const clone = structuredClone(m);
  clone.layout.fingers = clone.layout.fingers.map(canonicalRow);
  if (clone.layout.thumbs) clone.layout.thumbs = clone.layout.thumbs.map(canonicalRow);
  clone.fingermap = clone.fingermap.map((row, i) => {
    const width = tokensOf(m.layout.fingers[i]).length;
    return tokensOf(row).slice(0, width).join(" ");
  });
  return clone;
}

describe("mana2/1 -> akl/1 -> mana2/1 (every vendored fixture)", () => {
  const files = fs.readdirSync(MANA2_FIXTURES_DIR).filter(isBaseFixtureFile).sort();

  for (const file of files) {
    const stem = file.slice(0, -".json".length);
    const m = JSON.parse(fs.readFileSync(path.join(MANA2_FIXTURES_DIR, file), "utf8")) as Mana2Payload;

    it(`[LDB-F5] ${stem}: identity (x.mana2 round trip, modulo row whitespace)`, () => {
      expect(mana2_1.validate(m).ok).toBe(true);
      const akl = mana2_1.to["akl/1"]!(m) as AklPayload;
      expect(akl1.validate(akl).ok).toBe(true);
      const back = mana2_1.from["akl/1"]!(akl);
      expect(canonicalizeRows(back)).toEqual(canonicalizeRows(m));
    });
  }
});

// -- half 3: akl/1 -> mana2/1 -> akl/1, every akl/1 fixture (LOSSY by
// mana2's own nature -- documented exactly, not guessed: README.md
// "Documented losses") --

// `TB` (either thumb) has no mana2 idiom -- becomes the LEFT thumb
// (translate.ts's `thumbHandOf`).
function tbToLt(board: AklBoard | undefined): AklBoard | undefined {
  return board; // board itself never carries a finger; kept for symmetry with the walk below
}

interface Entry {
  ch: string | undefined; // undefined = a `free` position
  row: number;
  col: number;
  finger: string;
}

function thumbHand(finger: string): "L" | "R" | null {
  if (finger === "LT" || finger === "TB") return "L";
  if (finger === "RT") return "R";
  return null;
}

// `fromAkl`'s exact algorithm (translate.ts's own comment: "ordered by
// ascending col and packed CONTIGUOUSLY... the exact inverse of toAkl's own
// col = token's ordinal position for anything THIS format produced"), so a
// payload this format itself round-trips is untouched -- but a genuinely
// akl-native payload whose columns are NOT already contiguous per row/hand
// (several cmini-derived fixtures: 011-40kwh, 012-apt26, 014-abyss, and
// others -- cmini's absolute-column convention leaves real gaps, e.g. a
// thumb key at col 6 with nothing at cols 0-5 on that hand) gets its
// columns COMPACTED, exactly as README.md documents. This function
// predicts that compaction precisely (row values are untouched -- only
// column numbering changes -- so it is applied BEFORE numMainRowsOf, which
// reads rows, not columns).
function compactColumns(p: AklPayload): AklPayload {
  const main: Entry[] = [];
  const left: Entry[] = [];
  const right: Entry[] = [];
  function place(ch: string | undefined, row: number, col: number, finger: string): void {
    const mapped = finger === "TB" ? "LT" : finger;
    const hand = thumbHand(finger);
    const e: Entry = { ch, row, col, finger: mapped };
    if (hand === "L") left.push(e);
    else if (hand === "R") right.push(e);
    else main.push(e);
  }
  for (const [ch, pos] of Object.entries(p.keys)) place(ch, pos.row, pos.col, pos.finger);
  for (const pos of p.free ?? []) place(undefined, pos.row, pos.col, pos.finger);

  const keys: Record<string, AklPosition> = {};
  const free: AklPosition[] = [];
  const numMainRows = main.length === 0 ? 0 : Math.max(...main.map((e) => e.row)) + 1;
  for (let r = 0; r < numMainRows; r++) {
    const row = main.filter((e) => e.row === r).sort((a, b) => a.col - b.col);
    row.forEach((e, i) => {
      if (e.ch === undefined) free.push({ row: r, col: i, finger: e.finger });
      else keys[e.ch] = { row: r, col: i, finger: e.finger };
    });
  }
  const thumbRow = numMainRows;
  const sortedLeft = [...left].sort((a, b) => a.col - b.col);
  const sortedRight = [...right].sort((a, b) => a.col - b.col);
  sortedLeft.forEach((e, i) => {
    if (e.ch === undefined) free.push({ row: thumbRow, col: i, finger: "LT" });
    else keys[e.ch] = { row: thumbRow, col: i, finger: "LT" };
  });
  sortedRight.forEach((e, i) => {
    const col = sortedLeft.length + i;
    if (e.ch === undefined) free.push({ row: thumbRow, col, finger: "RT" });
    else keys[e.ch] = { row: thumbRow, col, finger: "RT" };
  });

  const out: AklPayload = { keys, board: p.board };
  if (free.length > 0) out.free = free;
  if (p.magic) out.magic = p.magic;
  return out;
}

// akl board.kind: "ortho" (with no x.mana2 hint to recover the source's own
// isRowStaggered/rowOrColumnStagger) becomes mana2 isRowStaggered: true
// with an all-zero rowOrColumnStagger (matching docs/layouts.md's own
// "minimal layout" example) -- translated back to akl/1 that reads as
// board.kind: "rowstag" with an all-zero stagger, never "ortho" again: the
// mirror image of colstag's own documented loss against cmini/1.
// `board.cmini` is ALSO dropped -- mana2 has no field for it at all (unlike
// `x.cmini`'s own dedicated slot on the cmini/1 pair), so it never survives
// even one hop.
function expectedBoard(board: AklBoard | undefined, numMainRows: number): AklBoard {
  if (board === undefined || board.kind === "ortho") {
    return { kind: "rowstag", stagger: new Array(numMainRows).fill(0) };
  }
  const out: AklBoard = { kind: board.kind };
  if (board.stagger) out.stagger = board.stagger;
  return out;
}

// fromAkl ALWAYS sets `board.isRowStaggered`/`rowOrColumnStagger` on the
// mana2 payload it produces (falling back to the SAME kind-based derivation
// `boardToAkl` uses, when no x.mana2 hint exists to prefer instead) --
// never omitted. So `to["akl/1"]` on THAT payload always finds them
// present and (translate.ts's own contract: "a key is present here IFF it
// was present... on the source mana2 payload") faithfully carries them
// into a NEW `x.mana2`, even though the original akl/1 payload never had
// one. Harmless (it always agrees with the returned `board.kind`/
// `stagger`) but real: documented in README.md as the mirror-image of the
// "an x.mana2 hint appears" case a genuinely mana2-sourced record produces
// on purpose.
function expectedMana2Hint(board: AklBoard | undefined, numMainRows: number): { isRowStaggered: boolean; rowOrColumnStagger: number[] } {
  if (board === undefined || board.kind === "ortho") {
    return { isRowStaggered: true, rowOrColumnStagger: new Array(numMainRows).fill(0) };
  }
  if (board.kind === "colstag") {
    return { isRowStaggered: false, rowOrColumnStagger: board.stagger ? [...board.stagger] : [] };
  }
  return { isRowStaggered: true, rowOrColumnStagger: board.stagger ? [...board.stagger] : new Array(numMainRows).fill(0) };
}

// mana2 has no idiom concept: `computeRows` (the SAME lowering the record's
// own `lower()`/collision check already ran at write time) is exactly what
// `akl/1 -> mana2/1` produces as `magic.rules[]`, and that is ALL that
// survives the trip back -- no magic_keys/chiral_keys/adaptive_swaps
// structure, ever (translate.ts "Magic: no lift, ever").
function expectedMagic(p: AklPayload): AklPayload["magic"] {
  const rows = computeRows(p.magic, p.keys);
  if (rows.length === 0) return undefined;
  return { rules: rows.map((r) => ({ inputs: r.inputs, output: r.output, type: "raw" })) };
}

function numMainRowsOf(p: AklPayload): number {
  const thumbFingers = new Set(["LT", "RT", "TB"]);
  const rows = [
    ...Object.values(p.keys).filter((k) => !thumbFingers.has(k.finger)).map((k) => k.row),
    ...(p.free ?? []).filter((k) => !thumbFingers.has(k.finger)).map((k) => k.row),
  ];
  return rows.length === 0 ? 0 : Math.max(...rows) + 1;
}

// The ONLY `x` key that ever survives a mana2 round trip is `x.mana2`
// itself (parallel to LDB-F10's "only x.cmini survives to['cmini/1']") --
// none of this format's own akl/1 fixtures carry one going IN, but
// `fromAkl` always MANUFACTURES one on the way out (see
// `expectedMana2Hint`'s comment), so every akl/1 fixture's original `x` is
// replaced by that manufactured one, never simply dropped.
function adjustForMana2RoundTrip(a: AklPayload): AklPayload {
  const mapped = compactColumns(a);
  const numMainRows = numMainRowsOf(mapped);
  const board = expectedBoard(tbToLt(mapped.board), numMainRows);
  const out: AklPayload = { keys: mapped.keys, board };
  if (mapped.free) out.free = mapped.free;
  const magic = expectedMagic(mapped);
  if (magic) out.magic = magic;
  out.x = { mana2: expectedMana2Hint(mapped.board, numMainRows) };
  return out;
}

describe("akl/1 -> mana2/1 -> akl/1 (every akl/1 fixture, documented losses)", () => {
  const files = fs.readdirSync(AKL_FIXTURES_DIR).filter(isBaseFixtureFile).sort();

  it("the akl/1 fixture set is non-empty", () => {
    expect(files.length).toBeGreaterThan(0);
  });

  for (const file of files) {
    const stem = file.slice(0, -".json".length);
    const a = JSON.parse(fs.readFileSync(path.join(AKL_FIXTURES_DIR, file), "utf8")) as AklPayload;

    it(`[LDB-F5] '${stem}': identity minus the documented losses`, () => {
      expect(akl1.validate(a).ok).toBe(true);
      const m = mana2_1.from["akl/1"]!(a);
      expect(mana2_1.validate(m).ok).toBe(true);
      const back = mana2_1.to["akl/1"]!(m) as AklPayload;
      expect(back).toEqual(adjustForMana2RoundTrip(a));
    });
  }

  it("[LDB-F5] '009-adept': TB becomes LT, exactly, not skipped", () => {
    const a = JSON.parse(fs.readFileSync(path.join(AKL_FIXTURES_DIR, "009-adept.json"), "utf8")) as AklPayload;
    const hadTb = Object.values(a.keys).some((k) => k.finger === "TB") || (a.free ?? []).some((k) => k.finger === "TB");
    expect(hadTb).toBe(true);
    const back = mana2_1.to["akl/1"]!(mana2_1.from["akl/1"]!(a)) as AklPayload;
    const stillTb = Object.values(back.keys).some((k) => k.finger === "TB") || (back.free ?? []).some((k) => k.finger === "TB");
    expect(stillTb).toBe(false);
  });
});

// -- the JSONC reader: comments in strings, trailing commas, block comments --

describe("jsonc.ts's stripJsonc/parseJsonc", () => {
  const cases: Array<[string, string, unknown]> = [
    ["line comment", '{\n  "a": 1 // trailing\n}', { a: 1 }],
    ["block comment", '{ "a": /* mid */ 1 }', { a: 1 }],
    ["block comment spanning lines", '{\n  "a": 1,\n  /* skip\n     this */\n  "b": 2\n}', { a: 1, b: 2 }],
    ["trailing comma in object", '{ "a": 1, "b": 2, }', { a: 1, b: 2 }],
    ["trailing comma in array", '{ "a": [1, 2, 3,] }', { a: [1, 2, 3] }],
    ["// inside a string is not a comment", '{ "a": "http://example.com" }', { a: "http://example.com" }],
    ["/* inside a string is not a comment", '{ "a": "a /* b */ c" }', { a: "a /* b */ c" }],
    ["a comma right before a quote-adjacent close is not stripped mid-string", '{ "a": "x, " }', { a: "x, " }],
    ["an escaped quote inside a string does not end it", '{ "a": "she said \\"hi\\"" }', { a: 'she said "hi"' }],
    ["a backslash right before a real closing quote", '{ "a": "line\\\\" }', { a: "line\\" }],
    ["unicode escape (mana2's own <, > style)", '{ "a": "\\u003cspace\\u003e" }', { a: "<space>" }],
  ];

  for (const [label, input, expected] of cases) {
    it(`parses: ${label}`, () => {
      expect(parseJsonc(input)).toEqual(expected);
    });
  }

  it("a real vendored file (with both comment styles) parses", () => {
    const raw = fs.readFileSync(path.join(MANA2_FIXTURES_DIR, "001-baffled.jsonc"), "utf8");
    expect(() => parseJsonc(raw)).not.toThrow();
  });

  it("stripJsonc output is itself valid JSON (sanity: JSON.parse doesn't need a second pass)", () => {
    const raw = fs.readFileSync(path.join(MANA2_FIXTURES_DIR, "001-baffled.jsonc"), "utf8");
    expect(() => JSON.parse(stripJsonc(raw))).not.toThrow();
  });
});
