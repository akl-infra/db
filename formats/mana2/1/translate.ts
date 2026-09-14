// mana2/1 <-> spark/1 (design/layout-db/12-implementation-phase5.md §2.5,
// which replaces 01-format.md §6.3). The one place this pair is
// implemented (matching spark/1/translate.ts's own cmini <-> spark/1
// pairing): mana2/1's `to["spark/1"]`/`from["spark/1"]` live here; spark/1's own
// reciprocal `to["mana2/1"]`/`from["mana2/1"]` (spark/1/index.ts) import
// these same two functions rather than re-implementing them.
//
// Ground truth is vendor/mana2/core/load_layout.go, read line-by-line (not
// docs/layouts.md, which says "Specification: todo"). The row/cell
// tokeniser below is a deliberately narrow port of that file's
// `tokeniseLayoutFileRow`/`parseList`/`createTapHoldFromNode`: exactly
// enough to (a) count one grouped tap-hold/directional cell as ONE column
// (matching the loader's own `root.children` indexing), (b) resolve the
// character(s) a cell contributes for the loader's OWN duplicate-key check
// (verified against d5.jsonc by hand: its two `(<space repeat> $shift)`
// cells each resolve to a bare space with no error -- the Go code never
// actually validates or uses the tap-hold's OUTER second slot at all, a
// real quirk in mana2 itself, reproduced faithfully below, not "fixed"),
// and (c) tell a genuine grammar error (refused) from a syntactically
// valid but untranslatable construct (held). It does not attempt to
// support arbitrary nesting depth -- the loader itself only allows one
// level (a tap-hold's first slot may be a directional; nothing nests
// inside a directial or on a hold), and no vendored file goes deeper.

import type { Payload as SparkPayload } from "../../spark/1/index.ts";
import type { MagicIntent } from "../../spark/1/magic.ts";
import { computeRows, resolveRows } from "../../spark/1/magic.ts";
import type { Key as SparkPosition } from "../../spark/1/geometry.ts";
import type { Payload as Mana2Payload, Board as Mana2Board, Rule as Mana2Rule } from "./index.ts";

// 12-implementation-phase5.md §2.5 / core/stats.go's `fingerSuffixNames`.
export const FINGER_BY_DIGIT = ["LP", "LR", "LM", "LI", "LT", "RT", "RI", "RM", "RR", "RP"] as const;
export const DIGIT_BY_FINGER: Record<string, number> = Object.fromEntries(FINGER_BY_DIGIT.map((f, i) => [f, i]));

export interface Held {
  held: true;
  reason: string;
}

function isHeld<T>(v: T | Held): v is Held {
  return typeof v === "object" && v !== null && (v as { held?: unknown }).held === true;
}

// ---------------------------------------------------------------------
// Row/thumb-string tokenising (the loader's tokeniseLayoutFileRow/parseList)
// ---------------------------------------------------------------------

export type RawCell = { type: "word"; text: string } | { type: "paren"; children: RawCell[] } | { type: "angle"; children: RawCell[] };

export interface ParseError {
  message: string;
}

// Splits one row/thumb string into top-level cells, respecting `(...)`/
// `<...>` grouping (recursing into a group's inner text so one level of
// nesting -- a directional as a tap-hold's first slot -- parses
// correctly). Leading/trailing/inter-token whitespace is insignificant
// (core/load_layout.go's own tokeniser only ever splits on ' ', and the
// loader's row-shape checks operate on ITS OWN token/cell count, never on
// whitespace).
export function splitCells(row: string): RawCell[] | ParseError {
  const cells: RawCell[] = [];
  let i = 0;
  while (i < row.length) {
    const c = row[i]!;
    if (/\s/.test(c)) {
      i++;
      continue;
    }
    if (c === "(" || c === "<") {
      const open = c;
      const close = open === "(" ? ")" : ">";
      let depth = 1;
      let j = i + 1;
      while (j < row.length && depth > 0) {
        if (row[j] === open) depth++;
        else if (row[j] === close) depth--;
        j++;
      }
      if (depth !== 0) return { message: `Unclosed opening token: ${open}` };
      const inner = row.slice(i + 1, j - 1);
      const children = splitCells(inner);
      if ("message" in children) return children;
      cells.push({ type: open === "(" ? "paren" : "angle", children });
      i = j;
      continue;
    }
    let j = i;
    while (j < row.length && !/\s/.test(row[j]!)) j++;
    cells.push({ type: "word", text: row.slice(i, j) });
    i = j;
  }
  return cells;
}

