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
// S3 adds akl/1 (renamed spark/1 by 20-spark.md S1): every cmini fixture's
// `.spark-1.json` golden (cmini1.to's generic loop below) is ALSO written
// as its own base fixture under formats/spark/1/fixtures/ (07 §5.3: "the
// spark side holds each translation as its own fixture"). The two
// hand-written spark-native fixtures (900-colstag, 901-idioms) are
// authored directly as base files and need no code here --
// `writeDerivedGoldens` picks up every base fixture it finds on disk,
// generated or hand-written alike, and fills in its `.lowered.json`/
// `.<to>.json` goldens generically. (A third, 902-x, existed only to
// exercise spark/1's now-deleted free-form `x` field -- 21-formats.md
// D10 removed it along with the field.)
//
// X2 adds mana2/1: its 13 named base fixtures (formats/mana2/1/fixtures/)
// and hand-written 900+ ones are authored directly on disk (the named 13
// via `scripts/pick-mana2-fixtures.mjs`, a one-time fixture-authoring step
// outside this script; the 900+ ones by hand) -- `writeDerivedGoldens
// (mana2_1)` below picks them up the same generic way as every other
// format, but mana2/1's own registry `to` map is `{}` (nothing is ever
// stored as mana2/1, so there is nothing to dispatch through) -- it only
// ever fills in `.lowered.json` for these. mana2.test.ts's own dedicated
// "goldens (LDB-F7)" block covers `toSpark`/`fromSpark` directly instead
// (see that file's header comment) -- there is no `.cmini-1.json` golden
// for any format any more (21-formats.md D5 deleted `toCmini` entirely).
//
// Format modules are self-contained (07 §5: they never import
// src/formats/registry.ts), so this script imports them directly with
// plain Node ESM resolution instead of going through the Worker-only
// registry -- registry.ts's *other* imports (src/core/*, extension-less,
// resolved by a bundler in tests/the Worker build) aren't resolvable here.
import fs from "node:fs";
import path from "node:path";
import url from "node:url";
import * as cmini1 from "../formats/adapters/cmini/index.ts";
import * as spark1 from "../formats/spark/1/index.ts";
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
// uses). LDB-F39 (2026-09-13): `formats/spark/1/fixtures/parity-vectors
// .json` is a LIST of 300 golden vectors (`scripts/
// gen-spark-parity-vectors.mjs`), not a single base Payload -- excluded
// here by name, the same way `tests/formats/validated-shapes.ts` excludes
// it from its own copy of this predicate.
function isBaseFixtureFile(filename) {
  if (!filename.endsWith(".json")) return false;
  if (filename === "parity-vectors.json") return false;
  return !filename.slice(0, -".json".length).includes(".");
}

// The cmini adapter isn't versioned like a registered format (it moved to
// `formats/adapters/cmini/` -- 20-spark.md S1, decision 2) -- everything
// else's fixtures dir is still `formats/<name>/<major>/fixtures`.
function fixturesDirFor(mod) {
  if (mod === cmini1) return path.join(DB_ROOT, "formats", "adapters", "cmini", "fixtures");
  const [name, major] = mod.id.split("/");
  return path.join(DB_ROOT, "formats", name, major, "fixtures");
}

// Each module's own compile step, post-20-spark.md-S1: `lower` left the
// `FormatModule` contract (registry.ts's `role` replaces it), so there is
// no single generic name to call anymore -- spark renamed its own to
// `compileMagic`, the cmini adapter's to `rows`, mana2/1 kept `lower`.
function compileFn(mod) {
  if (mod === spark1) return spark1.compileMagic;
  if (mod === cmini1) return cmini1.rows;
  return mod.lower;
}

