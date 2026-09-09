#!/usr/bin/env node
// Writes db/formats/<name>/<major>/fixtures/NNN-<id>.json (the payload) and
// its derived goldens (.lowered.json; .<to>.json for every declared
// translation) from the frozen tests/fixtures/upstream-100 snapshot.
//
// Run ONCE per new fixture: `npm run goldens -- --write`. After that,
// `frozen.test.ts` (LDB-F6) fails the build on any change to these files --
// a bug found in the wild becomes a NEW fixture, never an edit to one that
// already merged. Without `--write` this prints what it would do and
// changes nothing.
//
// S3 adds akl/1: every cmini fixture's `.akl-1.json` golden (cmini1.to's
// generic loop below) is ALSO written as its own base fixture under
// formats/akl/1/fixtures/ (07 §5.3: "the akl side holds each translation as
// its own fixture"). The three hand-written akl-native fixtures
// (900-colstag, 901-idioms, 902-x) are authored directly as base files and
// need no code here -- `writeDerivedGoldens` picks up every base fixture it
// finds on disk, generated or hand-written alike, and fills in its
// `.lowered.json`/`.<to>.json` goldens generically.
//
// X2 adds mana2/1: its 74 base fixtures (every vendored mana2 layout except
// `d5.jsonc`, which uses an undocumented tap-hold/directional mini-language
// -- formats/mana2/1/README.md) are authored directly on disk (a one-time
// fixture-authoring step outside this script -- mana2's own jsonc.ts reader
// runs over vendor/mana2/data/layouts/*.jsonc, NOT this script, which only
// ever reads already-parsed formats/*/fixtures/*.json), so
// `writeDerivedGoldens(mana2_1)` below picks them up the same generic way
// and fills in their `.lowered.json`/`.akl-1.json` goldens. The REVERSE
// pair -- three akl/1 fixtures gaining a `.mana2-1.json` golden -- is NOT
// generic (mana2/1's own `to`/`from` only cover `akl/1`; there is no
// `akl1.to["mana2/1"]` to loop over), so it is written explicitly below,
// for exactly the three fixtures 12-implementation-phase5.md §1 X2 names
// (900-colstag, 901-idioms, one cmini-derived: 001-graphite).
//
// Format modules are self-contained (07 §5: they never import
// src/formats/registry.ts), so this script imports them directly with
// plain Node ESM resolution instead of going through the Worker-only
// registry -- registry.ts's *other* imports (src/core/*, extension-less,
// resolved by a bundler in tests/the Worker build) aren't resolvable here.
import fs from "node:fs";
import path from "node:path";
import url from "node:url";
import * as cmini1 from "../formats/cmini/1/index.ts";
import * as akl1 from "../formats/akl/1/index.ts";
import * as mana2_1 from "../formats/mana2/1/index.ts";

const SCRIPTS_DIR = path.dirname(url.fileURLToPath(import.meta.url));
const DB_ROOT = path.join(SCRIPTS_DIR, "..");
const WRITE = process.argv.includes("--write");

// 07 §5.3's named witnesses -- kept in the same order pick-fixtures.mjs
// selects them in, so NNN lines up with "the Nth witness", not with any
// upstream ordering.
const CMINI_NAMED = [
  "graphite",
  "opal",
  "auditor",
  "opal-dario",
  "whirl",
  "opal-e200",
  "crescent",
  "sanrie-cmini-test2",
  "adept",
  "test12222",
  "40kwh",
  "apt26",
  "haul",
  "abyss",
  "adnw",
  "00------higgs",
  "io",
  "02_we've_been_in_this_room_too_long",
];

const RECORD_FIELDS = new Set(["name", "user", "likes", "created_at", "modified_at"]);

function cminiPayloadFrom(detail) {
  const payload = {};
  for (const [k, v] of Object.entries(detail)) {
    if (!RECORD_FIELDS.has(k)) payload[k] = v;
  }
  return payload;
}

function pad3(n) {
  return String(n).padStart(3, "0");
}

function writeJson(file, data) {
  const text = JSON.stringify(data, null, 2) + "\n";
  if (!WRITE) {
    console.log(`[dry run] would write ${path.relative(DB_ROOT, file)} (${text.length} bytes)`);
    return;
  }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
  console.log(`wrote ${path.relative(DB_ROOT, file)}`);
}

// Base fixture files are `NNN-<id>.json`; goldens are
// `NNN-<id>.lowered.json` / `NNN-<id>.<to-format>.json` -- one extra "."
// segment distinguishes them (same predicate tests/formats/goldens.test.ts
// uses).
function isBaseFixtureFile(filename) {
  if (!filename.endsWith(".json")) return false;
  return !filename.slice(0, -".json".length).includes(".");
}

function fixturesDirFor(mod) {
  const [name, major] = mod.id.split("/");
  return path.join(DB_ROOT, "formats", name, major, "fixtures");
}