// `word == "space"` -> a literal space (parseList's own substitution,
// applied before any further resolution -- decision #8 in 12's ledger: a
// mana2 `space` token becomes a `" "` key in spark/1, lossless both ways).
// One code point -> itself. Anything else (including "skip", handled by
// the caller before this is reached) -> not a valid single character.
function singleCharOf(word: string): string | null {
  if (word === "space") return " ";
  const cps = [...word];
  return cps.length === 1 ? word : null;
}

// "Unrecognisable word[. Did you mean \"a b\"]" -- core/load_layout.go's
// own parseList text, verbatim (the 2-character hint only).
function unrecognisableWord(word: string): string {
  const cps = [...word];
  const hint = cps.length === 2 ? ` Did you mean "${cps[0]} ${cps[1]}"` : "";
  return `Unrecognisable word${hint}`;
}

export interface CellResolution {
  tap?: string; // resolved character (already "space" -> " "), when this cell is a plain key
  hold?: string; // the tap-hold's second character, ONLY for a plain (a b) with two single-char words
  isSkip?: boolean; // the bare "skip" word: occupies the column, contributes no character
  heldReason?: string; // set when the cell is syntactically valid mana2 but has no akl/1 idiom
}

// createTapHoldFromNode, ported. A bare top-level "repeat" or "$name" word
// is a grammar error here (mana2's own tokenString case: length != 1, not
// "space", not "" -> "A key may only output a single character") -- those
// two words are only ever meaningful as the UNRESOLVED second slot of a
// directional or tap-hold (see below), never resolved as a character on
// their own.
export function resolveCell(cell: RawCell): CellResolution | ParseError {
  if (cell.type === "word") {
    if (cell.text === "skip") return { isSkip: true };
    const c = singleCharOf(cell.text);
    if (c !== null) return { tap: c };
    return { message: unrecognisableWord(cell.text) };
  }

  if (cell.type === "angle") {
    // <a b> -- top-level directional. Both children must be plain words
    // (never another group); `a` must resolve to one character; `b` is
    // stored as a magic-key marker and its shape is NEVER validated (the
    // Go code reads `children[1].token.value` with no length check at
    // all) -- reproduced faithfully, not "fixed".
    if (cell.children.length !== 2) return { message: "Directionals must have exactly 2 items" };
    const [a, b] = cell.children;
    if (a!.type !== "word" || b!.type !== "word") {
      return { message: a!.type === "angle" || b!.type === "angle" ? "Cannot have a directional inside another" : "Cannot have a tap hold inside a directional, consider re-arranging" };
    }
    const av = singleCharOf(a!.text);
    if (av === null) return { message: "A key may only output a single character" };
    return { tap: av, heldReason: "directional token has no akl/1 idiom" };
  }

  // cell.type === "paren" -- (a b), a tap-hold.
  if (cell.children.length !== 2) return { message: "Tap holds must have exactly 2 items" };
  const [a, b] = cell.children;
  if (a!.type === "paren" || b!.type === "paren") return { message: "Cannot have a tap hold inside another" };
  if (b!.type === "angle") return { message: "Cannot have directionals on a hold" };

  if (a!.type !== "angle") {
    // Both slots plain words -- both must resolve to one character.
    if (a!.type !== "word") return { message: "A key may only output a single character" };
    const av = singleCharOf(a!.text);
    if (av === null) return { message: "A key may only output a single character" };
    if (b!.type !== "word") return { message: "A key may only output a single character" };
    const bv = singleCharOf(b!.text);
    if (bv === null) return { message: "A key may only output a single character" };
    return { tap: av, hold: bv, heldReason: "tap-hold token has no akl/1 idiom" };
  }

  // a is a directional nested in the tap-hold's first slot (the ONE
  // nesting depth the loader allows). Its own two children must be plain
  // words; the directional's OWN second child (the magic-key marker,
  // e.g. "repeat") is stored but never validated, same as the top-level
  // angle case. The tap-hold's OWN second slot (`b`) is READ NOWHERE in
  // this branch of the Go source -- not validated, not resolved, simply
  // discarded (verified against d5.jsonc: its outer `$shift` slot is
  // never touched). `hold` is therefore never set here.
  if (a!.children.length !== 2) return { message: "Directionals must have exactly 2 items" };
  const [aa, ab] = a!.children;
  if (aa!.type !== "word" || ab!.type !== "word") return { message: "Can only nest 1 directional in a tap hold, or vice versa" };
  const aav = singleCharOf(aa!.text);
  if (aav === null) return { message: "A key may only output a single character" };
  return { tap: aav, heldReason: "directional/tap-hold token has no akl/1 idiom" };
}

