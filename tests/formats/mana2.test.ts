// [LDB-F5] [LDB-F13] mana2/1 <-> spark/1 (12-implementation-phase5.md §2.5,
// which replaces 01-format.md §6.3, renamed by 20-spark.md S1). mana2/1
// stays registered, so `goldens.test.ts`'s own generic loop (`validated-
// shapes.ts`) still covers F1 (validate) and F2 (`.lowered.json`) for
// every fixture here, and `mutations.test.ts`/`frozen.test.ts` still cover
// the fingers/fingermap/duplicate-char/duplicate-inputs/combos mutation
// matrix [LDB-F1], same as before. What that generic loop CAN'T reach
// anymore: this format's `.spark-1.json` golden -- mana2/1's registry
// `to`/`from` are `{}` now (nothing is ever stored as mana2/1, so the
// registry has nothing to dispatch through) -- this file's own "goldens
// (LDB-F7, kept out of goldens.test.ts)" block below is what keeps THAT
// tested, calling `toSpark`/`fromSpark` (this format's own named exports,
// were `toAkl`/`fromAkl`) directly. 21-formats.md D5 deleted `toCmini`
// entirely, so there is no `.cmini-1.json` golden for any format any
// more. Everything else here is what was always this file's own: the
// envelope over all 75 vendored layouts, the algorithm-row assertions
// §2.5 states by name, both round-trip directions, and the held-reasons
// enumeration.
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import * as spark1 from "../../formats/spark/1/index.ts";
import { computeRows } from "../../formats/spark/1/magic.ts";
import type { Payload as SparkPayload } from "../../formats/spark/1/index.ts";
import * as mana2_1 from "../../formats/mana2/1/index.ts";
import type { Payload as Mana2Payload } from "../../formats/mana2/1/index.ts";
import { parseRow, toSpark, fromSpark, DEFAULT_ROW_STAGGER } from "../../formats/mana2/1/translate.ts";

const VENDORED_DIR = path.resolve(import.meta.dirname, "..", "fixtures", "mana2-vendored");
const MANA2_FIXTURES_DIR = path.resolve(import.meta.dirname, "..", "..", "formats", "mana2", "1", "fixtures");
const SPARK_FIXTURES_DIR = path.resolve(import.meta.dirname, "..", "..", "formats", "spark", "1", "fixtures");
const CMINI_FIXTURES_DIR = path.resolve(import.meta.dirname, "..", "..", "formats", "adapters", "cmini", "fixtures");

// LDB-F39 (2026-09-13): `parity-vectors.json` is a LIST of 300 golden
// vectors (`scripts/gen-spark-parity-vectors.mjs`), not a single base
// Payload -- excluded here the same way `tests/formats/validated-shapes.ts`
// excludes it from its own (separately-duplicated, self-contained-test
// posture) copy of this function.
function isBaseFixtureFile(filename: string): boolean {
  if (!filename.endsWith(".json")) return false;
  if (filename === "parity-vectors.json") return false;
  return !filename.slice(0, -".json".length).includes(".");
}

function isHeldResult(v: unknown): v is { held: true; reason: string } {
  return typeof v === "object" && v !== null && (v as { held?: unknown }).held === true;
}

