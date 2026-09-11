// [LDB-P5] The offline half of the D12 diff (07 §6 S8): `parseUpstreamRaw`
// / `compareRecords` / `diffCorpus` from `src/import/diff.ts`, over the
// frozen `upstream-100` snapshot -- no network, so this runs on every PR,
// not just the daily job (`tests/upstream-diff.test.ts` owns the live half).
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  diffCorpus,
  httpOurs,
  parseUpstreamRaw,
  pathDiff,
  type FetchImpl,
  type OursEntry,
  type OursSource,
  type UpstreamEntry,
} from "../../src/import/diff";

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

// Defaults to `following` -- the base fixture's whole premise is "ours
// mirrors upstream exactly", so a fresh `OursEntry` built straight off a
// raw upstream detail is, by construction, still following it. Individual
// tests below override `upstream` to exercise `forked`/`null`/`extra`.
function toOursEntry(raw: Record<string, unknown>, ref: string): OursEntry {
  const parsed = parseUpstreamRaw(raw);
  if (!parsed.ok) throw new Error(`fixture '${String(raw.name)}' failed parseUpstreamRaw: ${parsed.error.message}`);
  return { ...parsed.detail, ref, upstream: { source: "cmini", id: ref, state: "following" } };
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

  // 20-spark.md S3b (LDB-I13): a detail that's schema-valid per cmini/1 but
  // fails spark's OWN (stricter) semantic validate -- here, a magic rule
  // whose trigger key isn't among the layout's own `keys` -- is reported as
  // an `invalidUpstream`-shaped parse failure, never thrown. This is the
  // same class of finding the daily diff surfaces as a `corpus.invalidUpstream`
  // line for real upstream data (`tests/upstream-diff.test.ts`, live).
  it("[LDB-I13] a cmini/1-valid detail whose fromCmini fails spark's own validate is reported, not thrown", () => {
    const raw = {
      name: "Bad-Magic",
      user: "1234567890123456789",
      created_at: "2026-01-01T00:00:00Z",
      modified_at: "2026-01-01T00:00:00Z",
      board: "ortho",
      keys: {},
      // cmini/1 caps no string field; spark/1 caps `x` (where cmini's
      // tag/blame/combos/link land) at 16 KiB canonical. (Was a magic key
      // missing from the layout, which spark/1 accepts since 2026-09-11,
      // LDB-F22, matching akl.gg.)
      blame: "x".repeat(17000),
    };
    const parsed = parseUpstreamRaw(raw);
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) {
      expect(parsed.error.path).toBe("/x");
      expect(parsed.error.message).toContain("over the 16384-byte cap");
    }
  });
});

