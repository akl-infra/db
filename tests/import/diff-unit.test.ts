// [LDB-P5] The offline half of the shrunk upstream mirror diff (LEDGER.md
// L4): `parseUpstreamRaw` / `compareRecords` / `pathDiff` / `diffUpstream`
// from `src/import/diff.ts`, over the frozen `upstream-100` snapshot -- no
// network, so this runs on every PR, not just the daily job
// (`tests/upstream-diff.test.ts` owns the live half).
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  compareRecords,
  diffUpstream,
  httpOurs,
  parseUpstreamRaw,
  pathDiff,
  type FetchImpl,
  type OursEntry,
  type OursSource,
} from "../../src/import/diff";

const FIXTURE_DIR = path.join(import.meta.dirname, "..", "fixtures", "upstream-100");

interface RawFull {
  layouts: Record<string, unknown>[];
}

function loadFixture(): Record<string, unknown>[] {
  const full = JSON.parse(fs.readFileSync(path.join(FIXTURE_DIR, "full.json"), "utf8")) as RawFull;
  return full.layouts;
}

function toOursEntry(raw: Record<string, unknown>, ref: string): OursEntry {
  const parsed = parseUpstreamRaw(raw);
  if (!parsed.ok) throw new Error(`fixture '${String(raw.name)}' failed parseUpstreamRaw: ${parsed.error.message}`);
  return { ...parsed.detail, ref, upstream: { source: "cmini", id: ref, state: "following" } };
}

describe("parseUpstreamRaw over upstream-100", () => {
  it("[LDB-P5] every fixture detail parses ok, except the one known LDB-F27 case (LDB-F11 already covers schema validity; this checks the record-field half too)", () => {
    for (const raw of loadFixture()) {
      const parsed = parseUpstreamRaw(raw);
      // design/layout-db/23-geometry.md §4.4-3 (LDB-F27): 'test12222' has a
      // thumb-labelled key physically on a finger row (0-2) -- fromCmini
      // preserves the multiset exactly (LDB-F23) rather than inventing a
      // fix, so it fails spark's own (stricter) validate() by design; see
      // `tests/formats/cmini-envelope.test.ts`'s own dedicated case.
      if (raw.name === "test12222") {
        expect(parsed.ok).toBe(false);
        continue;
      }
      expect(parsed.ok, `'${String(raw.name)}': ${!parsed.ok ? parsed.error.message : ""}`).toBe(true);
    }
  });

  // 20-spark.md S3b (LDB-I13): a detail that's schema-valid per cmini/1 but
  // fails spark's OWN (stricter) semantic validate is reported as an
  // `invalidUpstream`-shaped parse failure, never thrown. This is the same
  // class of finding the daily diff surfaces as an `invalidUpstream` line
  // for real upstream data (`tests/upstream-diff.test.ts`, live).
  // design/layout-db/23-geometry.md's LDB-F27 gave this test its first real
  // example ('test12222', asserted above) -- LDB-I13's positive half stays
  // fully covered by `tests/formats/cmini-envelope.test.ts` and the daily
  // `tests/upstream-diff.test.ts`, and `parseUpstreamRaw`'s own defensive
  // `sparkCheck.ok` branch is now exercised, real code, not just reachable.
});

