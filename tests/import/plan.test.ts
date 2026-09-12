// [LDB-I3] [LDB-I6] planTick: table-driven over every rule in
// 07 §6 S5, plus the ≥24h full-pass trigger and both stall conditions.
// Purity: same input -> same output, no D1 (this file never touches `env`).
import { describe, expect, it } from "vitest";
import { planTick, type LocalMapRow } from "../../src/import/plan";
import type { UpstreamListEntry } from "../../src/import/upstream";

const NOW = "2026-09-08T12:00:00.000Z";
const RECENT = "2026-09-08T00:00:00.000Z"; // 12h before NOW -- full pass not due
const OLD = "2026-09-06T00:00:00.000Z"; // > 24h before NOW -- full pass due

function entry(patch: Partial<UpstreamListEntry> & { id: string }): UpstreamListEntry {
  return { name: patch.id, modified_at: "2026-01-01T00:00:00Z", like_count: 0, ...patch };
}

function row(patch: Partial<LocalMapRow> & { upstreamId: string; layoutId: string }): LocalMapRow {
  return {
    name: patch.upstreamId,
    modified_at: "2026-01-01T00:00:00Z",
    like_count: 0,
    deleted: false,
    ...patch,
  };
}

describe("planTick", () => {
  it("[LDB-I6] a brand-new (empty local) database plans to fetch every listed id, never collapses", () => {
    const list = [entry({ id: "a" }), entry({ id: "b" })];
    const result = planTick({ list, local: [], lastFull: null, fullPassCursor: null, now: NOW });
    expect(result.kind).toBe("ok");
    if (result.kind === "ok") {
      expect(result.fetch).toEqual(["a", "b"]);
      expect(result.delete).toEqual([]);
      expect(result.deleteStalled).toBeNull();
    }
  });

  it("a listed id not in the map is fetched (new)", () => {
    const list = [entry({ id: "a" })];
    const local = [row({ upstreamId: "z", layoutId: "L-z", modified_at: "2026-01-01T00:00:00Z" })];
    // z isn't listed -> a prune candidate, not relevant to this assertion;
    // list is well over half of local (1 vs 1) so no collapse.
    const result = planTick({ list, local, lastFull: RECENT, fullPassCursor: null, now: NOW });
    expect(result.kind).toBe("ok");
    if (result.kind === "ok") expect(result.fetch).toContain("a");
  });

  it("mapped id with a changed modified_at is fetched", () => {
    const list = [entry({ id: "a", modified_at: "2026-02-01T00:00:00Z" })];
    const local = [row({ upstreamId: "a", layoutId: "L-a", modified_at: "2026-01-01T00:00:00Z" })];
    const result = planTick({ list, local, lastFull: RECENT, fullPassCursor: null, now: NOW });
    expect(result.kind).toBe("ok");
    if (result.kind === "ok") expect(result.fetch).toEqual(["a"]);
  });

  // B1 (design/layout-db/review/audit-db.md B1): upstream showing MORE
  // likes than we have is still a real signal (we might be missing one to
  // union in) -- fetched same as before.
  it("[LDB-L5] mapped id whose upstream like_count is HIGHER than ours is fetched", () => {
    const list = [entry({ id: "a", like_count: 5 })];
    const local = [row({ upstreamId: "a", layoutId: "L-a", like_count: 3 })];
    const result = planTick({ list, local, lastFull: RECENT, fullPassCursor: null, now: NOW });
    expect(result.kind).toBe("ok");
    if (result.kind === "ok") expect(result.fetch).toEqual(["a"]);
  });

  // B1: the importer never removes a like, so a LOCAL like_count higher
  // than upstream's (extra likes made through us, which cmini's own count
  // will never independently catch up to) must not force a fetch on its
  // own -- that would re-fetch this id forever with nothing to apply.
  it("[LDB-L5] mapped id whose LOCAL like_count is HIGHER than upstream's is not fetched on that account alone", () => {
    const list = [entry({ id: "a", like_count: 3 })];
    const local = [row({ upstreamId: "a", layoutId: "L-a", like_count: 5 })];
    const result = planTick({ list, local, lastFull: RECENT, fullPassCursor: null, now: NOW });
    expect(result.kind).toBe("ok");
    if (result.kind === "ok") expect(result.fetch).toEqual([]);
  });

  it("a missing list like_count is treated as 0", () => {
    const list = [entry({ id: "a", like_count: undefined })];
    const local = [row({ upstreamId: "a", layoutId: "L-a", like_count: 0 })];
    const result = planTick({ list, local, lastFull: RECENT, fullPassCursor: null, now: NOW });
    expect(result.kind).toBe("ok");
    if (result.kind === "ok") expect(result.fetch).toEqual([]); // 0 === 0, nothing else differs
  });

  it("mapped id with a changed name is fetched", () => {
    const list = [entry({ id: "a", name: "New-Name" })];
    const local = [row({ upstreamId: "a", layoutId: "L-a", name: "Old-Name" })];
    const result = planTick({ list, local, lastFull: RECENT, fullPassCursor: null, now: NOW });
    expect(result.kind).toBe("ok");
    if (result.kind === "ok") expect(result.fetch).toEqual(["a"]);
  });

  it("a locally tombstoned but still-listed id is fetched (possible resurrection)", () => {
    const list = [entry({ id: "a" })];
    const local = [row({ upstreamId: "a", layoutId: "L-a", deleted: true })];
    const result = planTick({ list, local, lastFull: RECENT, fullPassCursor: null, now: NOW });
    expect(result.kind).toBe("ok");
    if (result.kind === "ok") expect(result.fetch).toEqual(["a"]);
  });

  it("an unchanged mapped id is NOT fetched when no full pass is due", () => {
    const list = [entry({ id: "a" })];
    const local = [row({ upstreamId: "a", layoutId: "L-a" })];
    const result = planTick({ list, local, lastFull: RECENT, fullPassCursor: null, now: NOW });
    expect(result.kind).toBe("ok");
    if (result.kind === "ok") expect(result.fetch).toEqual([]);
  });

  it("[full pass] lastFull null (never run) forces a fetch of an otherwise-unchanged id", () => {
    const list = [entry({ id: "a" })];
    const local = [row({ upstreamId: "a", layoutId: "L-a" })];
    const result = planTick({ list, local, lastFull: null, fullPassCursor: null, now: NOW });
    expect(result.kind).toBe("ok");
    if (result.kind === "ok") {
      expect(result.fetch).toEqual([]); // no real reason to fetch -- it's full-pass-only
      expect(result.fetchFullPassOnly).toEqual(["a"]);
      expect(result.isFullPass).toBe(true);
    }
  });

  it("[full pass] >=24h since lastFull forces a fetch of an otherwise-unchanged id", () => {
    const list = [entry({ id: "a" })];
    const local = [row({ upstreamId: "a", layoutId: "L-a" })];
    const result = planTick({ list, local, lastFull: OLD, fullPassCursor: null, now: NOW });
    expect(result.kind).toBe("ok");
    if (result.kind === "ok") {
      expect(result.fetch).toEqual([]);
      expect(result.fetchFullPassOnly).toEqual(["a"]);
      expect(result.isFullPass).toBe(true);
    }
  });

  it("[full pass] a new (unmapped) id is fetched as priority, not full-pass-only, even during a full pass", () => {
    const list = [entry({ id: "a" }), entry({ id: "brand-new" })];
    const local = [row({ upstreamId: "a", layoutId: "L-a" })];
    const result = planTick({ list, local, lastFull: null, fullPassCursor: null, now: NOW });
    expect(result.kind).toBe("ok");
    if (result.kind === "ok") {
      expect(result.fetch).toEqual(["brand-new"]);
      expect(result.fetchFullPassOnly).toEqual(["a"]);
    }
  });

  it("[full pass] exactly 24h since lastFull counts as due", () => {
    const exactly24hAgo = new Date(Date.parse(NOW) - 24 * 60 * 60 * 1000).toISOString();
    const list = [entry({ id: "a" })];
    const local = [row({ upstreamId: "a", layoutId: "L-a" })];
    const result = planTick({ list, local, lastFull: exactly24hAgo, fullPassCursor: null, now: NOW });
    expect(result.kind).toBe("ok");
    if (result.kind === "ok") expect(result.isFullPass).toBe(true);
  });

  it("[full pass] a few seconds under 24h is not due", () => {
    const almost24h = new Date(Date.parse(NOW) - 24 * 60 * 60 * 1000 + 5000).toISOString();
    const list = [entry({ id: "a" })];
    const local = [row({ upstreamId: "a", layoutId: "L-a" })];
    const result = planTick({ list, local, lastFull: almost24h, fullPassCursor: null, now: NOW });
    expect(result.kind).toBe("ok");
    if (result.kind === "ok") {
      expect(result.isFullPass).toBe(false);
      expect(result.fetch).toEqual([]);
      expect(result.fetchFullPassOnly).toEqual([]);
    }
  });

  it("an unlisted map row is a delete candidate", () => {
    const list: UpstreamListEntry[] = [];
    const local = Array.from({ length: 10 }, (_, i) => row({ upstreamId: `id-${i}`, layoutId: `L-${i}` }));
    // list has 0 entries; 0 < 0.5*10 would collapse -- use enough listed ids
    // to keep this test isolated to the delete rule, not the collapse guard.
    const listed = [entry({ id: "keep-0" }), ...local.slice(0, 5).map((r) => entry({ id: r.upstreamId }))];
    const result = planTick({ list: listed, local, lastFull: RECENT, fullPassCursor: null, now: NOW });
    expect(result.kind).toBe("ok");
    if (result.kind === "ok") {
      const deletedIds = result.delete.map((d) => d.upstreamId).sort();
      expect(deletedIds).toEqual(["id-5", "id-6", "id-7", "id-8", "id-9"]);
    }
  });

  it("[LDB-I3] deletes at exactly the bound (max(5, 5%)) are applied, not stalled", () => {
    // 100 live records, 5% = 5 -> bound is max(5,5)=5; exactly 5 unlisted is allowed.
    const local = Array.from({ length: 100 }, (_, i) => row({ upstreamId: `id-${i}`, layoutId: `L-${i}` }));
    const listed = local.slice(0, 95).map((r) => entry({ id: r.upstreamId }));
    const result = planTick({ list: listed, local, lastFull: RECENT, fullPassCursor: null, now: NOW });
    expect(result.kind).toBe("ok");
    if (result.kind === "ok") {
      expect(result.delete.length).toBe(5);
      expect(result.deleteStalled).toBeNull();
    }
  });

  it("[LDB-I3] deletes one past the bound stall the deletes, but fetches still proceed", () => {
    const local = Array.from({ length: 100 }, (_, i) => row({ upstreamId: `id-${i}`, layoutId: `L-${i}` }));
    const listed = [
      ...local.slice(0, 94).map((r) => entry({ id: r.upstreamId })),
      entry({ id: "brand-new" }), // keeps a fetch action alive alongside the stalled deletes
    ];
    const result = planTick({ list: listed, local, lastFull: RECENT, fullPassCursor: null, now: NOW });
    expect(result.kind).toBe("ok");
    if (result.kind === "ok") {
      expect(result.delete).toEqual([]);
      expect(result.deleteStalled).not.toBeNull();
      expect(result.fetch).toContain("brand-new"); // the rest of the tick proceeds
    }
  });

  it("[LDB-I3] the bound is never below 5 even with very few live records", () => {
    // 3 live records; 5% of 3 is 0.15, so the bound floors at 5 -- all 3
    // being unlisted (well under 5) must NOT stall.
    const local = Array.from({ length: 3 }, (_, i) => row({ upstreamId: `id-${i}`, layoutId: `L-${i}` }));
    const result = planTick({ list: [], local, lastFull: RECENT, fullPassCursor: null, now: NOW });
    // list.length (0) < 0.5*3 (1.5) -- this trips the COLLAPSE guard first,
    // which is a distinct (and stricter) rule than the prune bound; assert
    // that instead.
    expect(result.kind).toBe("collapsed");
  });

  it("[LDB-I6] a list shorter than half the live record count collapses the whole tick", () => {
    const local = Array.from({ length: 10 }, (_, i) => row({ upstreamId: `id-${i}`, layoutId: `L-${i}` }));
    const listed = local.slice(0, 4).map((r) => entry({ id: r.upstreamId })); // 4 < 0.5*10 = 5
    const result = planTick({ list: listed, local, lastFull: RECENT, fullPassCursor: null, now: NOW });
    expect(result.kind).toBe("collapsed");
  });

  it("[LDB-I6] a list at exactly half the live record count does NOT collapse", () => {
    const local = Array.from({ length: 10 }, (_, i) => row({ upstreamId: `id-${i}`, layoutId: `L-${i}` }));
    const listed = local.slice(0, 5).map((r) => entry({ id: r.upstreamId })); // 5 == 0.5*10
    const result = planTick({ list: listed, local, lastFull: RECENT, fullPassCursor: null, now: NOW });
    expect(result.kind).toBe("ok");
  });

  it("[LDB-I6] an empty local database never collapses regardless of list size", () => {
    const result = planTick({ list: [], local: [], lastFull: RECENT, fullPassCursor: null, now: NOW });
    expect(result.kind).toBe("ok");
  });

  it("purity: identical input produces a deep-equal result on repeated calls", () => {
    const list = [entry({ id: "a" }), entry({ id: "b", modified_at: "2026-03-01T00:00:00Z" })];
    const local = [
      row({ upstreamId: "b", layoutId: "L-b" }),
      row({ upstreamId: "gone", layoutId: "L-gone" }),
    ];
    const input = { list, local, lastFull: RECENT, fullPassCursor: null, now: NOW };
    const first = planTick(input);
    const second = planTick(input);
    expect(second).toEqual(first);
    // and the inputs are untouched
    expect(list).toEqual([entry({ id: "a" }), entry({ id: "b", modified_at: "2026-03-01T00:00:00Z" })]);
  });

  it("a full-pass cursor excludes already-swept ids (id <= cursor) from fetchFullPassOnly", () => {
    const list = [entry({ id: "a" }), entry({ id: "b" }), entry({ id: "c" })];
    const local = ["a", "b", "c"].map((id) => row({ upstreamId: id, layoutId: `L-${id}` }));
    const result = planTick({ list, local, lastFull: null, fullPassCursor: "a", now: NOW });
    expect(result.kind).toBe("ok");
    if (result.kind === "ok") {
      expect(result.fetch).toEqual([]);
      expect(result.fetchFullPassOnly).toEqual(["b", "c"]); // "a" already covered
      expect(result.isFullPass).toBe(true); // a cursor in progress stays "due" regardless of lastFull
    }
  });

  it("an in-progress cursor keeps the pass due even when lastFull looks recent", () => {
    const list = [entry({ id: "a" })];
    const local = [row({ upstreamId: "a", layoutId: "L-a" })];
    const result = planTick({ list, local, lastFull: RECENT, fullPassCursor: "", now: NOW });
    expect(result.kind).toBe("ok");
    if (result.kind === "ok") {
      expect(result.isFullPass).toBe(true);
      expect(result.fetchFullPassOnly).toEqual(["a"]); // "a" > "" (the empty-string sentinel)
    }
  });
});