export interface RowCell {
  index: number; // column x
  resolution: CellResolution;
}

// One row/thumb string, fully parsed: every cell resolved in order,
// stopping at the first error (matching the Go loader's own short-circuit
// -- `for _, element := range root.children { ...; if err != nil { return
// err } }`).
export function parseRow(row: string): RowCell[] | ParseError {
  const cells = splitCells(row);
  if ("message" in cells) return cells;
  const out: RowCell[] = [];
  for (let i = 0; i < cells.length; i++) {
    const r = resolveCell(cells[i]!);
    if ("message" in r) return r;
    out.push({ index: i, resolution: r });
  }
  return out;
}

// ---------------------------------------------------------------------
// mana2/1 -> spark/1
// ---------------------------------------------------------------------

// Everything mana2 carries that spark/1 has no idiom for: the WHOLE
// `board` object (design/layout-db/26-no-board.md: spark/1 has no board
// field at all -- `isRowStaggered`/`rowOrColumnStagger` included, not just
// the `mirrorLeftRowStagger`/`splitAngle` rendering hints D10 already
// dropped) and `magic.magicKeys`/`layers` (mana2-only bookkeeping). 12 §2.5
// originally held all of these; the hatch that used to carry them
// (spark/1's free-form `x`) went with 21-formats.md D10, whose own cost
// list already accepts this kind of rendering/bookkeeping loss for cmini's
// `tag`/`blame`/`link`. `toSpark` silently drops them: a documented loss,
// not a hold (MF-9's sibling for this pair -- see `901-splitangle-hatch`/
// `902-mirror-hatch`/`908-stagger-mismatch` in mana2.test.ts).
export interface Mana2Extra {
  board?: Mana2Board;
  magicKeys?: string[] | null;
  layers?: unknown;
}

// Last duplicate wins (mana2's own load-time semantics -- the loader
// re-parses `magic.rules` into a map keyed by `inputs`, so a later entry
// silently overwrites an earlier one). Shared by `lower()` (index.ts) and
// `to["spark/1"]` below so the two can never disagree about which rule
// "wins".
export function dedupeRulesLastWins(rules: Mana2Rule[]): Mana2Rule[] {
  const byInputs = new Map<string, Mana2Rule>();
  for (const r of rules) byInputs.set(r.inputs, r); // last write per key wins
  const order: string[] = [];
  const seen = new Set<string>();
  for (const r of rules) {
    if (seen.has(r.inputs)) continue;
    seen.add(r.inputs);
    order.push(r.inputs);
  }
  return order.map((inputs) => byInputs.get(inputs)!);
}

