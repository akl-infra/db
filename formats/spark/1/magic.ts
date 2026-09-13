// Lowering, lifting and the ported magic-rules authoring-shape validation
// for akl/1's `magic` idiom (01-format.md §2-§3).
//
// `lowerLabeled`/`liftRules` are a TypeScript port of
// scripts/magic_interop.py's `lower()`/`lift()`
// (origin/magic-api-interop @ f49b870f16e5261b3d2f52f3ff262e4ba94cb2d7),
// which is itself the reference implementation for
// design/cmini-live-api/02-magic-rules-interop.md §3. Three deliberate
// differences from that Python (07-implementation-phase1.md §5.2):
//   1. `except` is honoured: a char listed in a magic/chiral key's `except`
//      never gets a scaffold row (the python has no such list).
//   2. `chiral`/`default:<c>` rows are emitted the same as the other three
//      tags (the python already does this; kept explicit here because the
//      OLDER bridgecore/rules.mjs compile this format also draws from has
//      no tags at all).
//   3. NO rank-based dedupe. The python resolves same-`inputs` collisions by
//      precedence (default < magic < chiral < adaptive) and only refuses a
//      same-rank tie. Here every same-`inputs` pair is a collision (01 §3,
//      "D4") EXCEPT that an explicit `magic_keys[].rules[]` entry for a
//      given `after` silently replaces that key's own scaffold row for the
//      same `after` -- not a collision, exactly as both the python and
//      rules.mjs already treat it.
//
// `validateMagicSemantics` ports scripts/../functions/_lib/rules.mjs's
// `validateRuleSet` (f6c836af561d2ff07d6c44d4f0072786a785073a) over the
// `magic_keys`/`chiral_keys`/`adaptive_swaps` arrays, message texts kept
// verbatim minus the `${layoutId}: ` prefix (there is no record name at
// this layer), plus 01-format.md §2.1's `except[]` entries being single code points (the
// keys a rule set names need not be on the layout, as on akl.gg: LDB-F22). Schema-level facts (types, required-ness) are left to
// schema.json; only checks JSON Schema can't express live here, matching
// rules.mjs's own approach (it validates a plain object with no schema
// pass at all).
import type { Position } from "./index.ts";

// One Unicode code point, not one UTF-16 code unit (rules.mjs's own
// isSingleChar comment: a plain .length would split an astral character).
export function isSingleChar(value: unknown): value is string {
  return typeof value === "string" && [...value].length === 1;
}

// design/layout-db/24-spark-wire-review.md's format review round 2
// (§Resolution item 1, superseding the round-1 `{repeat:true}|{char}`
// shape): tagged-shape guards for `MagicDefault`/`ChiralValue`, discriminated
// by a `kind` field, shared by validation and computation so neither can
// drift from what the other accepts.
export function isRepeatTag(v: unknown): v is { kind: "repeat" } {
  return typeof v === "object" && v !== null && !Array.isArray(v) && (v as { kind?: unknown }).kind === "repeat" && Object.keys(v as object).length === 1;
}

export function isCharTag(v: unknown): v is { kind: "char"; char: string } {
  return (
    typeof v === "object" &&
    v !== null &&
    !Array.isArray(v) &&
    (v as { kind?: unknown }).kind === "char" &&
    isSingleChar((v as { char?: unknown }).char) &&
    Object.keys(v as object).length === 2
  );
}

export interface MagicKeyRule {
  after: string;
  output: string;
}

// design/layout-db/24-spark-wire-review.md finding 6 (F6), round 2's
// resolution item 1: tagged sentinels, not bare strings -- `{kind:
// "repeat"}` (was the string "repeat_previous") or `{kind: "char", char:
// "e"}` (was a bare single-character string). Absent means "none" (was the
// string "none") -- there is no explicit "none" tag at all any more, the
// field is simply omitted.
export type MagicDefault = { kind: "repeat" } | { kind: "char"; char: string };

export interface MagicKey {
  key: string;
  default?: MagicDefault;
  rules?: MagicKeyRule[];
  except?: string[];
}

// design/layout-db/24-spark-wire-review.md finding 6, round 2's resolution
// item F: the SAME kind-tagged union as MagicDefault -- a literal
// same/opposite character is `{kind: "char", char: "e"}`, never a bare
// string; same/opposite have never had a "none" sentinel (absent/null
// already means that), so there is no third tag.
export type ChiralValue = MagicDefault;

export interface ChiralKey {
  key: string;
  same?: ChiralValue | null; // null reads as absent, as akl.gg's validator does (`!= null`)
  opposite?: ChiralValue | null;
  except?: string[];
}

export interface AdaptiveSwap {
  trigger: string;
  swap: [string, string];
}

