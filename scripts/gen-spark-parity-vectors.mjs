#!/usr/bin/env node
// Generates + freezes db/formats/spark/1/fixtures/parity-vectors.json (300
// seeded fast-check cases: `{keys, magic, expected}`, `expected =
// compileMagic({keys, magic})`, then 60 refused ones:
// `{keys, magic, refused: {message, path}}`, a valid rule set plus one key
// that isn't on the layout, `refused` being spark1.validate()'s error) -- the interop contract
// between spark/1's own magic compiler and akl.gg's `magicRulesFlatCompile`
// (`@akl/core/rules`), now that bot/ no longer depends on this package at
// all (saltorbit, 2026-09-13: "the bot is a third-party client of the layout DB
// like any other", LDB-B6/LDB-B334) and so can't import `compileMagic`
// directly any more to run its own property test against it.
//
// This is the SAME generator shape `bot/tests/magic/spark-parity.test.ts`
// (LDB-B78) used to run live, seeded here instead so both sides get a
// FROZEN, byte-identical fixture rather than each independently reproducing
// "the same" fast-check arbitrary (a genuine risk of silent drift -- a
// fast-check version bump, or a one-character difference in either copy of
// the generator, would otherwise go unnoticed). `tests/formats/
// spark-parity-vectors.test.ts` (LDB-F39, db-side) asserts `compileMagic`
// over this file still equals `expected`, so the DB can't drift from its
// own published vectors either; `bot/tests/fixtures/spark-parity-vectors
// .json` is the bot's own hand-refreshed copy of this exact file, asserted
// against `magicRulesFlatCompile` by LDB-B78.
//
// Deterministic: `fc.sample(..., {numRuns: 300, seed: SEED})` with a fixed
// seed reproduces byte-identical output on every run with the same
// fast-check version. `--check` recomputes into memory and diffs against
// the committed file instead of writing (mirrors `gen-vectors.mjs`,
// LDB-B4's sibling).
import fs from "node:fs";
import path from "node:path";
import url from "node:url";
import fc from "fast-check";
import * as spark1 from "../formats/spark/1/index.ts";

const SCRIPTS_DIR = path.dirname(url.fileURLToPath(import.meta.url));
const DB_ROOT = path.join(SCRIPTS_DIR, "..");
const OUT_FILE = path.join(DB_ROOT, "formats", "spark", "1", "fixtures", "parity-vectors.json");
const CHECK = process.argv.includes("--check");
const SEED = 0x53504b31; // 'SPK1' -- arbitrary, fixed forever (changing it changes every vector)
const NUM_RUNS = 300;

// ---------------------------------------------------------------------
// The generator -- byte-for-byte the same shape bot/tests/magic/
// spark-parity.test.ts used to run live (POOL/FINGERS/OFF, layoutArb,
// ruleSetArb): only rule sets akl.gg's gate (functions/_lib/rules.mjs
// `validateRuleSet`) accepts -- single-character keys and afters, one rule
// per `after` per key, outputs that start with their `after`, a key never
// both magic and chiral, no two swaps sharing a (trigger, member), and
// every key a rule set names on the layout (LDB-F22).
// ---------------------------------------------------------------------
const POOL = [...'abcdefghijklmnopqrst'];
// design/layout-db/23-geometry.md §4.2: `TB` is gone from the finger
// vocabulary (the label IS the hand).
const FINGERS = ['LP', 'LR', 'LM', 'LI', 'RI', 'RM', 'RR', 'RP'];
// Characters no generated layout carries -- the refused vectors' one bad key
// (LDB-F22: every named key must be on the layout, on both sides). The
// upper-case ones are adaptative-magic-sturdy's shape: `C` named where the
// layout has `c`.
const OFF = ['C', 'M', 'K', '*', '@'];
const REFUSED_SEED = SEED + 1;
const NUM_REFUSED = 60;

