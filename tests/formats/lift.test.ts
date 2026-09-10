// [LDB-F8] `liftRules(lower(m)) == (m, [])` for every valid akl `magic`
// idiom set; `lower(lift(rows)) ≡ rows` for every typed row set (checked
// against every cmini/1 fixture that carries magic -- opal, auditor,
// opal-dario, whirl, opal-e200, 07 §5.3's named witnesses for exactly this);
// leftovers are exactly the rows that fail their tag's invariant, are
// untyped, or have an `inputs` that isn't 2 code points.
import fs from "node:fs";
import path from "node:path";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import * as cmini1 from "../../formats/cmini/1/index.ts";
import { computeRows, findCollision, liftRules, type MagicIntent, type Row } from "../../formats/akl/1/magic.ts";
import { reconcileScaffoldsToTrueRows } from "../../formats/akl/1/translate.ts";
import type { Position } from "../../formats/akl/1/index.ts";

const CMINI_FIXTURES_DIR = path.resolve(import.meta.dirname, "..", "..", "formats", "cmini", "1", "fixtures");

// -- half 1: property -- valid akl idioms round-trip through lower/lift exactly --

const CHAR_POOL = [..."abcdefghijklmnopqrstuvwxyz,.';/-[]=`\\~"];
// Disjoint from CHAR_POOL/the layout's own chars ON PURPOSE: a chiral
// key's literal `same`/`opposite` value that happens to equal the layout
// char it's being emitted for is genuinely ambiguous with the
// `repeat_previous` sentinel (both look like "output ends in the same char
// as `after`") -- a real gap in the chiral tag's single-type design (it has
// no `default:<c>`-style split), not something this property should chase.
const VALUE_POOL = [..."0123456789"];
const LEFT_FINGERS = ["LP", "LR", "LM", "LI"];
const RIGHT_FINGERS = ["RP", "RR", "RM", "RI"];

// A random 20-35 key layout, every key on a KNOWN hand (no thumbs) -- so a
// chiral key generated below always sees both "same" and "opposite" keys
// and never hits the documented zero-row corner (01 §4 "zero-row
// constructs", which is real but not what THIS property is about).
function genLayout(g: fc.GeneratorValue): Record<string, Position> {
  const n = g(fc.integer, { min: 20, max: 35 });
  const chars = g(fc.shuffledSubarray, CHAR_POOL, { minLength: n, maxLength: n });
  const keys: Record<string, Position> = {};
  chars.forEach((c: string, i: number) => {
    const left = i % 2 === 0;
    const fingers = left ? LEFT_FINGERS : RIGHT_FINGERS;
    keys[c] = { row: i % 3, col: Math.floor(i / 2), finger: fingers[i % fingers.length]! };
  });
  return keys;
}

// A random, non-degenerate `magic` idiom set on `keys`: 0-3 magic keys (a
// default plus 0-3 explicit overrides plus 0-2 excepted chars), 0-2 chiral
// keys (both same/opposite set, 0-2 excepted chars), 0-2 adaptive swaps.
// Every construct's chars come from its OWN exclusive partition of the
// layout (never shared with another construct), which is what makes the
// set collision-free BY CONSTRUCTION -- verified once more with `fc.pre`
// as a safety net, not the primary mechanism.
function genMagicIntent(g: fc.GeneratorValue, keys: Record<string, Position>): MagicIntent {
  const allChars = Object.keys(keys);
  const nMagic = g(fc.integer, { min: 0, max: Math.min(3, Math.floor(allChars.length / 4)) });
  const nChiral = g(fc.integer, { min: 0, max: Math.min(2, Math.floor(allChars.length / 4)) });
  const nSwaps = g(fc.integer, { min: 0, max: Math.min(2, Math.floor(allChars.length / 6)) });

  const specialCount = nMagic + nChiral + nSwaps * 3;
  const special = g(fc.shuffledSubarray, allChars, { minLength: specialCount, maxLength: specialCount });
  let cursor = 0;
  const take = (n: number): string[] => special.slice(cursor, (cursor += n));
  const magicKeyChars = take(nMagic);
  const chiralKeyChars = take(nChiral);
  const swapChars = take(nSwaps * 3);

  const remaining = allChars.filter((c) => !special.includes(c));

  // NOTE: no `except` here. `except` only ever round-trips exactly through
  // bare `liftRules` when it's masking a real collision -- a "gratuitous"
  // except (nothing else claims the excluded slot) is indistinguishable
  // from "just not covered" once lowered, which is the documented, lossy
  // "uncovered key" case (01 §4.2 in the interop writeup), not a bug this
  // property should chase. This generator builds every construct
  // collision-free by construction, so no except is ever NEEDED -- exactly
  // testing `except` where it matters (avoiding a genuine collision) is
  // 901-idioms's job (roundtrip.test.ts) and collisions.test.ts's.
  const magic_keys = magicKeyChars.map((key) => {
    const defaultKind = g(fc.constantFrom, "repeat_previous", "none", "literal");
    let dflt = defaultKind === "literal" ? g(fc.constantFrom, ...CHAR_POOL) : defaultKind;
    // A "none" default with zero explicit rules is the OTHER documented
    // zero-row construct (01 §4.1): it produces no rows at all, so nothing
    // survives to lift back -- not this property's concern, so force at
    // least one visible row instead of generating a construct guaranteed
    // to fail for a reason unrelated to what's being tested.
    if (dflt === "none" && remaining.length === 0) dflt = "repeat_previous";
    const minRules = dflt === "none" ? 1 : 0;
    const nRules = g(fc.integer, { min: minRules, max: Math.max(minRules, Math.min(3, remaining.length)) });
    const afters = g(fc.shuffledSubarray, remaining, { minLength: nRules, maxLength: nRules });
    const rules = afters.map((after: string) => ({ after, output: after + g(fc.constantFrom, ...CHAR_POOL) }));
    return { key, default: dflt, rules };
  });

  const chiral_keys = chiralKeyChars.map((key) => {
    const same = g(fc.constantFrom, "repeat_previous", ...VALUE_POOL);
    const opposite = g(fc.constantFrom, "repeat_previous", ...VALUE_POOL);
    return { key, same, opposite };
  });

  const adaptive_swaps: { trigger: string; swap: [string, string] }[] = [];
  for (let i = 0; i < nSwaps; i++) {
    const [trigger, a, b] = swapChars.slice(i * 3, i * 3 + 3) as [string, string, string];
    adaptive_swaps.push({ trigger, swap: [a, b] });
  }

  const magic: MagicIntent = {};
  if (magic_keys.length > 0) magic.magic_keys = magic_keys;
  if (chiral_keys.length > 0) magic.chiral_keys = chiral_keys;
  if (adaptive_swaps.length > 0) magic.adaptive_swaps = adaptive_swaps;
  return magic;
}