export interface RawRule {
  inputs: string;
  output: string;
  type?: string;
  note?: string;
}

// design/layout-db/24-spark-wire-review.md round 2's resolution item 2:
// `notes`/`updated` are DROPPED from the payload entirely (no writer ever
// produced them -- neither the importer nor `liftRules` -- and a
// non-semantic field that still bumps `payload_json = canonical(payload)`
// on every touch contradicts that invariant). The schema refuses them now
// (additionalProperties: false already covers this once the properties are
// gone).
export interface MagicIntent {
  magic_keys?: MagicKey[];
  chiral_keys?: ChiralKey[];
  adaptive_swaps?: AdaptiveSwap[];
  rules?: RawRule[];
}

export interface Row {
  inputs: string;
  output: string;
  type?: string;
}

// A lowered row plus where it came from, e.g. "magic_keys[0]" (a scaffold
// row), "magic_keys[0].rules[1]" (an explicit rule), "chiral_keys[0]",
// "adaptive_swaps[0]" or "rules[2]" (the raw escape hatch) -- exactly the
// vocabulary 01 §3's `magic_collision` example body uses in `from`.
export interface LabeledRow extends Row {
  type: string;
  from: string;
}

export interface CollisionInfo {
  inputs: string;
  from: [string, string];
  message: string;
  path: string;
  hint?: { path: string; add: string };
}

// "magic_keys[0].rules[1]" -> "/magic/magic_keys/0/rules/1" -- a `from`
// label (bracket-path, matching 01 §3's own `hint.path` vocabulary) turned
// into a JSON Pointer for the error body's own `path` field, so a
// magic_collision reads the same way every other 400 in this format does.
function fromToPointer(from: string): string {
  return "/magic/" + from.replace(/\./g, "/").replace(/\[(\d+)\]/g, "/$1");
}

function handOf(keys: Record<string, Position>, ch: string): "L" | "R" | null {
  const f = keys[ch]?.finger ?? "";
  return f.startsWith("L") ? "L" : f.startsWith("R") ? "R" : null;
}

// The layout's own keys, sorted by CODE POINT (not the default UTF-16
// code-unit string sort, which can misorder at the BMP/astral boundary) --
// the port note's "iterates keys sorted by code point, keep that order".
function layoutChars(keys: Record<string, Position>, exclude: Set<string>): string[] {
  return Object.keys(keys)
    .filter((c) => !exclude.has(c))
    .sort((a, b) => a.codePointAt(0)! - b.codePointAt(0)!);
}

// What `member` emits right after `trigger` when it is the far half of an
// adaptive swap: its own char, unless it is itself a magic key (ported
// _emission).
function emission(m: MagicIntent, keys: Record<string, Position>, trigger: string, member: string): string {
  for (const mk of m.magic_keys ?? []) {
    if (mk.key !== member) continue;
    for (const r of mk.rules ?? []) {
      if (r.after === trigger) return [...r.output].length === 2 ? [...r.output][1]! : member;
    }
    const d = mk.default;
    if (d === undefined) return member;
    return isRepeatTag(d) ? trigger : d.char;
  }
  return member;
}

