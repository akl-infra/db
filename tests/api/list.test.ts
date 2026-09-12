// [LDB-F5] [LDB-R4] `GET /v1/layouts?format=spark/1` (21-formats.md §2.4):
// a keyset cursor walk of any sort/limit visits every live record exactly
// once, in order; every filter equals a plain JS filter over the seed;
// `?full=1` streams every live record's payload, matching `fromCmini` of
// the upstream fixture's own shape.
import { SELF } from "cloudflare:test";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import fullSnapshot from "../fixtures/upstream-100/full.json" with { type: "json" };
import { canonical } from "../../src/core/canonical";
import { parseUpstreamDetail } from "../../src/import/apply";
import { fromCmini } from "../../formats/adapters/cmini/translate.ts";
import type { RawUpstreamDetail } from "../../src/import/upstream";
import { db, seedUpstream100 } from "./support";
import { commitWrite, type CommitInput } from "../../src/core/events";
import { formatsForLayout, readById } from "../../src/core/records";
import { fixedClock } from "../../src/core/time";
import { registerForTest } from "../../formats/registry.ts";
import { T1, T2, T3 } from "../formats/stub-lineage.ts";
import { ulid } from "ulidx";

beforeAll(async () => {
  await seedUpstream100();
});

interface ListItem {
  id: string;
  owner: string;
  format: string;
  has_magic: boolean;
  modified_at: string;
}

async function walkAll(sort: string, limit: number): Promise<string[]> {
  const ids: string[] = [];
  let cursor: string | undefined;
  for (;;) {
    const qs = new URLSearchParams({ format: "spark/1", sort, limit: String(limit) });
    if (cursor !== undefined) qs.set("cursor", cursor);
    const res = await SELF.fetch(`https://example.com/v1/layouts?${qs.toString()}`);
    expect(res.status).toBe(200);
    const body = await res.json<{ items: ListItem[]; next_cursor: string | null }>();
    for (const item of body.items) ids.push(item.id);
    if (body.next_cursor === null) break;
    cursor = body.next_cursor;
  }
  return ids;
}

const SORT_ORDER_SQL: Record<string, string> = {
  name: "ORDER BY name COLLATE NOCASE ASC, id ASC",
  modified_at: "ORDER BY modified_at DESC, id ASC",
  created_at: "ORDER BY created_at DESC, id ASC",
  like_count: "ORDER BY like_count DESC, id ASC",
};

async function expectedOrder(sort: string): Promise<string[]> {
  const { results } = await db.prepare(`SELECT id FROM layouts WHERE deleted = 0 ${SORT_ORDER_SQL[sort]}`).all<{ id: string }>();
  return results.map((r) => r.id);
}

async function loadSeedRows(): Promise<ListItem[]> {
  const { results } = await db
    .prepare(
      `SELECT l.id AS id, l.owner AS owner, f.format AS format, f.has_magic AS has_magic, l.modified_at AS modified_at
       FROM layouts l JOIN layout_formats f ON f.layout_id = l.id AND f.lineage = 'spark'
       WHERE l.deleted = 0`,
    )
    .all<{ id: string; owner: string; format: string; has_magic: number; modified_at: string }>();
  return results.map((r) => ({ ...r, has_magic: r.has_magic !== 0 }));
}

describe("[LDB-R4] every sort x limit cursor walk visits every live record exactly once, in order", () => {
  const sorts = ["name", "modified_at", "created_at", "like_count"];
  const limits = [1, 7, 100];

  for (const sort of sorts) {
    for (const limit of limits) {
      it(`[LDB-R4] sort=${sort} limit=${limit}`, async () => {
        const walked = await walkAll(sort, limit);
        const expected = await expectedOrder(sort);
        expect(walked).toEqual(expected);
        expect(new Set(walked).size).toBe(walked.length); // no repeats
      });
    }
  }
});

