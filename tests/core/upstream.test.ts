// [LDB-I14] `nextUpstream` is the whole write rule, as a pure function --
// tested here over its full matrix so every future call site's behaviour
// is pinned independent of any particular importer/strip/write call site
// (those are covered live in tests/events/upstream.test.ts and
// tests/import/*). A few rows are unreachable through today's production
// call sites (each is gated -- e.g. the importer only calls this when
// `upstreamOf` already answered `following`) but are still well-defined
// and worth pinning, same style as other invariant docs in this repo.
import { describe, expect, it } from "vitest";
import { nextUpstream } from "../../src/core/upstream";
import type { Upstream } from "../../src/core/records";

const FOLLOWING: Upstream = { source: "cmini", id: "u1", state: "following" };
const FORKED: Upstream = { source: "cmini", id: "u1", state: "forked" };

describe("[LDB-I14] nextUpstream matrix", () => {
  it("[LDB-I14] null stays null regardless of kind/via", () => {
    for (const [kind, via] of [
      ["created", "discord"],
      ["updated", "discord"],
      ["imported", "import:cmini"],
      ["upstream_deleted", "import:cmini"],
    ] as const) {
      expect(nextUpstream(null, kind, via)).toBeNull();
    }
  });

  it("[LDB-I14] every user rev-bumping write forks a non-null prior (same source/id, state -> forked)", () => {
    for (const kind of ["created", "updated", "renamed", "fingermap", "transferred", "deleted", "restored"] as const) {
      expect(nextUpstream(FOLLOWING, kind, "discord")).toEqual(FORKED);
      // Idempotent on an already-forked record: still forked, same link.
      expect(nextUpstream(FORKED, kind, "discord")).toEqual(FORKED);
    }
  });

  it("[LDB-I14] a client-lane via forks too -- 'forked' is about WHO wrote, not which literal discord/client string", () => {
    expect(nextUpstream(FOLLOWING, "updated", "client:abc123")).toEqual(FORKED);
  });

  it("[LDB-I14] import writes (via: import:cmini) set/keep following, same source/id", () => {
    expect(nextUpstream(FOLLOWING, "imported", "import:cmini")).toEqual(FOLLOWING);
    expect(nextUpstream(FOLLOWING, "upstream_deleted", "import:cmini")).toEqual(FOLLOWING);
    // Unreachable through today's call sites (the importer only reaches
    // this function when `upstreamOf` already answered "following" --
    // `import/apply.ts`'s `applyMapped` gates its write on `following`,
    // `applyDelete` too) but well-defined: an import write always answers
    // "following", never "forked" -- LDB-I14's "the importer never writes
    // a forked record".
    expect(nextUpstream(FORKED, "imported", "import:cmini")).toEqual({ ...FORKED, state: "following" });
  });

  it("[LDB-I14] the importer never writes 'forked': every import-via output has state 'following', never 'forked'", () => {
    for (const prior of [FOLLOWING, FORKED]) {
      for (const kind of ["imported", "upstream_deleted"] as const) {
        expect(nextUpstream(prior, kind, "import:cmini")!.state).toBe("following");
      }
    }
  });
});
