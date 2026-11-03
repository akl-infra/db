// RP5 for the format payload validators: spark/1, mana2/1 and the cmini adapter validate with ajv STANDALONE code generated
// at build time (scripts/build-validators.mjs) instead of compiling their schemas when the module loads, so importing a
// format loads no ajv. This proves the committed files are current and that each generated validator and ajv's run-time
// compile of the same schema (the options the formats used before) agree on every payload of a corpus: all verdicts and the
// whole error list, in order, schemaPath and params included (spark/1's most-specific-error picker reads all of them).
// Corpus: every base fixture of each format, plus fast-check mutations of them (delete, retype, extra key, replace with a
// scalar, graft a subtree from another fixture), plus the formats' own fixtures as given.
import fs from "node:fs";
import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import * as sparkAll from "../../formats/spark/1/validate-all.generated";
import * as spark from "../../formats/spark/1/validate.generated";
import * as mana2 from "../../formats/mana2/1/validate.generated";
import * as cmini from "../../formats/adapters/cmini/validate.generated";
import { validationSchema as sparkSchema } from "../../formats/spark/1/validation-schema";
import mana2Schema from "../../formats/mana2/1/schema.json" with { type: "json" };
import cminiSchema from "../../formats/adapters/cmini/schema.json" with { type: "json" };
// @ts-expect-error the script is plain ESM without types
import { TARGETS } from "../../scripts/build-validators.mjs";
import { fixturesIn } from "./validated-shapes";
import path from "node:path";

const FORMATS = path.resolve(import.meta.dirname, "..", "..", "formats");
type Gen = ((d: unknown) => boolean) & { errors?: unknown[] | null };

/** The compile each format module did at load before RP5 (same options, ajv-formats added where it was). */
function runtimeCompile(schema: object, opts: { allErrors: boolean; discriminator?: boolean; formats: boolean }): Gen {
  const ajv = new Ajv2020({ allErrors: opts.allErrors, strict: true, ...(opts.discriminator ? { discriminator: true } : {}) });
  if (opts.formats) addFormats(ajv);
  return ajv.compile(schema) as unknown as Gen;
}

interface Case {
  name: string;
  generated: Gen;
  reference: Gen;
  fixtures: unknown[];
}
const fixturesOf = (dir: string): unknown[] => fixturesIn(dir).map((f) => f.payload);
const sparkFixtures = fixturesOf(path.join(FORMATS, "spark", "1", "fixtures"));
const CASES: Case[] = [
  { name: "spark/1 (allErrors: false, discriminator)", generated: spark.validate as Gen, reference: runtimeCompile(sparkSchema, { allErrors: false, discriminator: true, formats: true }), fixtures: sparkFixtures },
  { name: "spark/1 (allErrors: true, discriminator)", generated: sparkAll.validate as Gen, reference: runtimeCompile(sparkSchema, { allErrors: true, discriminator: true, formats: true }), fixtures: sparkFixtures },
  { name: "mana2/1", generated: mana2.validate as Gen, reference: runtimeCompile(mana2Schema, { allErrors: false, formats: false }), fixtures: fixturesOf(path.join(FORMATS, "mana2", "1", "fixtures")) },
  { name: "cmini adapter", generated: cmini.validate as Gen, reference: runtimeCompile(cminiSchema, { allErrors: false, formats: true }), fixtures: fixturesOf(path.join(FORMATS, "adapters", "cmini", "fixtures")) },
];

// ---- mutation corpus ----
type Path = (string | number)[];
function allPaths(node: unknown, prefix: Path = [], out: Path[] = []): Path[] {
  out.push(prefix);
  if (Array.isArray(node)) node.forEach((v, i) => allPaths(v, [...prefix, i], out));
  else if (node !== null && typeof node === "object") for (const [k, v] of Object.entries(node)) allPaths(v, [...prefix, k], out);
  return out;
}
const getAt = (root: unknown, p: Path): unknown => p.reduce<unknown>((n, k) => (n as Record<string | number, unknown>)[k], root);
function setAt(root: unknown, p: Path, value: unknown, del = false): unknown {
  if (p.length === 0) return value;
  const clone = structuredClone(root) as Record<string | number, unknown>;
  const parent = getAt(clone, p.slice(0, -1)) as Record<string | number, unknown> | unknown[];
  const last = p[p.length - 1]!;
  if (del) {
    if (Array.isArray(parent)) parent.splice(Number(last), 1);
    else delete (parent as Record<string, unknown>)[last as string];
  } else (parent as Record<string | number, unknown>)[last] = value;
  return clone;
}
const SCALARS: unknown[] = [null, true, false, 0, -1, 1, 1.5, 7, 1e9, Number.MAX_SAFE_INTEGER, "", "a", "ab", "x".repeat(300), "é", "😀", "\n", [], [1], ["a"], {}, { kind: "x" }, { kind: "same" }, { kind: "opposite" }, { kind: "word_start" }];