describe("[LDB-F5] every filter equals a plain JS filter over the seed", () => {
  it("[LDB-F5] owner=", async () => {
    const seed = await loadSeedRows();
    const owner = seed[0]!.owner;
    const expected = new Set(seed.filter((r) => r.owner === owner).map((r) => r.id));
    expect(expected.size).toBeGreaterThan(0);

    const res = await SELF.fetch(`https://example.com/v1/layouts?format=spark/1&owner=${owner}&limit=1000`);
    const body = await res.json<{ items: ListItem[] }>();
    expect(new Set(body.items.map((i) => i.id))).toEqual(expected);
  });

  // 21-formats.md D4: `format` is no longer an optional equality filter --
  // it's the required selector itself (every seed record is spark/1, one
  // lineage), so this now just confirms the selector returns the full set.
  it("[LDB-F5] format=spark/1 selects the whole seed (every record is stored spark/1)", async () => {
    const seed = await loadSeedRows();
    const expected = new Set(seed.map((r) => r.id));

    const res = await SELF.fetch(`https://example.com/v1/layouts?format=spark/1&limit=1000`);
    const body = await res.json<{ items: ListItem[] }>();
    expect(new Set(body.items.map((i) => i.id))).toEqual(expected);
  });

  it("[LDB-F5] has_magic=true and has_magic=false partition the seed", async () => {
    // M1 (LDB-I10): a fresh import never sets has_magic=true -- upstream's
    // magic is stripped before it ever reaches a payload. Flip one seed
    // record's `has_magic` directly on its SPARK format row to exercise
    // the true branch.
    const seedRows = await loadSeedRows();
    await db.prepare("UPDATE layout_formats SET has_magic = 1 WHERE layout_id = ? AND lineage = 'spark'").bind(seedRows[0]!.id).run();

    const seed = await loadSeedRows();
    const expectedTrue = new Set(seed.filter((r) => r.has_magic).map((r) => r.id));
    const expectedFalse = new Set(seed.filter((r) => !r.has_magic).map((r) => r.id));
    expect(expectedTrue.size + expectedFalse.size).toBe(seed.length);
    expect(expectedTrue.size).toBeGreaterThan(0);

    const trueRes = await SELF.fetch("https://example.com/v1/layouts?format=spark/1&has_magic=true&limit=1000");
    const trueBody = await trueRes.json<{ items: ListItem[] }>();
    expect(new Set(trueBody.items.map((i) => i.id))).toEqual(expectedTrue);

    const falseRes = await SELF.fetch("https://example.com/v1/layouts?format=spark/1&has_magic=false&limit=1000");
    const falseBody = await falseRes.json<{ items: ListItem[] }>();
    expect(new Set(falseBody.items.map((i) => i.id))).toEqual(expectedFalse);
  });

  it("[LDB-F5] since=<iso> (modified_at > since)", async () => {
    const seed = await loadSeedRows();
    const sortedByModified = [...seed].sort((a, b) => (a.modified_at < b.modified_at ? -1 : 1));
    const since = sortedByModified[Math.floor(sortedByModified.length / 2)]!.modified_at;
    const expected = new Set(seed.filter((r) => r.modified_at > since).map((r) => r.id));

    const res = await SELF.fetch(`https://example.com/v1/layouts?format=spark/1&since=${encodeURIComponent(since)}&limit=1000`);
    const body = await res.json<{ items: ListItem[] }>();
    expect(new Set(body.items.map((i) => i.id))).toEqual(expected);
  });
});

// [H1] Coordinator review (2026-09-11): the plain list must not carry a
// payload at all (21-formats.md §2.4: rows are the §2.3 fields MINUS
// payload -- full=1 is the only route that adds it back), and `formats`
// must list EVERY stored format a layout has, not just the one lineage
// `?format=` joined on for filtering/translation. Exercised with a real
// SECOND stored lineage (`tests/formats/stub-lineage.ts`'s `T1`,
// registered for this file only) added to one seeded layout.
describe("[H1] plain list: no payload, formats map is complete", () => {
  const clock = fixedClock("2026-07-20T00:00:00.000Z");
  let unregisterT1: () => void;
  let twoFormatLayoutId: string;
  let twoFormatLayoutOwner: string;

  beforeAll(async () => {
    unregisterT1 = registerForTest(T1);
    const seedRows = await loadSeedRows();
    const targetId = seedRows[0]!.id;
    const current = await readById(db, targetId);
    const currentFormats = await formatsForLayout(db, targetId);
    const input: CommitInput = {
      layoutId: targetId,
      creating: false,
      currentN: current!.n,
      currentLayout: current,
      currentFormats,
      format: { kind: "format_added", lineage: "t", format: "t/1", payload: { v: 1, a: 1 }, hasMagic: false },
      modified_at: clock(),
      actor: current!.owner,
      via: "discord",
      source: { client: "discord-app:test", version: null },
      upstream: current!.upstream,
    };
    await commitWrite(db, clock, input);
    twoFormatLayoutId = targetId;
    twoFormatLayoutOwner = current!.owner;
  });

  afterAll(() => {
    unregisterT1();
  });

  it("[H1] a plain row carries no `payload` (and no `derived_from`) at all", async () => {
    const res = await SELF.fetch("https://example.com/v1/layouts?format=spark/1&limit=1000");
    expect(res.status).toBe(200);
    const body = await res.json<{ items: Record<string, unknown>[] }>();
    expect(body.items.length).toBeGreaterThan(0);
    for (const item of body.items) {
      expect(Object.prototype.hasOwnProperty.call(item, "payload")).toBe(false);
      expect(Object.prototype.hasOwnProperty.call(item, "derived_from")).toBe(false);
    }
  });

  it("[H1] formats includes a layout's SECOND stored lineage, not just the one ?format= filtered on", async () => {
    const res = await SELF.fetch(`https://example.com/v1/layouts?format=spark/1&owner=${twoFormatLayoutOwner}&limit=1000`);
    expect(res.status).toBe(200);
    const body = await res.json<{ items: { id: string; formats: Record<string, { rev: number }> }[] }>();
    const item = body.items.find((i) => i.id === twoFormatLayoutId);
    expect(item, "the two-format layout must still appear under ?format=spark/1").toBeDefined();
    expect(Object.keys(item!.formats).sort()).toEqual(["spark/1", "t/1"]);
    expect(item!.formats["t/1"]!.rev).toBe(1);
  });

  it("[H1] ?full=1 also gets the complete formats map (in addition to its own payload)", async () => {
    const res = await SELF.fetch("https://example.com/v1/layouts?full=1&format=spark/1");
    expect(res.status).toBe(200);
    const body = await res.json<{ items: { id: string; formats: Record<string, { rev: number }>; payload: unknown }[] }>();
    const item = body.items.find((i) => i.id === twoFormatLayoutId);
    expect(item).toBeDefined();
    expect(Object.keys(item!.formats).sort()).toEqual(["spark/1", "t/1"]);
    expect(item!.payload).toBeDefined();
  });
});

