// [LDB-F5] [LDB-R4] `GET /v1/layouts` (03 §2, 07 §6 S6): a keyset cursor
// walk of any sort/limit visits every live record exactly once, in order;
// every filter equals a plain JS filter over the seed; `?full=1` streams
// every live record's payload, matching `fromCmini` of the upstream
// fixture's own shape (21-formats.md D5 deleted the cmini export, so this
// is spark-shaped now, not byte-identical to upstream's own cmini shape).
import { SELF } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import fullSnapshot from "../fixtures/upstream-100/full.json" with { type: "json" };
import { canonical } from "../../src/core/canonical";
import { parseUpstreamDetail } from "../../src/import/apply";
import { fromCmini } from "../../formats/adapters/cmini/translate.ts";
import type { RawUpstreamDetail } from "../../src/import/upstream";
import { db, seedUpstream100 } from "./support";

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
    const qs = new URLSearchParams({ sort, limit: String(limit) });
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
  const { results } = await db
    .prepare(`SELECT id FROM layouts WHERE deleted = 0 ${SORT_ORDER_SQL[sort]}`)
    .all<{ id: string }>();
  return results.map((r) => r.id);
}

async function loadSeedRows(): Promise<ListItem[]> {
  const { results } = await db
    .prepare("SELECT id, owner, format, has_magic, modified_at FROM layouts WHERE deleted = 0")
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

    const res = await SELF.fetch(`https://example.com/v1/layouts?owner=${owner}&limit=1000`);
    const body = await res.json<{ items: ListItem[] }>();
    expect(new Set(body.items.map((i) => i.id))).toEqual(expected);
  });

  it("[LDB-F5] format=", async () => {
    const seed = await loadSeedRows();
    const format = seed[0]!.format;
    const expected = new Set(seed.filter((r) => r.format === format).map((r) => r.id));

    const res = await SELF.fetch(`https://example.com/v1/layouts?format=${encodeURIComponent(format)}&limit=1000`);
    const body = await res.json<{ items: ListItem[] }>();
    expect(new Set(body.items.map((i) => i.id))).toEqual(expected);
  });

  it("[LDB-F5] has_magic=true and has_magic=false partition the seed", async () => {
    // M1 (LDB-I10): a fresh import never sets has_magic=true -- upstream's
    // magic is stripped before it ever reaches a payload (07 §5.3's "picked
    // to include magic layouts" premise described the pre-M1 import, not
    // the filter itself). Flip one seed record's `has_magic` directly to
    // exercise the true branch the way a record that already carried local
    // magic before M1 landed would (LDB-I11 keeps such a record's magic on
    // later import writes; M2 gives akl.gg's own rules the same shape) --
    // this is a read-route filter test, so the column alone is enough.
    const seedRows = await loadSeedRows();
    await db.prepare("UPDATE layouts SET has_magic = 1 WHERE id = ?").bind(seedRows[0]!.id).run();

    const seed = await loadSeedRows();
    const expectedTrue = new Set(seed.filter((r) => r.has_magic).map((r) => r.id));
    const expectedFalse = new Set(seed.filter((r) => !r.has_magic).map((r) => r.id));
    expect(expectedTrue.size + expectedFalse.size).toBe(seed.length);
    expect(expectedTrue.size).toBeGreaterThan(0);

    const trueRes = await SELF.fetch("https://example.com/v1/layouts?has_magic=true&limit=1000");
    const trueBody = await trueRes.json<{ items: ListItem[] }>();
    expect(new Set(trueBody.items.map((i) => i.id))).toEqual(expectedTrue);

    const falseRes = await SELF.fetch("https://example.com/v1/layouts?has_magic=false&limit=1000");
    const falseBody = await falseRes.json<{ items: ListItem[] }>();
    expect(new Set(falseBody.items.map((i) => i.id))).toEqual(expectedFalse);
  });

  it("[LDB-F5] since=<iso> (modified_at > since)", async () => {
    const seed = await loadSeedRows();
    const sortedByModified = [...seed].sort((a, b) => (a.modified_at < b.modified_at ? -1 : 1));
    const since = sortedByModified[Math.floor(sortedByModified.length / 2)]!.modified_at;
    const expected = new Set(seed.filter((r) => r.modified_at > since).map((r) => r.id));

    const res = await SELF.fetch(`https://example.com/v1/layouts?since=${encodeURIComponent(since)}&limit=1000`);
    const body = await res.json<{ items: ListItem[] }>();
    expect(new Set(body.items.map((i) => i.id))).toEqual(expected);
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

    const res = await SELF.fetch(`https://example.com/v1/layouts?liked_by=${userId}&limit=1000`);
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

    const res = await SELF.fetch(`https://example.com/v1/layouts?liked_by=${userId}&has_magic=true&sort=like_count&limit=1000`);
    expect(res.status).toBe(200);
    const body = await res.json<{ items: ListItem[] }>();
    expect(new Set(body.items.map((i) => i.id))).toEqual(expected);
  });

  it("[LDB-R8] a user_id nobody has liked anything for -> empty list", async () => {
    const res = await SELF.fetch("https://example.com/v1/layouts?liked_by=999999999999999999&limit=1000");
    expect(res.status).toBe(200);
    const body = await res.json<{ items: ListItem[] }>();
    expect(body.items).toEqual([]);
  });

  it("[LDB-R8] a malformed liked_by -> 400 bad_request", async () => {
    const res = await SELF.fetch("https://example.com/v1/layouts?liked_by=not-a-snowflake");
    expect(res.status).toBe(400);
    const body = await res.json<{ error: string }>();
    expect(body.error).toBe("bad_request");
  });

  it("[LDB-R8] ?full=1&liked_by= streams only the liked records' payloads", async () => {
    const { results } = await db.prepare("SELECT DISTINCT user_id FROM likes LIMIT 1").all<{ user_id: string }>();
    const userId = results[0]!.user_id;
    const expected = await likedIdsFor(userId);

    const res = await SELF.fetch(`https://example.com/v1/layouts?full=1&liked_by=${userId}`);
    expect(res.status).toBe(200);
    const body = await res.json<{ items: { id: string; payload: unknown }[] }>();
    expect(new Set(body.items.map((i) => i.id))).toEqual(expected);
    for (const item of body.items) expect(item.payload).toBeDefined();
  });
});

describe("[LDB-F5] ?full=1 streams every live record's payload", () => {
  it("[LDB-F5] matches fromCmini(upstream fixture) exactly, for every seeded record", async () => {
    const fixtureByName = new Map(
      (fullSnapshot as { layouts: RawUpstreamDetail[] }).layouts.map((d) => [d.name, d]),
    );

    const res = await SELF.fetch("https://example.com/v1/layouts?full=1");
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
