// mana2/1 <-> akl/1 (01-format.md §6.3), the one place this pair is
// implemented (matching akl/1/translate.ts's own cmini/1 <-> akl/1 pairing:
// mana2/1's `to["akl/1"]`/`from["akl/1"]` live here, imported by index.ts).
//
// Ground truth for every derivation below is vendor/mana2/core/load_layout.go
// (the Go loader that actually reads these files), not docs/layouts.md alone
// -- the docs' "Specification: todo" leaves the column/thumb/finger
// arithmetic unstated, and one vendored fixture (d5.jsonc) uses an
// undocumented tap-hold/directional mini-language the docs never cover
// either. Every claim below cites the exact function/line behaviour it is
// read from; see this format's README.md for the same derivations in
// prose, with the real-file evidence.
import { computeRows, type MagicIntent } from "../../akl/1/magic.ts";
import type { Payload as AklPayload, Position as AklPosition, Board as AklBoard } from "../../akl/1/index.ts";
import type { Payload as Mana2Payload, Board as Mana2Board } from "./index.ts";

// core/stats.go's `fingerSuffixNames` -- the ONE place mana2 names what
// digit 0-9 means: index i is akl's finger letter i (LP LR LM LI LT RT RI
// RM RR RP). Confirmed against every vendored qwerty-shaped fingermap (e.g.
// qwerty.jsonc row 0 "0 1 2 3 3 6 6 7 8 9" over "q w e r t y u i o p":
// q/w/e/r/t -> pinky/ring/middle/index/index, matching LP LR LM LI LI, then
// y/u/i/o/p -> RI RI RM RR RP).
const FINGER_BY_DIGIT = ["LP", "LR", "LM", "LI", "LT", "RT", "RI", "RM", "RR", "RP"] as const;
const DIGIT_BY_FINGER: Record<string, string> = Object.fromEntries(FINGER_BY_DIGIT.map((f, i) => [f, String(i)]));

// Whitespace-tokenise one `fingers`/`fingermap`/`thumbs` row. A single vs
// double space between tokens (docs/layouts.md's examples use a double
// space to visually mark the hand split; several real vendored files
// (hours.jsonc, cyclone.jsonc, ...) use a single space throughout) makes NO
// difference here -- core/load_layout.go's own tokeniser
// (`strings.Fields`, used by addFingerMap/addThumbsToLayout) collapses any
// run of whitespace, and so does this. A LEADING space (used in several
// vendored files' rows 1/2 to visually suggest the row's physical rightward
// shift, e.g. hours.jsonc's " t m s d g..." / "  z v p c b...") is stripped
// by the same trim -- it carries no column information; the actual physical
// shift is `board.rowOrColumnStagger`'s job, not the string's leading
// whitespace (verified: hours.jsonc's row 1 leading space does NOT appear
// as a missing/skip token in that row's fingermap, which has the same
// token count as the fingers row once both are trimmed and split).
function rowTokens(row: string | undefined): string[] {
  return (row ?? "").trim().split(/\s+/).filter((t) => t.length > 0);
}