// [LDB-P13] Coordinator review (LOW, third batch): the plain list route
// skips selecting/parsing every row's `payload_json` (and thus its own
// `translate()` call) whenever it can prove, from the registry alone,
// that no row could possibly need it -- which requires MORE than "the
// caller asked for the latest major": `chainToLatest` upgrades a row's
// stored major only on its OWN next write, never as a background
// migration, so a row can genuinely sit at an older major indefinitely
// once a newer one ships. This proves the guard actually checks
// `latestOf(lineage) === 1` (only one major has EVER existed for this
// lineage), not just "requesting today's latest" -- a record written
// while `t` had only `t/1` registered, still genuinely stored as `t/1`
// after `t/2`/`t/3` are registered (never re-written), must still
// translate correctly on `?format=t/3` rather than skip its own payload
// fetch and hand `translate()` `undefined`.
describe("[LDB-P13] plain list still fetches/translates a row genuinely stuck at an older major of a NOW-chained lineage", () => {
  it("[LDB-P13] a t/1-native row survives ?format=t/3 on the plain list once t/2 and t/3 are ALSO registered", async () => {
    const unregisterT1 = registerForTest(T1);
    let recordId: string;
    try {
      const input: CommitInput = {
        layoutId: ulid(),
        creating: true,
        currentN: 0,
        currentLayout: null,
        currentFormats: new Map(),
        layout: { kind: "created", name: "chained-list-stuck-old-major", owner: "900000000000000001", created_at: "2026-07-21T00:00:00.000Z", deleted: false },
        format: { kind: "format_added", lineage: "t", format: "t/1", payload: { v: 1, a: 1 }, hasMagic: false },
        modified_at: "2026-07-21T00:00:00.000Z",
        actor: "900000000000000001",
        via: "discord",
        source: { client: "discord-app:test", version: null },
        upstream: null,
      };
      const { layout } = await commitWrite(db, fixedClock("2026-07-21T00:00:00.000Z"), input);
      recordId = layout.id;

      // Register t/2 and t/3 AFTER the record above was written -- it is
      // never re-written, so it is still genuinely stored as t/1 even
      // though `latestOf("t")` is now 3.
      const unregisterT2 = registerForTest(T2);
      const unregisterT3 = registerForTest(T3);
      try {
        const res = await SELF.fetch("https://example.com/v1/layouts?format=t/3");
        expect(res.status).toBe(200);
        const body = await res.json<{ items: { id: string; format: string }[] }>();
        const row = body.items.find((i) => i.id === recordId);
        expect(row, "the t/1-native row must still appear under ?format=t/3").toBeDefined();
        // up() never holds (LDB-F18) -- a correct translate() call proves
        // the payload really was fetched, not skipped.
        expect(row?.format).toBe("t/3");
      } finally {
        unregisterT3();
        unregisterT2();
      }
    } finally {
      unregisterT1();
    }
  });
});