function mutated(fixtures: unknown[]): fc.Arbitrary<unknown> {
  const op = fc.record({
    kind: fc.constantFrom("delete", "replace", "extra", "graft"),
    at: fc.nat(),
    value: fc.constantFrom(...SCALARS),
    other: fc.nat(),
    otherAt: fc.nat(),
    key: fc.constantFrom("zz", "x", "kind", "default", "keys", "magic"),
  });
  return fc.record({ base: fc.nat(), ops: fc.array(op, { minLength: 1, maxLength: 3 }) }).map(({ base, ops }) => {
    let doc: unknown = structuredClone(fixtures[base % fixtures.length]);
    for (const o of ops) {
      const paths = allPaths(doc);
      const p = paths[o.at % paths.length]!;
      if (o.kind === "delete" && p.length > 0) doc = setAt(doc, p, undefined, true);
      else if (o.kind === "replace") doc = setAt(doc, p, o.value);
      else if (o.kind === "extra") {
        const t = getAt(doc, p);
        if (t !== null && typeof t === "object" && !Array.isArray(t)) doc = setAt(doc, [...p, o.key], o.value);
      } else if (o.kind === "graft") {
        const donor = fixtures[o.other % fixtures.length];
        const dp = allPaths(donor);
        doc = setAt(doc, p, structuredClone(getAt(donor, dp[o.otherAt % dp.length]!)));
      }
    }
    return doc;
  });
}

function agree(c: Case, data: unknown): void {
  const a = c.reference(data);
  const b = c.generated(data);
  expect(b, `${c.name} ${JSON.stringify(data).slice(0, 200)}`).toBe(a);
  expect(c.generated.errors ?? null, `${c.name} errors for ${JSON.stringify(data).slice(0, 200)}`).toEqual(c.reference.errors ?? null);
}

describe("precompiled format validators (RP5)", () => {
  it("[LDB-RP5] every committed validators file (routes and formats) is exactly what `npm run build:validators` generates", () => {
    expect((TARGETS as { out: string; path: string; generate(): string }[]).map((t) => t.out)).toEqual([
      "src/routes/validators.generated.ts",
      "formats/spark/1/validate.generated.ts",
      "formats/spark/1/validate-all.generated.ts",
      "formats/mana2/1/validate.generated.ts",
      "formats/adapters/cmini/validate.generated.ts",
    ]);
    for (const t of TARGETS as { out: string; path: string; generate(): string }[]) expect(fs.readFileSync(t.path, "utf8"), t.out).toBe(t.generate());
  });

  it("[LDB-RP5] the format modules import neither ajv nor ajv-formats, and the generated files import nothing", () => {
    for (const f of ["spark/1/index.ts", "spark/1/validation-schema.ts", "mana2/1/index.ts", "adapters/cmini/index.ts"]) {
      const src = fs.readFileSync(path.join(FORMATS, f), "utf8");
      expect(src, f).not.toMatch(/from\s+["']ajv/);
      expect(src, f).not.toMatch(/\bnew Ajv|\.compile\(/);
    }
    for (const f of ["spark/1/validate.generated.ts", "spark/1/validate-all.generated.ts", "mana2/1/validate.generated.ts", "adapters/cmini/validate.generated.ts"]) {
      expect(fs.readFileSync(path.join(FORMATS, f), "utf8"), f).not.toMatch(/\brequire\(|\bimport\b/);
    }
  });

  for (const c of CASES) {
    it(`[LDB-RP5] ${c.name}: the generated validator and ajv's run-time compile agree on every fixture, valid or not`, () => {
      expect(c.fixtures.length).toBeGreaterThan(5);
      let valid = 0;
      for (const f of c.fixtures) {
        agree(c, f);
        if (c.reference(f)) valid++;
      }
      expect(valid, "the fixtures include valid payloads").toBeGreaterThan(0);
    });

    it(`[LDB-RP5] ${c.name}: and on generated mutations (delete, retype, extra key, graft) the verdicts and the whole error lists are identical`, () => {
      let refused = 0;
      let accepted = 0;
      fc.assert(
        fc.property(mutated(c.fixtures), (doc) => {
          agree(c, doc);
          if (c.reference(doc)) accepted++;
          else refused++;
          return true;
        }),
        { numRuns: 1500, seed: 11 },
      );
      expect(refused, "the mutations produce refused payloads").toBeGreaterThan(100);
      expect(accepted + refused).toBe(1500);
    });

    it(`[LDB-RP5] ${c.name}: and on arbitrary JSON`, () => {
      fc.assert(fc.property(fc.jsonValue(), (doc) => (agree(c, doc), true)), { numRuns: 300, seed: 12 });
    });
  }
});
