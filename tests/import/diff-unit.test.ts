// [LDB-P5] The offline half of the D12 diff (07 §6 S8): `parseUpstreamRaw`
// / `compareRecords` / `diffCorpus` from `src/import/diff.ts`, over the
// frozen `upstream-100` snapshot -- no network, so this runs on every PR,
// not just the daily job (`tests/upstream-diff.test.ts` owns the live half).
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { diffCorpus, parseUpstreamRaw, pathDiff, type OursEntry, type UpstreamEntry } from "../../src/import/diff";

const FIXTURE_DIR = path.join(import.meta.dirname, "..", "fixtures", "upstream-100");

interface RawFull {
  layouts: Record<string, unknown>[];
}

function loadFixture(): Record<string, unknown>[] {
  const full = JSON.parse(fs.readFileSync(path.join(FIXTURE_DIR, "full.json"), "utf8")) as RawFull;
  return full.layouts;
}

// A raw fixture detail, parsed once, turned into both an `UpstreamEntry`
// and (same content) an `OursEntry` -- the identity case every test below
// starts from before mutating one side.
function toUpstreamEntry(raw: Record<string, unknown>): UpstreamEntry {
  const name = raw.name as string;
  return { name, parsed: parseUpstreamRaw(raw) };
}

function toOursEntry(raw: Record<string, unknown>, ref: string): OursEntry {
  const parsed = parseUpstreamRaw(raw);
  if (!parsed.ok) throw new Error(`fixture '${String(raw.name)}' failed parseUpstreamRaw: ${parsed.error.message}`);
  return { ...parsed.detail, ref };
}

function corpusMaps(raws: Record<string, unknown>[]): { upstream: Map<string, UpstreamEntry>; ours: Map<string, OursEntry> } {
  const upstream = new Map<string, UpstreamEntry>();
  const ours = new Map<string, OursEntry>();
  for (const raw of raws) {
    const name = raw.name as string;
    const key = name.toLowerCase();
    upstream.set(key, toUpstreamEntry(raw));
    ours.set(key, toOursEntry(raw, `id-${key}`));
  }
  return { upstream, ours };
}

describe("parseUpstreamRaw over upstream-100", () => {
  it("[LDB-P5] every fixture detail parses ok (LDB-F11 already covers schema validity; this checks the record-field half too)", () => {
    for (const raw of loadFixture()) {
      const parsed = parseUpstreamRaw(raw);
      expect(parsed.ok, `'${String(raw.name)}': ${!parsed.ok ? parsed.error.message : ""}`).toBe(true);
    }
  });
});

