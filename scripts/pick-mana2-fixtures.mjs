#!/usr/bin/env node
// Reads vendor/mana2/data/layouts/*.jsonc from a path given ON THE COMMAND
// LINE (the submodule is not checked out in a worktree, 12-implementation-
// phase5.md §0.5) and writes, via this format's own `parseJsonc`:
//
//   1. tests/fixtures/mana2-vendored/{<name>.json x 75, SOURCE} -- every
//      vendored layout, parsed, verbatim. `SOURCE` records the submodule
//      commit the snapshot was taken from (the vendored `.git`'s detached
//      HEAD). This is the envelope test's own input (mana2.test.ts: "all
//      75 mana2-vendored/*.json validate").
//   2. formats/mana2/1/fixtures/NNN-<name>.json -- 13 named witnesses
//      (X2's own list, minus `d5`: see the note below), one per row of
//      12 §0.5's table.
//
// Run: `node scripts/pick-mana2-fixtures.mjs /path/to/vendor/mana2` (or
// `--write` is implicit; this script is idempotent and safe to re-run --
// it always regenerates tests/fixtures/mana2-vendored/ in full, but the
// 13 named `formats/mana2/1/fixtures/*.json` base files are LDB-F6-frozen
// once merged, same as every other format's fixtures -- re-running this
// after that point would only matter if the vendored content itself
// changed, which `frozen.test.ts` would then catch).
//
// `d5.jsonc` is deliberately NOT one of the 13 named fixtures: verified by
// hand against core/load_layout.go (README.md has the full trace), it
// contains a duplicate plain "y" token on row 0 (outside any tap-hold
// group) that the loader's own `addKeyToLayout` refuses with "Duplicate
// keys are not allowed..." BEFORE either of its two tap-hold cells would
// ever matter for translation. It is still written to
// tests/fixtures/mana2-vendored/d5.json (the envelope test asserts it
// parses there and that `validate()` refuses it, naming the duplicate) --
// it is simply not a "this validates and translates" named witness, since
// it doesn't validate at all. Genuine `held` cases (tap-hold, directional,
// >5 thumb keys, non-empty combos, mismatched rowstag stagger padding) are
// demonstrated by hand-written fixtures at 900+ instead (README.md).
import fs from "node:fs";
import path from "node:path";
import { parseJsonc } from "../formats/mana2/1/jsonc.ts";
import * as mana2_1 from "../formats/mana2/1/index.ts";

const DB_ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const VENDORED_OUT = path.join(DB_ROOT, "tests", "fixtures", "mana2-vendored");
const NAMED_OUT = path.join(DB_ROOT, "formats", "mana2", "1", "fixtures");

const NAMED = [
  ["001", "hours"],
  ["002", "graphite"],
  ["003", "stand_iso"],
  ["004", "whirl"],
  ["005", "bunya"],
  ["006", "chantries"],
  ["007", "vigil"],
  ["008", "cyclone"],
  ["009", "nystyc"],
  ["010", "lucens_de"],
  ["011", "opal"],
  ["012", "sturdy"],
  ["013", "sturdy_ortho"],
];

function findVendorDir(argPath) {
  if (argPath && fs.existsSync(path.join(argPath, "data", "layouts"))) return path.join(argPath, "data", "layouts");
  if (argPath && fs.existsSync(path.join(argPath, "layouts"))) return argPath;
  throw new Error(`No vendor/mana2/data/layouts found under ${argPath} -- pass the path to a checkout of the mana2 repo (or its vendor/mana2 submodule dir)`);
}

function findSourceCommit(vendorRoot) {
  // vendorRoot is .../vendor/mana2/data/layouts; the repo root is two dirs up.
  const repoRoot = path.resolve(vendorRoot, "..", "..");
  const gitFile = path.join(repoRoot, ".git");
  try {
    const stat = fs.statSync(gitFile);
    if (stat.isDirectory()) {
      return fs.readFileSync(path.join(gitFile, "HEAD"), "utf8").trim();
    }
    // a submodule: ".git" is a file with "gitdir: <relative path>"
    const gitdirLine = fs.readFileSync(gitFile, "utf8").trim();
    const rel = gitdirLine.replace(/^gitdir:\s*/, "");
    const gitdir = path.resolve(repoRoot, rel);
    return fs.readFileSync(path.join(gitdir, "HEAD"), "utf8").trim();
  } catch {
    return "UNKNOWN (could not read .git HEAD -- pass a real checkout path)";
  }
}

function main() {
  const argPath = process.argv[2];
  if (!argPath) {
    console.error("usage: node scripts/pick-mana2-fixtures.mjs /path/to/a/checkout/containing/vendor/mana2");
    process.exit(1);
  }
  const vendorDir = findVendorDir(path.resolve(argPath));
  const source = findSourceCommit(vendorDir);

  fs.mkdirSync(VENDORED_OUT, { recursive: true });
  fs.mkdirSync(NAMED_OUT, { recursive: true });

  const files = fs.readdirSync(vendorDir).filter((f) => f.endsWith(".jsonc")).sort();
  let count = 0;
  for (const file of files) {
    const name = file.slice(0, -".jsonc".length);
    const raw = fs.readFileSync(path.join(vendorDir, file), "utf8");
    const payload = parseJsonc(raw);
    fs.writeFileSync(path.join(VENDORED_OUT, `${name}.json`), JSON.stringify(payload, null, 2) + "\n");
    count++;
  }
  fs.writeFileSync(path.join(VENDORED_OUT, "SOURCE"), `${source}\n`);
  console.log(`wrote ${count} layouts to ${path.relative(DB_ROOT, VENDORED_OUT)}/ (SOURCE=${source})`);

  for (const [num, name] of NAMED) {
    const file = `${name}.jsonc`;
    if (!files.includes(file)) throw new Error(`named fixture '${name}' not found in ${vendorDir}`);
    const raw = fs.readFileSync(path.join(vendorDir, file), "utf8");
    const payload = parseJsonc(raw);
    const check = mana2_1.validate(payload);
    if (!check.ok) throw new Error(`named fixture '${name}' fails mana2/1's own validate(): ${JSON.stringify(check.error)}`);
    const dest = path.join(NAMED_OUT, `${num}-${name}.json`);
    fs.writeFileSync(dest, JSON.stringify(payload, null, 2) + "\n");
    console.log(`wrote ${path.relative(DB_ROOT, dest)}`);
    // The raw .jsonc text too (tests/formats/jsonc.test.ts's own "parses
    // to its committed .json" case, which needs a committed copy to run
    // against in a worktree that has no vendor/mana2 submodule checked
    // out at all -- 12-implementation-phase5.md §0.5).
    const rawDest = path.join(NAMED_OUT, `${num}-${name}.jsonc`);
    fs.writeFileSync(rawDest, raw);
  }
}

main();
