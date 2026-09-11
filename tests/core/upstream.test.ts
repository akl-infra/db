// [LDB-I14] [MF-12 = LDB-I18] `nextUpstream` is the whole write rule, as a
// pure function -- tested here over its full matrix so every future call
// site's behaviour is pinned independent of any particular importer/write
// call site (those are covered live in tests/events/upstream.test.ts,
// tests/events/fold.test.ts's write model, and tests/import/*).
// 21-formats.md §2.2 restates the rule with an explicit `touches` flag
// (true for a layout-scope write or a format-scope write on lineage
// `spark`; false for every other lineage) instead of switching on `kind`
// directly -- `core/write.ts` is what decides `touches` per call site.
import { describe, expect, it } from "vitest";
import { nextUpstream } from "../../src/core/upstream";
import type { Upstream } from "../../src/core/records";

const FOLLOWING: Upstream = { source: "cmini", id: "u1", state: "following" };
const FORKED: Upstream = { source: "cmini", id: "u1", state: "forked" };

describe("[LDB-I14] nextUpstream matrix", () => {
  it("[LDB-I14] null stays null regardless of via/touches", () => {
    for (const via of ["discord", "import:cmini", "client:abc"]) {
      for (const touches of [true, false]) {
        expect(nextUpstream(null, via, touches)).toBeNull();
      }
    }
  });

  it("[MF-12] touches=false leaves a non-null prior BYTE-IDENTICAL, whatever `via` is", () => {
    expect(nextUpstream(FOLLOWING, "discord", false)).toEqual(FOLLOWING);
    expect(nextUpstream(FORKED, "discord", false)).toEqual(FORKED);
    expect(nextUpstream(FOLLOWING, "import:cmini", false)).toEqual(FOLLOWING);
  });

  it("[LDB-I14] a user (non-import) touching write forks a non-null prior (same source/id, state -> forked)", () => {
    expect(nextUpstream(FOLLOWING, "discord", true)).toEqual(FORKED);
    // Idempotent on an already-forked record: still forked, same link.
    expect(nextUpstream(FORKED, "discord", true)).toEqual(FORKED);
  });

  it("[LDB-I14] a client-lane via forks too -- 'forked' is about WHO wrote, not which literal discord/client string", () => {
    expect(nextUpstream(FOLLOWING, "client:abc123", true)).toEqual(FORKED);
  });

  it("[LDB-I14] an import-lane touching write sets/keeps following, same source/id", () => {
    expect(nextUpstream(FOLLOWING, "import:cmini", true)).toEqual(FOLLOWING);
    // Well-defined even though unreachable through today's call sites (the
    // importer only reaches this when `upstreamOf` already answered
    // "following" -- LDB-I14's "the importer never writes a forked record"):
    // an import write always answers "following", never "forked".
    expect(nextUpstream(FORKED, "import:cmini", true)).toEqual({ ...FORKED, state: "following" });
  });

  it("[LDB-I14] the importer never writes 'forked': every touching import-via output has state 'following', never 'forked'", () => {
    for (const prior of [FOLLOWING, FORKED]) {
      expect(nextUpstream(prior, "import:cmini", true)!.state).toBe("following");
    }
  });
});