// Every row the idioms + raw rules produce, in 07 §5.2's output order:
// per magic key (scaffold rows sorted by layout char, then the LDB-F14
// word-start row for a literal default, then explicit rules in author
// order), per chiral key (scaffold rows sorted by layout char), per
// adaptive swap (two rows, author order), then `rules[]` in author order.
// Emits EVERY row unconditionally -- collisions are a separate pass
// (`findCollision`) so `lower()` stays a total, pure mapping.
export function computeRows(magic: MagicIntent | undefined, keys: Record<string, Position>): LabeledRow[] {
  const m = magic ?? {};
  const magicKeys = m.magic_keys ?? [];
  const chiralKeys = m.chiral_keys ?? [];
  const swaps = m.adaptive_swaps ?? [];
  const rawRules = m.rules ?? [];
  const rows: LabeledRow[] = [];

  // LDB-F15 (design/layout-db/01-format.md §3, db/INVARIANTS.md): the
  // site's magicScaffoldChars (web/src/core/magicScaffold.ts) excludes
  // EVERY magic key's own char AND every chiral key's own char from EVERY
  // key's board-char scaffold -- one GLOBAL set, not "just this key's own
  // char". A prior version of this comment claimed the narrower
  // (per-key-only) exclusion was needed because real upstream data
  // (auditor) has 'b' as its own magic key yet its stored `magic` array
  // still carries '*''s repeat row `b*->bb` -- that claim was wrong about
  // WHY the row exists: auditor's frozen row is genuine historical data
  // (tests/fixtures/upstream-100), but recompiling auditor's OWN idiom
  // through today's site compiler would NOT reproduce it (magicScaffoldChars
  // excludes 'b' from every scaffold, '*''s included) -- confirmed live via
  // scripts/verify_magic_migration.py against production (rosewood/
  // tanglewood/twister all over-emit exactly this shape of row today). The
  // row survives round-tripping anyway: `liftRules` below promotes a
  // repeat/default row whose `after` is itself a special char into an
  // EXPLICIT override on that key, since the (correctly narrowed) scaffold
  // can no longer emit it as a default.
  const specialChars = new Set<string>();
  for (const mk of magicKeys) if (mk.key) specialChars.add(mk.key);
  for (const ck of chiralKeys) if (ck.key) specialChars.add(ck.key);

  magicKeys.forEach((mk, i) => {
    const exceptSet = new Set(mk.except ?? []);
    const explicitAfters = new Set((mk.rules ?? []).map((r) => r.after));
    const dflt = mk.default; // undefined = "none" (24-spark-wire-review.md finding 6: tagged, not a string sentinel)
    for (const c of layoutChars(keys, specialChars)) {
      if (exceptSet.has(c) || explicitAfters.has(c)) continue; // an explicit rule for this `after` REPLACES the scaffold row -- not a collision (01 §3)
      if (dflt === undefined) continue;
      if (isRepeatTag(dflt)) {
        rows.push({ inputs: c + mk.key, output: c + c, type: "repeat", from: `magic_keys[${i}]` });
      } else {
        rows.push({ inputs: c + mk.key, output: c + dflt.char, type: `default:${dflt.char}`, from: `magic_keys[${i}]` });
      }
    }
    // LDB-F14 (design/layout-db/01-format.md §3, db/INVARIANTS.md): the
    // site's compile (web/src/core/rules.ts's magicRulesFlatCompile,
    // I-153) emits one extra scaffold row for a LITERAL default -- a bare
    // space (word-initial text has no preceding board character for the
    // loop above to enumerate). Mirrors the site's condition exactly:
    //   - repeat_previous gets none (the site's own comment: "repeating a
    //     space types text nobody analyzes", #210's board-only scaffold).
    //   - NOT gated by `except`: the site has no such list to consult for
    //     this row at all (its MagicKey type carries no `except` field),
    //     so unlike every board-char row above, exceptSet is deliberately
    //     NOT checked here -- an authored `except: [" "]` does not
    //     suppress it (findCollision below omits the misleading
    //     "add ' ' to except" hint for exactly this reason).
    //   - IS suppressed by an explicit magic_keys[].rules[] entry whose
    //     `after` is a bare space, same "explicit replaces scaffold"
    //     carve-out board chars already get (01 §3).
    //   - Guarded against literal duplication on the vanishing chance a
    //     layout's own `keys` assigns a real position to the ' ' character
    //     itself (no fixture does; the site's magicScaffoldChars excludes
    //     whitespace from its board enumeration for the same reason) --
    //     in that case the loop above already emitted (and except-gated)
    //     the ' '+key row, so this dedicated push would only duplicate it.
    if (dflt !== undefined && !isRepeatTag(dflt) && !explicitAfters.has(" ") && !(" " in keys)) {
      rows.push({ inputs: " " + mk.key, output: " " + dflt.char, type: `default:${dflt.char}`, from: `magic_keys[${i}]` });
    }
    (mk.rules ?? []).forEach((r, j) => {
      rows.push({ inputs: r.after + mk.key, output: r.output, type: "magic", from: `magic_keys[${i}].rules[${j}]` });
    });
  });

  // LDB-F15: the site's chiral loop (`for (const k of keys)`,
  // web/src/core/rules.ts) enumerates EVERY layout key with a resolvable
  // hand, the chiral key's OWN char included -- same hand as itself, so it
  // always takes `same` (never `opposite`), giving a self row `key+key`
  // (repeat_previous doubles it, same as any other char; a literal `same`
  // emits `key`+that char). Confirmed live: neon/neon_colstag/stingray/
  // tenders all serve this row (`yy->y#`, `уу->у@`) that `lower()` was
  // dropping. No `specialChars` exclusion here either -- the site's loop
  // has none; a magic key's own char is a perfectly good chiral scaffold
  // char (only a key's OWN except list, or lacking a hand, excludes it).
  chiralKeys.forEach((ck, i) => {
    const exceptSet = new Set(ck.except ?? []);
    const kh = handOf(keys, ck.key);
    for (const c of layoutChars(keys, new Set())) {
      if (exceptSet.has(c)) continue;
      const h = handOf(keys, c);
      if (h === null || kh === null) continue; // no hand on either side -> this construct produces nothing here (a documented zero-row case, 01 §4.1 in the interop writeup)
      const val = h === kh ? ck.same : ck.opposite;
      if (val == null) continue; // undefined or null: absent, as on akl.gg
      const output = c + (isRepeatTag(val) ? c : val.char);
      rows.push({ inputs: c + ck.key, output, type: "chiral", from: `chiral_keys[${i}]` });
    }
  });

  swaps.forEach((sw, i) => {
    const [a, b] = sw.swap;
    rows.push({ inputs: sw.trigger + a, output: sw.trigger + emission(m, keys, sw.trigger, b), type: "adaptive", from: `adaptive_swaps[${i}]` });
    rows.push({ inputs: sw.trigger + b, output: sw.trigger + emission(m, keys, sw.trigger, a), type: "adaptive", from: `adaptive_swaps[${i}]` });
  });

  rawRules.forEach((r, i) => {
    rows.push({ inputs: r.inputs, output: r.output, type: r.type ?? "raw", from: `rules[${i}]` });
  });

  return rows;
}

