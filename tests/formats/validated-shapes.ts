// Shared shape list for every "generated per format x fixture" test in
// this directory (mutations.test.ts, goldens.test.ts, edits.test.ts).
// Before 20-spark.md S1, all three of these files looped over
// `listFormats()` and got cmini/1's fixtures for free; S1 moved cmini out
// of the registry into an unregistered adapter (db/formats/adapters/
// cmini/), so a bare `listFormats()` loop silently stopped covering it --
// losing LDB-F1's mutation matrix, LDB-E1's edit purity, and the F2/F7
// golden checks for every cmini fixture. `validatedShapes()` is
// `listFormats()`'s two registered formats PLUS the cmini adapter, given
// the same shape, so those three generated suites keep exactly the
// coverage they had before the rename -- generated from disk + this list,
// never hand-picked back in.
import fs from "node:fs";
import path from "node:path";
import { list as listFormats, get as getFormat, type FormatModule, type ValidationResult, type FormatEdits } from "../../src/formats/registry";
import * as cminiAdapter from "../../formats/adapters/cmini/index.ts";
import { compileMagic as sparkCompileMagic } from "../../formats/spark/1/index.ts";
import { lower as mana2Lower } from "../../formats/mana2/1/index.ts";

const FORMATS_DIR = path.resolve(import.meta.dirname, "..", "..", "formats");

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- a payload's exact shape is the format's own business (registry.ts's own `Payload = any`)
type AnyFn = (p: any) => any;

export interface ValidatedShape {
  id: string;
  validate(p: unknown): ValidationResult;
  hasMagic: AnyFn;
  to: Record<string, AnyFn>;
  from: Record<string, AnyFn>;
  edits?: FormatEdits;
  // Each shape's own compile step: `lower` left the `FormatModule`
  // contract entirely (S1) -- spark's is `compileMagic`, mana2's kept
  // `lower`, the cmini adapter's is `rows` (also renamed from `lower`).
  compile: AnyFn;
  fixturesDir: string; // absolute path
}

// `lower`'s per-id dispatch (S1: no single name every shape answers to
// anymore) -- shared here so goldens.test.ts doesn't need its own copy.
const COMPILE: Record<string, AnyFn> = {
  "spark/1": sparkCompileMagic,
  "mana2/1": mana2Lower,
  "cmini/1": cminiAdapter.rows,
};

function fixturesDirFor(id: string): string {
  if (id === "cmini/1") return path.join(FORMATS_DIR, "adapters", "cmini", "fixtures");
  const [name, major] = id.split("/") as [string, string];
  return path.join(FORMATS_DIR, name, major, "fixtures");
}

function fromFormatModule(f: FormatModule): ValidatedShape {
  return {
    id: f.id,
    validate: f.validate,
    hasMagic: f.hasMagic,
    to: f.to,
    from: f.from,
    edits: f.edits,
    compile: COMPILE[f.id]!,
    fixturesDir: fixturesDirFor(f.id),
  };
}

// 21-formats.md D5: the adapter's own `from`/`edits` are gone along with
// `toCmini` (there is no more spark -> cmini direction, and no more
// cmini/1 record to PATCH) -- `from: {}` and no `edits` reflect that
// exactly, not a gap in this shared shape list.
const CMINI_ADAPTER_SHAPE: ValidatedShape = {
  id: "cmini/1",
  validate: cminiAdapter.validate,
  hasMagic: cminiAdapter.hasMagic,
  to: cminiAdapter.to,
  from: {},
  compile: cminiAdapter.rows,
  fixturesDir: fixturesDirFor("cmini/1"),
};

// The registered formats (`listFormats()`) plus the cmini adapter --
// exactly what `listFormats()` alone answered before S1 unregistered it.
export function validatedShapes(): ValidatedShape[] {
  return [...listFormats().map(fromFormatModule), CMINI_ADAPTER_SHAPE];
}

// Re-exported so callers that need to validate a translation TARGET (not
// just the shapes being generated over) don't need a second import of the
// Worker registry wrapper -- goldens.test.ts's "output validates there"
// check is the one case (a `to[target]` target is always a REGISTERED
// format; the cmini adapter is never a `to[...]` target of anything).
export { getFormat };

// LDB-F39 (2026-09-13): `formats/spark/1/fixtures/parity-vectors.json` is a
// LIST of 300 `{keys, magic, expected}` golden vectors (`scripts/
// gen-spark-parity-vectors.mjs`), not a single base Payload -- it lives
// alongside spark/1's real base fixtures deliberately (it IS a spark/1
// fixture, in the sense that it's frozen the same way and lives under the
// same major, LDB-F6), but every "generated per format x fixture" suite in
// this directory (mutations/goldens/edits) would otherwise pick it up as if
// it were one, mutate/lower/golden-check fields that don't exist on it, and
// fail in bulk. Named out here, the one place that would otherwise matter.
const NOT_A_BASE_FIXTURE = new Set(["parity-vectors.json"]);

export function isBaseFixtureFile(filename: string): boolean {
  if (!filename.endsWith(".json")) return false;
  if (NOT_A_BASE_FIXTURE.has(filename)) return false;
  return !filename.slice(0, -".json".length).includes(".");
}

export interface Fixture {
  stem: string; // "NNN-<id>", no extension
  dir: string;
  payload: unknown;
}

export function fixturesIn(dir: string): Fixture[] {
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter(isBaseFixtureFile)
    .sort()
    .map((file) => ({
      stem: file.slice(0, -".json".length),
      dir,
      payload: JSON.parse(fs.readFileSync(path.join(dir, file), "utf8")) as unknown,
    }));
}