interface ThumbCell {
  index: number;
  char?: string; // undefined = skip
}

function parseThumbSide(raw: string | undefined): { cells: ThumbCell[] } | Held {
  const parsed = parseRow(raw ?? "");
  if ("message" in parsed) {
    // A thumb string that fails to parse can only do so via a held
    // construct here (validate() already refused genuine grammar errors
    // before to["spark/1"] is ever called) -- surfaced as held for safety
    // rather than silently dropped.
    return { held: true, reason: parsed.message };
  }
  const cells: ThumbCell[] = [];
  for (const { index, resolution } of parsed) {
    if (resolution.heldReason) return { held: true, reason: resolution.heldReason };
    cells.push({ index, char: resolution.isSkip ? undefined : resolution.tap });
  }
  return { cells };
}

// to["spark/1"] (mana2 -> spark/1). Assumes `p` already validates. mana2's
// own loader refuses duplicate characters (`checkGrammarAndDuplicates`), so
// every entry this builds gets its own char -- never two entries sharing
// one (design/layout-db/23-geometry.md's duplicate-characters follow-up:
// `SparkPayload.keys` is one array now, char optional, the old separate
// `free` array folded in).
export function toSpark(p: Mana2Payload): SparkPayload | Held {
  const keys: SparkPosition[] = [];

  const fingers = p.layout.fingers;
  const fingermap = p.fingermap;
  for (let y = 0; y < fingers.length; y++) {
    const parsed = parseRow(fingers[y]!);
    if ("message" in parsed) return { held: true, reason: parsed.message }; // validate() should have refused this already; defensive
    for (const { index: x, resolution } of parsed) {
      if (resolution.heldReason) return { held: true, reason: resolution.heldReason };
      const digit = Number(fingermap[y]!.trim().split(/\s+/).filter(Boolean)[x]);
      const finger = FINGER_BY_DIGIT[digit]!;
      // design/layout-db/24-spark-wire-review.md finding 11 (D, identity):
      // spark/1 refuses a space (" ") as a `char` -- a mana2 `space` token
      // becomes a free position instead (the finger/position survive, the
      // fact that it types a space doesn't), a documented loss.
      if (resolution.isSkip || resolution.tap === " ") keys.push({ row: y, col: x, finger });
      else keys.push({ char: resolution.tap!, row: y, col: x, finger });
    }
  }

  const thumbRow = fingers.length;
  const thumbs = p.layout.thumbs ?? [];
  const left = parseThumbSide(thumbs[0]);
  if (isHeld(left)) return left;
  const right = parseThumbSide(thumbs[1]);
  if (isHeld(right)) return right;
  if (left.cells.length > 5) return { held: true, reason: "more than five keys on one thumb" };
  if (right.cells.length > 5) return { held: true, reason: "more than five keys on one thumb" };
  const n = left.cells.length;
  left.cells.forEach((cell, i) => {
    const col = 4 - (n - 1 - i);
    // Same space -> free-position rule as the main grid above.
    if (cell.char === undefined || cell.char === " ") keys.push({ row: thumbRow, col, finger: "LT" });
    else keys.push({ char: cell.char, row: thumbRow, col, finger: "LT" });
  });
  right.cells.forEach((cell, j) => {
    const col = 5 + j;
    if (cell.char === undefined || cell.char === " ") keys.push({ row: thumbRow, col, finger: "RT" });
    else keys.push({ char: cell.char, row: thumbRow, col, finger: "RT" });
  });

  if ((p.combos?.length ?? 0) > 0) return { held: true, reason: "combos have no akl/1 idiom" };

  const rules = dedupeRulesLastWins(p.magic?.rules ?? []);
  let magic: MagicIntent | undefined;
  if (rules.length > 0) {
    magic = { rules: rules.map((r) => ({ inputs: r.inputs, output: r.output, type: "raw" })) };
  }

  // `board` (all of it), `magic.magicKeys` and `layers` have no spark/1
  // idiom and are dropped here (a documented loss -- see the `Mana2Extra`
  // comment above).
  const out: SparkPayload = { keys };
  if (magic) out.magic = magic;
  return out;
}