describe("diffCorpus over upstream-100 against itself", () => {
  it("[LDB-P5] zero differences: every entry matches, none missing, none extra", () => {
    const raws = loadFixture();
    const { upstream, ours } = corpusMaps(raws);
    const result = diffCorpus(upstream, ours);
    expect(result.missing).toEqual([]);
    expect(result.invalidUpstream).toEqual([]);
    expect(result.contentDiffs).toEqual([]);
    expect(result.extra).toEqual([]);
    expect(result.extraUnresolved).toEqual([]);
    expect(result.matched).toBe(raws.length);
  });

  it("[LDB-P5] a mutated payload field is reported at its own path", () => {
    const raws = loadFixture();
    const graphite = raws.find((r) => r.name === "graphite");
    expect(graphite).toBeDefined();
    const { upstream, ours } = corpusMaps(raws);

    // Mutate ONE key's row in the local copy only -- graphite's `keys` is
    // known non-empty (07 §5.3: it's the repo's canonical fixture).
    const mutated = structuredClone(graphite) as Record<string, unknown>;
    const keys = mutated.keys as Record<string, { row: number; col: number; finger: string }>;
    const firstChar = Object.keys(keys).sort()[0]!;
    // Flip `finger` only -- leaves every key's (row, col) untouched, so
    // this can never collide with `findDuplicatePosition`'s dedup check
    // the way mutating `row`/`col` risked on a dense real layout.
    keys[firstChar]!.finger = keys[firstChar]!.finger === "LP" ? "LR" : "LP";
    ours.set("graphite", toOursEntry(mutated, "id-graphite"));

    const result = diffCorpus(upstream, ours);
    expect(result.contentDiffs).toHaveLength(1);
    expect(result.contentDiffs[0]!.name).toBe("graphite");
    expect(result.contentDiffs[0]!.path).toBe(`/keys/${firstChar}/finger`);
    expect(result.matched).toBe(raws.length - 1);
  });

  it("[LDB-P5] a mutated top-level scalar (board) is reported at /board", () => {
    const raws = loadFixture();
    const { upstream, ours } = corpusMaps(raws);
    const abyss = raws.find((r) => r.name === "abyss"); // angle, per 07 §5.3
    expect(abyss).toBeDefined();
    const mutated = { ...(abyss as Record<string, unknown>), board: "ortho" };
    ours.set("abyss", toOursEntry(mutated, "id-abyss"));

    const result = diffCorpus(upstream, ours);
    const diff = result.contentDiffs.find((d) => d.name === "abyss");
    expect(diff?.path).toBe("/board");
  });

  it("[LDB-P5] likes compared sorted -- reordering our copy's likes is NOT a difference", () => {
    const raws = loadFixture();
    const { upstream, ours } = corpusMaps(raws);
    const graphite = ours.get("graphite")!;
    expect(graphite.likes.length).toBeGreaterThan(1); // 07 §5.3: graphite has real likes
    ours.set("graphite", { ...graphite, likes: [...graphite.likes].reverse() });

    const result = diffCorpus(upstream, ours);
    expect(result.contentDiffs).toEqual([]);
    expect(result.matched).toBe(raws.length);
  });

  it("[LDB-P5] a genuine likes difference IS reported, under /likes", () => {
    const raws = loadFixture();
    const { upstream, ours } = corpusMaps(raws);
    const graphite = ours.get("graphite")!;
    ours.set("graphite", { ...graphite, likes: graphite.likes.slice(1) }); // drop one like

    const result = diffCorpus(upstream, ours);
    const diff = result.contentDiffs.find((d) => d.name === "graphite");
    // Element-wise array compare (pathDiff), so a dropped element reports
    // at whichever index first disagrees after the shift, not the whole
    // array -- `/likes` itself, not a fixed sub-index.
    expect(diff?.path).toMatch(/^\/likes(\/\d+)?$/);
  });

  it("[LDB-P5] a missing local record is reported under 'missing'", () => {
    const raws = loadFixture();
    const { upstream, ours } = corpusMaps(raws);
    ours.delete("graphite");

    const result = diffCorpus(upstream, ours);
    expect(result.missing).toEqual([{ name: "graphite", path: "/", message: "no local record by this name" }]);
    expect(result.matched).toBe(raws.length - 1);
  });

  it("[LDB-P5] a local-only record that follows upstream is reported under 'extra'", () => {
    const raws = loadFixture();
    const { upstream, ours } = corpusMaps(raws);
    const graphite = ours.get("graphite")!;
    ours.set("ghost-of-graphite", { ...graphite, name: "ghost-of-graphite", followsUpstream: true });

    const result = diffCorpus(upstream, ours);
    expect(result.extra).toEqual([
      {
        name: "ghost-of-graphite",
        path: "/",
        message: "follows upstream but upstream no longer lists a layout by this name",
      },
    ]);
    expect(result.extraUnresolved).toEqual([]);
  });

  it("[LDB-P5] a local-only record that does NOT follow upstream is skipped entirely (not extra, not unresolved)", () => {
    const raws = loadFixture();
    const { upstream, ours } = corpusMaps(raws);
    const graphite = ours.get("graphite")!;
    ours.set("locally-owned", { ...graphite, name: "locally-owned", followsUpstream: false });

    const result = diffCorpus(upstream, ours);
    expect(result.extra).toEqual([]);
    expect(result.extraUnresolved).toEqual([]);
  });

  it("[LDB-P5] a local-only record with unresolved follow status is reported separately, never silently dropped or counted as extra", () => {
    const raws = loadFixture();
    const { upstream, ours } = corpusMaps(raws);
    const graphite = ours.get("graphite")!;
    ours.set("mystery", { ...graphite, name: "mystery" }); // followsUpstream left undefined

    const result = diffCorpus(upstream, ours);
    expect(result.extra).toEqual([]);
    expect(result.extraUnresolved).toEqual(["mystery"]);
  });

  it("[LDB-P5] an invalid upstream detail is reported under 'invalidUpstream' with its shape path, not thrown", () => {
    const raws = loadFixture();
    const { upstream, ours } = corpusMaps(raws);
    upstream.set("graphite", { name: "graphite", parsed: { ok: false, error: { path: "/user", message: "boom" } } });

    const result = diffCorpus(upstream, ours);
    expect(result.invalidUpstream).toEqual([{ name: "graphite", path: "/user", message: "boom" }]);
    expect(result.contentDiffs).toEqual([]);
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
