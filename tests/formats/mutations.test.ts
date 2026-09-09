// [LDB-F1] Generated matrix: for every fixture, for every leaf (scalar)
// path in the payload, each applicable mutation in {delete, wrong type,
// empty string, negative number} is refused by `validate()` with `path`
// pointing at that leaf or its immediate parent -- except mutations that
// are enumerated below in ALLOWED because they produce another valid
// payload (07 §6 S2: "no blanket skips"; 07 §6 S3: ALLOWED is now
// per-format so cmini/1 and akl/1 can't leak allowances into each other).
// Duplicate-sibling mutations (positions, magic inputs) are structural,
// generated once per fixture alongside the per-leaf matrix.
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { list as listFormats } from "../../src/formats/registry";

const FORMATS_DIR = path.resolve(import.meta.dirname, "..", "..", "formats");

function isBaseFixtureFile(filename: string): boolean {
  if (!filename.endsWith(".json")) return false;
  return !filename.slice(0, -".json".length).includes(".");
}

interface Fixture {
  stem: string;
  payload: unknown;
}

function fixturesFor(formatId: string): Fixture[] {
  const [name, major] = formatId.split("/") as [string, string];
  const dir = path.join(FORMATS_DIR, name, major, "fixtures");
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter(isBaseFixtureFile)
    .sort()
    .map((file) => ({
      stem: file.slice(0, -".json".length),
      payload: JSON.parse(fs.readFileSync(path.join(dir, file), "utf8")) as unknown,
    }));
}

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
  "akl/1": new Set([
    "default:delete", // magic_keys[].default (falls back to "none"); can only REMOVE rows, never collide
    "cmini:delete", // board.cmini (derived when absent, 01 §6.2)
    "same:delete", // chiral_keys[] needs only ONE of same/opposite -- 901-idioms sets both
    "opposite:delete",
    "type:delete", // magic.rules[]' optional `type` (defaults to "raw")
    "type:empty string",
    "note:delete", // magic.rules[]' optional `note`
    "note:empty string",
    "stagger:negative number", // 01 §2.1 only constrains stagger's LENGTH, not its per-entry sign
  ]),
  "mana2/1": new Set([
    "fingers:empty string", // an empty layout.fingers row is a real state (zero keys that row) -- fromAkl produces one for a main row with no keys
    "thumbs:delete", // 1-2 items either way (schema minItems 1) -- shrinking to 1 is still a valid thumbs array
    "thumbs:empty string", // "" means no key on that hand (gust.jsonc's own ["", "space"]) -- a real vendored state, not a corruption
    "splitAngle:delete", // optional tilt angle
    "splitAngle:negative number", // a mirrored tilt is still a tilt -- no sign constraint, same reasoning as akl/1's stagger
    "rowOrColumnStagger:delete", // this format holds what mana2 holds (mana2's own runtime-only length check against row/column count is out of scope here, same "representation, not full engine validity" stance cmini/1 takes)
    "rowOrColumnStagger:negative number", // same reasoning as akl/1's stagger: length is never checked here, sign never was either
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
  for (const format of listFormats()) {
    describe(format.id, () => {
      const allowed = ALLOWED[format.id] ?? new Set<string>();

      for (const fixture of fixturesFor(format.id)) {
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
            const isAllowed = allowed.has(`${kind}:${mutation}`);
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
    });
  }
});
