// [LDB-F1] Generated matrix: for every fixture, for every leaf (scalar)
// path in the payload, each applicable mutation in {delete, wrong type,
// empty string, negative number} is refused by `validate()` with `path`
// pointing at that leaf or its immediate parent -- except mutations that
// are enumerated below in ALLOWED because they produce another valid
// payload (07 §6 S2: "no blanket skips"; 07 §6 S3: ALLOWED is now
// per-format so cmini/1 and spark/1 can't leak allowances into each
// other). Duplicate-sibling mutations (positions, magic inputs) are
// structural, generated once per fixture alongside the per-leaf matrix.
// Loops over `validatedShapes()` (`validated-shapes.ts`), not
// `listFormats()` directly: cmini/1 left the registry in 20-spark.md S1
// (moved to the unregistered adapter, db/formats/adapters/cmini/), and a
// bare `listFormats()` loop would silently stop generating this matrix
// for it -- `validatedShapes()` is that same list plus the adapter, so
// this file's coverage is unchanged by the move.
import { describe, expect, it } from "vitest";
import { validatedShapes, fixturesIn } from "./validated-shapes.ts";
import * as spark1 from "../../formats/spark/1/index.ts";

// -- JSON Pointer helpers (RFC 6901) --
function pointerSeg(seg: string): string {
  return seg.replace(/~/g, "~0").replace(/\//g, "~1");
}
function toPointer(segs: string[]): string {
  return segs.length === 0 ? "" : "/" + segs.map(pointerSeg).join("/");
}
// cmini/1's and akl/1's validate() both report the root as "/" (an
// instancePath of "" is mapped there) -- match that convention.
function toPointerOrRoot(segs: string[]): string {
  const p = toPointer(segs);
  return p === "" ? "/" : p;
}
// The immediate parent of a JSON Pointer, e.g. "/magic/rules/1/inputs" ->
// "/magic/rules/1" -- used wherever an error can only reasonably name a
// container (a required-field deletion; a magic_collision naming the
// colliding ROW, not one of its fields).
function parentPointer(pointer: string): string {
  const i = pointer.lastIndexOf("/");
  return i <= 0 ? "/" : pointer.slice(0, i);
}

// -- generic leaf walk: every scalar (string/number) value's path --
interface Leaf {
  segs: string[];
  pointer: string;
  kind: "string" | "number";
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- walking an arbitrary JSON tree
function walkLeaves(node: any, prefix: string[] = [], out: Leaf[] = []): Leaf[] {
  if (Array.isArray(node)) {
    node.forEach((item, i) => walkLeaves(item, [...prefix, String(i)], out));
  } else if (node !== null && typeof node === "object") {
    for (const [k, v] of Object.entries(node)) walkLeaves(v, [...prefix, k], out);
  } else if (typeof node === "string" || typeof node === "number") {
    out.push({ segs: prefix, pointer: toPointer(prefix), kind: typeof node as "string" | "number" });
  }
  return out;
}

// akl/1's `x` is free-form and validated only as JSON (01 §2: "preserved
// verbatim, ignored by lowering") -- its own size cap is x.test.ts's job
// (LDB-F10), not this generic schema-leaf matrix, which would otherwise
// have to special-case every mutation under it as "allowed".
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function omitX(payload: any): unknown {
  if (payload === null || typeof payload !== "object" || Array.isArray(payload)) return payload;
  const { x: _x, ...rest } = payload;
  return rest;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function navigateToParent(root: any, segs: string[]): { parent: any; key: string | number } {
  let node = root;
  for (let i = 0; i < segs.length - 1; i++) {
    const seg = segs[i]!;
    node = Array.isArray(node) ? node[Number(seg)] : node[seg];
  }
  const last = segs[segs.length - 1]!;
  return { parent: node, key: Array.isArray(node) ? Number(last) : last };
}

function deleteLeaf(root: unknown, segs: string[]): unknown {
  const clone = structuredClone(root);
  const { parent, key } = navigateToParent(clone, segs);
  if (Array.isArray(parent)) parent.splice(key as number, 1);
  else delete parent[key as string];
  return clone;
}

function setLeaf(root: unknown, segs: string[], value: unknown): unknown {
  const clone = structuredClone(root);
  const { parent, key } = navigateToParent(clone, segs);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (parent as any)[key as any] = value;
  return clone;
}

type Mutation = "delete" | "wrong type" | "empty string" | "negative number";

function mutationsFor(leaf: Leaf): Mutation[] {
  const out: Mutation[] = ["delete", "wrong type"];
  if (leaf.kind === "string") out.push("empty string");
  if (leaf.kind === "number") out.push("negative number");
  return out;
}

function applyMutation(payload: unknown, leaf: Leaf, mutation: Mutation): unknown {
  switch (mutation) {
    case "delete":
      return deleteLeaf(payload, leaf.segs);
    case "wrong type":
      return setLeaf(payload, leaf.segs, leaf.kind === "string" ? 12345 : "wrong-type");
    case "empty string":
      return setLeaf(payload, leaf.segs, "");
    case "negative number":
      return setLeaf(payload, leaf.segs, -1);
  }
}

// Mutations that are known, ahead of time, to still produce a VALID payload
// -- keyed by "<field kind>:<mutation>" per format (a pair not listed here
// is expected to be REFUSED; a pair that turns out valid but isn't listed
// fails the test loudly rather than silently passing, 07 §6 S2's "no
// blanket skips"). `fieldKind` (below) folds an array INDEX segment back to
// its containing array's name, so e.g. every `except[i]` deletion is one
// row, not one per index.
const ALLOWED: Record<string, Set<string>> = {
  "cmini/1": new Set([
    "tag:delete",
    "tag:empty string",
    "blame:delete",
    "blame:empty string",
    "link:delete",
    "link:empty string",
    "type:delete", // magic row's optional `type` (defaults to "raw" on lower())
    "type:empty string",
  ]),
  "spark/1": new Set([
    // Key.char is optional (23-geometry.md's duplicate-characters follow-up
    // -- absent means a free position); deleting or blanking it is always a
    // valid transform. Shares this "char" bucket with magic_keys[].default's
    // and chiral_keys[].same/opposite's OWN `char` sub-field
    // (24-spark-wire-review.md finding 6, round 2's resolution item F: the
    // SAME kind-tagged union) purely by fieldKind's naive last-segment
    // naming -- THOSE instances need the opposite verdict, handled by the
    // dedicated `isTaggedValueChar` skip below rather than here.
    "char:delete",
    "char:empty string",
    // chiral_keys[] needs only ONE of same/opposite -- 901-idioms sets both
    // -- but with same/opposite now nested tagged objects (never a bare
    // scalar leaf), the generic walker never generates a "delete the whole
    // same/opposite field" mutation to allow; that construct (one side
    // absent, the other a valid tagged value) is covered directly by
    // magic-aklgg-validation.test.ts's [LDB-F22] cases instead.
    "type:delete", // magic.rules[]' optional `type` (defaults to "raw")
    "type:empty string",
    "note:delete", // magic.rules[]' optional `note`
    "note:empty string",
  ]),
  "mana2/1": new Set([
    "fingers:empty string", // an empty layout.fingers row is a real state (zero keys that row) -- fromAkl produces one for a main row with no keys
    "thumbs:delete", // 1-2 items either way (schema minItems 0) -- shrinking is still a valid thumbs array
    "thumbs:empty string", // "" means no key on that hand (gust.jsonc's own ["", "space"]) -- a real vendored state, not a corruption
    "splitAngle:delete", // optional tilt angle
    "splitAngle:negative number", // a mirrored tilt is still a tilt -- no sign constraint, same reasoning as akl/1's stagger
    "rowOrColumnStagger:negative number", // 12 §2.5 checks stagger LENGTH against the layout's true height/width, never per-entry sign -- same reasoning as akl/1's own stagger
  ]),
};

// The last path segment names the field UNLESS it's an array index (a
// plain scalar array like `except`/`swap`/`stagger`, where the leaf IS the
// element) -- then the array's own name is what distinguishes e.g.
// `except[0]:delete` (allowed) from `swap[0]:delete` (refused, minItems).
function fieldKind(segs: string[]): string {
  const last = segs[segs.length - 1] ?? "";
  if (/^\d+$/.test(last)) return segs[segs.length - 2] ?? last;
  return last;
}

// -- duplicate-sibling: structural (01 §2.1 / 07 §5.1's semantic rules: no
// duplicate position across keys ∪ free, no duplicate magic inputs).
// Position containers are the same shape in both formats; magic inputs
// live at a different path per format (`magic[].inputs` for cmini/1,
// `magic.rules[].inputs` for akl/1's escape hatch). Walked in the same
// order each format's own dedup/collision finder uses, so "the second one"
// always names the entry both sides agree on.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function positionContainerPaths(payload: any): string[] {
  const out: string[] = [];
  for (const ch of Object.keys(payload.keys ?? {})) out.push(`/keys/${pointerSeg(ch)}`);
  (payload.free ?? []).forEach((_: unknown, i: number) => out.push(`/free/${i}`));
  return out;
}
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function magicInputsLeafPaths(payload: any): string[] {
  const magic = payload.magic;
  if (Array.isArray(magic)) return magic.map((_: unknown, i: number) => `/magic/${i}/inputs`);
  if (magic && Array.isArray(magic.rules)) return magic.rules.map((_: unknown, i: number) => `/magic/rules/${i}/inputs`);
  return [];
}

function segsOf(pointer: string): string[] {
  return pointer === "" ? [] : pointer.slice(1).split("/").map((s) => s.replace(/~1/g, "/").replace(/~0/g, "~"));
}

function duplicatePosition(payload: unknown, containerA: string, containerB: string): unknown {
  const clone = structuredClone(payload);
  const { parent: parentA, key: keyA } = navigateToParent(clone, segsOf(containerA));
  const posA = parentA[keyA as never];
  const { parent: parentB, key: keyB } = navigateToParent(clone, segsOf(containerB));
  parentB[keyB as never] = { ...parentB[keyB as never], row: posA.row, col: posA.col };
  return clone;
}

function duplicateMagicInputs(payload: unknown, inputsA: string, inputsB: string): unknown {
  const clone = structuredClone(payload);
  const { parent: parentA, key: keyA } = navigateToParent(clone, segsOf(inputsA));
  const value = parentA[keyA as never];
  const { parent: parentB, key: keyB } = navigateToParent(clone, segsOf(inputsB));
  parentB[keyB as never] = value;
  return clone;
}

describe("payload mutations", () => {
  for (const format of validatedShapes()) {
    describe(format.id, () => {
      const allowed = ALLOWED[format.id] ?? new Set<string>();

      for (const fixture of fixturesIn(format.fixturesDir)) {
        for (const leaf of walkLeaves(omitX(fixture.payload))) {
          const kind = fieldKind(leaf.segs);
          for (const mutation of mutationsFor(leaf)) {
            // `except[i]:delete` is genuinely per-INDEX, not per-fixture:
            // most entries an import adds are harmless "uncovered key"
            // omissions (removing them just re-admits a row nothing else
            // claims), but SOME are the collision guard itself (whirl's
            // `except: [..., "y"]` -- removing "y" reintroduces the exact
            // magic_collision it was added to avoid, verified by hand: 11
            // of whirl's 12 entries validate fine removed, one doesn't).
            // No uniform ALLOWED/refused verdict is honest here, so this
            // one case is skipped (visibly, not silently) in favour of
            // collisions.test.ts's dedicated "except removes the collision"
            // case, which tests the exact mechanism instead of guessing.
            if (kind === "except" && mutation === "delete") {
              it.skip(`[LDB-F1] ${fixture.stem} ${leaf.pointer} delete -- per-index, see collisions.test.ts`, () => {});
              continue;
            }
            // Same reasoning, one fixture: `908-held-stagger-mismatch`'s
            // whole POINT is a 4th `rowOrColumnStagger` entry disagreeing
            // with the 3rd (12 §2.5's held rule) -- deleting ANY one of
            // its four entries always leaves exactly 3, which trivially
            // satisfies "no entries past the 3rd to disagree" and
            // therefore validates. Not a uniform ALLOWED/refused verdict
            // for `rowOrColumnStagger:delete` (every OTHER mana2/1 fixture
            // has exactly the required minimum and correctly refuses a
            // deletion) -- skipped visibly for this one fixture, favour of
            // the dedicated stagger-mismatch assertion in mana2.test.ts.
            if (format.id === "mana2/1" && kind === "rowOrColumnStagger" && mutation === "delete" && fixture.stem.startsWith("908-")) {
              it.skip(`[LDB-F1] ${fixture.stem} ${leaf.pointer} delete -- deleting any one entry removes the mismatch itself, see mana2.test.ts`, () => {});
              continue;
            }
            // `combos[].inputs[j]` (mana2/1 only): `fieldKind` collapses
            // to plain "inputs" regardless of context, which would also
            // match `magic.rules[].inputs` (schema-required, minLength 2,
            // correctly refused) if added to ALLOWED by that name --
            // matched on the full leaf pointer instead so only the combos
            // path is affected. "every char must be a key" is vacuous
            // over a shrunk/emptied trigger string, so both mutations
            // still validate.
            const isCombosInputsElement =
              format.id === "mana2/1" &&
              kind === "inputs" &&
              leaf.pointer.startsWith("/combos/") &&
              (mutation === "delete" || mutation === "empty string"); // "wrong type" still correctly refused (schema requires a string)
            // `900-held-combos`'s combos reference the same row
            // `fingers:empty string` would otherwise be free to blank out
            // (both a general mana2/1 allowance AND this fixture's own
            // combos content, in tension only here) -- emptying the row
            // removes the combo's own referenced keys, correctly refused
            // by checkCombos. Fixture-specific, not a blanket verdict for
            // `fingers:empty string` (every other fixture has no combos to
            // collide with), so it is the ONE skip, not a change to the
            // shared ALLOWED set.
            const isEmptiedComboRow = kind === "fingers" && mutation === "empty string" && fixture.stem.startsWith("900-") && leaf.pointer === "/layout/fingers/0";
            if (isEmptiedComboRow) {
              it.skip(`[LDB-F1] ${fixture.stem} ${leaf.pointer} empty string -- combos on this fixture reference this row's own keys, see mana2.test.ts`, () => {});
              continue;
            }
            // spark/1's magic_keys[].default and chiral_keys[].same/opposite,
            // when they hold `{kind: "char", char: <c>}` (24-spark-wire-
            // review.md finding 6, round 2's resolution item F: the SAME
            // tagged union for both), share the generic "char" field-kind
            // bucket with Payload.keys[i].char (now optional -- a free
            // position) purely by fieldKind's naive last-segment naming: it
            // can't tell "this /default/char" or "this /same|opposite/char"
            // from "this /keys/N/char" apart. They need OPPOSITE verdicts --
            // deleting or blanking a KEY's char is a valid free position
            // (ALLOWED, above); deleting or blanking a tagged value's char
            // leaves it matching neither half of the tagged-union schema
            // (`{kind:"repeat"}` or `{kind:"char", char:<single character>}`),
            // correctly REFUSED. Asserted directly here (not a blanket
            // ALLOWED/deferred skip) since the verdict is uniform and known.
            const isTaggedValueChar = format.id === "spark/1" && kind === "char" && /\/(default|same|opposite)\/char$/.test(leaf.pointer);
            if (isTaggedValueChar && (mutation === "delete" || mutation === "empty string")) {
              it(`[LDB-F1] ${fixture.stem} ${leaf.pointer} ${mutation} -- a tagged char value with no char left is refused (shares the 'char' bucket with Key.char, which IS allowed)`, () => {
                const mutated = applyMutation(fixture.payload, leaf, mutation);
                const result = format.validate(mutated);
                expect(result.ok).toBe(false);
              });
              continue;
            }
            // A key's char is a free position (ALLOWED above) EXCEPT when it's
            // the only entry for a char the magic names as a magic/chiral key
            // or a swap trigger/member: taking it off leaves the rule set
            // naming a key the layout doesn't have, refused at the magic's
            // own path (LDB-F22, saltorbit/aklgg#322).
            if (format.id === "spark/1" && kind === "char" && /^\/keys\/\d+\/char$/.test(leaf.pointer) && (mutation === "delete" || mutation === "empty string")) {
              const payload = fixture.payload as { keys: { char?: string }[]; magic?: { magic_keys?: { key: string }[]; chiral_keys?: { key: string }[]; adaptive_swaps?: { trigger: string; swap: string[] }[] } };
              const char = payload.keys[Number(leaf.segs[1])]?.char;
              const m = payload.magic ?? {};
              const named = new Set([
                ...(m.magic_keys ?? []).map((mk) => mk.key),
                ...(m.chiral_keys ?? []).map((ck) => ck.key),
                ...(m.adaptive_swaps ?? []).flatMap((sw) => [sw.trigger, ...sw.swap]),
              ]);
              if (char !== undefined && named.has(char) && payload.keys.filter((k) => k.char === char).length === 1) {
                it(`[LDB-F1][LDB-F22] ${fixture.stem} ${leaf.pointer} ${mutation} -- ${JSON.stringify(char)} is named by the magic, so it can't leave the layout`, () => {
                  const result = format.validate(applyMutation(fixture.payload, leaf, mutation));
                  expect(result.ok).toBe(false);
                  if (!result.ok) expect(result.error.message).toMatch(/is not one of this layout's keys$/);
                });
                continue;
              }
            }
            const isAllowed = isCombosInputsElement || allowed.has(`${kind}:${mutation}`);
            it(`[LDB-F1] ${fixture.stem} ${leaf.pointer} ${mutation}${isAllowed ? " (allowed)" : ""}`, () => {
              const mutated = applyMutation(fixture.payload, leaf, mutation);
              const result = format.validate(mutated);
              if (isAllowed) {
                expect(result.ok).toBe(true);
              } else {
                expect(result.ok).toBe(false);
                if (!result.ok) {
                  const errPath = result.error.path;
                  const parent = toPointerOrRoot(leaf.segs.slice(0, -1));
                  expect([leaf.pointer, parent]).toContain(errPath);
                }
              }
            });
          }
        }

        const positions = positionContainerPaths(fixture.payload);
        if (positions.length >= 2) {
          it(`[LDB-F1] ${fixture.stem} duplicate position (${positions[0]} <- ${positions[1]})`, () => {
            const mutated = duplicatePosition(fixture.payload, positions[0]!, positions[1]!);
            const result = format.validate(mutated);
            expect(result.ok).toBe(false);
            if (!result.ok) expect(result.error.path).toBe(positions[1]);
          });
        }

        const magicInputs = magicInputsLeafPaths(fixture.payload);
        if (magicInputs.length >= 2) {
          if (format.id === "mana2/1") {
            // mana2's own load-time semantics: a later `magic.rules[]`
            // entry with the same `inputs` REPLACES the earlier one
            // (core/load_layout.go re-parses rules into a map keyed by
            // `inputs`) -- 12-implementation-phase5.md §2.5's explicit
            // override of every other format's "duplicate inputs refused"
            // default. `lower()` keeps the LAST occurrence.
            it(`[LDB-F1] ${fixture.stem} duplicate magic inputs (${magicInputs[0]} <- ${magicInputs[1]}) -- last wins, not refused`, () => {
              const mutated = duplicateMagicInputs(fixture.payload, magicInputs[0]!, magicInputs[1]!);
              const result = format.validate(mutated);
              expect(result.ok).toBe(true);
              const lowered = format.compile(mutated);
              const dup = lowered?.filter((r: { inputs: string }) => r.inputs === (fixture.payload as { magic?: { rules?: { inputs: string }[] } }).magic?.rules?.[0]?.inputs);
              expect(dup?.length).toBe(1); // exactly one surviving row for that `inputs`
            });
          } else {
            it(`[LDB-F4] ${fixture.stem} duplicate magic inputs (${magicInputs[0]} <- ${magicInputs[1]})`, () => {
              const mutated = duplicateMagicInputs(fixture.payload, magicInputs[0]!, magicInputs[1]!);
              const result = format.validate(mutated);
              expect(result.ok).toBe(false);
              // cmini/1 names the exact leaf; akl/1's magic_collision names
              // the colliding ROW (a magic_collision has no single "field"
              // to blame) -- both are acceptable, exact-or-parent.
              if (!result.ok) expect([magicInputs[1], parentPointer(magicInputs[1]!)]).toContain(result.error.path);
            });
          }
        }
      }
    });
  }
});

// [LDB-F27] spark/1's own real (non-schema) geometry rule (design/layout-
// db/23-geometry.md §4.4 minus everything a board word carried --
// 26-no-board.md deleted the board enum and the iso-row-2-width rule with
// the field): the thumb-row rule is a hand-written check in
// `validateGeometry` -- a dedicated refusing fixture rather than a row in
// the generic per-leaf matrix (it is a cross-field finger/row check, not a
// single-leaf mutation).
describe("[LDB-F27] spark/1's real (non-schema) geometry rules", () => {
  it("[LDB-F40] a `board` field is refused by the schema -- spark/1 has no board (design/layout-db/26-no-board.md)", () => {
    for (const board of ["ansi", "iso", "ortho", "colstag", { kind: "ansi" }]) {
      const result = spark1.validate({ keys: [], board });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error).toMatchObject({ error: "invalid_payload", path: "/" });
    }
    expect(spark1.validate({ keys: [] }).ok).toBe(true);
  });

  it("[LDB-F27] a thumb finger (LT/RT) on a finger row (0-2) is refused; row 3+ is fine", () => {
    const onFingerRow = spark1.validate({ keys: [{ char: "a", row: 2, col: 0, finger: "LT" }] });
    expect(onFingerRow.ok).toBe(false);
    const onThumbRow = spark1.validate({ keys: [{ char: "a", row: 3, col: 0, finger: "LT" }] });
    expect(onThumbRow.ok).toBe(true);
  });
});

// [LDB-F33] design/layout-db/23-geometry.md's duplicate-characters follow-
// up: a char any magic construct NAMES is refused once it appears on more
// than one `keys` entry (`magic_needs_unique_key`); a plain duplicate no
// magic construct names is unrestricted.
describe("[LDB-F33] magic-named chars must be unique among keys", () => {
  it("[LDB-F33] a magic key's own `key` char appearing on two entries is refused magic_needs_unique_key", () => {
    const payload = {
      keys: [
        { char: "z", row: 0, col: 0, finger: "LP" },
        { char: "z", row: 1, col: 0, finger: "LP" },
      ],
      magic: { magic_keys: [{ key: "z", default: { kind: "repeat" } }] },
    };
    const result = spark1.validate(payload);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.error).toBe("magic_needs_unique_key");
  });

  it("[LDB-F33] a plain duplicate char no magic construct names is unrestricted", () => {
    const payload = {
      keys: [
        { char: "z", row: 0, col: 0, finger: "LP" },
        { char: "z", row: 1, col: 0, finger: "LP" },
      ],
    };
    expect(spark1.validate(payload).ok).toBe(true);
  });
});
