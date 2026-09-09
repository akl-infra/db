// [LDB-F1] Generated matrix: for every fixture, for every leaf (scalar)
// path in the payload, each applicable mutation in {delete, wrong type,
// empty string, negative number} is refused by `validate()` with `path`
// pointing at that leaf or its immediate parent -- except mutations that
// are enumerated below in ALLOWED because they produce another valid
// payload (07 §6 S2: "no blanket skips"). Duplicate-sibling mutations
// (positions, magic inputs) are structural, generated once per fixture
// alongside the per-leaf matrix.
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
// cmini/1's validate() reports the root as "/" (its instancePath "" is
// mapped there, see formats/cmini/1/index.ts) -- match that convention.
function toPointerOrRoot(segs: string[]): string {
  const p = toPointer(segs);
  return p === "" ? "/" : p;
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
// -- keyed by "<last path segment>:<mutation>". Every field/mutation pair
// not in this set is expected to be REFUSED; a pair that turns out valid
// but isn't listed here fails the test loudly rather than silently passing
// (07 §6 S2's "no blanket skips").
const ALLOWED = new Set<string>([
  "tag:delete",
  "tag:empty string",
  "blame:delete",
  "blame:empty string",
  "link:delete",
  "link:empty string",
  "type:delete", // magic row's optional `type` (defaults to "raw" on lower())
  "type:empty string",
]);

function fieldKind(segs: string[]): string {
  return segs[segs.length - 1] ?? "";
}

// -- duplicate-sibling: structural, cmini/1-specific (07 §5.1's own two
// semantic rules: no duplicate position across keys ∪ free, no duplicate
// magic[].inputs). Walked in the same order validate()'s own dedup finder
// uses, so "the second one" always names the same entry both sides agree on.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function positionContainerPaths(payload: any): string[] {
  const out: string[] = [];
  for (const ch of Object.keys(payload.keys ?? {})) out.push(`/keys/${pointerSeg(ch)}`);
  (payload.free ?? []).forEach((_: unknown, i: number) => out.push(`/free/${i}`));
  return out;
}
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function magicInputsLeafPaths(payload: any): string[] {
  return (payload.magic ?? []).map((_: unknown, i: number) => `/magic/${i}/inputs`);
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
      for (const fixture of fixturesFor(format.id)) {
        for (const leaf of walkLeaves(fixture.payload)) {
          const kind = fieldKind(leaf.segs);
          for (const mutation of mutationsFor(leaf)) {
            const allowed = ALLOWED.has(`${kind}:${mutation}`);
            it(`[LDB-F1] ${fixture.stem} ${leaf.pointer} ${mutation}${allowed ? " (allowed)" : ""}`, () => {
              const mutated = applyMutation(fixture.payload, leaf, mutation);
              const result = format.validate(mutated);
              if (allowed) {
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
          it(`[LDB-F1] ${fixture.stem} duplicate magic inputs (${magicInputs[0]} <- ${magicInputs[1]})`, () => {
            const mutated = duplicateMagicInputs(fixture.payload, magicInputs[0]!, magicInputs[1]!);
            const result = format.validate(mutated);
            expect(result.ok).toBe(false);
            if (!result.ok) expect(result.error.path).toBe(magicInputs[1]);
          });
        }
      }
    });
  }
});