// For every base fixture already on disk (generated above, or hand-written
// directly) write its `.lowered.json` and every declared `.<to>.json`
// golden. Generic over the format module, so a hand-authored fixture (900+)
// needs no special-casing here.
function writeDerivedGoldens(mod) {
  const dir = fixturesDirFor(mod);
  if (!fs.existsSync(dir)) return;
  const lower = compileFn(mod);
  for (const file of fs.readdirSync(dir).filter(isBaseFixtureFile).sort()) {
    const stem = file.slice(0, -".json".length);
    const payload = JSON.parse(fs.readFileSync(path.join(dir, file), "utf8"));
    const check = mod.validate(payload);
    if (!check.ok) {
      throw new Error(`${mod.id} fixture '${stem}' fails its own validate(): ${JSON.stringify(check.error)}`);
    }

    const lowered = lower(payload);
    if (lowered !== null) writeJson(path.join(dir, `${stem}.lowered.json`), lowered);

    for (const target of Object.keys(mod.to)) {
      const translated = mod.to[target](payload);
      writeJson(path.join(dir, `${stem}.${target.replace("/", "-")}.json`), translated);
    }
  }
}

function main() {
  const snapshotDir = path.join(DB_ROOT, "tests", "fixtures", "upstream-100");
  const list = JSON.parse(fs.readFileSync(path.join(snapshotDir, "list.json"), "utf8")).layouts;
  const full = JSON.parse(fs.readFileSync(path.join(snapshotDir, "full.json"), "utf8")).layouts;
  const nameById = new Map(list.map((l) => [l.id, l.name]));
  const byName = new Map(full.map((l) => [l.name, l]));

  const cminiFixturesDir = fixturesDirFor(cmini1);
  const sparkFixturesDir = fixturesDirFor(spark1);

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

    // The spark side holds the SAME translation as its own base fixture
    // (07 §5.3), not just a golden under adapters/cmini/ -- so its own
    // goldens.test.ts rows (validate, compileMagic) exist for it too.
    // design/layout-db/23-geometry.md §4.4-3 (LDB-F27): 'test12222' is the
    // one known upstream-100 layout with a thumb-labelled key physically on
    // a finger row (0-2) -- fromCmini preserves the (row, col, finger)
    // multiset exactly (LDB-F23) rather than inventing a fix, so its own
    // spark projection fails spark/1's own validate() by design. Skipped
    // here (not written as a spark/1 base fixture at all -- every
    // db/tests/formats/*.test.ts loop that globs formats/spark/1/fixtures/
    // therefore naturally never sees it); the cmini/1-side golden
    // (adapters/cmini/fixtures/010-test12222.spark-1.json, written by
    // writeDerivedGoldens(cmini1) below) is unaffected and still exists,
    // still exercised by mf9-fromcmini.test.ts's multiset check and
    // mana2.test.ts's dedicated "6 LT-labelled keys is held" case.
    const spark = cmini1.to["spark/1"] ? cmini1.to["spark/1"](payload) : undefined;
    if (spark !== undefined) {
      const sparkCheck = spark1.validate(spark);
      if (sparkCheck.ok) {
        writeJson(path.join(sparkFixturesDir, `${base}.json`), spark);
      } else {
        console.log(`skip formats/spark/1/fixtures/${base}.json -- fails spark/1's own validate() (${JSON.stringify(sparkCheck.error)})`);
      }
    }
  });

  // Derived goldens for every base fixture found on disk -- the 18 above
  // AND the hand-written spark-native ones (900-colstag, 901-idioms),
  // which must already exist as base files before this runs; and
  // mana2/1's own named + hand-written base fixtures (authored outside
  // this script -- see the header comment). Order matters only for
  // `mana2_1` needing `spark1`'s reciprocal `to["mana2/1"]` to already be
  // wired (it's a static import, so it always is) -- otherwise these three
  // are independent.
  writeDerivedGoldens(cmini1);
  writeDerivedGoldens(spark1);
  writeDerivedGoldens(mana2_1);

  if (!WRITE) console.log("\n(dry run -- pass --write to actually write these files)");
}

main();
