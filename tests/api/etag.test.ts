// [LDB-R1] ETag/304 (03 §5, 07 §6 S6): the four cached routes carry
// Cache-Control + a strong ETag and answer 304 to a matching
// If-None-Match; the ETag changes iff the event log head or the query
// changes.
import { SELF } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import { canonical } from "../../src/core/canonical";
import { appendLike } from "../../src/core/events";
import { etagFor } from "../../src/core/etag";
import { fixedClock } from "../../src/core/time";
import { db, seedUpstream100 } from "./support";

async function sha256Hex(s: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

// 20-spark.md S2 (LDB-R1 amended): `WIRE_VERSION` is folded into the
// hashed query -- a white-box check that the CURRENT constant is 2
// (bumped by this slice) and is actually part of what gets hashed, not
// merely present in a comment. Replicates `etagFor`'s own formula with a
// literal `wireVersion: 2` -- if a future slice bumps the real constant
// without bumping this test, the two hashes diverge and this fails,
// which is the point: a version bump is a deliberate, visible edit here
// too.
describe("[LDB-R1] WIRE_VERSION is folded into the ETag hash", () => {
  it("[LDB-R1] etagFor(seq, query) reproduces exactly the wireVersion:2-folded hash", async () => {
    const seq = 42;
    const query = { a: 1, b: "x" };
    const expectedHash = await sha256Hex(canonical({ wireVersion: 2, query }));
    const expected = `"${seq}:${expectedHash.slice(0, 16)}"`;
    expect(await etagFor(seq, query)).toBe(expected);
  });

  it("[LDB-R1] a hash computed with a DIFFERENT wireVersion does not match (proves the fold isn't a no-op)", async () => {
    const seq = 42;
    const query = { a: 1, b: "x" };
    const wrongHash = await sha256Hex(canonical({ wireVersion: 1, query }));
    const wrong = `"${seq}:${wrongHash.slice(0, 16)}"`;
    expect(await etagFor(seq, query)).not.toBe(wrong);
  });
});

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

  // [LDB-R1] Weak comparison (RFC 7232 §3.2): Cloudflare rewrites our
  // strong ETag to `W/"…"` on every compressed response, so a client that
  // echoes what it received sends the weak form -- it must still get a
  // 304 (2026-09-10: the bot's per-minute heartbeat never did, paying the
  // full meta query each time). A weak tag with a DIFFERENT opaque value
  // is still a miss, and a list mixing forms matches on any member.
  it("[LDB-R1] the weak form W/<etag> of the current tag -> 304; a weak stale tag -> 200; a list matches on any member", async () => {
    const first = await SELF.fetch(`https://example.com${path}`);
    const etag = first.headers.get("ETag")!;
    expect(etag.startsWith('"')).toBe(true); // strong on the way out, unchanged

    const weak = await SELF.fetch(`https://example.com${path}`, { headers: { "If-None-Match": `W/${etag}` } });
    expect(weak.status).toBe(304);
    expect(weak.headers.get("ETag")).toBe(etag);

    const weakStale = await SELF.fetch(`https://example.com${path}`, { headers: { "If-None-Match": 'W/"0:0000000000000000"' } });
    expect(weakStale.status).toBe(200);

    const list = await SELF.fetch(`https://example.com${path}`, {
      headers: { "If-None-Match": `"0:0000000000000000", W/${etag}` },
    });
    expect(list.status).toBe(304);
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
