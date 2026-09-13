// [LDB-F35]..[LDB-F38]: `validate()` reports the MOST SPECIFIC ajv error
// for a schema violation, not `errors[0]` (design/layout-db/22-spark-spec.md
// §6, the akl.gg publish-session bug, 2026-09-13: a magic key's `default`
// sent as a tagged sentinel wrapped TWICE -- `{kind:'char', char:{kind:
// 'repeat'}}` -- reported "must NOT have additional properties" from the
// WRONG oneOf branch (`kind: 'repeat'`'s own additionalProperties check),
// sending a debugging session an hour down the wrong path instead of
// naming the real problem: `default.char` must be a single-character
// string). `formats/spark/1/index.ts`'s own comments (`withDiscriminatorHint`,
// `pickMostSpecificError`) explain the mechanism this file pins:
//   - the sentinel unions (`magicDefault`, and `chiralValue`'s `$ref` to
//     it) get ajv's own `discriminator` keyword on a validator-only clone
//     of the schema (never the served `schema.json`/GET .../schema.json,
//     LDB-F35's own comment in index.ts -- no WIRE_VERSION bump, no
//     conformance fixture touched), so ajv resolves straight to the ONE
//     branch `kind` names and reports only that branch's own error;
//   - every other union (chiralKey.same/opposite's `| null`, and anything
//     schema.json grows later that isn't `kind`-discriminated) falls back
//     to `pickMostSpecificError`'s general rule: group by branch, drop a
//     branch whose own discriminating field failed a const/enum check,
//     drop `oneOf`/`anyOf`/`if`/`then` bookkeeping outright, then take the
//     deepest surviving `instancePath` (ties broken by keyword
//     specificity, then by original array position -- deterministic).
import fs from "node:fs";
import path from "node:path";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import * as spark1 from "../../formats/spark/1/index.ts";

const FIXTURES_DIR = path.resolve(import.meta.dirname, "..", "..", "formats", "spark", "1", "fixtures");

function loadFixture(stem: string): unknown {
  return JSON.parse(fs.readFileSync(path.join(FIXTURES_DIR, `${stem}.json`), "utf8"));
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- walking an arbitrary already-valid spark/1 payload to inject one fault
type AnyPayload = any;

function parentPointer(pointer: string): string {
  const i = pointer.lastIndexOf("/");
  return i <= 0 ? "/" : pointer.slice(0, i);
}

// The reported path is the fault's own path, or its immediate parent --
// never a grandparent, never a sibling branch's path entirely.
function isFaultOrOneLevelUp(reported: string, faultPath: string): boolean {
  return reported === faultPath || reported === parentPointer(faultPath);
}

describe("[LDB-F35] the double-wrapped magic-default sentinel names the real problem", () => {
  it("[LDB-F35] {kind:'char', char:{kind:'repeat'}} reports 'default/char must be string', never 'must NOT have additional properties'", () => {
    const payload = loadFixture("901-idioms") as AnyPayload;
    payload.magic.magic_keys[0].default = { kind: "char", char: { kind: "repeat" } };
    const result = spark1.validate(payload);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.message).toBe("payload/magic/magic_keys/0/default/char must be string");
    expect(result.error.message).not.toMatch(/additional propert/i);
    expect(result.error.path).toBe("/magic/magic_keys/0/default/char");
  });

  it("[LDB-F35] the same double-wrap under chiralKey.same reports 'same/char must be string'", () => {
    const payload = loadFixture("901-idioms") as AnyPayload;
    payload.magic.chiral_keys[0].same = { kind: "char", char: { kind: "repeat" } };
    const result = spark1.validate(payload);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.message).toBe("payload/magic/chiral_keys/0/same/char must be string");
    expect(result.error.message).not.toMatch(/additional propert/i);
  });

  it("[LDB-F35] a `kind` naming neither branch reports the discriminator's own error, at the union's path", () => {
    const payload = loadFixture("901-idioms") as AnyPayload;
    payload.magic.magic_keys[0].default = { kind: "bogus" };
    const result = spark1.validate(payload);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.path).toBe("/magic/magic_keys/0/default");
    expect(result.error.message).toMatch(/tag "kind"/);
  });
});