// [LDB-R8] 10 C1: `liked_by` equals a plain JS filter over the seed's own
// `likes` rows, composable with every other filter/sort, and rides on
// `?full=1` too.
describe("[LDB-R8] liked_by=<user_id>", () => {
  async function likedIdsFor(userId: string): Promise<Set<string>> {
    const { results } = await db.prepare("SELECT layout_id FROM likes WHERE user_id = ?").bind(userId).all<{ layout_id: string }>();
    return new Set(results.map((r) => r.layout_id));
  }

  it("[LDB-R8] equals a JS filter over the seed's likes, for a real liker", async () => {
    const { results } = await db.prepare("SELECT DISTINCT user_id FROM likes LIMIT 1").all<{ user_id: string }>();
    const userId = results[0]?.user_id;
    expect(userId, "upstream-100 must include at least one like").toBeDefined();

    const expected = await likedIdsFor(userId!);
    expect(expected.size).toBeGreaterThan(0);

    const res = await SELF.fetch(`https://example.com/v1/layouts?format=spark/1&liked_by=${userId}&limit=1000`);
    expect(res.status).toBe(200);
    const body = await res.json<{ items: ListItem[] }>();
    expect(new Set(body.items.map((i) => i.id))).toEqual(expected);
  });

  it("[LDB-R8] composes with has_magic and sort", async () => {
    const { results } = await db.prepare("SELECT DISTINCT user_id FROM likes LIMIT 1").all<{ user_id: string }>();
    const userId = results[0]!.user_id;
    const liked = await likedIdsFor(userId);
    const seed = await loadSeedRows();
    const expected = new Set(seed.filter((r) => liked.has(r.id) && r.has_magic).map((r) => r.id));

    const res = await SELF.fetch(`https://example.com/v1/layouts?format=spark/1&liked_by=${userId}&has_magic=true&sort=like_count&limit=1000`);
    expect(res.status).toBe(200);
    const body = await res.json<{ items: ListItem[] }>();
    expect(new Set(body.items.map((i) => i.id))).toEqual(expected);
  });

  it("[LDB-R8] a user_id nobody has liked anything for -> empty list", async () => {
    const res = await SELF.fetch("https://example.com/v1/layouts?format=spark/1&liked_by=999999999999999999&limit=1000");
    expect(res.status).toBe(200);
    const body = await res.json<{ items: ListItem[] }>();
    expect(body.items).toEqual([]);
  });

  it("[LDB-R8] a malformed liked_by -> 400 bad_request", async () => {
    const res = await SELF.fetch("https://example.com/v1/layouts?format=spark/1&liked_by=not-a-snowflake");
    expect(res.status).toBe(400);
    const body = await res.json<{ error: string }>();
    expect(body.error).toBe("bad_request");
  });

  it("[LDB-R8] ?full=1&liked_by= streams only the liked records' payloads", async () => {
    const { results } = await db.prepare("SELECT DISTINCT user_id FROM likes LIMIT 1").all<{ user_id: string }>();
    const userId = results[0]!.user_id;
    const expected = await likedIdsFor(userId);

    const res = await SELF.fetch(`https://example.com/v1/layouts?full=1&format=spark/1&liked_by=${userId}`);
    expect(res.status).toBe(200);
    const body = await res.json<{ items: { id: string; payload: unknown }[] }>();
    expect(new Set(body.items.map((i) => i.id))).toEqual(expected);
    for (const item of body.items) expect(item.payload).toBeDefined();
  });
});

describe("[LDB-F5] ?full=1 streams every live record's payload", () => {
  it("[LDB-F5] matches fromCmini(upstream fixture) exactly, for every seeded record", async () => {
    const fixtureByName = new Map((fullSnapshot as { layouts: RawUpstreamDetail[] }).layouts.map((d) => [d.name, d]));

    const res = await SELF.fetch("https://example.com/v1/layouts?full=1&format=spark/1");
    expect(res.status).toBe(200);
    const body = await res.json<{ items: { name: string; held?: boolean; payload?: unknown }[] }>();
    expect(body.items.length).toBe(100);

    for (const item of body.items) {
      expect(item.held).toBeUndefined(); // every seed record is native spark/1 -- nothing held for spark/1
      const raw = fixtureByName.get(item.name);
      expect(raw, `no fixture entry for '${item.name}'`).toBeDefined();
      const parsed = parseUpstreamDetail(raw);
      if (!parsed.ok) throw new Error(`fixture '${item.name}' failed to parse: ${parsed.error.message}`);
      expect(canonical(item.payload)).toBe(canonical(fromCmini(parsed.detail.payload)));
    }
  });
});