// Order-insensitive: `magic_keys`/`chiral_keys`/`adaptive_swaps` are SETS
// keyed by `key`/`trigger` (liftRules already sorts by key internally, but
// the generator doesn't produce them pre-sorted -- functions/_lib/
// rules.mjs's own ruleSetSignature treats every array in this schema as a
// set for exactly this reason).
function canonicalIntent(m: MagicIntent): unknown {
  const sortByKey = <T extends { key?: string; trigger?: string }>(arr?: T[]): T[] | undefined =>
    arr
      ? [...arr]
          .map((x) => ("rules" in x && Array.isArray((x as { rules?: unknown[] }).rules) ? { ...x, rules: [...(x as { rules: { after: string }[] }).rules].sort((a, b) => (a.after < b.after ? -1 : 1)) } : x))
          .sort((a, b) => {
            const ka = a.key ?? a.trigger ?? "";
            const kb = b.key ?? b.trigger ?? "";
            return ka < kb ? -1 : ka > kb ? 1 : 0;
          })
      : undefined;
  return {
    magic_keys: sortByKey(m.magic_keys) ?? [],
    chiral_keys: sortByKey(m.chiral_keys) ?? [],
    adaptive_swaps: sortByKey(m.adaptive_swaps) ?? [],
  };
}

describe("liftRules(lower(m)) == (m, []) -- valid akl idioms", () => {
  it("[LDB-F8] [LDB-F14] property: 200 random 20-35 key layouts x idiom sets (a third of magic keys get a literal default, exercising the word-start row)", () => {
    fc.assert(
      fc.property(fc.gen(), (g) => {
        const keys = genLayout(g);
        const magic = genMagicIntent(g, keys);
        const rows = computeRows(magic, keys);
        fc.pre(findCollision(rows) === null); // safety net -- construction should already guarantee this

        const { lifted, leftovers } = liftRules(
          rows.map(({ inputs, output, type }) => ({ inputs, output, type })),
          keys,
        );
        expect(leftovers).toEqual([]);
        expect(canonicalIntent(lifted)).toEqual(canonicalIntent(magic));
      }),
      { numRuns: 200 },
    );
  });
});

// -- half 2: every cmini/1 fixture with magic -- lower(lift(rows)) ≡ rows --

interface TypedRow extends Row {
  type: string;
}

function typed(rows: Row[]): TypedRow[] {
  return rows.map((r) => ({ inputs: r.inputs, output: r.output, type: r.type ?? "raw" }));
}

function byTriple(a: TypedRow, b: TypedRow): number {
  const ka = `${a.inputs} ${a.output} ${a.type}`;
  const kb = `${b.inputs} ${b.output} ${b.type}`;
  return ka < kb ? -1 : ka > kb ? 1 : 0;
}

function handOf(keys: Record<string, Position>, ch: string): "L" | "R" | null {
  const f = keys[ch]?.finger ?? "";
  return f.startsWith("L") ? "L" : f.startsWith("R") ? "R" : null;
}