// ---------------------------------------------------------------------
// spark/1 -> mana2/1
// ---------------------------------------------------------------------

interface MainEntry {
  row: number;
  col: number;
  char?: string; // undefined = a `free` position
  finger: string;
}

interface ThumbEntry {
  col: number;
  row: number; // sort key only, never stored
  char?: string;
}

// design/layout-db/26-no-board.md: spark/1 carries no board, so the
// mana2 `board` this lowering emits is a FIXED default, never read from the
// payload -- the ANSI row stagger (`[0, 0.25, 0.75]`, what the old
// `STAGGER_BY_KIND.ansi` said and what the site's own default comparison
// view, `rowstag`, draws), padded to `numMainRows` by repeating row 2's
// own offset for any row past it. A reader that wants another board edits
// the file it downloaded; the DB never guesses one from the keys.
export const DEFAULT_ROW_STAGGER: readonly [number, number, number] = [0, 0.25, 0.75];

function defaultBoard(numMainRows: number): { isRowStaggered: boolean; rowOrColumnStagger: number[] } {
  const padded: number[] = [...DEFAULT_ROW_STAGGER];
  while (padded.length < numMainRows) padded.push(padded[padded.length - 1]!);
  return { isRowStaggered: true, rowOrColumnStagger: padded };
}

// from["spark/1"] (spark/1 -> mana2/1). Mirrors the site's ConvertLayout
// (tools/mana2bridge/bridgecore/convert.go): a grid over the NON-thumb
// keys/free (rows 0..maxRow, cols 0..maxCol, absolute -- no compaction,
// matching cmini's own absolute-column convention), a `skip` for any
// column with neither a key nor a `free` entry (fingermap digit 0 for
// those, since there is no finger to report), trailing `skip`s of a row
// trimmed so mana2's own vendored files round-trip byte-for-byte; thumb
// keys (finger LT/RT, §4.2: the label IS the hand, on ANY row >= 3) go
// straight to their own side's string BY LABEL, never re-anchored by
// column any more (design/layout-db/23-geometry.md §4.5 -- `LDB-F29`),
// sorted by (col, row) within that side.
// design/layout-db/23-geometry.md's duplicate-characters follow-up
// (24-spark-wire-review.md finding 5, the coordinator's correction): mana2
// refuses duplicate letters (`checkGrammarAndDuplicates`), so a spark/1
// layout with the same char on more than one position needs a policy for
// which occurrence survives the hop. "The first entry for that char in
// LIST ORDER is the analysed key; later duplicates are emitted as `skip`
// cells" (the position exists, no character) -- `keys` is an ORDERED list,
// never resorted by (row, col) or anything else -- a documented LDB-F5
// loss, matching `spark/1/index.ts`'s own `charMap` convention for the same
// reason (one shared rule, two independent implementations -- format
// modules stay self-contained, 07 §5).
function firstOccurrencePerChar(keys: SparkPosition[]): Map<string, SparkPosition> {
  const out = new Map<string, SparkPosition>();
  for (const k of keys) {
    if (k.char === undefined) continue;
    if (!out.has(k.char)) out.set(k.char, k);
  }
  return out;
}