// -- goldens (LDB-F7, kept out of goldens.test.ts -- see the header
// comment): every mana2/1 base fixture's `.spark-1.json` (was
// `.akl-1.json`) and `.cmini-1.json` golden, called through this format's
// own named exports since its registry `to`/`from` are `{}`. F1
// (validate) and F2 (`.lowered.json`) are NOT duplicated here -- mana2/1
// is still registered, so `goldens.test.ts`'s own generic loop already
// covers both for every one of these same fixtures.
describe("mana2/1 goldens (LDB-F7)", () => {
  const files = fs.readdirSync(MANA2_FIXTURES_DIR).filter(isBaseFixtureFile).sort();

  for (const file of files) {
    const stem = file.slice(0, -".json".length);
    const payload = JSON.parse(fs.readFileSync(path.join(MANA2_FIXTURES_DIR, file), "utf8")) as Mana2Payload;
    const check = mana2_1.validate(payload);
    if (!check.ok) continue; // shouldn't happen among base fixtures; the envelope describe is the authority

    // A held golden (e.g. 900-held-combos.spark-1.json) is the `{held,
    // reason}` object itself, written verbatim (scripts/goldens.mjs's own
    // rule) -- compared as-is, same as a real payload; only a non-held
    // translation gets the extra "validates as spark/1" check.
    const sparkGolden = path.join(MANA2_FIXTURES_DIR, `${stem}.spark-1.json`);
    if (fs.existsSync(sparkGolden)) {
      it(`[LDB-F7] ${stem}: toSpark matches its frozen golden (.spark-1.json, was .akl-1.json)`, () => {
        const translated = toSpark(payload);
        expect(translated).toEqual(JSON.parse(fs.readFileSync(sparkGolden, "utf8")));
      });

      it(`[LDB-F7] ${stem}: toSpark's output validates there`, () => {
        const translated = toSpark(payload);
        if (isHeldResult(translated)) return; // a held golden carries no payload to validate (07 §5), same as goldens.test.ts's own rule
        expect(spark1.validate(translated).ok).toBe(true);
      });
    }
    // 21-formats.md D5 deleted `toCmini` (the cmini export) entirely --
    // there is no more `.cmini-1.json` golden for any format, mana2/1
    // included.
  }
});

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
      const translated = toSpark(payload);
      if (isHeldResult(translated)) {
        heldVendoredFiles.push(stem);
        return;
      }
      expect(spark1.validate(translated as SparkPayload).ok).toBe(true);
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
  function spark(name: string): SparkPayload {
    const t = toSpark(load(name));
    if (isHeldResult(t)) throw new Error(`${name} unexpectedly held: ${t.reason}`);
    return t as SparkPayload;
  }

  function keyOf(a: SparkPayload, ch: string) {
    return a.keys.find((k) => k.char === ch);
  }

  it("hours: e at {row:3,col:5,finger:RT}, space (mana2's own token) becomes a free position at {row:3,col:4,finger:LT} (LDB-F11, finding 11: spark refuses a space char)", () => {
    const a = spark("001-hours");
    expect(keyOf(a, "e")).toEqual({ char: "e", row: 3, col: 5, finger: "RT" });
    expect(a.keys).toContainEqual({ row: 3, col: 4, finger: "LT" });
    expect(keyOf(a, " ")).toBeUndefined();
  });

  it("chantries: l {row:3,col:3,finger:LT}, h {row:3,col:4,finger:LT}", () => {
    const a = spark("006-chantries");
    expect(keyOf(a, "l")).toEqual({ char: "l", row: 3, col: 3, finger: "LT" });
    expect(keyOf(a, "h")).toEqual({ char: "h", row: 3, col: 4, finger: "LT" });
  });

  it("stand_iso: a free entry at {row:2,col:5,finger:LI}", () => {
    const a = spark("003-stand_iso");
    expect(a.keys).toContainEqual({ row: 2, col: 5, finger: "LI" });
  });

  it("cyclone: row 2 col 0 is 'k' with LR", () => {
    const a = spark("008-cyclone");
    expect(keyOf(a, "k")).toMatchObject({ row: 2, col: 0, finger: "LR" });
  });

  it("graphite: columns reach 11", () => {
    const a = spark("002-graphite");
    const maxCol = Math.max(...a.keys.map((k) => k.col));
    expect(maxCol).toBe(11);
  });

  it("[LDB-F40] whirl (column-staggered) and bunya (ortho): toSpark carries no board at all (design/layout-db/26-no-board.md)", () => {
    for (const name of ["004-whirl", "005-bunya", "001-hours"]) {
      const a = spark(name);
      expect("board" in a).toBe(false);
    }
  });

  it("904-dup-rules: keeps the last rule", () => {
    const t = spark("904-dup-rules");
    expect(t.magic?.rules).toEqual([{ inputs: "th", output: "te", type: "raw" }]);
  });

  // [LDB-F29] [LDB-F33] 905-duplicate-chars (spark/1 -- a hand-written
  // fixture, not mana2-derived): 'y' appears twice, on OPPOSITE hands
  // (row 0 col 5, RI; row 1 col 4, LI), with no magic referencing it -- a
  // plain duplicate letter, valid on its own (§4.8). `fromSpark` keeps only
  // the FIRST occurrence IN LIST ORDER (row 0's) as the analysed 'y'; the
  // second becomes a `skip` cell, its finger (LI, digit 3) still recorded.
  it("[LDB-F29] [LDB-F33] 905-duplicate-chars: fromSpark keeps the first-listed 'y', the second becomes skip", () => {
    const payload = JSON.parse(fs.readFileSync(path.join(SPARK_FIXTURES_DIR, "905-duplicate-chars.json"), "utf8")) as SparkPayload;
    expect(spark1.validate(payload).ok).toBe(true);
    const m = fromSpark(payload);
    expect(m.layout.fingers[0]).toBe("q w e r t y u i o p");
    expect(m.layout.fingers[1]).toBe("a s d f skip h j k l ;");
    expect(m.fingermap[1]!.trim().split(/\s+/)[4]).toBe("3"); // LI's digit -- the skip cell still reports the right finger
  });

  // [LDB-F40] [LDB-F42] design/layout-db/26-no-board.md: spark/1 says
  // nothing about the board, so `fromSpark`'s mana2 `board` is a FIXED
  // default -- the ANSI row stagger (`DEFAULT_ROW_STAGGER`, what the site's
  // own default comparison view draws), covering physical rows
  // minRow..max(2, maxRow) -- NEVER just `fingers.length`'s own range, so a
  // layout with fewer than 3 finger rows still gets rows 0-2's worth of
  // stagger, padding by repeating row 2's offset past that; never
  // `isRowStaggered: false`, never read from the payload. The row-minus-one
  // decision (2026-09-21) adds one more physical row BEFORE row 0: -1 (the
  // number row), offset -0.5, whenever a fixture has any non-thumb key on
  // it -- this is additive-only (`CHANGELOG-API.md` 1.15): a fixture with
  // no row -1 gets EXACTLY the same stagger array as before this decision.
  // `expectedStaggerRow` below is this file's own independent restatement
  // of `translate.ts`'s `staggerForRow`, not a call into it (a test
  // re-deriving the rule catches a regression in the rule itself, not just
  // its own call site).
  function expectedStaggerRow(physicalRow: number): number {
    if (physicalRow === -1) return -0.5;
    if (physicalRow <= 0) return DEFAULT_ROW_STAGGER[0];
    if (physicalRow === 1) return DEFAULT_ROW_STAGGER[1];
    return DEFAULT_ROW_STAGGER[2]; // row >= 2
  }
  it("[LDB-F40] [LDB-F42] fromSpark's board is the fixed ANSI row stagger for every spark/1 fixture", () => {
    const files = fs.readdirSync(SPARK_FIXTURES_DIR).filter(isBaseFixtureFile).sort();
    expect(files.length).toBeGreaterThan(0);
    for (const file of files) {
      const payload = JSON.parse(fs.readFileSync(path.join(SPARK_FIXTURES_DIR, file), "utf8")) as SparkPayload;
      const m = fromSpark(payload);
      const mainRows = payload.keys.filter((k) => k.finger !== "LT" && k.finger !== "RT").map((k) => k.row);
      const minRow = mainRows.length === 0 ? 0 : Math.min(0, ...mainRows);
      const maxRow = mainRows.length === 0 ? -1 : Math.max(...mainRows);
      const staggerLen = Math.max(2, maxRow) - minRow + 1;
      const expected = Array.from({ length: staggerLen }, (_, i) => expectedStaggerRow(minRow + i));
      expect(m.board, file).toEqual({ isRowStaggered: true, rowOrColumnStagger: expected, mirrorLeftRowStagger: false, splitAngle: 0 });
    }
  });

  const heldCases: Array<[string, string]> = [
    ["900-held-combos", "combos have no akl/1 idiom"],
    ["903-held-sixthumbs", "more than five keys on one thumb"],
    ["906-held-taphold", "tap-hold token has no akl/1 idiom"],
    ["907-held-directional", "directional token has no akl/1 idiom"],
  ];
  for (const [name, reason] of heldCases) {
    it(`${name}: held -- ${reason}`, () => {
      const t = toSpark(load(name));
      expect(isHeldResult(t)).toBe(true);
      if (isHeldResult(t)) expect(t.reason).toBe(reason);
    });
  }

  // 21-formats.md D10: spark/1's free-form `x` field (and this pair's own
  // `x.mana2` hatch, which used to carry these fields across the hop
  // exactly) is gone. 23-geometry.md then replaced `board` itself with a
  // plain word, and 26-no-board.md removed the field entirely -- there is
  // no `board` on the spark side AT ALL to carry a `splitAngle`/
  // `mirrorLeftRowStagger` property, a per-column stagger, or the old
  // "entries past the third must equal the third" hold (908, which used to
  // be held) on. None of these is held -- every one translates to a plain
  // board-less payload; the whole mana2 board is a documented loss.
  const boardLossCases: Array<[string, string]> = [
    ["901-splitangle-hatch", "splitAngle"],
    ["902-mirror-hatch", "mirrorLeftRowStagger"],
    ["905-colstag-zeros", "an all-zero column stagger"],
    ["908-stagger-mismatch", "a row stagger whose 4th entry disagrees with the 3rd"],
  ];
  for (const [name, what] of boardLossCases) {
    it(`[LDB-F40] ${name}: NOT held -- ${what} has nowhere to go (spark/1 has no board, 26-no-board.md)`, () => {
      const a = spark(name);
      expect(isHeldResult(a)).toBe(false);
      expect("board" in a).toBe(false);
    });
  }
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
// design/layout-db/24-spark-wire-review.md finding 11 (D, identity): a
// space (" ") is refused as a spark/1 `char`, so a mana2 `space` token
// becomes a free position (mana2's own "skip") on the mana2 -> spark hop --
// a NEW, permanent, documented loss (mana2/1/translate.ts's own `toSpark`
// comment) that affects nearly every vendored fixture (most keyboards have
// a spacebar). Canonicalised away here exactly like the OTHER documented
// losses this function already folds (mirrorLeftRowStagger, splitAngle,
// etc.) -- "space" and "skip" compare equal for this round trip's purposes.
function dropSpaceToken(token: string): string {
  return token === "space" ? "skip" : token;
}

