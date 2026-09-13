// cmini -> spark/1, in ONE place (01-format.md §6.1, moved here from
// spark/1/translate.ts by 20-spark.md S1: cmini is an import source now,
// not a registered format, so the conversion lives with the adapter, not
// with spark). `fromCmini` is §6.1 (the import: cmini -> spark). The
// reverse direction (§6.2's `toCmini`, what the bot/emulayout used to
// read) was deleted by 21-formats.md D5 -- the cmini export is gone
// entirely, the cmini IMPORT (this function) stays. Dependency runs
// adapter -> spark (this file imports spark's `computeRows`/`isScaffold`/
// `liftRules`), never the reverse -- spark/1/index.ts has no import of
// this directory at all.
import * as cmini1 from "./index.ts";
import { computeRows, isScaffold, liftRules, type MagicIntent, type Row, type RawRule } from "../../spark/1/magic.ts";
import type { Board, Key } from "../../spark/1/geometry.ts";
import type { Payload as SparkPayload, Position } from "../../spark/1/index.ts";

// design/layout-db/23-geometry.md §4.6's word table: cmini's `stagger`/
// `angle` both land on `ansi` (the angle mod is already baked into `keys`'
// cols/fingers, as cmini itself stores it -- the geometry word is the same
// ANSI shape either way, and the angle mod itself is a FINGERING now, not a
// board word); `ortho`/`mini` both land on `ortho`. design/layout-db/
// 24-spark-wire-review.md finding 10 (the coordinator's amendment): import
// is faithful to this table alone -- there is NO angle-family bump to
// `ansi` any more (validate() no longer enforces "angle/nokwts/meteorite
// needs board: ansi" at all; that rule moved to the bot's own `fingers!`/
// `board!` verbs).
const WORD_TABLE: Record<cmini1.Payload["board"], Board> = {
  stagger: "ansi",
  angle: "ansi",
  ortho: "ortho",
  mini: "ortho",
};

// §4.6: a `TB` finger, or an `LT`/`RT` thumb whose column disagrees with the
// rule below, is relabelled -- the last time this ever runs (spark/1 itself
// never stores `TB` or a disagreeing label again, LDB-F28). Non-thumb
// fingers (and an already-agreeing LT/RT) pass through untouched.
function relabelFinger(finger: string, col: number): "LT" | "RT" | null {
  if (finger !== "TB" && finger !== "LT" && finger !== "RT") return null;
  const correct = col < 5 ? "LT" : "RT";
  return finger === correct ? null : correct;
}

export interface RelabeledEntry {
  key?: string; // absent for a `free` position (no char to name)
  row: number;
  col: number;
  from: string;
  to: string;
}

export interface ImportChanges {
  relabeled: RelabeledEntry[];
}

// lift() infers "default: repeat_previous" (etc.) from seeing ANY row of
// that shape for a key -- it has no way to know the default DOESN'T apply
// to every other layout char too. Relowering that inferred default
// therefore invents rows the true data never had, two ways:
//   - "uncovered key" (01 §3 / the interop writeup §4.2): the true data
//     just omits a char (opal has `,` but no `,◇` row) -- no explicit
//     signal, only its absence.
//   - a genuine collision: the omitted slot is filled by something else
//     entirely (a leftover raw rule, e.g. whirl's one untyped row shares
//     `inputs` with `*`'s own repeat scaffold).
// Both are the same fix: `except` the offending char on the producing key,
// exactly what 01 §3 says the import does automatically ("applies that
// hint automatically so no existing rule set is refused"). Detected by
// diffing the candidate structure's OWN relowering against the true rows
// -- any scaffold-sourced row that doesn't exactly match (by inputs+
// output+type) a true row gets `except`ed. Mutates `magic.magic_keys`/
// `magic.chiral_keys` in place.
// Exported for lift.test.ts: LDB-F8's "lower(lift(rows)) ≡ rows" is true of
// the REAL import step, which is lift + this reconciliation together (01
// §3's own text: the migration applies the `except` hint automatically) --
// bare `liftRules` alone invents rows on any fixture with an uncovered key
// (opal, opal-e200, whirl all have one), so testing it in isolation would
// be testing something this system never actually does.
export function reconcileScaffoldsToTrueRows(magic: MagicIntent, trueRows: Row[], keys: Record<string, Position>): void {
  const trueByInputs = new Map(trueRows.map((r) => [r.inputs, r]));
  for (const r of computeRows(magic, keys)) {
    if (!isScaffold(r.from)) continue;
    const truth = trueByInputs.get(r.inputs);
    if (truth && truth.output === r.output && (truth.type ?? "raw") === r.type) continue; // matches -- nothing to fix
    const after = [...r.inputs].slice(0, -1).join(""); // the scaffold key itself is always exactly 1 code point
    const match = /^(magic_keys|chiral_keys)\[(\d+)\]$/.exec(r.from)!;
    const list = match[1] === "magic_keys" ? magic.magic_keys! : magic.chiral_keys!;
    const key = list[Number(match[2])]!;
    key.except = [...(key.except ?? []), after];
  }
}

// §4.6: relabel every `keys` entry, reporting each change (row/col/from/to,
// plus the char since `keys` entries have one). Order-preserving (object
// key order survives `Object.entries`/rebuild, same as the input).
function relabelKeys(keys: Record<string, Position>): { keys: Record<string, Position>; relabeled: RelabeledEntry[] } {
  const out: Record<string, Position> = {};
  const relabeled: RelabeledEntry[] = [];
  for (const [ch, pos] of Object.entries(keys)) {
    const to = relabelFinger(pos.finger, pos.col);
    if (to === null) {
      out[ch] = pos;
    } else {
      out[ch] = { ...pos, finger: to };
      relabeled.push({ key: ch, row: pos.row, col: pos.col, from: pos.finger, to });
    }
  }
  return { keys: out, relabeled };
}

