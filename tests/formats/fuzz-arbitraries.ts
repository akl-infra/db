// [LDB-FZ10] Arbitraries shared by the seeded property suites: generated spark/1 payloads (odd code points on purpose, API 1.38 cases
// included), fixture mutations, and arbitrary JSON. Pure data, no assertions.
import fc from "fast-check";

// import.meta.glob (not fs): this module also loads inside the workers pool, which has no filesystem.
const RAW = import.meta.glob("../../formats/spark/1/fixtures/*.json", { eager: true, import: "default" }) as Record<string, unknown>;
export const FIXTURES: { name: string; payload: unknown }[] = Object.entries(RAW)
  .map(([file, payload]) => ({ name: file.split("/").pop()!, payload }))
  .filter((f) => /^\d+-.*\.json$/.test(f.name) && !/\.(lowered|mana2-1)\.json$/.test(f.name))
  .sort((a, b) => (a.name < b.name ? -1 : 1));

export const FINGERS = ["LP", "LR", "LM", "LI", "RI", "RM", "RR", "RP", "LT", "RT"];

// Awkward single code points: the astral, the space, the quote, the infinity, a combining mark, `_`, a BMP surrogate-adjacent one.
const ODD_CHARS = ["∞", '"', "\\", " ", "😀", "𝒳", "é", "\u0301", "_", "\u0000", "\u{10FFFF}", "◇", "'", "/"];
export const charArb = fc.oneof(
  { weight: 5, arbitrary: fc.constantFrom(..."abcdefghijklmnopqrstuvwxyz;,./'") },
  { weight: 2, arbitrary: fc.constantFrom(...ODD_CHARS) },
  { weight: 1, arbitrary: fc.string({ unit: "binary", minLength: 1, maxLength: 1 }) },
);
export const fingerArb = fc.constantFrom(...FINGERS);

// Rows -1..3 only: the schema allows row 4, but a layout spanning six rows (-1..4) translates to a mana2/1 payload that mana2/1's own
// validate refuses (`/layout/fingers` has more than 5 items; reported to the owner in the Stage 4 F-db handoff, LDB-FZ10 note), so the
// "translation validates" property is stated over layouts that fit mana2/1's five rows.
// A layout with distinct characters (so magic can name them), arbitrary positions (the duplicate-position refusal is a valid
// outcome the properties must survive), then optional alts/combos/magic built from layout chars and odd literals.
export const payloadArb: fc.Arbitrary<Record<string, unknown>> = fc
  .uniqueArray(charArb, { minLength: 1, maxLength: 14 })
  .chain((chars) => {
    const keys = fc.tuple(...chars.map((c) => fc.record({ char: fc.constant(c), row: fc.integer({ min: -1, max: 3 }), col: fc.integer({ min: 0, max: 12 }), finger: fingerArb })));
    const lit = fc.oneof(fc.constantFrom(...chars), charArb);
    const alt = fc.oneof(
      fc.record({ ngram: fc.tuple(lit), fingers: fc.tuple(fingerArb) }),
      fc.record({ ngram: fc.tuple(lit, lit), fingers: fc.tuple(fingerArb, fingerArb) }),
      fc.record({ ngram: fc.tuple(lit, fc.constant(null), lit), fingers: fc.tuple(fingerArb, fc.constant(null), fingerArb) }),
    );
    const combo = fc.record({ keys: fc.tuple(fc.constantFrom(...chars), fc.constantFrom(...chars)), output: charArb });
    const magic = fc.record(
      {
        magic_keys: fc.array(fc.record({ key: fc.constantFrom(...chars), default: fc.constant({ kind: "repeat" }) }), { maxLength: 3 }),
        adaptive_swaps: fc.array(fc.record({ trigger: lit, swap: fc.tuple(fc.constantFrom(...chars), fc.constantFrom(...chars)) }), { maxLength: 3 }),
      },
      { requiredKeys: [] },
    );
    return fc.record(
      { keys, alts: fc.array(alt, { maxLength: 4 }), combos: fc.array(combo, { maxLength: 3 }), magic },
      { requiredKeys: ["keys"] },
    );
  });