describe("compareRecords / pathDiff over upstream-100", () => {
  it("[LDB-P5] identical records compare equal", () => {
    const raws = loadFixture();
    const graphite = raws.find((r) => r.name === "graphite")!;
    const a = toOursEntry(graphite, "id-a");
    const b = toOursEntry(graphite, "id-b"); // `ref` is never part of the compared projection
    expect(compareRecords(a, b)).toEqual({ equal: true, path: null });
  });

  it("[LDB-P5] a mutated payload field is reported at its own path", () => {
    const raws = loadFixture();
    const graphite = raws.find((r) => r.name === "graphite")!;
    const a = toOursEntry(graphite, "id-a");

    const mutated = structuredClone(graphite);
    const keys = mutated.keys as Record<string, { row: number; col: number; finger: string }>;
    const firstChar = Object.keys(keys).sort()[0]!;
    keys[firstChar]!.finger = keys[firstChar]!.finger === "LP" ? "LR" : "LP";
    const b = toOursEntry(mutated, "id-b");

    const result = compareRecords(a, b);
    expect(result.equal).toBe(false);
    // design/layout-db/23-geometry.md's duplicate-characters follow-up:
    // spark/1's `keys` is an ARRAY now (index-addressed), not a char-keyed
    // map -- find the char's own index in the CONVERTED payload.
    const idx = a.payload.keys.findIndex((k) => k.char === firstChar);
    expect(idx).toBeGreaterThanOrEqual(0);
    expect(result.path).toBe(`/payload/keys/${idx}/finger`);
  });

  it("[LDB-P5] [LDB-F40] a mutated upstream board word is NOT a difference -- spark/1 carries no board (design/layout-db/26-no-board.md)", () => {
    const raws = loadFixture();
    const abyss = raws.find((r) => r.name === "abyss")!; // angle, per 07 §5.3
    const a = toOursEntry(abyss, "id-a");
    const mutated = { ...abyss, board: "ortho" };
    const b = toOursEntry(mutated, "id-b");

    expect(compareRecords(a, b)).toEqual({ equal: true, path: null });
  });

  it("[LDB-P5] likes compared sorted -- reordering is NOT a difference", () => {
    const raws = loadFixture();
    const graphite = raws.find((r) => r.name === "graphite")!;
    const a = toOursEntry(graphite, "id-a");
    expect(a.likes.length).toBeGreaterThan(1); // 07 §5.3: graphite has real likes
    const b = { ...a, likes: [...a.likes].reverse() };

    expect(compareRecords(a, b)).toEqual({ equal: true, path: null });
  });

  it("[LDB-P5] a genuine likes difference IS reported, under /likes", () => {
    const raws = loadFixture();
    const graphite = raws.find((r) => r.name === "graphite")!;
    const a = toOursEntry(graphite, "id-a");
    const b = { ...a, likes: a.likes.slice(1) }; // drop one like

    const result = compareRecords(a, b);
    expect(result.equal).toBe(false);
    expect(result.path).toMatch(/^\/likes(\/\d+)?$/);
  });

  // M1 (design/layout-db/17-magic-ownership.md §3): `compareRecords` drops
  // `magic` on both sides -- upstream's magic is never akl.gg's, and a
  // followed record's own is never a mirror difference either.
  it("[LDB-P5] [LDB-I11] different magic on each side is NOT a content difference", () => {
    const raws = loadFixture();
    const opal = raws.find((r) => r.name === "opal")!;
    const opalMagic = (opal as { magic?: unknown[] }).magic;
    expect(opalMagic).toBeDefined();
    expect((opalMagic as unknown[]).length).toBeGreaterThan(0); // 07 §5.3: opal is a real magic fixture

    const a = toOursEntry(opal, "id-a");
    const mutated = { ...opal, magic: [{ inputs: "q◇", output: "qq", type: "repeat" }] };
    const b = toOursEntry(mutated, "id-b");

    expect(compareRecords(a, b)).toEqual({ equal: true, path: null });
  });

  it("[LDB-P5] [LDB-I11] one side dropping magic entirely is NOT a content difference", () => {
    const raws = loadFixture();
    const opal = raws.find((r) => r.name === "opal")!;
    const a = toOursEntry(opal, "id-a");
    const { magic: _magic, ...withoutMagic } = opal;
    const b = toOursEntry(withoutMagic, "id-b");

    expect(compareRecords(a, b)).toEqual({ equal: true, path: null });
  });

  it("[LDB-P5] [LDB-I11] a genuine non-magic difference is still reported even when magic ALSO differs", () => {
    const raws = loadFixture();
    const opal = raws.find((r) => r.name === "opal")!;
    const a = toOursEntry(opal, "id-a");
    const keys = structuredClone(opal.keys) as Record<string, { row: number; col: number; finger: string }>;
    const firstChar = Object.keys(keys).sort()[0]!;
    keys[firstChar]!.finger = keys[firstChar]!.finger === "LP" ? "LR" : "LP";
    const mutated = { ...opal, keys, magic: [{ inputs: "q◇", output: "qq", type: "repeat" }] };
    const b = toOursEntry(mutated, "id-b");

    const result = compareRecords(a, b);
    expect(result.equal).toBe(false);
    expect(result.path).toMatch(/^\/payload\/keys\/\d+\/finger$/); // the real difference, never magic's own path
  });
});

describe("pathDiff", () => {
  it("[LDB-P5] deep-equal values report null", () => {
    expect(pathDiff({ a: [1, { b: "x" }] }, { a: [1, { b: "x" }] })).toBeNull();
  });

  it("[LDB-P5] a nested array element mismatch is reported at its index", () => {
    expect(pathDiff({ free: [{ row: 0 }, { row: 1 }] }, { free: [{ row: 0 }, { row: 2 }] })).toBe("/free/1/row");
  });

  it("[LDB-P5] a key present on only one side is reported at that key's path", () => {
    expect(pathDiff({ tag: "cmini" }, {})).toBe("/tag");
  });

  it("[LDB-P5] object keys with '/' and '~' are pointer-escaped", () => {
    expect(pathDiff({ "a/b": 1 }, { "a/b": 2 })).toBe("/a~1b");
    expect(pathDiff({ "a~b": 1 }, { "a~b": 2 })).toBe("/a~0b");
  });
});