// LDB-F4, amended 2026-09-11 (saltorbit: "layoutdb validation rules for the
// spark format should match what we already have with aklgg"): idiom rows
// that share `inputs` are RESOLVED the way akl.gg's own compile
// (web/src/core/rules.ts `magicRulesFlatCompile`) resolves them -- its
// phase order is every magic key's scaffold rows (the LDB-F14 word-start
// row included), then chiral scaffolds, then explicit `rules[]`
// exceptions, then adaptive swaps, and the LAST row for an `inputs` wins
// (mana2's own loader semantics). The raw escape hatch comes after all of
// them and never takes part in a resolution: `findCollision` still refuses
// any collision a raw row is part of (akl.gg has no raw rows at all).
function phaseOf(from: string): number {
  if (/^magic_keys\[\d+\]$/.test(from)) return 0;
  if (/^chiral_keys\[\d+\]$/.test(from)) return 1;
  if (/^magic_keys\[\d+\]\.rules\[\d+\]$/.test(from)) return 2;
  if (/^adaptive_swaps\[\d+\]$/.test(from)) return 3;
  return 4; // rules[i], the raw escape hatch
}

function isRaw(from: string): boolean {
  return /^rules\[\d+\]$/.test(from);
}

// One row per `inputs`. The WINNER is the row akl.gg's compile keeps: the
// last in its phase order (a later phase beats an earlier one; within a
// phase, the later-emitted row). The row sits where computeRows first
// emitted that `inputs`, so a payload without overlaps lowers byte for byte
// as before the amendment (the frozen goldens, LDB-F2/F7, and every stored
// record); akl.gg parity is as SETS of (inputs, output), mana2's loader
// being order-insensitive once each `inputs` appears once.
export function resolveRows(rows: LabeledRow[]): LabeledRow[] {
  const winner = new Map<string, { row: LabeledRow; phase: number; idx: number }>();
  rows.forEach((row, idx) => {
    const phase = phaseOf(row.from);
    const cur = winner.get(row.inputs);
    if (!cur || phase > cur.phase || (phase === cur.phase && idx > cur.idx)) winner.set(row.inputs, { row, phase, idx });
  });
  const out: LabeledRow[] = [];
  const seen = new Set<string>();
  for (const r of rows) {
    if (seen.has(r.inputs)) continue;
    seen.add(r.inputs);
    out.push(winner.get(r.inputs)!.row);
  }
  return out;
}

export function lower(magic: MagicIntent | undefined, keys: Record<string, Position>): Row[] {
  return resolveRows(computeRows(magic, keys)).map(({ inputs, output, type }) => ({ inputs, output, type }));
}

// Exported for translate.ts's import-time reconciliation (a leftover row
// colliding with a scaffold gets an `except` entry instead of a refusal --
// 01 §3's "the magic migration applies that hint automatically").
export function isScaffold(from: string): boolean {
  return /^(magic_keys|chiral_keys)\[\d+\]$/.test(from);
}

