// [LDB-F23] MF-9 (design/layout-db/21-formats.md §4): "fromCmini is exact
// where spark has a place." Replaces the `toCmini(fromCmini(x))` round
// trip 21-formats.md D5 deleted (there is no more cmini EXPORT to round-
// trip through -- the cmini IMPORT, `fromCmini`, stays) with a direct,
// test-local projection over the same `upstream-100` fixture: for every
// cmini layout, the multiset of (char, row, col, finger) equals spark/1's
// `keys` entries (plus `free` positions), cmini's board word maps to
// spark's `board` by the fixed table `translate.ts`'s own `boardFromCmini`
// implements, and the fields dropped are exactly `tag`, `blame`, `combos`,
// `link` (D10's own cost list -- these have no spark/1 idiom, and, since
// D10 also deleted spark/1's free-form `x`, there is nowhere left to
// reserve them either).
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { fromCmini } from "../../formats/adapters/cmini/translate.ts";
import type { Payload as CminiPayload, Position } from "../../formats/adapters/cmini/index.ts";

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

// The fixed cmini board word -> spark board.kind table `translate.ts`'s
// own `boardFromCmini` implements: "stagger"/"angle" both land on
// "rowstag" (angle's shift is already baked into keys' cols/fingers, as
// cmini itself stores it -- the geometry word is the same ANSI-stagger
// shape either way); "ortho"/"mini" both land on "ortho".
const BOARD_KIND: Record<CminiPayload["board"], "rowstag" | "ortho"> = {
  stagger: "rowstag",
  angle: "rowstag",
  ortho: "ortho",
  mini: "ortho",
};

function positionMultiset(keys: Record<string, Position>, free: Position[] | undefined): Set<string> {
  const out = new Set<string>();
  for (const [ch, pos] of Object.entries(keys)) out.add(`key:${ch}:${pos.row}:${pos.col}:${pos.finger}`);
  for (const pos of free ?? []) out.add(`free:${pos.row}:${pos.col}:${pos.finger}`);
  return out;
}

const SPARK_ALLOWED_FIELDS = new Set(["keys", "free", "board", "magic"]);
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

    it(`[LDB-F23] '${name}': the (char, row, col, finger) multiset survives exactly`, () => {
      expect(positionMultiset(spark.keys, spark.free)).toEqual(positionMultiset(cmini.keys, cmini.free));
    });

    it(`[LDB-F23] '${name}': the board word maps to spark's board.kind by the fixed table`, () => {
      expect(spark.board?.kind).toBe(BOARD_KIND[cmini.board]);
    });

    it(`[LDB-F23] '${name}': the fields dropped are exactly tag, blame, combos, link -- nothing else survives or vanishes`, () => {
      const sparkKeys = new Set(Object.keys(spark));
      for (const field of CMINI_ONLY_FIELDS) {
        expect(sparkKeys.has(field), `spark payload unexpectedly carries '${field}'`).toBe(false);
      }
      for (const key of sparkKeys) {
        expect(SPARK_ALLOWED_FIELDS.has(key), `spark payload has an unexpected field '${key}' (no free-form 'x' since D10)`).toBe(true);
      }
    });
  }
});
