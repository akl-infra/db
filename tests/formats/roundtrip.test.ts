// [LDB-F5] [LDB-F10] cmini/1 <-> akl/1 is identity in both directions
// (01-format.md §6.1/§6.2), on the two fixture sets that exercise it:
//
//   - every upstream-100 detail: cmini -> akl -> cmini reproduces the SAME
//     `cminiDetail` projection (07 §5.1's `project`), likes sorted both
//     sides (this is the fixture-level half of LDB-F5; the daily D12 diff,
//     LDB-P5, is the live-set half).
//   - every akl/1 fixture: akl -> cmini -> akl reproduces the SAME payload,
//     minus every `x` key other than `x.cmini` (LDB-F10) and minus the
//     three losses 01 §6.1/§6.2 document exactly (verified against the
//     real translate.ts output before being written down here, not
//     guessed): a board with no `cmini` hint gains one (cmini "remembers"
//     its own word); colstag has no cmini word at all, so it becomes ortho
//     and the stagger amounts are dropped; `magic.rules[].note` has no
//     cmini idiom and is dropped.
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import * as cmini1 from "../../formats/adapters/cmini/index.ts";
import { fromCmini, toCmini } from "../../formats/adapters/cmini/translate.ts";
import * as spark1 from "../../formats/spark/1/index.ts";
import { specialCharsFromRows } from "../../formats/spark/1/magic.ts";
import type { Board, Payload as SparkPayload } from "../../formats/spark/1/index.ts";

const SNAPSHOT_DIR = path.resolve(import.meta.dirname, "..", "fixtures", "upstream-100");
const SPARK_FIXTURES_DIR = path.resolve(import.meta.dirname, "..", "..", "formats", "spark", "1", "fixtures");

// -- half 1: every upstream-100 detail, cmini -> akl -> cmini --

interface UpstreamDetail {
  name: string;
  user: string;
  likes?: string[];
  created_at: string;
  modified_at: string;
  [k: string]: unknown;
}

const RECORD_FIELDS = new Set(["name", "user", "likes", "created_at", "modified_at"]);

function payloadFrom(detail: UpstreamDetail): cmini1.Payload {
  const payload: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(detail)) {
    if (!RECORD_FIELDS.has(k)) payload[k] = v;
  }
  return payload as unknown as cmini1.Payload;
}

function projectWithPayload(detail: UpstreamDetail, payload: cmini1.Payload): cmini1.CminiDetail {
  return cmini1.project({
    name: detail.name,
    owner: detail.user,
    created_at: detail.created_at,
    modified_at: detail.modified_at,
    likes: detail.likes ?? [],
    payload,
  });
}

// `project()` already sorts `likes`; the `magic` array is semantically a
// SET keyed by `inputs` (every row's `inputs` is unique, akl/1/magic.ts's
// own vocabulary), and akl/1's fixed lowering order has no reason to match
// whatever order upstream's row generator used -- sorted the same way on
// both sides before a plain deep-equal, matching this codebase's existing
// "every array in this schema is semantically a SET" convention
// (functions/_lib/rules.mjs's ruleSetSignature).
// LDB-F15: a magic/chiral key's own char (auditor's 'b', 'd', 'j', 'q',
// 'v' -- each a `default: "none"` magic key in its own right) is now
// excluded from every OTHER key's board-char scaffold (magic.ts's
// `specialChars`, mirroring the site's `magicScaffoldChars`). A frozen
// row like auditor's `b*->bb` (type "repeat") still round-trips, but only
// as an EXPLICIT `magic_keys[].rules[]` override on `*` -- which relowers
// tagged "magic", not "repeat"/"default:<c>". Same (inputs, output) pair,
// intentionally relabeled; not a real difference in behavior.
function normalized(detail: cmini1.CminiDetail): unknown {
  const clone = structuredClone(detail) as cmini1.CminiDetail;
  if (clone.magic) {
    const special = specialCharsFromRows(clone.magic.map((r) => ({ inputs: r.inputs, output: r.output, type: r.type ?? "raw" })));
    // `type` absent and `type: "raw"` are the same row (07 §5.1's own
    // `lower()` already treats them identically) -- whirl's one untyped
    // row would otherwise look like a mismatch against its own
    // round-tripped (explicitly "raw") copy.
    clone.magic = clone.magic
      .map((r) => {
        let type = r.type ?? "raw";
        const cps = [...r.inputs];
        const after = cps[0];
        if (cps.length === 2 && after !== " " && special.has(after!) && (type === "repeat" || type.startsWith("default:"))) {
          type = "magic";
        }
        return { inputs: r.inputs, output: r.output, type };
      })
      .sort((a, b) => (a.inputs < b.inputs ? -1 : a.inputs > b.inputs ? 1 : 0));
  }
  return clone;
}