// Independent (not calling liftRules) re-check of each tag's OWN invariant
// (01-format.md §3's table), used to confirm a leftover EARNED its spot --
// the group-shaped tags (chiral, adaptive) are checked against the row's
// siblings in the SAME rows list, exactly as the table states them.
function failsTagInvariant(row: TypedRow, allRows: TypedRow[], keys: Record<string, Position>): boolean {
  const cps = [...row.inputs];
  if (cps.length !== 2) return true; // "not 2 code points" -- always a leftover
  const [after, key] = cps as [string, string];

  switch (true) {
    case row.type === "repeat":
      return row.output !== after + after;
    case row.type.startsWith("default:"): {
      const c = row.type.slice("default:".length);
      return !([...c].length === 1 && row.output === after + c);
    }
    case row.type === "magic":
      return [...row.output][0] !== after;
    case row.type === "chiral": {
      if (!row.output.startsWith(after)) return true;
      const kh = handOf(keys, key);
      const h = handOf(keys, after);
      if (kh === null || h === null) return true;
      const tail = row.output.slice(after.length);
      const siblings = allRows.filter((r) => r.type === "chiral" && [...r.inputs][1] === key);
      const sameSideTails = new Set(
        siblings
          .filter((r) => handOf(keys, [...r.inputs][0]!) === h)
          .map((r) => {
            const a = [...r.inputs][0]!;
            const t = r.output.slice(a.length);
            return t === a ? "repeat_previous" : t;
          }),
      );
      return sameSideTails.size > 1; // disagreement within the hand
    }
    case row.type === "adaptive": {
      if (!row.output.startsWith(after)) return true;
      const mates = allRows.filter((r) => r.type === "adaptive" && [...r.inputs][0] === after && r !== row);
      return mates.length !== 1;
    }
    default:
      return true; // untyped/unknown tag -- always a leftover
  }
}

describe("lower(lift(rows)) ≡ rows -- every cmini/1 fixture with magic", () => {
  const files = fs.readdirSync(CMINI_FIXTURES_DIR).filter((f) => f.endsWith(".lowered.json"));
  const withMagic = files.filter((f) => {
    const rows = JSON.parse(fs.readFileSync(path.join(CMINI_FIXTURES_DIR, f), "utf8"));
    return Array.isArray(rows) && rows.length > 0;
  });

  it("at least one named fixture actually carries magic (opal/auditor/opal-dario/whirl/opal-e200)", () => {
    expect(withMagic.length).toBeGreaterThanOrEqual(5);
  });

  for (const loweredFile of withMagic) {
    const stem = loweredFile.slice(0, -".lowered.json".length);
    const rows: TypedRow[] = typed(JSON.parse(fs.readFileSync(path.join(CMINI_FIXTURES_DIR, loweredFile), "utf8")));
    const payload = JSON.parse(fs.readFileSync(path.join(CMINI_FIXTURES_DIR, `${stem}.json`), "utf8")) as cmini1.Payload;

    it(`[LDB-F8] ${stem}: lower(lift(rows)) reproduces rows; leftovers ⊆ rows and each earns its spot`, () => {
      const { lifted, leftovers } = liftRules(rows, payload.keys);
      expect(leftovers.length + Object.values(lifted).flat().length).toBeGreaterThanOrEqual(0); // sanity: liftRules ran

      // "lift" here is the real import step: lift + reconciliation (01 §3 --
      // the migration auto-`except`s an uncovered/colliding scaffold row).
      // Bare `liftRules` alone would invent rows on opal/opal-e200/whirl,
      // every one of which has an uncovered key; testing the two together
      // is testing what fromCmini() actually does.
      const magic: MagicIntent = {};
      if (lifted.magic_keys.length > 0) magic.magic_keys = lifted.magic_keys;
      if (lifted.chiral_keys.length > 0) magic.chiral_keys = lifted.chiral_keys;
      if (lifted.adaptive_swaps.length > 0) magic.adaptive_swaps = lifted.adaptive_swaps;
      reconcileScaffoldsToTrueRows(magic, rows, payload.keys);

      const relowered = typed(computeRows({ ...magic, rules: leftovers.map((r) => ({ inputs: r.inputs, output: r.output, type: r.type })) }, payload.keys));
      expect([...relowered].sort(byTriple)).toEqual([...rows].sort(byTriple));

      const rowSet = new Set(rows.map((r) => `${r.inputs} ${r.output} ${r.type}`));
      for (const leftover of leftovers) {
        const lo = typed([leftover])[0]!;
        expect(rowSet.has(`${lo.inputs} ${lo.output} ${lo.type}`)).toBe(true); // leftovers ⊆ rows
        expect(failsTagInvariant(lo, rows, payload.keys)).toBe(true); // and each one EARNED being a leftover
      }
    });
  }
});