// Two rows with the same `inputs` where one of them is a RAW `rules[]` row
// -- refused at write time (01 §3, "D4", as amended 2026-09-11: idiom-only
// overlaps are resolved by `resolveRows`, akl.gg's order). `hint` names the
// `except` entry that would remove the collision whenever the other side is
// a scaffold row.
export function findCollision(rows: LabeledRow[]): CollisionInfo | null {
  const byInputs = new Map<string, LabeledRow[]>();
  for (const r of rows) {
    const group = byInputs.get(r.inputs);
    if (group) group.push(r);
    else byInputs.set(r.inputs, [r]);
  }
  for (const [inputs, group] of byInputs) {
    if (group.length < 2) continue;
    const rawIdx = group.findIndex((r) => isRaw(r.from));
    if (rawIdx < 0) continue; // idiom rows only: resolved, never refused
    const first = group[0]!;
    const second = (rawIdx === 0 ? group[1] : group[rawIdx])!;
    const scaffoldFrom = isScaffold(first.from) ? first.from : isScaffold(second.from) ? second.from : undefined;
    const afterChar = [...inputs].slice(0, -1).join("");
    // LDB-F14: a bare space `after` is the word-start row's own signature
    // (computeRows above never checks `except` for it), so "add ' ' to
    // except" would not actually resolve this collision -- omit the hint
    // rather than ship one that doesn't work.
    const hint = scaffoldFrom && afterChar !== " " ? { path: `${scaffoldFrom}.except`, add: afterChar } : undefined;
    return {
      inputs,
      from: [first.from, second.from],
      message: `two rows fire on '${inputs}': ${first.from} and ${second.from}`,
      path: fromToPointer(second.from), // the later-emitted (so, second-authored) side of the pair
      hint,
    };
  }
  return null;
}

function splitInputs(inputs: string): [string, string] | null {
  const cps = [...inputs];
  return cps.length === 2 ? [cps[0]!, cps[1]!] : null;
}

export interface LiftedIntent {
  magic_keys: MagicKey[];
  chiral_keys: ChiralKey[];
  adaptive_swaps: AdaptiveSwap[];
}

// Ported from magic_interop.py's `lift()`. Never raises on content -- a row
// that isn't producible by any construct on THIS layout is a leftover, kept
// verbatim (01 §3's round-trip section; #221's "leftovers are never
// dropped").
// LDB-F15: the set of magic/chiral key chars a row LIST implies -- every
// distinct `key` (the 2nd code point) among rows shaped like a magic-key
// scaffold/override ('repeat', 'default:<c>', 'magic') or a chiral
// scaffold ('chiral'). This is the same set `computeRows` builds directly
// from `magic_keys[]`/`chiral_keys[]` when an idiom already exists; here
// it's reconstructed from the FLAT rows themselves, for the two places
// that need it before (or without) an idiom: `liftRules` (below -- the
// idiom doesn't exist yet, this pass IS what builds it) and any test
// comparing a frozen row set against its own round trip, which must
// tolerate the same type relabeling `liftRules` performs (a repeat/
// default row whose `after` is itself a special char comes back tagged
// "magic", not "repeat"/"default:<c>" -- same (inputs, output), promoted
// to an explicit override since the scaffold that used to emit it no
// longer does, LDB-F8).
export function specialCharsFromRows(rows: Row[]): Set<string> {
  const special = new Set<string>();
  for (const r of rows) {
    const t = r.type ?? "";
    if (t !== "repeat" && t !== "magic" && t !== "chiral" && !t.startsWith("default:")) continue;
    const split = splitInputs(r.inputs);
    if (!split) continue;
    special.add(split[1]);
  }
  return special;
}

