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
// Format modules are self-contained (07 §5: they never import
// src/formats/registry.ts), so this script imports them directly with
// plain Node ESM resolution instead of going through the Worker-only
// registry -- registry.ts's *other* imports (src/core/*, extension-less,
// resolved by a bundler in tests/the Worker build) aren't resolvable here.
import fs from "node:fs";
import path from "node:path";
import url from "node:url";
import * as cmini1 from "../formats/cmini/1/index.ts";

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

function main() {
  const snapshotDir = path.join(DB_ROOT, "tests", "fixtures", "upstream-100");
  const list = JSON.parse(fs.readFileSync(path.join(snapshotDir, "list.json"), "utf8")).layouts;
  const full = JSON.parse(fs.readFileSync(path.join(snapshotDir, "full.json"), "utf8")).layouts;
  const nameById = new Map(list.map((l) => [l.id, l.name]));
  const byName = new Map(full.map((l) => [l.name, l]));

  const [, major] = cmini1.id.split("/");
  const fixturesDir = path.join(DB_ROOT, "formats", "cmini", major, "fixtures");

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
    writeJson(path.join(fixturesDir, `${base}.json`), payload);

    const lowered = cmini1.lower(payload);
    writeJson(path.join(fixturesDir, `${base}.lowered.json`), lowered);

    // S2's cmini/1 has no `to[...]` yet (S3 fills it in) -- nothing else to
    // write. Kept as a loop so S3's akl/1 addition needs no change here.
    for (const target of Object.keys(cmini1.to)) {
      const translated = cmini1.to[target](payload);
      writeJson(path.join(fixturesDir, `${base}.${target.replace("/", "-")}.json`), translated);
    }
  });

  if (!WRITE) console.log("\n(dry run -- pass --write to actually write these files)");
}

main();
