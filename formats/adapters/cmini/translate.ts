// cmini <-> spark/1, in ONE place (01-format.md §6.1/§6.2, moved here from
// spark/1/translate.ts by 20-spark.md S1: cmini is an import source now,
// not a registered format, so the conversion lives with the adapter, not
// with spark). `fromCmini` is §6.1 (the import: cmini -> spark); `toCmini`
// is §6.2 (what the bot/emulayout read: spark -> cmini). Dependency runs
// adapter -> spark (this file imports spark's `computeRows`/`isScaffold`/
// `liftRules`/`cminiBoardWord`), never the reverse -- spark/1/index.ts has
// no import of this directory at all.
import * as cmini1 from "./index.ts";
import { computeRows, isScaffold, liftRules, resolveRows, type MagicIntent, type Row, type RawRule } from "../../spark/1/magic.ts";
import { cminiBoardWord } from "../../spark/1/index.ts";
import type { Payload as SparkPayload, Position } from "../../spark/1/index.ts";

const ANSI_STAGGER = [0, 0.25, 0.75];

function boardFromCmini(word: cmini1.Payload["board"]): SparkPayload["board"] {
  switch (word) {
    case "stagger":
      return { kind: "rowstag", stagger: [...ANSI_STAGGER], cmini: "stagger" };
    case "angle":
      // The angle shift is already baked into `keys`' cols/fingers, as
      // cmini itself stores it (01 §6.1) -- the geometry word is the same
      // rowstag/ANSI shape as "stagger".
      return { kind: "rowstag", stagger: [...ANSI_STAGGER], cmini: "angle" };
    case "ortho":
      return { kind: "ortho", cmini: "ortho" };
    case "mini":
      return { kind: "ortho", cmini: "mini" };
  }
}

function definedEntries<T extends object>(obj: T): Partial<T> {
  const out: Partial<T> = {};
  for (const [k, v] of Object.entries(obj)) {
    if (v !== undefined) (out as Record<string, unknown>)[k] = v;
  }
  return out;
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

// fromCmini (01 §6.1): the import. Must be lossless -- every cmini payload
// round-trips through `toCmini(fromCmini(x))` back to the same
// `cminiDetail` projection (LDB-F5, roundtrip.test.ts).
export function fromCmini(p: cmini1.Payload): SparkPayload {
  const out: SparkPayload = {
    keys: p.keys,
    board: boardFromCmini(p.board),
  };
  if (p.free !== undefined) out.free = p.free;

  const rows = cmini1.rows(p); // typed rows, `type` defaulted to "raw" (the adapter's own rows())
  if (rows.length > 0) {
    const { lifted, leftovers } = liftRules(rows, p.keys);
    const magic: MagicIntent = {};
    if (lifted.magic_keys.length > 0) magic.magic_keys = lifted.magic_keys;
    if (lifted.chiral_keys.length > 0) magic.chiral_keys = lifted.chiral_keys;
    if (lifted.adaptive_swaps.length > 0) magic.adaptive_swaps = lifted.adaptive_swaps;
    if (magic.magic_keys || magic.chiral_keys) reconcileScaffoldsToTrueRows(magic, rows, p.keys);
    if (leftovers.length > 0) {
      magic.rules = leftovers.map((r): RawRule => ({ inputs: r.inputs, output: r.output, type: r.type ?? "raw" }));
    }
    if (Object.keys(magic).length > 0) out.magic = magic;
  }

  // tag/blame/combos/link have no spark/1 idiom (01 §2's "escape hatch" is
  // for magic rows, not these) -- reserved in `x.cmini` so nothing is lost
  // (01 §6.1). Never emit an empty `x`/`x.cmini` (round-trip identity with
  // a spark-native payload that never had one).
  const cminiExtra = definedEntries({ tag: p.tag, blame: p.blame, combos: p.combos, link: p.link });
  if (Object.keys(cminiExtra).length > 0) out.x = { cmini: cminiExtra };

  return out;
}

// toCmini (01 §6.2): what the bot and emulayout read.
export function toCmini(p: SparkPayload): cmini1.Payload {
  const out: cmini1.Payload = {
    board: cminiBoardWord(p.board),
    keys: p.keys,
  };
  if (p.free !== undefined) out.free = p.free;

  const rows = resolveRows(computeRows(p.magic, p.keys)); // LDB-F4: akl.gg's order, last wins
  if (rows.length > 0) {
    out.magic = rows.map(({ inputs, output, type }) => ({ inputs, output, type }));
  }

  // Only `x.cmini` survives (LDB-F10); every other `x` key is dropped.
  const cminiExtra = p.x?.["cmini"] as { tag?: string; blame?: string; combos?: cmini1.Combo[]; link?: string } | undefined;
  if (cminiExtra) {
    if (cminiExtra.tag !== undefined) out.tag = cminiExtra.tag;
    if (cminiExtra.blame !== undefined) out.blame = cminiExtra.blame;
    if (cminiExtra.combos !== undefined) out.combos = cminiExtra.combos;
    if (cminiExtra.link !== undefined) out.link = cminiExtra.link;
  }

  return out;
}