const layoutArb = fc
  .uniqueArray(fc.constantFrom(...POOL), { minLength: 4, maxLength: 12 })
  .chain((chars) =>
    fc.tuple(fc.constant(chars), fc.array(fc.constantFrom(...FINGERS), { minLength: chars.length, maxLength: chars.length })),
  )
  .map(([chars, fingers]) => chars.map((c, i) => ({ c, row: i % 3, col: i, finger: fingers[i] })));

function ruleSetArb(cells) {
  const chars = cells.map((k) => k.c);
  const ch = fc.constantFrom(...chars);
  const named = ch;
  const emitted = fc.constantFrom(...chars, 'y', "'", ' ');
  const magicKeyArb = (key) =>
    fc.record({
      key: fc.constant(key),
      default: fc.oneof(fc.constant('repeat_previous'), fc.constant('none'), fc.constantFrom(...chars, 'y')),
      rules: fc
        .uniqueArray(fc.constantFrom(...chars, ' '), { maxLength: 4 })
        .chain((afters) => fc.tuple(...afters.map((a) => emitted.map((o) => ({ after: a, output: a + o })))))
        .map((rs) => [...rs]),
    });
  const chiralKeyArb = (key) =>
    fc
      .record({
        same: fc.option(fc.constantFrom('repeat_previous', null, ...chars), { nil: undefined }),
        opposite: fc.option(fc.constantFrom('repeat_previous', null, ...chars), { nil: undefined }),
      })
      .map((h) => {
        // a JSON null reads as absent on both sides (LDB-F22)
        const out = { key };
        if (h.same !== undefined) out.same = h.same;
        if (h.opposite !== undefined) out.opposite = h.opposite;
        if (out.same == null && out.opposite == null) out.same = 'repeat_previous';
        return out;
      });
  const swapsArb = fc.array(fc.tuple(named, named, named), { maxLength: 5 }).map((triples) => {
    const seen = new Set();
    const out = [];
    for (const [t, a, b] of triples) {
      if (a === b || seen.has(`${t}|${a}`) || seen.has(`${t}|${b}`)) continue;
      seen.add(`${t}|${a}`);
      seen.add(`${t}|${b}`);
      out.push({ trigger: t, swap: [a, b] });
    }
    return out;
  });
  return fc.uniqueArray(named, { maxLength: 3 }).chain((special) => {
    const nMagic = special.length === 0 ? 0 : Math.max(1, special.length - 1);
    return fc.record(
      {
        magic_keys: fc.tuple(...special.slice(0, nMagic).map(magicKeyArb)).map((m) => [...m]),
        chiral_keys: fc.tuple(...special.slice(nMagic).map(chiralKeyArb)).map((c) => [...c]),
        adaptive_swaps: swapsArb,
      },
      { requiredKeys: ['magic_keys', 'chiral_keys', 'adaptive_swaps'] },
    );
  });
}

const casesArb = layoutArb.chain((cells) => fc.tuple(fc.constant(cells), ruleSetArb(cells)));

// A valid case plus one off-layout key, appended where it's the first thing
// validation trips on: a new magic key, a new chiral key, or a new swap whose
// trigger or one member is off the layout (the other two chars are on it).
const refusedArb = casesArb.chain(([cells, rs]) => {
  const chars = cells.map((k) => k.c);
  return fc
    .record({
      where: fc.constantFrom('magic_key', 'chiral_key', 'trigger', 'member'),
      off: fc.constantFrom(...OFF),
      on: fc.shuffledSubarray(chars, { minLength: 2, maxLength: 2 }),
    })
    .map(({ where, off, on: [a, b] }) => {
      const bad = { magic_keys: [...rs.magic_keys], chiral_keys: [...rs.chiral_keys], adaptive_swaps: [...rs.adaptive_swaps] };
      if (where === 'magic_key') bad.magic_keys.push({ key: off, default: 'repeat_previous', rules: [] });
      if (where === 'chiral_key') bad.chiral_keys.push({ key: off, same: 'repeat_previous' });
      if (where === 'trigger') bad.adaptive_swaps.push({ trigger: off, swap: [a, b] });
      if (where === 'member') bad.adaptive_swaps.push({ trigger: a, swap: [b, off] });
      return [cells, bad];
    });
});