// core/load_layout.go's addFingerMap: `for keyX, fingerString := range
// strings.Fields(...)` -- keyX is the plain 0-based index into the
// WHITESPACE-SPLIT token list, counted continuously across the whole row
// (no offset at the hand boundary; nothing in the Go source treats column 5
// specially for the main rows). addFingerMap then looks up
// `coordToKeyIdx[{Column: keyX, Row: fingerRow}]` built while parsing
// `layout.fingers` -- a fingermap token past the end of that row's REAL
// keys (several real fixtures declare MORE fingermap columns than fingers
// tokens for a given row: cyclone.jsonc row 2 has 7 fingers tokens but 10
// fingermap tokens; knightest.jsonc/standlight.jsonc row 1 has 10 fingers
// tokens but 11 fingermap tokens, the last one a duplicate "9"; vigil.jsonc
// row 2 has 8 fingers tokens but 9 fingermap tokens) simply finds nothing
// in `coordToKeyIdx` and is silently ignored. So: column = token's ordinal
// position (0-based) in ITS OWN row; a fingermap row may be longer than its
// fingers row (unused padding, not a gap) but never shorter (validate()
// refuses that).
//
// addThumbsToLayout is the ONE place with a real hand-offset: the right
// thumb string's tokens (hand index 1) get
// `coordinate.Column += len(strings.Fields(thumbs[0]))` -- i.e. offset by
// the LEFT thumb's OWN token count, not a fixed number. Thumbs get NO
// fingermap lookup at all -- `finger` is hardcoded 4 (hand 0, left) or 5
// (hand 1, right) directly in that function. `thumbYCoordinate :=
// layout.Board.GetRowsLength()` -- i.e. row = the number of `fingers` rows
// (always 3 in every vendored fixture, so thumbs sit at row 3 there, but
// this format computes it, never hardcodes 3).
//
// `skip` (parseList: `tok.value == "skip"` -> `tok.value = ""`, then
// createTapHoldFromNode/addFingersToLayout|addThumbsToLayout: an empty
// value is `continue`d -- NO key, NOT EVEN a placeholder, is registered).
// mana2 itself therefore has no notion of "this position exists but is
// empty" beyond the string saying `skip` at parse time; a `skip` position's
// FINGER only survives because addFingerMap/addThumbsToLayout still walks
// every fingermap/thumbmap token regardless -- akl/1's `free` list is where
// that finger is recorded on this side (01-format.md §6.3: "skip <-> free"),
// something mana2's own runtime representation has already thrown away by
// the time stats are computed.

// Everything mana2 carries that akl/1 has no idiom for, recovered exactly
// on a mana2-sourced record's own round trip (the SAME escape-hatch pattern
// 01-format.md §6.1 uses for `x.cmini`): the raw `isRowStaggered`/
// `rowOrColumnStagger` pair (akl/1's own `board.kind`/`stagger` is a
// best-effort DERIVED view for akl-native clients -- see boardToAkl's
// comment for why it alone cannot round-trip an "ortho-shaped" mana2 board
// exactly), `mirrorLeftRowStagger`/`splitAngle` (board tilt/mirroring, no
// akl/1 concept at all), `magic.magicKeys` (present -- usually `null`, once
// seen as `[]` in opaline.jsonc -- in every vendored fixture, but unused
// even by mana2 itself: core/load_layout.go's addMagicDirectionals is a
// stub, its real body commented out `TODO: Implement`) and top-level
// `layers` (mana2 docs: "Layers: todo"). A key is present here IFF it was
// present (at any value, including `false`/`0`/`null`) on the source mana2
// payload -- `"k" in extra`, never `extra.k !== undefined`, is how every
// reader of this type must check it, so an explicit `false`/`0`/`null` is
// not mistaken for "absent".
export interface Mana2Extra {
  isRowStaggered?: boolean;
  rowOrColumnStagger?: number[];
  mirrorLeftRowStagger?: boolean;
  splitAngle?: number;
  magicKeys?: string[] | null;
  layers?: unknown;
}

function definedEntries<T extends object>(obj: T): Partial<T> {
  const out: Partial<T> = {};
  for (const [k, v] of Object.entries(obj)) {
    if (v !== undefined) (out as Record<string, unknown>)[k] = v;
  }
  return out;
}

// akl/1's rowstag stagger is PER ROW, colstag's is PER COLUMN
// (01-format.md §2) -- exactly mana2's own isRowStaggered dichotomy
// (core/load_layout.go's addBoardShape: the row-staggered branch indexes
// `RowOrColumnStagger[coordinate.Row]`, the else branch indexes
// `RowOrColumnStagger[coordinate.Column]`). This is the AKL-FACING view --
// a best-effort read for a client that only speaks akl/1's own board
// vocabulary. It is NOT what a mana2-sourced record's OWN round trip relies
// on (that is Mana2Extra, always present for any real vendored fixture,
// which always sets `isRowStaggered`+`rowOrColumnStagger`) -- this function
// alone cannot distinguish "isRowStaggered: false, stagger absent/all-zero"
// from "isRowStaggered: true, stagger absent/all-zero" (both look like
// "ortho" here), which is exactly why Mana2Extra exists.
function boardToAkl(board: Mana2Board): AklBoard {
  if (board.isRowStaggered) {
    const stagger = board.rowOrColumnStagger;
    return stagger !== undefined ? { kind: "rowstag", stagger: [...stagger] } : { kind: "rowstag" };
  }
  const stagger = board.rowOrColumnStagger;
  if (stagger !== undefined && stagger.some((v) => v !== 0)) {
    return { kind: "colstag", stagger: [...stagger] };
  }
  return { kind: "ortho" };
}

