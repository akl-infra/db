// [LDB-R1] ETag/304 (03 §5, 07 §6 S6): the four cached routes carry
// Cache-Control + a strong ETag and answer 304 to a matching
// If-None-Match; the ETag changes iff the event log head or the query
// changes.
import { SELF } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import { appendLike } from "../../src/core/events";
import { fixedClock } from "../../src/core/time";
import { db, seedUpstream100 } from "./support";

const CACHE_CONTROL = "public, max-age=10";
const CACHED_ROUTES = ["/v1/meta", "/v1/layouts", "/v1/changes", "/v1/authors"];

beforeAll(async () => {
  await seedUpstream100();
});

describe.each(CACHED_ROUTES)("[LDB-R1] %s", (path) => {
  it("[LDB-R1] no header -> 200; matching If-None-Match -> 304; stale -> 200", async () => {
    const first = await SELF.fetch(`https://example.com${path}`);
    expect(first.status).toBe(200);
    expect(first.headers.get("Cache-Control")).toBe(CACHE_CONTROL);
    const etag = first.headers.get("ETag");
    expect(etag).toBeTruthy();

    const matching = await SELF.fetch(`https://example.com${path}`, {
      headers: { "If-None-Match": etag! },
    });
    expect(matching.status).toBe(304);
    expect(matching.headers.get("ETag")).toBe(etag);
    expect(matching.headers.get("Cache-Control")).toBe(CACHE_CONTROL);
    expect(await matching.text()).toBe("");

    const stale = await SELF.fetch(`https://example.com${path}`, {
      headers: { "If-None-Match": '"0:0000000000000000"' },
    });
    expect(stale.status).toBe(200);
    expect(stale.headers.get("ETag")).toBe(etag);
    expect(stale.headers.get("Cache-Control")).toBe(CACHE_CONTROL);
  });
});

describe("[LDB-R1] ETag changes iff the event head changes, or the query changes", () => {
  it("[LDB-R1] is stable across repeated reads with no event in between", async () => {
    const a = await SELF.fetch("https://example.com/v1/meta");
    const b = await SELF.fetch("https://example.com/v1/meta");
    expect(b.headers.get("ETag")).toBe(a.headers.get("ETag"));
  });

  it("[LDB-R1] changes after any event, across every cached route (the head is global)", async () => {
    const before = new Map<string, string>();
    for (const path of CACHED_ROUTES) {
      const res = await SELF.fetch(`https://example.com${path}`);
      before.set(path, res.headers.get("ETag")!);
    }

    const rec = await db.prepare("SELECT id FROM layouts WHERE deleted = 0 LIMIT 1").first<{ id: string }>();
    if (rec === null) throw new Error("no live record to like");
    const result = await appendLike(db, fixedClock("2026-06-07T00:00:00.000Z"), {
      kind: "liked",
      layoutId: rec.id,
      userId: "1", // not a real liker in the fixture -- guaranteed to append, not a no-op
      via: "discord",
    });
    expect(result.seq).not.toBeNull(); // confirms an event really was appended, not a no-op

    for (const path of CACHED_ROUTES) {
      const res = await SELF.fetch(`https://example.com${path}`);
      expect(res.headers.get("ETag"), `${path} did not change after an event`).not.toBe(before.get(path));
    }
  });

  it("[LDB-R1] differs for a different query at the same head", async () => {
    const a = await SELF.fetch("https://example.com/v1/layouts?limit=1");
    const b = await SELF.fetch("https://example.com/v1/layouts?limit=2");
    expect(a.headers.get("ETag")).not.toBe(b.headers.get("ETag"));
  });
});