// Same relabelling over `free` (no char to report -- LDB-F28's "one info
// event per relabelled key" still names the position, just not by char).
function relabelFree(free: Position[] | undefined): { free: Position[] | undefined; relabeled: RelabeledEntry[] } {
  if (free === undefined) return { free: undefined, relabeled: [] };
  const relabeled: RelabeledEntry[] = [];
  const out = free.map((pos) => {
    const to = relabelFinger(pos.finger, pos.col);
    if (to === null) return pos;
    relabeled.push({ row: pos.row, col: pos.col, from: pos.finger, to });
    return { ...pos, finger: to };
  });
  return { free: out, relabeled };
}

// design/layout-db/23-geometry.md's duplicate-characters follow-up:
// spark/1's `keys` is one array now (char optional, the old separate
// `free` array folded in) -- cmini payloads never have duplicate
// characters (cmini's own schema/loader refuse them), so the relabelled
// char-keyed record and free array built above map onto it one entry per
// char plus one per free position. design/layout-db/24-spark-wire-
// review.md round 2's resolution item 3: emitted sorted by (row, col) --
// deterministic, so the import diff's own `canonical()` byte-identity
// check never flags a reorder as a real change.
function toKeyArray(keys: Record<string, Position>, free: Position[] | undefined): Key[] {
  const out: Key[] = [];
  for (const [ch, pos] of Object.entries(keys)) out.push({ char: ch, row: pos.row, col: pos.col, finger: pos.finger });
  for (const pos of free ?? []) out.push({ row: pos.row, col: pos.col, finger: pos.finger });
  out.sort((a, b) => (a.row !== b.row ? a.row - b.row : a.col - b.col));
  return out;
}

// The one shared computation `fromCmini`/`describeImportChanges` both draw
// from, so the payload actually written and the report describing it can
// never drift apart (they're the same call). Magic lifting/reconciliation
// stays on the char-keyed `Record<string, Position>` shape (magic.ts's own
// vocabulary, untouched by the keys-array change) -- only the final
// assembled payload uses the array.
function convert(p: cmini1.Payload): { payload: SparkPayload; changes: ImportChanges } {
  const { keys, relabeled: relabeledKeys } = relabelKeys(p.keys);
  const { free, relabeled: relabeledFree } = relabelFree(p.free);

  const board: Board = WORD_TABLE[p.board];
  const out: SparkPayload = { keys: toKeyArray(keys, free), board };

  const rows = cmini1.rows(p); // typed rows, `type` defaulted to "raw" (the adapter's own rows())
  if (rows.length > 0) {
    const { lifted, leftovers } = liftRules(rows, keys);
    const magic: MagicIntent = {};
    if (lifted.magic_keys.length > 0) magic.magic_keys = lifted.magic_keys;
    if (lifted.chiral_keys.length > 0) magic.chiral_keys = lifted.chiral_keys;
    if (lifted.adaptive_swaps.length > 0) magic.adaptive_swaps = lifted.adaptive_swaps;
    if (magic.magic_keys || magic.chiral_keys) reconcileScaffoldsToTrueRows(magic, rows, keys);
    if (leftovers.length > 0) {
      // design/layout-db/24-spark-wire-review.md round 2's resolution item
      // 5 ("raw means raw"): a leftover's OWN cmini-side type (possibly
      // itself "magic"/"repeat"/etc, cmini's own vocabulary, if the row
      // looked idiom-shaped but couldn't be lifted) is never carried into
      // spark/1's raw escape hatch verbatim -- only the importer's OWN
      // `liftRules` output (magic_keys/chiral_keys) may carry those tags.
      // Every leftover is genuinely "raw" here (the field is simply
      // omitted, spark's own convention for "raw" -- LDB-F23's exactness
      // claim never covered `type`, only inputs/output survive verbatim).
      magic.rules = leftovers.map((r): RawRule => ({ inputs: r.inputs, output: r.output }));
    }
    if (Object.keys(magic).length > 0) out.magic = magic;
  }

  return { payload: out, changes: { relabeled: [...relabeledKeys, ...relabeledFree] } };
}

// fromCmini (01 §6.1, design/layout-db/23-geometry.md §4.6): the import.
// `tag`/`blame`/`combos`/`link` have no spark/1 idiom (spark's escape hatch
// is for magic rows, not these) and, since 21-formats.md D10 dropped
// spark/1's free-form `x` field, are dropped here rather than reserved
// anywhere -- MF-9 (db/tests/formats/mf9-fromcmini.test.ts) is the
// invariant that replaces the old `toCmini(fromCmini(x))` round trip: it
// states exactly these four fields as the ones fromCmini is allowed to
// drop (LDB-F23/LDB-F31 -- the relabel is the one EXTRA change this round
// adds on top of that exactness claim; 24-spark-wire-review.md finding 10
// dropped the board-bump this comment used to also name).
export function fromCmini(p: cmini1.Payload): SparkPayload {
  return convert(p).payload;
}

// LDB-F28: what `fromCmini` changed beyond the exact-multiset guarantee --
// every relabelled key/free position. The importer (`db/src/import/
// apply.ts`) turns a non-empty result into an `import_relabel` info event
// (db/src/core/events.ts's `InfoKind`).
export function describeImportChanges(p: cmini1.Payload): ImportChanges {
  return convert(p).changes;
}