// For every base fixture already on disk (generated above, or hand-written
// directly) write its `.lowered.json` and every declared `.<to>.json`
// golden. Generic over the format module, so a hand-authored fixture (900+)
// needs no special-casing here.
function writeDerivedGoldens(mod) {
  const dir = fixturesDirFor(mod);
  if (!fs.existsSync(dir)) return;
  for (const file of fs.readdirSync(dir).filter(isBaseFixtureFile).sort()) {
    const stem = file.slice(0, -".json".length);
    const payload = JSON.parse(fs.readFileSync(path.join(dir, file), "utf8"));
    const check = mod.validate(payload);
    if (!check.ok) {
      throw new Error(`${mod.id} fixture '${stem}' fails its own validate(): ${JSON.stringify(check.error)}`);
    }

    const lowered = mod.lower(payload);
    if (lowered !== null) writeJson(path.join(dir, `${stem}.lowered.json`), lowered);

    for (const target of Object.keys(mod.to)) {
      const translated = mod.to[target](payload);
      writeJson(path.join(dir, `${stem}.${target.replace("/", "-")}.json`), translated);
    }
  }
}

// The three akl/1 fixtures 12-implementation-phase5.md §1 X2 names for a
// `.mana2-1.json` golden: `900-colstag` and `901-idioms` (hand-authored
// akl-native, exercising board.kind: colstag and the full magic idiom set),
// plus one cmini-derived fixture, `001-graphite` (an ortho board with
// rows of DIFFERENT lengths -- 12/11/10 keys -- the best real exercise of
// mana2/1's column arithmetic among the cmini-derived akl fixtures).
// mana2/1 has no `akl1.to["mana2/1"]` counterpart to loop over generically
// (only mana2_1's OWN `to`/`from` cover the pair) -- this stays a short,
// explicit list rather than pretending to be generic.
const AKL_TO_MANA2_GOLDEN_STEMS = ["900-colstag", "901-idioms", "001-graphite"];

function writeAklToMana2Goldens() {
  const dir = fixturesDirFor(akl1);
  for (const stem of AKL_TO_MANA2_GOLDEN_STEMS) {
    const file = path.join(dir, `${stem}.json`);
    const payload = JSON.parse(fs.readFileSync(file, "utf8"));
    const check = akl1.validate(payload);
    if (!check.ok) throw new Error(`akl/1 fixture '${stem}' fails its own validate(): ${JSON.stringify(check.error)}`);
    const translated = mana2_1.from["akl/1"](payload);
    const mana2Check = mana2_1.validate(translated);
    if (!mana2Check.ok) throw new Error(`akl/1 fixture '${stem}' -> mana2/1 fails mana2/1's own validate(): ${JSON.stringify(mana2Check.error)}`);
    writeJson(path.join(dir, `${stem}.mana2-1.json`), translated);
  }
}

function main() {
  const snapshotDir = path.join(DB_ROOT, "tests", "fixtures", "upstream-100");
  const list = JSON.parse(fs.readFileSync(path.join(snapshotDir, "list.json"), "utf8")).layouts;
  const full = JSON.parse(fs.readFileSync(path.join(snapshotDir, "full.json"), "utf8")).layouts;
  const nameById = new Map(list.map((l) => [l.id, l.name]));
  const byName = new Map(full.map((l) => [l.name, l]));

  const cminiFixturesDir = fixturesDirFor(cmini1);
  const aklFixturesDir = fixturesDirFor(akl1);

  CMINI_NAMED.forEach((id, i) => {
    const name = nameById.get(id);
    if (!name) throw new Error(`'${id}' is not in tests/fixtures/upstream-100/list.json -- run pick-fixtures first`);
    const detail = byName.get(name);
    if (!detail) throw new Error(`no ?full=1 detail for '${id}' (name '${name}')`);

    const payload = cminiPayloadFrom(detail);
    const check = cmini1.validate(payload);
    if (!check.ok) {
      throw new Error(`'${id}': generated payload fails cmini/1's own validate(): ${JSON.stringify(check.error)}`);
    }

    const base = `${pad3(i + 1)}-${id}`;
    writeJson(path.join(cminiFixturesDir, `${base}.json`), payload);

    // The akl side holds the SAME translation as its own base fixture (07
    // §5.3), not just a golden under cmini/1/ -- so its own goldens.test.ts
    // rows (validate, lower, to["cmini/1"]) exist for it too.
    const akl = cmini1.to["akl/1"] ? cmini1.to["akl/1"](payload) : undefined;
    if (akl !== undefined) writeJson(path.join(aklFixturesDir, `${base}.json`), akl);
  });

  // Derived goldens for every base fixture found on disk -- the 18 above
  // AND the hand-written akl-native ones (900-colstag, 901-idioms, 902-x),
  // which must already exist as base files before this runs; and mana2/1's
  // own 74 base fixtures (authored directly under formats/mana2/1/fixtures/
  // from vendor/mana2/data/layouts/*.jsonc, outside this script -- see the
  // header comment).
  writeDerivedGoldens(cmini1);
  writeDerivedGoldens(akl1);
  writeDerivedGoldens(mana2_1);
  writeAklToMana2Goldens();

  if (!WRITE) console.log("\n(dry run -- pass --write to actually write these files)");
}

main();