function normalizeMana2(m: Mana2Payload): unknown {
  const fingers = m.layout.fingers.map((r) => tokensOf(r).map(dropSpaceToken).join(" "));
  const thumbs = m.layout.thumbs?.map((r) => tokensOf(r).map(dropSpaceToken).join(" "));
  const fingermap = m.fingermap.map((row, y) => {
    const n = cellCount(m.layout.fingers[y] ?? "");
    return tokensOf(row).slice(0, n).join(" ");
  });
  // design/layout-db/26-no-board.md: spark/1 carries no board, so mana2's
  // `board` object never survives the hop (the lowering back always emits
  // the fixed ANSI row stagger, `DEFAULT_ROW_STAGGER`) -- a documented
  // loss, left out of the identity comparison entirely; `fromSpark`'s own
  // fixed output is pinned by the "[LDB-F40] fromSpark's board" test below.
  const out: Record<string, unknown> = { layout: { fingers }, fingermap };
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
      // Two fixtures are DESIGNED (or, for `opaline`, discovered) to be
      // lossy off the board, not round-trip clean -- `904-dup-rules`
      // (last-wins dedup at the FIRST hop discards the earlier duplicate
      // forever) and the vendored `opaline` (its own `magic.magicKeys: []`
      // -- an explicit empty array, distinct from absent/null -- comes back
      // `null`, D10's same loss: `normalizeMana2` treats `null` as absent
      // but `[]` as present, so this one real file's empty array can never
      // survive the hop now that there's nowhere to carry it). Every
      // BOARD-shaped loss that used to be listed here too (`905-colstag-
      // zeros`, the two hatch fixtures, the three genuinely column-staggered
      // files, `nastic`'s odd row stagger) is now the same one loss for
      // every fixture -- spark/1 has no board (26-no-board.md), so
      // `normalizeMana2` no longer compares it at all and those fixtures
      // round-trip like any other. Both are excluded here so this generic
      // loop's identity claim stays true for what it actually claims.
      if (["904-dup-rules", "opaline"].includes(stem)) continue;
      const translated = toSpark(m);
      if (isHeldResult(translated)) continue; // held fixtures have no round trip to check here (algorithm-row assertions cover them)

      it(`[LDB-F5] ${stem}: identity under normalizeMana2()`, () => {
        const spark = translated as SparkPayload;
        expect(spark1.validate(spark).ok).toBe(true);
        const back = fromSpark(spark);
        expect(normalizeMana2(back)).toEqual(normalizeMana2(m));
      });
    }
  }
});