// LEDGER.md L4: `httpOurs` no longer enumerates the whole corpus -- it
// pages the payload-free list to find `following` candidates, then reads
// only the sampled ones' full detail + likes.
describe("httpOurs (shrunk: count + a random sample of following layouts)", () => {
  const BASE = "https://ours.example";

  const LIST_ITEMS = [
    { id: "id-alpha", name: "alpha", upstream: { source: "cmini", id: "up-alpha", state: "following" } },
    { id: "id-beta", name: "beta", upstream: { source: "cmini", id: "up-beta", state: "forked" } }, // never sampled
    { id: "id-gamma", name: "gamma", upstream: null }, // never sampled
  ];

  const DETAIL_BY_ID: Record<string, unknown> = {
    "id-alpha": {
      name: "alpha",
      owner: "111111111111111111",
      created_at: "2026-01-01T00:00:00Z",
      modified_at: "2026-01-02T00:00:00Z",
      payload: { keys: [] },
      upstream: { source: "cmini", id: "up-alpha", state: "following" },
    },
  };

  function fakeFetch(): FetchImpl {
    return async (url) => {
      const u = new URL(url);
      if (u.pathname === "/v1/layouts" && u.searchParams.get("format") === "spark/1") {
        return new Response(JSON.stringify({ items: LIST_ITEMS, next_cursor: null }), { status: 200 });
      }
      const detailMatch = /^\/v1\/layouts\/([^/]+)$/.exec(u.pathname);
      if (detailMatch && u.searchParams.get("format") === "spark/1") {
        const detail = DETAIL_BY_ID[detailMatch[1]!];
        if (detail === undefined) throw new Error(`fakeFetch: no detail for ${detailMatch[1]}`);
        return new Response(JSON.stringify(detail), { status: 200 });
      }
      const likesMatch = /^\/v1\/layouts\/([^/]+)\/likes$/.exec(u.pathname);
      if (likesMatch) {
        return new Response(JSON.stringify({ user_ids: ["444444444444444444"] }), { status: 200 });
      }
      throw new Error(`fakeFetch: unhandled ${url}`);
    };
  }

  // No `/v1/meta` in `fakeFetch`: its `layout_count` counts akldb-native
  // layouts too (LDB-P5, amended 2026-09-14), so reading it would throw here.
  it("[LDB-P5] linkedLayoutCount() counts listed layouts linked to upstream, following or forked -- never an akldb-native one", async () => {
    const ours = httpOurs(BASE, fakeFetch());
    await expect(ours.linkedLayoutCount()).resolves.toBe(2); // alpha + beta, not gamma
  });

  it("[LDB-P5] the count and the sample share ONE walk of the list", async () => {
    let listCalls = 0;
    const inner = fakeFetch();
    const ours = httpOurs(BASE, async (url, init) => {
      if (new URL(url).pathname === "/v1/layouts") listCalls++;
      return inner(url, init);
    });
    await Promise.all([ours.linkedLayoutCount(), ours.sampleFollowing(10)]);
    expect(listCalls).toBe(1);
  });

  it("[LDB-P5] sampleFollowing() only ever picks `following` candidates, and reads their full detail + likes", async () => {
    const ours: OursSource = httpOurs(BASE, fakeFetch());
    const sample = await ours.sampleFollowing(10); // more than the one following candidate available
    expect(sample).toHaveLength(1);
    expect(sample[0]!.ref).toBe("id-alpha");
    expect(sample[0]!.owner).toBe("111111111111111111");
    expect(sample[0]!.likes).toEqual(["444444444444444444"]);
  });

  it("[LDB-P5] sampleFollowing(n) never returns more than n entries even with more candidates available", async () => {
    const manyItems = Array.from({ length: 5 }, (_, i) => ({
      id: `id-f${i}`,
      name: `f${i}`,
      upstream: { source: "cmini", id: `up-f${i}`, state: "following" },
    }));
    const detailById: Record<string, unknown> = {};
    for (const item of manyItems) {
      detailById[item.id] = {
        name: item.name,
        owner: "111111111111111111",
        created_at: "2026-01-01T00:00:00Z",
        modified_at: "2026-01-02T00:00:00Z",
        payload: { keys: [] },
        upstream: item.upstream,
      };
    }
    const fetchImpl: FetchImpl = async (url) => {
      const u = new URL(url);
      if (u.pathname === "/v1/layouts" && u.searchParams.get("format") === "spark/1") {
        return new Response(JSON.stringify({ items: manyItems, next_cursor: null }), { status: 200 });
      }
      const detailMatch = /^\/v1\/layouts\/([^/]+)$/.exec(u.pathname);
      if (detailMatch) return new Response(JSON.stringify(detailById[detailMatch[1]!]), { status: 200 });
      const likesMatch = /^\/v1\/layouts\/([^/]+)\/likes$/.exec(u.pathname);
      if (likesMatch) return new Response(JSON.stringify({ user_ids: [] }), { status: 200 });
      throw new Error(`fakeFetch: unhandled ${url}`);
    };
    const ours = httpOurs(BASE, fetchImpl);
    const sample = await ours.sampleFollowing(3);
    expect(sample).toHaveLength(3);
  });
});