function sparkKeys(cells) {
  return cells.map((k) => ({ char: k.c, row: k.row, col: k.col, finger: k.finger }));
}

// spark/1's OWN wire shape tags `default`/`same`/`opposite`
// (`{kind:"repeat"}` | `{kind:"char",char}` | absent/null, design/layout-db/
// 23-geometry.md round 3) -- the generator above produces bare strings (the
// OLD shared vocabulary); this tags them for spark/1, mirroring
// `bot/src/render/magic.ts`'s `legacyTag` in the opposite direction.
function tagDefault(bare) {
  if (bare === undefined || bare === 'none') return undefined;
  if (bare === 'repeat_previous') return { kind: 'repeat' };
  return { kind: 'char', char: bare };
}
function tagChiral(bare) {
  if (bare === null || bare === undefined) return bare;
  if (bare === 'repeat_previous') return { kind: 'repeat' };
  return { kind: 'char', char: bare };
}

function toSparkMagic(rs) {
  return {
    magic_keys: rs.magic_keys.map((mk) => ({ key: mk.key, default: tagDefault(mk.default), rules: mk.rules })),
    chiral_keys: rs.chiral_keys.map((ck) => ({ key: ck.key, same: tagChiral(ck.same), opposite: tagChiral(ck.opposite) })),
    adaptive_swaps: rs.adaptive_swaps,
  };
}

function buildVector([cells, rs]) {
  const keys = sparkKeys(cells);
  const magic = toSparkMagic(rs);
  const payload = { keys, magic };
  const validation = spark1.validate(payload);
  if (!validation.ok) {
    throw new Error(`generated payload failed spark1.validate(): ${JSON.stringify(validation.error)}\npayload: ${JSON.stringify(payload)}`);
  }
  const expected = spark1.compileMagic(payload);
  return { keys, magic, expected };
}

function buildRefusedVector([cells, rs]) {
  const keys = sparkKeys(cells);
  const magic = toSparkMagic(rs);
  const validation = spark1.validate({ keys, magic });
  if (validation.ok || !validation.error.message.endsWith("is not one of this layout's keys")) {
    throw new Error(`refused case wasn't refused for its off-layout key: ${JSON.stringify(validation)}\nmagic: ${JSON.stringify(magic)}`);
  }
  return { keys, magic, refused: { message: validation.error.message, path: validation.error.path } };
}

function build() {
  const samples = fc.sample(casesArb, { numRuns: NUM_RUNS, seed: SEED });
  const refused = fc.sample(refusedArb, { numRuns: NUM_REFUSED, seed: REFUSED_SEED });
  return [...samples.map(buildVector), ...refused.map(buildRefusedVector)];
}

function main() {
  const vectors = build();
  const text = JSON.stringify(vectors, null, 2) + "\n";

  if (CHECK) {
    const existing = fs.existsSync(OUT_FILE) ? fs.readFileSync(OUT_FILE, "utf8") : null;
    if (existing !== text) {
      console.error(`${path.relative(DB_ROOT, OUT_FILE)} is out of date -- run 'node scripts/gen-spark-parity-vectors.mjs' to regenerate.`);
      process.exitCode = 1;
      return;
    }
    console.log(`${path.relative(DB_ROOT, OUT_FILE)} matches (--check OK)`);
    return;
  }

  fs.mkdirSync(path.dirname(OUT_FILE), { recursive: true });
  fs.writeFileSync(OUT_FILE, text);
  console.log(`wrote ${path.relative(DB_ROOT, OUT_FILE)} (${vectors.length} vectors)`);
}

main();
