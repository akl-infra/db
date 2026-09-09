// [LDB-F12] "The DB's akl/1 -> mana2/1 grid and thumb strings equal the
// site's bridgecore.ConvertLayout output for every cmini fixture" -- the
// "integrate via the real tool" bar. Compares this format's own
// `cmini/1.to["mana2/1"]` against the COMMITTED snapshot
// `scripts/check-convert-parity.mjs` recorded from the site's real wasm
// engine (`swapengine.convertLayout('rowstag','none', cminiDetailJSON)`,
// the same surface tools/swapengine/smoke.js exercises) -- a file read,
// never a live wasm call at test time (LDB-G5 untouched).
//
// "modulo trailing skip tokens and the fingermap digits under skip cells"
// (12-implementation-phase5.md §X2's own words): the site's converter does
// NOT trim a row's trailing `skip` tokens (verified against the committed
// snapshots -- e.g. graphite's row 2 ends "... - / skip skip"), while this
// format deliberately does (translate.ts's own header comment: mana2's own
// vendored files round-trip byte-for-byte only if trailing skips are
// trimmed) -- both engines fill a cell with NO key with `skip`, they just
// disagree on whether to keep the tail. Trimmed on BOTH sides before
// comparing tokens. Under a `skip` cell, the fingermap digit is also
// engine-specific (the site emits `0`; this format emits the `free`
// entry's own finger when one exists) -- compared only where the token is
// NOT `skip`.
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import * as cmini1 from "../../formats/cmini/1/index.ts";
import type { Payload as Mana2Payload } from "../../formats/mana2/1/index.ts";

const CMINI_FIXTURES_DIR = path.resolve(import.meta.dirname, "..", "..", "formats", "cmini", "1", "fixtures");
const SNAPSHOT_DIR = path.resolve(import.meta.dirname, "..", "fixtures", "mana2-convert");

function isBaseFixtureFile(filename: string): boolean {
  if (!filename.endsWith(".json")) return false;
  return !filename.slice(0, -".json".length).includes(".");
}

function tokensOf(row: string | undefined): string[] {
  return (row ?? "").trim().split(/\s+/).filter((t) => t.length > 0);
}

// Trim a row's trailing "skip" tokens, trimming the corresponding
// fingermap entries the same amount (they always have >= as many entries
// as tokens -- 12 §0.4).
function trimTrailingSkips(fingers: string[], fingermap: string[]): { fingers: string[][]; fingermap: string[][] } {
  const outFingers: string[][] = [];
  const outFingermap: string[][] = [];
  for (let y = 0; y < fingers.length; y++) {
    const toks = tokensOf(fingers[y]);
    const digits = tokensOf(fingermap[y]).slice(0, toks.length);
    let end = toks.length;
    while (end > 0 && toks[end - 1] === "skip") end--;
    outFingers.push(toks.slice(0, end));
    outFingermap.push(digits.slice(0, end));
  }
  // A genuinely empty layout (0 keys, 52 live upstream layouts, 07 §0.1):
  // the site's converter produces `layout.fingers: []` (zero rows); this
  // format's own schema requires >=1 row (every real mana2 FILE has one),
  // so `fromAkl` emits a single all-empty row instead (translate.ts's own
  // comment). Both mean "no keys at all" -- normalized to the same empty
  // shape here before comparing.
  if (outFingers.length === 1 && outFingers[0]!.length === 0) return { fingers: [], fingermap: [] };
  return { fingers: outFingers, fingermap: outFingermap };
}

function normalizeThumbs(thumbs: string[] | undefined): [string[], string[]] {
  const left = tokensOf(thumbs?.[0]);
  const right = tokensOf(thumbs?.[1]);
  return [left, right];
}

describe("[LDB-F12] cmini/1 -> mana2/1 grid/thumbs equal the site's real wasm converter", () => {
  const cminiFiles = fs.readdirSync(CMINI_FIXTURES_DIR).filter(isBaseFixtureFile).sort();
  const snapshotFiles = fs.existsSync(SNAPSHOT_DIR) ? fs.readdirSync(SNAPSHOT_DIR).filter((f) => f.endsWith(".json")) : [];

  if (snapshotFiles.length === 0) {
    it.skip("[LDB-F12] SKIP: no tests/fixtures/mana2-convert/*.json snapshot -- run `node scripts/check-convert-parity.mjs` in a worktree with a full build (web/data/swap/{wasm_exec.js,engine.wasm})", () => {});
  }

  for (const file of cminiFiles) {
    const stem = file.slice(0, -".json".length);
    const snapshotPath = path.join(SNAPSHOT_DIR, `${stem}.json`);
    if (!fs.existsSync(snapshotPath)) continue; // no snapshot recorded (e.g. the script was never run here) -- the summary skip above says so

    it(`[LDB-F12] ${stem}: fingers/thumbs/fingermap match the site (modulo trailing skip + under-skip digits)`, () => {
      const cminiPayload = JSON.parse(fs.readFileSync(path.join(CMINI_FIXTURES_DIR, file), "utf8")) as cmini1.Payload;
      const mine = cmini1.to["mana2/1"]!(cminiPayload) as Mana2Payload;
      const site = JSON.parse(fs.readFileSync(snapshotPath, "utf8")) as Mana2Payload;

      const mineTrimmed = trimTrailingSkips(mine.layout.fingers, mine.fingermap);
      const siteTrimmed = trimTrailingSkips(site.layout.fingers, site.fingermap);

      expect(mineTrimmed.fingers).toEqual(siteTrimmed.fingers);
      // Fingermap compared only at NON-skip positions (both sides use a
      // different convention under a skip cell, documented above).
      for (let y = 0; y < mineTrimmed.fingers.length; y++) {
        for (let x = 0; x < mineTrimmed.fingers[y]!.length; x++) {
          if (mineTrimmed.fingers[y]![x] === "skip") continue;
          expect(mineTrimmed.fingermap[y]![x]).toBe(siteTrimmed.fingermap[y]![x]);
        }
      }

      expect(normalizeThumbs(mine.layout.thumbs)).toEqual(normalizeThumbs(site.layout.thumbs));
    });
  }
});