// Mutations over arbitrary JSON trees (dropped / renamed / retyped / duplicated fields, huge arrays).
export type Json = null | boolean | number | string | Json[] | { [k: string]: Json };
const jsonArb: fc.Arbitrary<Json> = fc.json({ maxDepth: 3 }).map((s) => JSON.parse(s) as Json);
export const wildJson = fc.oneof(
  jsonArb,
  fc.jsonValue({ maxDepth: 4 }) as fc.Arbitrary<Json>,
  fc.constantFrom<Json>(null, true, 0, -1, 1e308, "", "{}", [], {}, [[]], { keys: null }, { keys: {} }, { keys: [null] }, { keys: [{}] }),
);

function mutate(root: unknown, ops: { pick: number; kind: number; extra: Json }[]): unknown {
  let cur = structuredClone(root) as Json;
  for (const op of ops) {
    const before = structuredClone(cur);
    const paths: (string | number)[][] = [];
    (function walk(n: Json, p: (string | number)[]): void {
      paths.push(p);
      if (Array.isArray(n)) n.forEach((c, i) => walk(c, [...p, i]));
      else if (n !== null && typeof n === "object") for (const k of Object.keys(n)) walk(n[k]!, [...p, k]);
    })(cur, []);
    const target = paths[op.pick % paths.length]!;
    if (target.length === 0) {
      cur = op.kind % 3 === 0 ? structuredClone(op.extra) : cur;
      continue;
    }
    let parent: Json = cur;
    for (const seg of target.slice(0, -1)) parent = (parent as never)[seg];
    const last = target[target.length - 1]!;
    const container = parent as unknown as Record<string | number, Json> & Json[];
    switch (op.kind % 6) {
      case 0: // replace with arbitrary JSON (wrong type); always a COPY: fast-check reuses generated values across runs
        container[last] = structuredClone(op.extra);
        break;
      case 1: // drop
        if (Array.isArray(container)) container.splice(last as number, 1);
        else delete container[last];
        break;
      case 2: // rename a field
        if (!Array.isArray(container)) {
          const v = container[last]!;
          delete container[last];
          container[`${String(last)}_`] = v;
        }
        break;
      case 3: // duplicate an element
        if (Array.isArray(container)) container.splice(last as number, 0, structuredClone(container[last as number]!));
        break;
      case 4: // inflate: a huge array in place
        container[last] = Array.from({ length: 2000 }, (_, i) => i); // primitives only: nested inflations must not multiply (2000^3 OOMs a worker)
        break;
      default: // a string value becomes an odd code point (empty / astral / quote / infinity)
        if (typeof container[last] === "string") container[last] = ODD_CHARS[(op.pick >>> 3) % ODD_CHARS.length]!;
        else container[last] = structuredClone(op.extra);
    }
    // bound the input: ops compound (duplicate of an inflated array, ...), and a 100 MB input only tests the runner's heap
    if ((JSON.stringify(cur)?.length ?? 0) > 60000) cur = before;
  }
  return cur;
}
const mutationArb = fc.array(fc.record({ pick: fc.nat(100000), kind: fc.nat(100), extra: wildJson }), { minLength: 1, maxLength: 4 });
export const mutatedFixtureArb = fc.tuple(fc.constantFrom(...FIXTURES.map((f) => f.name)), mutationArb).map(([name, ops]) => mutate(FIXTURES.find((f) => f.name === name)!.payload, ops));

// Everything a spark/1 reader might be handed: generated payloads, mutated fixtures, arbitrary JSON.
export const anyInput = fc.oneof({ weight: 3, arbitrary: payloadArb }, { weight: 3, arbitrary: mutatedFixtureArb }, { weight: 2, arbitrary: wildJson });