export function liftRules(rows: Row[], keys: Record<string, Position>): { lifted: LiftedIntent; leftovers: Row[] } {
  const magicKeys = new Map<string, MagicKey>();
  const leftovers: Row[] = [];

  function mk(k: string): MagicKey {
    let m = magicKeys.get(k);
    if (!m) {
      // 24-spark-wire-review.md finding 6: `default` OMITTED means "none"
      // now -- never written as a string sentinel.
      m = { key: k, rules: [] };
      magicKeys.set(k, m);
    }
    return m;
  }

  // computeRows' scaffold now excludes every magic/chiral key's OWN char
  // from every OTHER key's scaffold (`specialChars` there, mirroring the
  // site's magicScaffoldChars) -- so a repeat/default row whose `after` is
  // itself a special char (auditor's real `b*->bb`, 'b' its own magic key)
  // can no longer be reproduced as that key's `default`; relowering a
  // `default: 'repeat_previous'`/`default: <c>` would skip `after`
  // entirely. It still round-trips: promoted below into an EXPLICIT
  // `magic_keys[].rules[]` override instead, which computeRows'
  // unconditional explicit-rules loop always emits regardless of
  // specialChars. ' ' is excluded on purpose: the LDB-F14 word-start row
  // also carries a `default:<c>` tag with `after === ' '`, but
  // computeRows' dedicated push for it is UNCONDITIONAL on specialChars
  // (only an explicit `after: ' '` rule suppresses it, same as any board
  // char) -- promoting it here would be based on a coincidence (some OTHER
  // key literally sitting on the space character, no fixture does) that
  // has nothing to do with why that row exists.
  const specialChars = specialCharsFromRows(rows);

  for (const r of rows) {
    const t = r.type ?? "";
    if (t !== "repeat" && t !== "magic" && !t.startsWith("default:")) continue;
    const split = splitInputs(r.inputs);
    if (!split) {
      leftovers.push(r);
      continue;
    }
    const [after, k] = split;
    if (t === "repeat") {
      if (r.output !== after + after) {
        leftovers.push(r);
        continue;
      }
      if (after !== " " && specialChars.has(after)) {
        mk(k).rules!.push({ after, output: r.output });
        continue;
      }
      const m = mk(k);
      if (m.default !== undefined && !isRepeatTag(m.default)) {
        leftovers.push(r);
        continue;
      }
      m.default = { kind: "repeat" };
    } else if (t.startsWith("default:")) {
      const d = t.slice("default:".length);
      if ([...d].length !== 1 || r.output !== after + d) {
        leftovers.push(r);
        continue;
      }
      if (after !== " " && specialChars.has(after)) {
        mk(k).rules!.push({ after, output: r.output });
        continue;
      }
      const m = mk(k);
      if (m.default !== undefined && !(isCharTag(m.default) && m.default.char === d)) {
        leftovers.push(r);
        continue;
      }
      m.default = { kind: "char", char: d };
    } else {
      mk(k).rules!.push({ after, output: r.output });
    }
  }

  const chiralGroups = new Map<string, Array<{ after: string; row: Row }>>();
  for (const r of rows) {
    if (r.type !== "chiral") continue;
    const split = splitInputs(r.inputs);
    if (!split || !r.output.startsWith(split[0])) {
      leftovers.push(r);
      continue;
    }
    const [after, k] = split;
    const group = chiralGroups.get(k);
    if (group) group.push({ after, row: r });
    else chiralGroups.set(k, [{ after, row: r }]);
  }
  const chiralKeys = new Map<string, ChiralKey>();
  for (const [k, items] of chiralGroups) {
    const kh = handOf(keys, k);
    const sides: { same: Set<string>; opposite: Set<string> } = { same: new Set(), opposite: new Set() };
    let bad = kh === null;
    for (const { after, row } of items) {
      const h = handOf(keys, after);
      if (h === null) {
        bad = true;
        break;
      }
      const tail = row.output.slice(after.length);
      const side = h === kh ? sides.same : sides.opposite;
      side.add(tail === after ? "repeat_previous" : tail);
    }
    if (bad || sides.same.size > 1 || sides.opposite.size > 1) {
      leftovers.push(...items.map((i) => i.row));
      continue;
    }
    // Internal bookkeeping above still uses the "repeat_previous" string as
    // its own sentinel (never leaves this function) -- converted to the
    // tagged `{kind: "repeat"}` / `{kind: "char", char}` shape only at the
    // point of writing the real `ChiralKey` (24-spark-wire-review.md finding
    // 6, round 2's resolution item F: same tagged union as MagicDefault).
    const toChiralValue = (v: string): ChiralValue => (v === "repeat_previous" ? { kind: "repeat" } : { kind: "char", char: v });
    const ck: ChiralKey = { key: k };
    if (sides.same.size === 1) ck.same = toChiralValue([...sides.same][0]!);
    if (sides.opposite.size === 1) ck.opposite = toChiralValue([...sides.opposite][0]!);
    chiralKeys.set(k, ck);
  }

  const adGroups = new Map<string, Map<string, Row>>();
  for (const r of rows) {
    if (r.type !== "adaptive") continue;
    const split = splitInputs(r.inputs);
    if (!split || !r.output.startsWith(split[0])) {
      leftovers.push(r);
      continue;
    }
    const [after, k] = split;
    const group = adGroups.get(after);
    if (group) group.set(k, r);
    else adGroups.set(after, new Map([[k, r]]));
  }
  // Verified against the already-lifted magic keys before being trusted:
  // real data (vylet-v4) tags a pair "adaptive" whose outputs need a
  // magic-key member's contextual emission ("nh"->"n'", "nr"->"ny") but
  // establishes no such magic key anywhere else -- `emission()` can only
  // recover that from an ALREADY-lifted `magic_keys` entry, so a pairing
  // whose relowered output wouldn't match the true rows isn't a
  // reproducible swap at all; both rows become leftovers instead of a
  // swap `lower()` could never relower correctly (LDB-F8).
  const candidateForEmission: MagicIntent = { magic_keys: [...magicKeys.values()] };
  const swaps: AdaptiveSwap[] = [];
  for (const [t, members] of adGroups) {
    const used = new Set<string>();
    for (const [a, ra] of members) {
      if (used.has(a)) continue;
      const b = ra.output.slice(t.length);
      const mate = members.has(b) && b !== a ? b : (() => {
        const others = [...members.keys()].filter((mm) => !used.has(mm) && mm !== a);
        return others.length === 1 ? others[0]! : null;
      })();
      if (mate === null) {
        leftovers.push(ra);
        used.add(a);
        continue;
      }
      const rb = members.get(mate)!;
      const aReproduces = t + emission(candidateForEmission, keys, t, mate) === ra.output;
      const bReproduces = t + emission(candidateForEmission, keys, t, a) === rb.output;
      if (!aReproduces || !bReproduces) {
        leftovers.push(ra, rb);
        used.add(a);
        used.add(mate);
        continue;
      }
      used.add(a);
      used.add(mate);
      swaps.push({ trigger: t, swap: [a, mate] });
    }
  }

  for (const r of rows) {
    const t = r.type ?? "";
    if (t !== "repeat" && t !== "magic" && t !== "adaptive" && t !== "chiral" && !t.startsWith("default:")) {
      leftovers.push(r);
    }
  }

  const lifted: LiftedIntent = {
    magic_keys: [...magicKeys.keys()].sort().map((k) => {
      const m = magicKeys.get(k)!;
      return { ...m, rules: [...(m.rules ?? [])].sort((a, b) => (a.after < b.after ? -1 : a.after > b.after ? 1 : 0)) };
    }),
    chiral_keys: [...chiralKeys.keys()].sort().map((k) => chiralKeys.get(k)!),
    adaptive_swaps: swaps.sort((a, b) => {
      if (a.trigger !== b.trigger) return a.trigger < b.trigger ? -1 : 1;
      const sa = [...a.swap].sort().join("");
      const sb = [...b.swap].sort().join("");
      return sa < sb ? -1 : sa > sb ? 1 : 0;
    }),
  };
  return { lifted, leftovers };
}