// -- half 4: akl/1 -> mana2/1 -> akl/1, every akl/1 AND cmini/1(-derived)
// fixture: identity OFF the thumb row (12 §5's own invariant wording),
// with the enumerated thumb re-anchoring asserted exactly, not skipped --

// design/layout-db/23-geometry.md's duplicate-characters follow-up
// (24-spark-wire-review.md finding 5): "the first entry for a char in LIST
// ORDER" wins for a repeated char -- `keys` is never resorted by (row,
// col) or anything else. The SAME rule `mana2/1/translate.ts`'s own
// `firstOccurrencePerChar` applies, reimplemented independently here (test
// stays self-contained) so magic lowering addresses the identical position
// a real hop would.
function firstOccurrencePerChar(keys: SparkPayload["keys"]): Set<SparkPayload["keys"][number]> {
  const seen = new Set<string>();
  const analysed = new Set<SparkPayload["keys"][number]>();
  for (const k of keys) {
    if (k.char === undefined || seen.has(k.char)) continue;
    seen.add(k.char);
    analysed.add(k);
  }
  return analysed;
}

function expectedMagic(p: SparkPayload): SparkPayload["magic"] {
  const analysed = firstOccurrencePerChar(p.keys);
  const charMap: Record<string, { row: number; col: number; finger: string }> = {};
  for (const k of analysed) if (k.char !== undefined) charMap[k.char] = { row: k.row, col: k.col, finger: k.finger };
  const rows = computeRows(p.magic, charMap);
  if (rows.length === 0) return undefined;
  return { rules: rows.map((r) => ({ inputs: r.inputs, output: r.output, type: "raw" })) };
}