describe("diffUpstream (orchestration: count + sampled compare)", () => {
  const raws = loadFixture();
  const graphite = raws.find((r) => r.name === "graphite")!;

  function fakeOurs(entries: OursEntry[], linkedCount: number): OursSource {
    return {
      async linkedLayoutCount() {
        return linkedCount;
      },
      async sampleFollowing() {
        return entries;
      },
    };
  }

  function fakeUpstreamFetch(byName: Map<string, unknown>, metaCount: number): FetchImpl {
    return async (url) => {
      const u = new URL(url);
      if (u.pathname === "/meta") return new Response(JSON.stringify({ layout_count: metaCount }), { status: 200 });
      const m = /^\/layouts\/([^/]+)$/.exec(u.pathname);
      if (m) {
        const raw = byName.get(decodeURIComponent(m[1]!));
        if (raw === undefined) return new Response("not found", { status: 404 });
        return new Response(JSON.stringify(raw), { status: 200 });
      }
      throw new Error(`fakeUpstreamFetch: unhandled ${url}`);
    };
  }

  it("[LDB-P5] a matching sample + equal counts is ok", async () => {
    const entry = toOursEntry(graphite, "id-graphite");
    const byName = new Map([["graphite", graphite]]);
    const summary = await diffUpstream({
      upstreamUrl: "https://up.example",
      ua: "test-ua",
      ours: fakeOurs([entry], 100),
      sampleSize: 1,
      fetchImpl: fakeUpstreamFetch(byName, 100),
      sleepImpl: async () => {},
    });
    expect(summary.ok).toBe(true);
    expect(summary.layoutCount).toEqual({ upstream: 100, ours: 100, equal: true });
    expect(summary.sampleSize).toBe(1);
    expect(summary.matched).toBe(1);
    expect(summary.contentDiffs).toEqual([]);
  });

  it("[LDB-P5] a layout_count mismatch fails ok even when the sample matches", async () => {
    const entry = toOursEntry(graphite, "id-graphite");
    const byName = new Map([["graphite", graphite]]);
    const summary = await diffUpstream({
      upstreamUrl: "https://up.example",
      ua: "test-ua",
      ours: fakeOurs([entry], 99),
      sampleSize: 1,
      fetchImpl: fakeUpstreamFetch(byName, 100),
      sleepImpl: async () => {},
    });
    expect(summary.ok).toBe(false);
    expect(summary.layoutCount.equal).toBe(false);
  });

  it("[LDB-P5] a content difference in the sample is reported and fails ok", async () => {
    const entry = toOursEntry(graphite, "id-graphite");
    // graphite's own fixture board is already "ortho" (07 §5.3) -- mutate a
    // key's finger instead, a real, unambiguous content difference.
    const mutated = structuredClone(graphite);
    const keys = mutated.keys as Record<string, { row: number; col: number; finger: string }>;
    const firstChar = Object.keys(keys).sort()[0]!;
    keys[firstChar]!.finger = keys[firstChar]!.finger === "LP" ? "LR" : "LP";
    const byName = new Map([["graphite", mutated]]);
    const summary = await diffUpstream({
      upstreamUrl: "https://up.example",
      ua: "test-ua",
      ours: fakeOurs([entry], 100),
      sampleSize: 1,
      fetchImpl: fakeUpstreamFetch(byName, 100),
      sleepImpl: async () => {},
    });
    expect(summary.ok).toBe(false);
    expect(summary.contentDiffs).toHaveLength(1);
    expect(summary.contentDiffs[0]!.name).toBe("graphite");
  });

  it("[LDB-P5] a sampled name upstream no longer answers for is reported under 'missing'", async () => {
    const entry = toOursEntry(graphite, "id-graphite");
    const summary = await diffUpstream({
      upstreamUrl: "https://up.example",
      ua: "test-ua",
      ours: fakeOurs([entry], 100),
      sampleSize: 1,
      fetchImpl: fakeUpstreamFetch(new Map(), 100), // upstream has nothing by this name -> 404
      sleepImpl: async () => {},
    });
    expect(summary.ok).toBe(false);
    expect(summary.missing).toHaveLength(1);
    expect(summary.missing[0]!.name).toBe("graphite");
  });
});
