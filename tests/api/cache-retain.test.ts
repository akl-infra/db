// [LDB-R19] A validated route's stored copy outlives the client-facing
// max-age, serves only while its ETag still matches, and goes out with the
// route's own Cache-Control; `/v1/meta` (clock-dependent health) keeps the
// short copy. Black-box via SELF.fetch and `caches.default`, the cache
// `conditional()`/`cachePut()` use.
import { SELF, testStore } from "../harness";
import { describe, expect, it } from "vitest";

const stored = async (url: string) => caches.default.match(new Request(url));

describe("[LDB-R19] stored copies of validated routes", () => {
  it("[LDB-R19] /v1/authors keeps its copy a day, answers from it with max-age=10, and never serves it once the authors moved", async () => {
    const url = "https://example.com/v1/authors?by=id&_retain=1";
    const first = await SELF.fetch(url);
    expect(first.status).toBe(200);
    expect(first.headers.get("Cache-Control")).toBe("public, max-age=10");
    const tag = first.headers.get("ETag")!;
    const copy = await stored(url);
    expect(copy?.headers.get("ETag")).toBe(tag);
    expect(copy?.headers.get("Cache-Control")).toBe("public, max-age=86400");

    const again = await SELF.fetch(url);
    expect(again.status).toBe(200);
    expect(again.headers.get("ETag")).toBe(tag);
    expect(again.headers.get("Cache-Control")).toBe("public, max-age=10");
    expect(await again.json()).toEqual(await first.json());

    await testStore.insert("authors", { user_id: "990000000000000001", name: "retain-test", first_seen_at: "2026-11-01T00:00:00.000Z", last_seen_at: "2026-11-01T00:00:00.000Z", name_source: "user" });
    const moved = await SELF.fetch(url);
    expect(moved.status).toBe(200);
    expect(moved.headers.get("ETag")).not.toBe(tag);
    expect((await moved.json<Record<string, string>>())["990000000000000001"]).toBe("retain-test");
  });

  it("[LDB-R19] /v1/meta keeps the short copy: its health ages with the clock", async () => {
    const url = "https://example.com/v1/meta?_retain=1";
    const res = await SELF.fetch(url);
    expect(res.status).toBe(200);
    expect((await stored(url))?.headers.get("Cache-Control")).toBe("public, max-age=10");
  });
});

describe("[LDB-R19] a hit never carries the stored copy's Cache-Control", () => {
  it("[LDB-R19] a stored copy with any other Cache-Control (as Cloudflare's zone Browser Cache TTL hands back) goes out with the route's max-age=10, /v1/meta included", async () => {
    for (const url of ["https://example.com/v1/meta?_ttl=1", "https://example.com/v1/comment-counts?_ttl=1"]) {
      const first = await SELF.fetch(url);
      expect(first.status).toBe(200);
      const copy = (await caches.default.match(new Request(url)))!;
      const headers = new Headers(copy.headers);
      headers.set("Cache-Control", "public, max-age=14400");
      await caches.default.put(new Request(url), new Response(await copy.text(), { status: 200, headers }));
      const hit = await SELF.fetch(url);
      expect(hit.headers.get("ETag")).toBe(first.headers.get("ETag"));
      expect(hit.headers.get("Cache-Control"), url).toBe("public, max-age=10");
    }
  });
});
