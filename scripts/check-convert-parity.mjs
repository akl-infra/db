#!/usr/bin/env node
// LDB-F12: "the DB's mana2 grid is the site's mana2 grid -- the 'integrate
// via the real tool' bar." Runs the SITE's own wasm engine
// (bridgecore.ConvertLayout, exported as `swapengine.convertLayout`, the
// same surface tools/swapengine/smoke.js exercises) over every cmini/1
// fixture and records `tests/fixtures/mana2-convert/<id>.json` -- the
// frozen snapshot `tests/formats/mana2-convert-parity.test.ts` compares
// this format's own `toMana2(fromCmini(p))` against, WITHOUT needing wasm
// at test time (a file read of the committed snapshot, LDB-G5 untouched:
// this script never imports anything from web/, only reads two files by
// path).
//
// Default mode WRITES/updates `tests/fixtures/mana2-convert/*.json` (run
// this once, or after a deliberate site engine change, then commit the
// new snapshot). `--check` mode is read-only: it recomputes from the live
// wasm and diffs against the COMMITTED snapshot, exiting non-zero on any
// mismatch -- the runbook's way to re-verify after a site engine change
// without touching the snapshot files.
//
// Usage:
//   node scripts/check-convert-parity.mjs [--check]
//     [--wasm-exec=<path>] [--wasm=<path>]
// Defaults: <repo-root>/web/data/swap/wasm_exec.js and .../engine.wasm
// (repo-root = three dirs up from this script; web/data is a symlink to
// the main checkout's full build in every worktree, 12 §X2's own DoD).
// If those two files are not both present, this prints why and exits 0
// WITHOUT writing anything or failing the build -- LDB-F12 is then simply
// unverified until a full build exists, not silently faked.
import fs from "node:fs";
import path from "node:path";
import url from "node:url";

const SCRIPTS_DIR = path.dirname(url.fileURLToPath(import.meta.url));
const DB_ROOT = path.join(SCRIPTS_DIR, "..");
const REPO_ROOT = path.resolve(DB_ROOT, "..");
const OUT_DIR = path.join(DB_ROOT, "tests", "fixtures", "mana2-convert");
const CMINI_FIXTURES_DIR = path.join(DB_ROOT, "formats", "adapters", "cmini", "fixtures");

function arg(name, fallback) {
  const found = process.argv.find((a) => a.startsWith(`--${name}=`));
  return found ? found.slice(name.length + 3) : fallback;
}

const CHECK = process.argv.includes("--check");
const wasmExecPath = arg("wasm-exec", path.join(REPO_ROOT, "web", "data", "swap", "wasm_exec.js"));
const wasmPath = arg("wasm", path.join(REPO_ROOT, "web", "data", "swap", "engine.wasm"));

function waitFor(cond, label, timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const tick = () => {
      if (cond()) return resolve();
      if (Date.now() - start > timeoutMs) return reject(new Error(`timed out waiting for ${label}`));
      setTimeout(tick, 10);
    };
    tick();
  });
}

function isBaseFixtureFile(filename) {
  if (!filename.endsWith(".json")) return false;
  return !filename.slice(0, -".json".length).includes(".");
}

async function main() {
  if (!fs.existsSync(wasmExecPath) || !fs.existsSync(wasmPath)) {
    console.log(`[LDB-F12] SKIP: ${wasmExecPath} and/or ${wasmPath} not found -- no full build in this worktree. Nothing written, nothing checked. Named reason: web/data/swap/{wasm_exec.js,engine.wasm} only exist after a full resync.sh build (a "Live browser QA rig"-style symlink usually provides them; see this repo's own memory notes on that).`);
    return;
  }

  const { createRequire } = await import("node:module");
  const require = createRequire(import.meta.url);
  require(path.resolve(wasmExecPath)); // sets globalThis.Go (same require(...) tools/swapengine/smoke.js uses)

  const go = new globalThis.Go();
  const wasmBuf = fs.readFileSync(path.resolve(wasmPath));
  const { instance } = await WebAssembly.instantiate(wasmBuf, go.importObject);
  go.run(instance); // never resolves -- blocks forever on select{}, dispatching callbacks

  await waitFor(() => globalThis.swapengineReady === true, "swapengineReady");
  const ready = globalThis.swapengine.ready();
  if (!ready.ok) throw new Error(`swapengine.ready() failed: ${ready.error}`);

  fs.mkdirSync(OUT_DIR, { recursive: true });

  const files = fs.readdirSync(CMINI_FIXTURES_DIR).filter(isBaseFixtureFile).sort();
  let mismatches = 0;
  let recorded = 0;
  for (const file of files) {
    const stem = file.slice(0, -".json".length);
    const payload = JSON.parse(fs.readFileSync(path.join(CMINI_FIXTURES_DIR, file), "utf8"));
    const converted = globalThis.swapengine.convertLayout("rowstag", "none", JSON.stringify(payload));
    if (!converted.ok) {
      console.error(`${stem}: convertLayout failed: ${converted.error}`);
      mismatches++;
      continue;
    }
    const snapshotPath = path.join(OUT_DIR, `${stem}.json`);
    const text = JSON.stringify(converted.value, null, 2) + "\n";

    if (CHECK) {
      if (!fs.existsSync(snapshotPath)) {
        console.error(`${stem}: no committed snapshot to check against (run without --check first)`);
        mismatches++;
        continue;
      }
      const committed = fs.readFileSync(snapshotPath, "utf8");
      if (committed !== text) {
        console.error(`${stem}: DRIFTED from the committed snapshot`);
        mismatches++;
      }
      continue;
    }

    fs.writeFileSync(snapshotPath, text);
    recorded++;
  }

  if (CHECK) {
    console.log(`[LDB-F12] checked ${files.length} fixtures against the committed snapshot: ${mismatches} mismatch(es)`);
    if (mismatches > 0) process.exit(1);
  } else {
    console.log(`[LDB-F12] recorded ${recorded}/${files.length} snapshots to ${path.relative(DB_ROOT, OUT_DIR)}/ (${mismatches} convertLayout failure(s))`);
    if (mismatches > 0) process.exit(1);
  }
}

main().catch((err) => {
  console.error("FAIL:", err);
  process.exit(1);
});