// toAkl (mana2 -> akl/1). Assumes `p` already validates (format `to`/`from`
// functions in this codebase never re-validate their input -- see
// akl/1/translate.ts's fromCmini/toCmini).
export function toAkl(p: Mana2Payload): AklPayload {
  const keys: Record<string, AklPosition> = {};
  const free: AklPosition[] = [];

  const fingers = p.layout.fingers;
  const fingermap = p.fingermap;
  for (let r = 0; r < fingers.length; r++) {
    const toks = rowTokens(fingers[r]);
    const fmToks = rowTokens(fingermap[r]);
    for (let c = 0; c < toks.length; c++) {
      const tok = toks[c]!;
      const digit = fmToks[c]!;
      const finger = FINGER_BY_DIGIT[Number(digit)]!;
      if (tok === "skip") free.push({ row: r, col: c, finger });
      else keys[tok] = { row: r, col: c, finger };
    }
  }

  // addThumbsToLayout: hand 0 (left) = finger 4 (LT), hand 1 (right) =
  // finger 5 (RT); the right string's columns are offset by the left
  // string's own token count.
  const thumbs = p.layout.thumbs ?? [];
  const leftToks = rowTokens(thumbs[0]);
  const rightToks = rowTokens(thumbs[1]);
  const thumbRow = fingers.length;
  leftToks.forEach((tok, i) => {
    if (tok === "skip") free.push({ row: thumbRow, col: i, finger: "LT" });
    else keys[tok] = { row: thumbRow, col: i, finger: "LT" };
  });
  rightToks.forEach((tok, i) => {
    const col = leftToks.length + i;
    if (tok === "skip") free.push({ row: thumbRow, col, finger: "RT" });
    else keys[tok] = { row: thumbRow, col, finger: "RT" };
  });

  const board = boardToAkl(p.board);

  // Magic -> flat rules ONLY, never lifted into idioms: mana2's own rules
  // carry no `type` at all (LayoutFileMagicRule has just Input/Output), so
  // this format's `lower()` always tags them "raw" (01-format.md §2's
  // vocabulary), and akl/1/magic.ts's `liftRules` treats every untyped/
  // "raw"-typed row as an unconditional leftover -- calling it here would
  // be a no-op that just re-wraps every row as the same raw leftover, so it
  // is skipped entirely (01-format.md §6.3's "+ optional lift" describes
  // the INTERACTIVE, author-confirmed lift 01-format.md §3 requires for a
  // guessed/untyped lift, not something this pure translate function can
  // do on its own).
  const rules = p.magic?.rules ?? [];
  let magic: MagicIntent | undefined;
  if (rules.length > 0) {
    magic = { rules: rules.map((r) => ({ inputs: r.inputs, output: r.output, type: "raw" })) };
  }

  const extra: Mana2Extra = definedEntries({
    isRowStaggered: p.board.isRowStaggered,
    rowOrColumnStagger: p.board.rowOrColumnStagger,
    mirrorLeftRowStagger: p.board.mirrorLeftRowStagger,
    splitAngle: p.board.splitAngle,
    magicKeys: p.magic?.magicKeys,
    layers: p.layers,
  });

  const out: AklPayload = { keys, board };
  if (free.length > 0) out.free = free;
  if (magic) out.magic = magic;
  if (Object.keys(extra).length > 0) out.x = { mana2: extra };
  return out;
}

interface RowEntry {
  row: number;
  col: number;
  tok: string; // the char, or "skip" for a `free` position
  finger: string; // the akl finger letter this position carried
}