// -- [LDB-F36] property: one injected fault -> the reported instancePath --

type FaultKind = "wrong kind" | "extra key property" | "bad finger" | "non-string char" | "nested default";

const FAULT_KINDS: FaultKind[] = ["wrong kind", "extra key property", "bad finger", "non-string char", "nested default"];

// Every one of these has at least one `keys` entry AND at least one
// magic_keys[].default -- what "wrong kind"/"nested default" need.
const MAGIC_FIXTURE_STEMS = ["003-auditor", "903-word-start", "901-idioms", "006-opal-e200"];

interface Injected {
  payload: AnyPayload;
  faultPath: string;
}

// Applies exactly one fault to a deep clone of a known-valid fixture, at
// the given index (for the two fault kinds that need one -- "wrong
// kind"/"nested default" always target the fixture's first magic_keys[]
// default and ignore `index`). Returns the fault's OWN json-pointer path
// (not necessarily where validate() will report it -- that's what the
// property below checks) or null when `index` doesn't apply to this
// fixture (e.g. "non-string char" over a fixture with fewer char-bearing
// keys than `index`) -- a skip, never a false pass.
function injectFaultAt(stem: string, kind: FaultKind, index: number): Injected | null {
  const payload = structuredClone(loadFixture(stem)) as AnyPayload;
  switch (kind) {
    case "wrong kind": {
      const idx = payload.magic.magic_keys.findIndex((mk: AnyPayload) => mk.default !== undefined);
      if (idx < 0) return null;
      payload.magic.magic_keys[idx].default.kind = "bogus";
      return { payload, faultPath: `/magic/magic_keys/${idx}/default/kind` };
    }
    case "extra key property": {
      if (index >= payload.keys.length) return null;
      payload.keys[index].extra_field_never_allowed = "x";
      return { payload, faultPath: `/keys/${index}` };
    }
    case "bad finger": {
      if (index >= payload.keys.length) return null;
      payload.keys[index].finger = "ZZ";
      return { payload, faultPath: `/keys/${index}/finger` };
    }
    case "non-string char": {
      const withChar: number[] = payload.keys
        .map((k: AnyPayload, i: number) => i)
        .filter((i: number) => typeof payload.keys[i].char === "string");
      if (index >= withChar.length) return null;
      const idx = withChar[index]!;
      payload.keys[idx].char = 12345;
      return { payload, faultPath: `/keys/${idx}/char` };
    }
    case "nested default": {
      const idx = payload.magic.magic_keys.findIndex((mk: AnyPayload) => mk.default !== undefined);
      if (idx < 0) return null;
      payload.magic.magic_keys[idx].default = { kind: "char", char: { kind: "repeat" } };
      return { payload, faultPath: `/magic/magic_keys/${idx}/default/char` };
    }
  }
}

describe("[LDB-F36] one injected fault -> the reported path is the fault's own path or one level up", () => {
  it("[LDB-F36] property over fixture x fault-kind x index, 100 runs", () => {
    fc.assert(
      fc.property(fc.constantFrom(...MAGIC_FIXTURE_STEMS), fc.constantFrom(...FAULT_KINDS), fc.nat({ max: 40 }), (stem, kind, index) => {
        const injected = injectFaultAt(stem, kind, index);
        fc.pre(injected !== null); // e.g. `index` past this fixture's key count -- skip, don't fail
        const { payload, faultPath } = injected!;
        const result = spark1.validate(payload);
        expect(result.ok).toBe(false);
        if (result.ok) return;
        expect(isFaultOrOneLevelUp(result.error.path as string, faultPath)).toBe(true);
      }),
      { numRuns: 100 },
    );
  });
});

// -- [LDB-F37] determinism: same input -> same error, every run --