describe("cmini/1 -> akl/1 -> cmini/1 (the import direction)", () => {
  const full: UpstreamDetail[] = JSON.parse(fs.readFileSync(path.join(SNAPSHOT_DIR, "full.json"), "utf8")).layouts;

  it("the snapshot is non-empty", () => {
    expect(full.length).toBeGreaterThan(0);
  });

  for (const detail of full) {
    it(`[LDB-F5] [LDB-F15] '${detail.name}': identity on the cminiDetail projection`, () => {
      const payload = payloadFrom(detail);
      expect(cmini1.validate(payload).ok).toBe(true);

      const akl = cmini1.to["spark/1"]!(payload) as SparkPayload;
      expect(spark1.validate(akl).ok).toBe(true);

      const back = cmini1.from["spark/1"]!(akl);
      expect(normalized(projectWithPayload(detail, back))).toEqual(normalized(projectWithPayload(detail, payload)));
    });
  }
});

// -- half 2: every akl/1 fixture, akl -> cmini -> akl --

function isBaseFixtureFile(filename: string): boolean {
  if (!filename.endsWith(".json")) return false;
  return !filename.slice(0, -".json".length).includes(".");
}

// 01 §6.1's board table, always attaching a `cmini` hint (verified against
// translate.ts's real output, not re-derived from memory): a rowstag board
// always comes back ANSI-staggered with the word cmini would have used
// (its own stagger amounts aren't stored -- only the word is); colstag has
// no cmini word, so it's ortho with the stagger dropped -- the one
// documented, exact geometry loss.
function expectedBoard(board: Board | undefined): Board {
  if (board === undefined || board.kind === "ortho" || board.kind === "colstag") {
    return { kind: "ortho", cmini: board?.cmini ?? "ortho" };
  }
  return { kind: "rowstag", stagger: [0, 0.25, 0.75], cmini: board.cmini ?? "stagger" };
}

// What `fromCmini(toCmini(a))` produces, by definition of the two documented
// lossy corners above plus LDB-F10 (only `x.cmini` survives a translation).
function adjustForCminiRoundTrip(a: SparkPayload): SparkPayload {
  const clone = structuredClone(a);
  clone.board = expectedBoard(a.board);
  if (clone.x) {
    const cmini = clone.x["cmini"];
    if (cmini !== undefined) clone.x = { cmini };
    else delete clone.x;
  }
  if (clone.magic?.rules) {
    // `note` is a pure akl/1 annotation -- cmini/1's magic rows have no
    // such field, so it cannot survive the round trip.
    clone.magic.rules = clone.magic.rules.map(({ note: _note, ...rest }) => rest);
  }
  return clone;
}

describe("akl/1 -> cmini/1 -> akl/1", () => {
  const fixtures = fs
    .readdirSync(SPARK_FIXTURES_DIR)
    .filter(isBaseFixtureFile)
    .sort();

  it("the akl/1 fixture set is non-empty", () => {
    expect(fixtures.length).toBeGreaterThan(0);
  });

  for (const file of fixtures) {
    const stem = file.slice(0, -".json".length);
    const a = JSON.parse(fs.readFileSync(path.join(SPARK_FIXTURES_DIR, file), "utf8")) as SparkPayload;

    it(`[LDB-F5] [LDB-F10] '${stem}': identity minus the documented losses`, () => {
      expect(spark1.validate(a).ok).toBe(true);
      const cmini = toCmini(a);
      expect(cmini1.validate(cmini).ok).toBe(true);
      const back = fromCmini(cmini);
      expect(back).toEqual(adjustForCminiRoundTrip(a));
    });
  }

  it("[LDB-F5] '900-colstag': colstag becomes ortho, stagger amounts dropped -- exactly, not skipped", () => {
    const a = JSON.parse(fs.readFileSync(path.join(SPARK_FIXTURES_DIR, "900-colstag.json"), "utf8")) as SparkPayload;
    const back = fromCmini(toCmini(a));
    expect(back.board).toEqual({ kind: "ortho", cmini: "ortho" });
  });
});