export function fromSpark(p: SparkPayload): Mana2Payload {
  const main: MainEntry[] = [];
  const left: ThumbEntry[] = [];
  const right: ThumbEntry[] = [];

  function place(row: number, col: number, char: string | undefined, finger: string): void {
    if (finger === "LT") {
      left.push({ col, row, char });
    } else if (finger === "RT") {
      right.push({ col, row, char });
    } else {
      main.push({ row, col, char, finger });
    }
  }

  const analysed = firstOccurrencePerChar(p.keys); // char -> the one entry (by reference) that keeps its char
  for (const k of p.keys) {
    const keepsChar = k.char !== undefined && analysed.get(k.char) === k;
    place(k.row, k.col, keepsChar ? k.char : undefined, k.finger);
  }

  // mana2's own schema requires >=1 fingers row (every vendored file has
  // 1-5) -- a genuinely empty spark/1 layout (0 keys, 52 live upstream
  // layouts, 07-implementation-phase1.md §0.1) still needs ONE row to
  // stay schema-valid; an empty string represents "no keys" faithfully.
  const numMainRows = Math.max(main.length === 0 ? 0 : Math.max(...main.map((e) => e.row)) + 1, 1);
  const maxCol = main.length === 0 ? -1 : Math.max(...main.map((e) => e.col));

  const fingers: string[] = [];
  const fingermap: string[] = [];
  for (let r = 0; r < numMainRows; r++) {
    const byCol = new Map<number, MainEntry>();
    for (const e of main) if (e.row === r) byCol.set(e.col, e);
    const tokens: string[] = [];
    const digits: string[] = [];
    for (let c = 0; c <= maxCol; c++) {
      const e = byCol.get(c);
      if (!e) {
        tokens.push("skip");
        digits.push("0");
      } else if (e.char === undefined) {
        tokens.push("skip");
        digits.push(String(DIGIT_BY_FINGER[e.finger] ?? 0));
      } else {
        tokens.push(e.char === " " ? "space" : e.char);
        digits.push(String(DIGIT_BY_FINGER[e.finger] ?? 0));
      }
    }
    while (tokens.length > 0 && tokens[tokens.length - 1] === "skip") {
      tokens.pop();
      digits.pop();
    }
    fingers.push(tokens.join(" "));
    fingermap.push(digits.join(" "));
  }

  const sortSide = (side: ThumbEntry[]): ThumbEntry[] => [...side].sort((a, b) => (a.col !== b.col ? a.col - b.col : a.row - b.row));
  const leftTokens = sortSide(left).map((e) => (e.char === undefined ? "skip" : e.char === " " ? "space" : e.char));
  const rightTokens = sortSide(right).map((e) => (e.char === undefined ? "skip" : e.char === " " ? "space" : e.char));

  // Nothing on `p` says what board this is (26-no-board.md) and no `x` to
  // recover `mirrorLeftRowStagger`/`splitAngle`/`magicKeys`/`layers` from
  // (21-formats.md D10) -- every derivation from a stored spark/1 record
  // answers each field's default, same as a genuinely mana2-native layout
  // that never set it.
  const derivedBoard = defaultBoard(numMainRows);
  const board: Mana2Board = {
    isRowStaggered: derivedBoard.isRowStaggered,
    rowOrColumnStagger: derivedBoard.rowOrColumnStagger,
    mirrorLeftRowStagger: false,
    splitAngle: 0,
  };

  // magic.ts's own vocabulary is still char-keyed (`Record<string,
  // Position>`) -- built from the SAME `analysed` first-occurrence map the
  // grid above uses, so magic addresses the identical position a duplicate
  // char's surviving occurrence sits at.
  const magicKeysMap: Record<string, { row: number; col: number; finger: string }> = {};
  for (const [ch, pos] of analysed) magicKeysMap[ch] = { row: pos.row, col: pos.col, finger: pos.finger };
  const rows = resolveRows(computeRows(p.magic, magicKeysMap)); // LDB-F4: akl.gg's order, last wins
  const rules: Mana2Rule[] = dedupeRulesLastWins(rows.map((r) => ({ inputs: r.inputs, output: r.output })));

  const out: Mana2Payload = {
    layout: { fingers },
    fingermap,
    board,
    magic: { rules, magicKeys: null },
    layers: null,
  };
  if (leftTokens.length > 0 || rightTokens.length > 0) out.layout.thumbs = [leftTokens.join(" "), rightTokens.join(" ")];
  return out;
}
