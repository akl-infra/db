// [LDB-F23] MF-9 (design/layout-db/21-formats.md §4, restated by
// design/layout-db/23-geometry.md §4.6 -- LDB-F31): "fromCmini is exact
// where spark has a place." Replaces the `toCmini(fromCmini(x))` round
// trip 21-formats.md D5 deleted (there is no more cmini EXPORT to round-
// trip through -- the cmini IMPORT, `fromCmini`, stays) with a direct,
// test-local projection over the same `upstream-100` fixture: for every
// cmini layout, the multiset of (char, row, col, finger) equals spark/1's
// `keys` array entries (`char` absent = free position, 23-geometry.md's
// duplicate-characters follow-up) MODULO the §4.6 relabel (a `TB` finger,
// or an `LT`/`RT` thumb whose column disagrees with `col < 5 => LT else
// RT`, is relabelled -- the last time this ever runs, LDB-F28), cmini's
// board word maps to spark's `board` by the fixed table `translate.ts`'s
// own `WORD_TABLE` implements (24-spark-wire-review.md finding 10: NO
// angle-family bump any more -- import is faithful to the word alone), and
// the fields dropped are exactly `tag`, `blame`, `combos`, `link` (D10's
// own cost list -- these have no spark/1 idiom, and, since D10 also
// deleted spark/1's free-form `x`, there is nowhere left to reserve them
// either).
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { fromCmini } from "../../formats/adapters/cmini/translate.ts";
import type { Payload as CminiPayload, Position } from "../../formats/adapters/cmini/index.ts";
import type { Key } from "../../formats/spark/1/geometry.ts";

const RECORD_FIELDS = new Set(["name", "user", "likes", "created_at", "modified_at"]);

// Same record-field strip `import/apply.ts`'s `payloadFromRaw` and
// `import/diff.ts`'s `parseUpstreamRaw` both do -- this test stays
// self-contained (no import of either) so it can't accidentally inherit a
// bug from the code it's meant to check independently.
function cminiPayloadFrom(raw: Record<string, unknown>): CminiPayload {
  const payload: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(raw)) {
    if (!RECORD_FIELDS.has(k)) payload[k] = v;
  }
  return payload as unknown as CminiPayload;
}

// The fixed cmini board word -> spark board table (design/layout-db/
// 23-geometry.md §4.6, 24-spark-wire-review.md finding 10 -- no
// angle-family bump, import is faithful to the word alone). Computed
// independently here (not by importing translate.ts's own `WORD_TABLE`) so
// this test can't share a bug with the code it checks.
const WORD_KIND: Record<CminiPayload["board"], "ansi" | "ortho"> = {
  stagger: "ansi",
  angle: "ansi",
  ortho: "ortho",
  mini: "ortho",
};

// §4.6's relabel rule, reimplemented independently (self-contained, same
// reasoning as the board table above): a `TB`, or an `LT`/`RT` disagreeing
// with its column, is relabelled by `col < 5 => LT else RT`.
function relabelFinger(finger: string, col: number): string {
  if (finger !== "TB" && finger !== "LT" && finger !== "RT") return finger;
  return col < 5 ? "LT" : "RT";
}

function positionMultiset(keys: Key[]): Set<string> {
  const out = new Set<string>();
  for (const k of keys) out.add(k.char !== undefined ? `key:${k.char}:${k.row}:${k.col}:${k.finger}` : `free:${k.row}:${k.col}:${k.finger}`);
  return out;
}

// The EXPECTED multiset: the cmini side's own positions, with §4.6's
// relabel already applied -- LDB-F23's "exact multiset" claim is over
// (char, row, col, finger) where finger is what fromCmini is DOCUMENTED to
// write, not necessarily cmini's own stored label (LDB-F28/F31).
function cminiPositionMultiset(keys: Record<string, Position>, free: Position[] | undefined): Set<string> {
  const out = new Set<string>();
  for (const [ch, pos] of Object.entries(keys)) out.add(`key:${ch}:${pos.row}:${pos.col}:${relabelFinger(pos.finger, pos.col)}`);
  for (const pos of free ?? []) out.add(`free:${pos.row}:${pos.col}:${relabelFinger(pos.finger, pos.col)}`);
  return out;
}

const SPARK_ALLOWED_FIELDS = new Set(["keys", "board", "magic"]);
const CMINI_ONLY_FIELDS = new Set(["tag", "blame", "combos", "link"]);

describe("[LDB-F23] fromCmini is exact where spark has a place (MF-9)", () => {
  const fixture = JSON.parse(
    fs.readFileSync(path.resolve(import.meta.dirname, "..", "fixtures", "upstream-100", "full.json"), "utf8"),
  ) as { layouts: Record<string, unknown>[] };

  expect(fixture.layouts.length).toBeGreaterThan(0); // sanity: the fixture really loaded

  for (const raw of fixture.layouts) {
    const name = raw.name as string;
    const cmini = cminiPayloadFrom(raw);
    const spark = fromCmini(cmini);

    it(`[LDB-F23] [LDB-F28] '${name}': the (char, row, col, finger) multiset survives exactly, modulo the TB/thumb relabel`, () => {
      expect(positionMultiset(spark.keys)).toEqual(cminiPositionMultiset(cmini.keys, cmini.free));
    });

    it(`[LDB-F23] [LDB-F31] '${name}': the board word maps to spark's board by the fixed table`, () => {
      expect(spark.board).toBe(WORD_KIND[cmini.board]);
    });

    it(`[LDB-F23] '${name}': the fields dropped are exactly tag, blame, combos, link -- nothing else survives or vanishes`, () => {
      const sparkKeys = new Set(Object.keys(spark));
      for (const field of CMINI_ONLY_FIELDS) {
        expect(sparkKeys.has(field), `spark payload unexpectedly carries '${field}'`).toBe(false);
      }
      for (const key of sparkKeys) {
        expect(SPARK_ALLOWED_FIELDS.has(key), `spark payload has an unexpected field '${key}' (no free-form 'x' since D10, no separate 'free' since 23-geometry.md)`).toBe(true);
      }
    });
  }
});