// -- validateRuleSet port (functions/_lib/rules.mjs, f6c836af561d2ff07d6c44d4f0072786a785073a) --

export interface SemanticError {
  message: string;
  path: string;
  // Optional override of the default "invalid_payload" error code
  // (index.ts's validate() uses this when present) -- design/layout-db/
  // 24-spark-wire-review.md round 2's `reserved_rule_type` is the one case
  // today.
  code?: string;
}

// Ported from validateRuleSet, restricted to what schema.json (draft
// 2020-12) cannot express: single-code-point-ness, per-key uniqueness,
// and cross-field agreement -- and nothing akl.gg's gate doesn't check
// (LDB-F22: a named key need not be on the layout). Returns the first
// violation instead of throwing (index.ts's validate() never throws).
export function validateMagicSemantics(
  magic: MagicIntent | undefined,
  keys: Record<string, Position>,
): SemanticError | null {
  if (magic === undefined) return null;

  const magicKeys = magic.magic_keys ?? [];
  const chiralKeys = magic.chiral_keys ?? [];
  const swaps = magic.adaptive_swaps ?? [];

  const magicKeyChars = new Set<string>();
  for (let i = 0; i < magicKeys.length; i++) {
    const mk = magicKeys[i]!;
    const base = `/magic/magic_keys/${i}`;
    if (!isSingleChar(mk.key)) return { message: "magic_keys[].key must be a single character", path: `${base}/key` };
    magicKeyChars.add(mk.key);

    const dflt = mk.default;
    if (dflt !== undefined && !isRepeatTag(dflt) && !isCharTag(dflt)) {
      return {
        message: `magic_keys[].default must be {"kind":"repeat"}, {"kind":"char","char":"<single character>"}, or omitted, got ${JSON.stringify(dflt)}`,
        path: `${base}/default`,
      };
    }

    const rules = mk.rules ?? [];
    const seenAfter = new Set<string>();
    for (let j = 0; j < rules.length; j++) {
      const rule = rules[j]!;
      const rbase = `${base}/rules/${j}`;
      const after = rule.after;
      if (!isSingleChar(after)) return { message: `rule.after must be a single character, got ${JSON.stringify(after)}`, path: `${rbase}/after` };
      if (seenAfter.has(after)) {
        return { message: `duplicate rule.after ${JSON.stringify(after)} for magic key ${JSON.stringify(mk.key)}`, path: `${rbase}/after` };
      }
      seenAfter.add(after);
      if (typeof rule.output !== "string" || [...rule.output].length < 2) {
        return {
          message: `rule.output must be at least two characters (the trigger plus what it emits), got ${JSON.stringify(rule.output)}`,
          path: `${rbase}/output`,
        };
      }
      if ([...rule.output][0] !== after) {
        return {
          message: `rule.output ${JSON.stringify(rule.output)} must start with rule.after ${JSON.stringify(after)} (the W-B' editor derives after from output's first code point)`,
          path: `${rbase}/output`,
        };
      }
    }

    const except = mk.except ?? [];
    for (let k = 0; k < except.length; k++) {
      if (!isSingleChar(except[k])) {
        return { message: `except[] entries must be a single character, got ${JSON.stringify(except[k])}`, path: `${base}/except/${k}` };
      }
    }
  }

  const seenChiralKeys = new Set<string>();
  for (let i = 0; i < chiralKeys.length; i++) {
    const ck = chiralKeys[i]!;
    const base = `/magic/chiral_keys/${i}`;
    const key = ck.key;
    if (!isSingleChar(key)) return { message: `chiral_keys[].key must be a single character, got ${JSON.stringify(key)}`, path: `${base}/key` };
    if (seenChiralKeys.has(key)) return { message: `duplicate chiral_keys.key ${JSON.stringify(key)}`, path: `${base}/key` };
    seenChiralKeys.add(key);
    if (magicKeyChars.has(key)) {
      return {
        message: `${JSON.stringify(key)} is both a magic key and a chiral key -- a key is magic or chiral, never both`,
        path: `${base}/key`,
      };
    }

    const same = ck.same;
    const opposite = ck.opposite;
    // `== null`: an explicit JSON null reads as absent (akl.gg's validator's
    // own `!= null`, which its Python mirror's .get() forces).
    if (same == null && opposite == null) {
      return { message: `chiral_keys[].${JSON.stringify(key)} must set at least one of 'same'/'opposite'`, path: base };
    }
    if (same != null && !isRepeatTag(same) && !isCharTag(same)) {
      return {
        message: `chiral_keys[].same must be {"kind":"repeat"}, {"kind":"char","char":"<single character>"}, null, or omitted, got ${JSON.stringify(same)}`,
        path: `${base}/same`,
      };
    }
    if (opposite != null && !isRepeatTag(opposite) && !isCharTag(opposite)) {
      return {
        message: `chiral_keys[].opposite must be {"kind":"repeat"}, {"kind":"char","char":"<single character>"}, null, or omitted, got ${JSON.stringify(opposite)}`,
        path: `${base}/opposite`,
      };
    }

    const except = ck.except ?? [];
    for (let k = 0; k < except.length; k++) {
      if (!isSingleChar(except[k])) {
        return { message: `except[] entries must be a single character, got ${JSON.stringify(except[k])}`, path: `${base}/except/${k}` };
      }
    }
  }

  // `notes`/`updated` were dropped entirely by design/layout-db/
  // 24-spark-wire-review.md round 2's resolution item 2 -- the schema's
  // `additionalProperties: false` now refuses them outright, so there is
  // nothing left to semantically validate here.

  const seenPairs = new Set<string>();
  for (let i = 0; i < swaps.length; i++) {
    const sw = swaps[i]!;
    const base = `/magic/adaptive_swaps/${i}`;
    if (!isSingleChar(sw.trigger)) {
      return { message: `adaptive_swaps[].trigger must be a single character, got ${JSON.stringify(sw.trigger)}`, path: `${base}/trigger` };
    }
    const pair = sw.swap;
    if (!(Array.isArray(pair) && pair.length === 2 && pair.every(isSingleChar))) {
      return { message: `adaptive_swaps[].swap must be a 2-element list of single characters, got ${JSON.stringify(pair)}`, path: `${base}/swap` };
    }
    if (pair[0] === pair[1]) return { message: "adaptive_swaps[].swap must name two different characters", path: `${base}/swap` };
    for (const c of pair) {
      const pairKey = `${sw.trigger} ${c}`;
      if (seenPairs.has(pairKey)) {
        return {
          message: `adaptive_swaps entries collide on ${JSON.stringify(sw.trigger)}+${JSON.stringify(c)} -- two swaps would compile to the same rule`,
          path: `${base}/swap`,
        };
      }
      seenPairs.add(pairKey);
    }
  }

  // design/layout-db/24-spark-wire-review.md round 2's resolution item 5:
  // "raw means raw" -- `magic.rules[]` (the escape hatch) is written by a
  // CLIENT, and only the importer's own `liftRules`/`computeRows` machinery
  // may ever produce a tagged row (`repeat`, `magic`, `chiral`, `adaptive`,
  // or a `default:<c>` shape). A client-supplied raw rule naming one of
  // these reserved words as its own `type` is refused -- it would otherwise
  // silently impersonate a scaffold/override row no idiom actually
  // produced. `400 reserved_rule_type`, naming the offending value.
  const rawRules = magic.rules ?? [];
  for (let i = 0; i < rawRules.length; i++) {
    const t = rawRules[i]!.type;
    if (t === undefined) continue;
    if (t === "repeat" || t === "magic" || t === "chiral" || t === "adaptive" || /^default:.+$/.test(t)) {
      return {
        message: `rules[].type ${JSON.stringify(t)} is reserved for idiom-produced rows -- a raw rule may not claim it`,
        path: `/magic/rules/${i}/type`,
        code: "reserved_rule_type",
      };
    }
  }

  return null;
}