describe("diffCorpus over upstream-100 against itself", () => {
  it("[LDB-P5] zero differences: every entry matches, none missing, none extra, none unresolved", () => {
    const raws = loadFixture();
    const { upstream, ours } = corpusMaps(raws);
    const result = diffCorpus(upstream, ours);
    expect(result.missing).toEqual([]);
    expect(result.invalidUpstream).toEqual([]);
    expect(result.contentDiffs).toEqual([]);
    expect(result.extra).toEqual([]);
    expect(result.divergent).toEqual([]);
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
    // 20-spark.md S3b: comparison happens in spark now, nested under
    // `payload` (unlike cmini/1's flat `keys` top-level).
    expect(result.contentDiffs[0]!.path).toBe(`/payload/keys/${firstChar}/finger`);
    expect(result.matched).toBe(raws.length - 1);
  });

  it("[LDB-P5] a mutated top-level scalar (board) is reported under /payload/board", () => {
    const raws = loadFixture();
    const { upstream, ours } = corpusMaps(raws);
    const abyss = raws.find((r) => r.name === "abyss"); // angle, per 07 §5.3
    expect(abyss).toBeDefined();
    const mutated = { ...(abyss as Record<string, unknown>), board: "ortho" };
    ours.set("abyss", toOursEntry(mutated, "id-abyss"));

    const result = diffCorpus(upstream, ours);
    const diff = result.contentDiffs.find((d) => d.name === "abyss");
    // cmini's bare `board` word becomes spark's `{kind, stagger?, cmini}`
    // object on both sides -- "angle" vs "ortho" disagree on every key, so
    // `pathDiff`'s sorted-key walk reports the first one, `cmini`.
    expect(diff?.path).toBe("/payload/board/cmini");
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

  // M1 (design/layout-db/17-magic-ownership.md §3): `compareRecords`
  // (import/diff.ts) drops `magic` on both sides (20-spark.md S3b: in
  // spark now, not cmini/1), so magic never surfaces as a mirror
  // difference -- upstream's magic is never akl.gg's, and a followed
  // record's own (nothing today; akl.gg's rules once M2 lands) is never
  // one either.
  it("[LDB-P5] [LDB-I11] our copy carrying DIFFERENT magic than upstream's is NOT a content difference", () => {
    const raws = loadFixture();
    const { upstream, ours } = corpusMaps(raws);
    const opal = raws.find((r) => r.name === "opal");
    expect(opal).toBeDefined();
    const opalMagic = (opal as { magic?: unknown[] }).magic;
    expect(opalMagic).toBeDefined();
    expect((opalMagic as unknown[]).length).toBeGreaterThan(0); // 07 §5.3: opal is a real magic fixture

    const mutated = { ...(opal as Record<string, unknown>), magic: [{ inputs: "q◇", output: "qq", type: "repeat" }] };
    ours.set("opal", toOursEntry(mutated, "id-opal"));

    const result = diffCorpus(upstream, ours);
    expect(result.contentDiffs).toEqual([]);
    expect(result.matched).toBe(raws.length);
  });

  it("[LDB-P5] [LDB-I11] our copy dropping magic entirely (upstream still has it) is NOT a content difference", () => {
    const raws = loadFixture();
    const { upstream, ours } = corpusMaps(raws);
    const opal = raws.find((r) => r.name === "opal");
    const { magic: _magic, ...withoutMagic } = opal as Record<string, unknown>;
    ours.set("opal", toOursEntry(withoutMagic, "id-opal"));

    const result = diffCorpus(upstream, ours);
    expect(result.contentDiffs).toEqual([]);
    expect(result.matched).toBe(raws.length);
  });

  it("[LDB-P5] [LDB-I11] a genuine non-magic difference is still reported even when magic ALSO differs", () => {
    const raws = loadFixture();
    const { upstream, ours } = corpusMaps(raws);
    const opal = raws.find((r) => r.name === "opal");
    const mutated = { ...(opal as Record<string, unknown>), board: "ortho", magic: [{ inputs: "q◇", output: "qq", type: "repeat" }] };
    ours.set("opal", toOursEntry(mutated, "id-opal"));

    const result = diffCorpus(upstream, ours);
    const diff = result.contentDiffs.find((d) => d.name === "opal");
    expect(diff?.path).toBe("/payload/board/cmini"); // the real difference, never magic's own path
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
    ours.set("ghost-of-graphite", { ...graphite, name: "ghost-of-graphite" }); // upstream: following, inherited from toOursEntry's default

    const result = diffCorpus(upstream, ours);
    expect(result.extra).toEqual([
      {
        name: "ghost-of-graphite",
        path: "/",
        message: "follows upstream but upstream no longer lists a layout by this name",
      },
    ]);
  });

  // 20-spark.md S3b (§8 R-H6): follow status is read straight off
  // `OursEntry.upstream` -- there's no more "unresolved" state to wait on
  // (every entry from `full()` already carries it), so both non-following
  // states (forked, and no link at all) are exercised directly here.
  it("[LDB-P5] a local-only FORKED record is skipped entirely (not extra, not a failure)", () => {
    const raws = loadFixture();
    const { upstream, ours } = corpusMaps(raws);
    const graphite = ours.get("graphite")!;
    ours.set("locally-owned", { ...graphite, name: "locally-owned", upstream: { source: "cmini", id: "id-locally-owned", state: "forked" } });

    const result = diffCorpus(upstream, ours);
    expect(result.extra).toEqual([]);
  });

  it("[LDB-P5] a local-only record with NO upstream link at all is skipped entirely (not extra, not a failure)", () => {
    const raws = loadFixture();
    const { upstream, ours } = corpusMaps(raws);
    const graphite = ours.get("graphite")!;
    ours.set("plain-local", { ...graphite, name: "plain-local", upstream: null });

    const result = diffCorpus(upstream, ours);
    expect(result.extra).toEqual([]);
  });

  it("[LDB-P5] an invalid upstream detail is reported under 'invalidUpstream' with its shape path, not thrown", () => {
    const raws = loadFixture();
    const { upstream, ours } = corpusMaps(raws);
    upstream.set("graphite", { name: "graphite", parsed: { ok: false, error: { path: "/user", message: "boom" } } });

    const result = diffCorpus(upstream, ours);
    expect(result.invalidUpstream).toEqual([{ name: "graphite", path: "/user", message: "boom" }]);
    expect(result.contentDiffs).toEqual([]);
  });

  // 20-spark.md S3b (LDB-P5 amended, decision 16): a name-matched local
  // record that's forked (or unlinked) is never content-compared -- it's
  // `divergent`, informational, and never a `contentDiffs`/failure entry,
  // even when its content genuinely differs from upstream's.
  it("[LDB-P5] a name-matched FORKED record is 'divergent', never a content diff, even when content differs", () => {
    const raws = loadFixture();
    const { upstream, ours } = corpusMaps(raws);
    const graphite = ours.get("graphite")!;
    ours.set("graphite", { ...graphite, upstream: { source: "cmini", id: "id-graphite", state: "forked" }, payload: { ...graphite.payload, board: { kind: "ortho", cmini: "ortho" } } });

    const result = diffCorpus(upstream, ours);
    expect(result.divergent).toEqual([
      { name: "graphite", path: "/", message: "name-matched local record is forked from upstream" },
    ]);
    expect(result.contentDiffs).toEqual([]);
    expect(result.matched).toBe(raws.length - 1);
  });

  it("[LDB-P5] a name-matched record with NO upstream link is 'unresolved' (a failure), never 'divergent' or a content diff", () => {
    const raws = loadFixture();
    const { upstream, ours } = corpusMaps(raws);
    const graphite = ours.get("graphite")!;
    ours.set("graphite", { ...graphite, upstream: null });

    const result = diffCorpus(upstream, ours);
    expect(result.unresolved).toHaveLength(1);
    expect(result.unresolved[0]!.name).toBe("graphite");
    expect(result.divergent).toEqual([]);
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

// X4 (12 §3 X4): `httpOurs` is the pre-X4 "our side" behaviour, moved
// unchanged behind `OursSource` -- this is the moved code's own regression
// suite, over a hand-built fake DB (no D1, no miniflare: `httpOurs` never
// touches either, only `fetchImpl`, so this belongs in the "node" project
// alongside the rest of this file).
describe("httpOurs (X4: the moved HTTP-based OursSource)", () => {
  const BASE = "https://ours.example";

  // 20-spark.md S3b: `?full=1&as=spark/1` items -- spark-shaped payloads,
  // each carrying its own `upstream` link straight on the wire (§8 R-H6:
  // no more `/history` follow-up for follow status).
  const OUR_ITEMS = [
    {
      id: "id-alpha",
      name: "alpha",
      owner: "111111111111111111",
      created_at: "2026-01-01T00:00:00Z",
      modified_at: "2026-01-02T00:00:00Z",
      like_count: 0,
      likes: [] as string[],
      payload: { board: { kind: "ortho", cmini: "ortho" }, keys: {} },
      upstream: { source: "cmini", id: "up-alpha", state: "following" },
    },
    {
      id: "id-beta",
      name: "beta",
      owner: "222222222222222222",
      created_at: "2026-01-01T00:00:00Z",
      modified_at: "2026-01-02T00:00:00Z",
      like_count: 0,
      held: true,
    },
    {
      id: "id-gamma",
      name: "gamma",
      owner: "333333333333333333",
      created_at: "2026-01-01T00:00:00Z",
      modified_at: "2026-01-02T00:00:00Z",
      like_count: 2,
      // No inline `likes` -- forces the /likes fallback (the older-build
      // shape `resolveOurLikes` still supports, unchanged by the move).
      payload: { board: { kind: "ortho", cmini: "ortho" }, keys: {} },
      upstream: { source: "cmini", id: "up-gamma", state: "forked" }, // a later human edit forked it
    },
  ];

  function fakeFetch(): FetchImpl {
    return async (url) => {
      const u = new URL(url);
      if (u.pathname === "/v1/layouts" && u.searchParams.get("full") === "1") {
        return new Response(JSON.stringify({ items: OUR_ITEMS }), { status: 200 });
      }
      if (u.pathname === "/v1/authors") {
        return new Response(JSON.stringify({ alpha: "111111111111111111", gamma: "333333333333333333" }), { status: 200 });
      }
      if (u.pathname === "/v1/meta") {
        // alpha + gamma; `beta` is `held` and excluded, same as
        // `/v1/meta.layout_count` (a held record is still a live record --
        // this fixture's `2` is just what this fake chose to report, not a
        // rule `httpOurs` enforces).
        return new Response(JSON.stringify({ layout_count: 2 }), { status: 200 });
      }
      const likesMatch = /^\/v1\/layouts\/([^/]+)\/likes$/.exec(u.pathname);
      if (likesMatch) {
        return new Response(JSON.stringify({ user_ids: ["444444444444444444", "555555555555555555"] }), { status: 200 });
      }
      throw new Error(`fakeFetch: unhandled ${url}`);
    };
  }

  it("[LDB-P5] full() yields every live record as an OursEntry (with its own upstream link), plus the name of every held one", async () => {
    const ours: OursSource = httpOurs(BASE, fakeFetch());
    const entries: (OursEntry | { held: string })[] = [];
    for await (const item of ours.full()) entries.push(item);

    expect(entries).toHaveLength(3);
    const alpha = entries.find((e) => "ref" in e && e.name === "alpha") as OursEntry;
    expect(alpha.ref).toBe("id-alpha");
    expect(alpha.owner).toBe("111111111111111111");
    expect(alpha.upstream).toEqual({ source: "cmini", id: "up-alpha", state: "following" });

    const heldEntry = entries.find((e) => "held" in e) as { held: string };
    expect(heldEntry.held).toBe("beta");

    const gamma = entries.find((e) => "ref" in e && e.name === "gamma") as OursEntry;
    expect(gamma.likes).toEqual(["444444444444444444", "555555555555555555"]);
    expect(gamma.upstream).toEqual({ source: "cmini", id: "up-gamma", state: "forked" });
  });

  it("[LDB-P5] authors() reproduces /v1/authors' {name: id} shape", async () => {
    const ours = httpOurs(BASE, fakeFetch());
    await expect(ours.authors()).resolves.toEqual({ alpha: "111111111111111111", gamma: "333333333333333333" });
  });

  it("[LDB-P5] layoutCount() reproduces /v1/meta's layout_count", async () => {
    const ours = httpOurs(BASE, fakeFetch());
    await expect(ours.layoutCount()).resolves.toBe(2);
  });
});