interface ThumbEntry {
  col: number;
  row: number;
  char?: string;
}

function isThumbFinger(f: string): boolean {
  return f === "LT" || f === "RT";
}

// Non-thumb keys/board/lower(magic) are identity (modulo the duplicate-char
// collapse below); thumb keys go to their own side BY LABEL (§4.5 --
// `LDB-F29`, no more `col < 4.5` re-anchoring) and come back out at fixed
// columns 4/5 (§2.5's own thumb formula) -- NOT the same row/col they
// started at. Predicted here by literally re-deriving what `fromAkl`'s own
// grouping+sort step produces, then feeding it through `toAkl`'s own
// reverse formula -- the exact mechanism, not a guess.
function adjustForMana2RoundTrip(a: SparkPayload): SparkPayload {
  const analysed = firstOccurrencePerChar(a.keys);
  const mainEntries: Array<{ row: number; col: number; char?: string; finger: string }> = [];
  const left: ThumbEntry[] = [];
  const right: ThumbEntry[] = [];

  for (const k of a.keys) {
    // A later occurrence of a duplicate char loses its char here, exactly
    // like `fromSpark`'s own `firstOccurrencePerChar` -- it becomes a plain
    // gap cell (position + finger survive, character doesn't, LDB-F5).
    const char = k.char !== undefined && analysed.has(k) ? k.char : undefined;
    if (isThumbFinger(k.finger)) (k.finger === "LT" ? left : right).push({ col: k.col, row: k.row, char });
    else mainEntries.push({ row: k.row, col: k.col, char, finger: k.finger });
  }

  // [LDB-F42] row-minus-one decision, 2026-09-21: `fromSpark` orders rows
  // minRow..maxRow ascending (minRow is -1 when `a` has a number row, 0
  // otherwise) -- but `toSpark` (mana2 -> spark, unchanged by this
  // decision, see formats/mana2/1/translate.ts's own header note) has no
  // idea a mana2 array index ever meant anything but "row = that index" --
  // it always reconstructs row `i` for array index `i`, starting at 0. A
  // layout with a number row therefore does NOT round-trip its row values
  // through mana2 identically any more: rows shift down by one (row -1
  // becomes 0, row 0 becomes 1, ...), same shift a 4th finger row (old row
  // 3) already caused before this decision existed. `minRow`/`maxRow` below
  // pick out which SOURCE rows contribute entries and in what order; the
  // reconstructed `out` array's own `row` field is the loop index `i`
  // itself (below), never `minRow + i` -- that's the one-line difference
  // from a same-numbering round trip, and it's what actually happens.
  const minRow = mainEntries.length === 0 ? 0 : Math.min(0, ...mainEntries.map((e) => e.row));
  const maxRow = mainEntries.length === 0 ? -1 : Math.max(...mainEntries.map((e) => e.row));
  const numMainRows = Math.max(maxRow - minRow + 1, 1);
  const maxCol = mainEntries.length === 0 ? -1 : Math.max(...mainEntries.map((e) => e.col));
  const thumbRow = numMainRows;
  const sortSide = (side: ThumbEntry[]): ThumbEntry[] => [...side].sort((x, y) => (x.col !== y.col ? x.col - y.col : x.row - y.row));

  // Exactly `fromAkl`'s own main-row grid: every column 0..maxCol that has
  // neither a key nor a gap entry becomes a "skip" cell (finger digit 0 =
  // LP, since there is no finger to report); an EXISTING gap entry
  // (originally free, OR a demoted duplicate) is ALSO a "skip" cell (its
  // own finger is what gets reported). Trailing skip cells (from either
  // source, indistinguishable once lowered to a token string) are trimmed
  // -- so a column past the row's LAST REAL KEY simply vanishes, key or
  // gap alike, and a surviving gap cell reappears as a NEW char-less entry
  // (finger LP for a pure gap, the original finger for a genuine one). ONE
  // array, in the SAME row-major, then-left-thumbs, then-right-thumbs
  // order `toSpark` itself pushes in -- array order matters for `toEqual`.
  const out: SparkPayload["keys"] = [];
  for (let i = 0; i < numMainRows; i++) {
    const srcRow = minRow + i; // the SOURCE row this array index draws from
    const byCol = new Map<number, { char?: string; finger: string }>();
    for (const e of mainEntries) if (e.row === srcRow) byCol.set(e.col, { char: e.char, finger: e.finger });
    let width = 0;
    for (let c = 0; c <= maxCol; c++) {
      const e = byCol.get(c);
      if (e && e.char !== undefined) width = c + 1;
    }
    for (let c = 0; c < width; c++) {
      const e = byCol.get(c);
      // The OUTPUT row is the array index `i` itself, never `srcRow` --
      // see the comment above `minRow`: `toSpark` reconstructs row = array
      // index, unconditionally.
      if (e && e.char !== undefined) out.push({ char: e.char, row: i, col: c, finger: e.finger });
      else out.push({ row: i, col: c, finger: e ? e.finger : "LP" });
    }
  }

  sortSide(left).forEach((e, i) => {
    const col = 4 - (sortSide(left).length - 1 - i);
    if (e.char === undefined) out.push({ row: thumbRow, col, finger: "LT" });
    else out.push({ char: e.char, row: thumbRow, col, finger: "LT" });
  });
  sortSide(right).forEach((e, j) => {
    const col = 5 + j;
    if (e.char === undefined) out.push({ row: thumbRow, col, finger: "RT" });
    else out.push({ char: e.char, row: thumbRow, col, finger: "RT" });
  });

  const result: SparkPayload = { keys: out };
  const magic = expectedMagic(a);
  if (magic) result.magic = magic;
  // 21-formats.md D10: spark/1 has no `x` field any more, so a spark ->
  // mana2 -> spark round trip no longer carries anything extra -- `toSpark`
  // silently drops `mirrorLeftRowStagger`/`splitAngle`/`magicKeys`/
  // `layers` instead of capturing them (mana2/1/translate.ts's own
  // `Mana2Extra` comment documents this loss).
  return result;
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
function assertMana2RoundTrip(stem: string, a: SparkPayload): void {
  expect(spark1.validate(a).ok).toBe(true);
  const m = fromSpark(a);
  expect(mana2_1.validate(m).ok).toBe(true);
  const back = toSpark(m);
  expect(isHeldResult(back)).toBe(false);
  expect(back).toEqual(adjustForMana2RoundTrip(a));
}

describe("akl/1 -> mana2/1 -> akl/1 (every akl/1 fixture, thumb re-anchoring asserted exactly)", () => {
  const files = fs.readdirSync(SPARK_FIXTURES_DIR).filter(isBaseFixtureFile).sort();

  it("the akl/1 fixture set is non-empty", () => {
    expect(files.length).toBeGreaterThan(0);
  });

  for (const file of files) {
    const stem = file.slice(0, -".json".length);
    const a = JSON.parse(fs.readFileSync(path.join(SPARK_FIXTURES_DIR, file), "utf8")) as SparkPayload;
    it(`[LDB-F5] [LDB-F30] '${stem}': identity off the thumb row`, () => assertMana2RoundTrip(stem, a));
  }

  // `010-test12222` ("both thumbs; thumb fingers on rows 0-2", 07 §5.3) is
  // real cmini data where a thumb-labelled key physically sits on a FINGER
  // row (0-2) -- exactly what design/layout-db/23-geometry.md §4.4-3 now
  // refuses (LDB-F27): `fromCmini` still preserves the (row, col, finger)
  // multiset exactly (LDB-F23) rather than inventing a fix, so its spark
  // projection fails spark/1's own validate() and never becomes a real
  // `formats/spark/1/fixtures/010-test12222.json` base fixture (`scripts/
  // goldens.mjs` skips writing it). Read here straight from the cmini
  // adapter's own golden instead, which still exists (cmini's schema has no
  // such row rule) -- the >5-keys-on-one-thumb-side held case this fixture
  // was originally picked for survives regardless: §4.6's relabel (by
  // column) puts all 9 of its thumb-ish keys on ONE side (RT, every one at
  // col >= 5), no re-anchoring needed to trigger it any more.
  it("test12222: a real cmini layout with 9 same-side thumb-labelled keys is held (more than five keys on one thumb)", () => {
    const a = JSON.parse(fs.readFileSync(path.join(CMINI_FIXTURES_DIR, "010-test12222.spark-1.json"), "utf8")) as SparkPayload;
    expect(spark1.validate(a).ok).toBe(false); // the known LDB-F27 case, not a fixture regression
    const ltCount = a.keys.filter((k) => k.finger === "LT").length;
    const rtCount = a.keys.filter((k) => k.finger === "RT").length;
    expect(Math.max(ltCount, rtCount)).toBeGreaterThan(5);
    const held = toSpark(fromSpark(a));
    expect(isHeldResult(held)).toBe(true);
    if (isHeldResult(held)) expect(held.reason).toBe("more than five keys on one thumb");
  });

  // LDB-F28: `TB` never reaches storage -- `fromCmini` relabels it (and any
  // disagreeing LT/RT) at import, before the payload is ever written, so
  // the regenerated `009-adept.json` base fixture already has none; this
  // checks that against adept's own CMINI-side golden (still `TB`-bearing,
  // cmini's schema is unaffected by this slice).
  it("[LDB-F28] adept: TB never reaches the stored spark fixture", () => {
    const cminiSide = JSON.parse(fs.readFileSync(path.join(CMINI_FIXTURES_DIR, "009-adept.json"), "utf8")) as { keys: Record<string, { finger: string }> };
    const hadTb = Object.values(cminiSide.keys).some((k) => k.finger === "TB");
    expect(hadTb).toBe(true);
    const sparkSide = JSON.parse(fs.readFileSync(path.join(SPARK_FIXTURES_DIR, "009-adept.json"), "utf8")) as SparkPayload;
    const stillTb = sparkSide.keys.some((k) => k.finger === "TB");
    expect(stillTb).toBe(false);
  });
});

describe("akl/1 -> mana2/1 -> akl/1 (every cmini-derived fixture, via the cmini/1 -> akl/1 golden)", () => {
  const files = fs.readdirSync(CMINI_FIXTURES_DIR).filter((f) => f.endsWith(".spark-1.json")).sort();

  for (const file of files) {
    const stem = file.slice(0, -".spark-1.json".length);
    const a = JSON.parse(fs.readFileSync(path.join(CMINI_FIXTURES_DIR, file), "utf8")) as SparkPayload;

    it(`[LDB-F5] cmini-derived '${stem}': identity off the thumb row`, () => {
      if (spark1.validate(a).ok !== true) return; // a held/incomplete golden shape; nothing to assert here
      assertMana2RoundTrip(stem, a);
    });
  }
});

// 21-formats.md D5 deleted `toCmini` and the whole cmini export -- the
// former "§6.8: space -> \" \" survives to ?as=cmini/1" block, which
// composed `toCmini(toSpark(p))`, has nothing left to test.