describe("[LDB-F37] error selection is deterministic", () => {
  it("[LDB-F37] the double-wrapped payload reports the identical {path, message} across 100 runs", () => {
    const payload = loadFixture("901-idioms") as AnyPayload;
    payload.magic.magic_keys[0].default = { kind: "char", char: { kind: "repeat" } };
    const results = Array.from({ length: 100 }, () => spark1.validate(structuredClone(payload)));
    expect(results.every((r) => !r.ok)).toBe(true);
    const shapes = results.map((r) => (r.ok ? null : { path: r.error.path, message: r.error.message }));
    expect(new Set(shapes.map((s) => JSON.stringify(s))).size).toBe(1);
  });

  it("[LDB-F37] every (fixture, fault kind) pair from the F36 property is stable across 100 runs of the SAME payload", () => {
    let checked = 0;
    for (const stem of MAGIC_FIXTURE_STEMS) {
      for (const kind of FAULT_KINDS) {
        const injected = injectFaultAt(stem, kind, 0);
        if (injected === null) continue;
        checked++;
        const results = Array.from({ length: 100 }, () => spark1.validate(structuredClone(injected.payload)));
        expect(results.every((r) => !r.ok)).toBe(true);
        const shapes = new Set(results.map((r) => (r.ok ? "" : JSON.stringify({ path: r.error.path, message: r.error.message }))));
        expect(shapes.size).toBe(1);
      }
    }
    expect(checked).toBeGreaterThan(0); // the loop actually exercised something -- no silent no-op
  });
});

// -- [LDB-F38] perf: validate() on the largest fixture stays within 2x --
//
// Measured 2026-09-13 (this machine, Node --experimental-strip-types,
// warm): the largest spark/1 fixture (002-opal.json, 30 keys + 7 magic
// keys with rules) validates in ~22us/call when VALID (the write-path
// common case, unchanged by this row -- `ajvValidate` alone, allErrors:
// false, one pass, no `pickMostSpecificError` call at all) and ~3us/call
// for the double-wrapped-default INVALID case (up from ~1.3us before this
// row -- the added `ajvValidateAll` allErrors:true re-pass only an
// invalid write ever pays for). Pinned LOOSELY (a generous absolute
// ceiling, not a tight percentage, to survive slower CI hardware without
// chasing noise) at a multiple comfortably above 2x either number.
// LDB-F39 (2026-09-13): `parity-vectors.json` is a LIST of 300 golden
// vectors (`scripts/gen-spark-parity-vectors.mjs`), not a single base
// Payload -- by far the largest FILE in this directory, which would
// otherwise make `largestFixtureStem()` below pick it as "the largest
// spark/1 fixture" and hand it to `spark1.validate()` as if it were one.
function isBaseFixtureFile(filename: string): boolean {
  if (!filename.endsWith(".json")) return false;
  if (filename === "parity-vectors.json") return false;
  return !filename.slice(0, -".json".length).includes(".");
}

function largestFixtureStem(): string {
  const files = fs.readdirSync(FIXTURES_DIR).filter(isBaseFixtureFile);
  let best = files[0]!;
  let bestSize = -1;
  for (const f of files) {
    const size = fs.statSync(path.join(FIXTURES_DIR, f)).size;
    if (size > bestSize) {
      bestSize = size;
      best = f;
    }
  }
  return best.replace(/\.json$/, "");
}

function timeUsPerCall(fn: () => void, n: number): number {
  for (let i = 0; i < Math.min(1000, n); i++) fn(); // warmup
  const t0 = performance.now();
  for (let i = 0; i < n; i++) fn();
  const t1 = performance.now();
  return ((t1 - t0) / n) * 1000;
}

describe("[LDB-F38] validate() latency on the largest fixture stays within 2x of baseline", () => {
  it("[LDB-F38] valid payload: under 300us/call (baseline ~22us, generous 2x+ headroom)", () => {
    const payload = loadFixture(largestFixtureStem());
    const usPerCall = timeUsPerCall(() => spark1.validate(payload), 5000);
    expect(usPerCall).toBeLessThan(300);
  });

  it("[LDB-F38] invalid (double-wrapped default) payload: under 60us/call (baseline ~3us, generous 2x+ headroom)", () => {
    const payload = loadFixture(largestFixtureStem()) as AnyPayload;
    if (!payload.magic) payload.magic = {};
    if (!payload.magic.magic_keys) payload.magic.magic_keys = [];
    payload.magic.magic_keys.push({ key: "¶", default: { kind: "char", char: { kind: "repeat" } } });
    const usPerCall = timeUsPerCall(() => spark1.validate(payload), 5000);
    expect(usPerCall).toBeLessThan(60);
  });
});