// akl/1 has no "either thumb" finger the way mana2 has no "TB" digit --
// `TB` (01-format.md §2's enum) becomes the LEFT thumb here: arbitrary but
// deterministic, and documented (README.md "Documented losses") -- an
// author who cares which physical thumb a `TB` key sits under has no
// akl/1-only way to say so in the first place (that is what `TB` means).
function thumbHandOf(finger: string): "L" | "R" | null {
  if (finger === "LT" || finger === "TB") return "L";
  if (finger === "RT") return "R";
  return null;
}

// fromAkl (akl/1 -> mana2). A row/thumb-hand's tokens are ordered by
// ascending `col` and packed CONTIGUOUSLY (mana2's own string rows carry no
// absolute column number, only token order -- see the addFingerMap/
// addThumbsToLayout comment above), the exact inverse of toAkl's own
// `col = token's ordinal position` for any payload this format itself
// produced (so an exact round trip: toAkl always assigns 0-based
// contiguous columns per row/hand already). For a genuinely akl-native
// payload whose columns are NOT contiguous, this compacts them (documented
// in README.md) -- none of this format's own fixtures (900/901
// hand-authored, 001-graphite cmini-derived) exercise that corner; every
// row in all three is already contiguous from 0.
export function fromAkl(p: AklPayload): Mana2Payload {
  const main: RowEntry[] = [];
  const left: RowEntry[] = [];
  const right: RowEntry[] = [];

  function place(row: number, col: number, tok: string, finger: string): void {
    const hand = thumbHandOf(finger);
    const entry = { row, col, tok, finger };
    if (hand === "L") left.push(entry);
    else if (hand === "R") right.push(entry);
    else main.push(entry);
  }

  for (const [ch, pos] of Object.entries(p.keys)) place(pos.row, pos.col, ch, pos.finger);
  for (const pos of p.free ?? []) place(pos.row, pos.col, "skip", pos.finger);

  const numMainRows = main.length === 0 ? 0 : Math.max(...main.map((e) => e.row)) + 1;
  const fingers: string[] = [];
  const fingermap: string[] = [];
  for (let r = 0; r < numMainRows; r++) {
    const row = main.filter((e) => e.row === r).sort((a, b) => a.col - b.col);
    fingers.push(row.map((e) => e.tok).join(" "));
    fingermap.push(row.map((e) => DIGIT_BY_FINGER[e.finger] ?? "0").join(" "));
  }

  const sortedLeft = [...left].sort((a, b) => a.col - b.col);
  const sortedRight = [...right].sort((a, b) => a.col - b.col);
  const thumbsOut = [sortedLeft.map((e) => e.tok).join(" "), sortedRight.map((e) => e.tok).join(" ")];

  const extra = (p.x?.["mana2"] ?? undefined) as Mana2Extra | undefined;

  const board: Mana2Board = {};
  if (extra && "isRowStaggered" in extra) board.isRowStaggered = extra.isRowStaggered;
  else board.isRowStaggered = p.board === undefined || p.board.kind !== "colstag";
  if (extra && "rowOrColumnStagger" in extra) board.rowOrColumnStagger = extra.rowOrColumnStagger;
  else if (p.board === undefined || p.board.kind === "ortho") board.rowOrColumnStagger = new Array(numMainRows).fill(0);
  else board.rowOrColumnStagger = p.board.stagger ? [...p.board.stagger] : new Array(numMainRows).fill(0);
  if (extra && "mirrorLeftRowStagger" in extra) board.mirrorLeftRowStagger = extra.mirrorLeftRowStagger;
  if (extra && "splitAngle" in extra) board.splitAngle = extra.splitAngle;

  const rows = computeRows(p.magic, p.keys);
  const rules = rows.map((r) => ({ inputs: r.inputs, output: r.output }));
  let magic: Mana2Payload["magic"];
  if (rules.length > 0 || extra !== undefined) {
    magic = { rules };
    if (extra && "magicKeys" in extra) magic.magicKeys = extra.magicKeys ?? null;
  }

  const out: Mana2Payload = {
    layout: { fingers, thumbs: thumbsOut },
    fingermap,
    board,
  };
  if (magic) out.magic = magic;
  if (extra && "layers" in extra) out.layers = extra.layers;
  return out;
}
