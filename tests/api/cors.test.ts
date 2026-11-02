// [LDB-CORS1] [LDB-CORS2] Public browser reads from any origin (src/core/cors.ts): every GET/HEAD answer carries
// `Access-Control-Allow-Origin: *`, success, 304 or error alike; writes and preflights never do.
import { SELF } from "../harness";
import { describe, expect, it } from "vitest";
import { CORS_EXPOSE_HEADERS } from "../../src/core/cors";
import { API_VERSION_HEADER, apiVersionString } from "../../src/core/version";

const ORIGIN = { Origin: "https://akl.gg" };

function expectCors(res: Response, label: string): void {
  expect(res.headers.get("Access-Control-Allow-Origin"), label).toBe("*");
  expect(res.headers.get("Access-Control-Expose-Headers"), label).toBe(CORS_EXPOSE_HEADERS);
  // The version header still rides beside it (LDB-V2): the CORS headers join the same rebuild.
  expect(res.headers.get(API_VERSION_HEADER), label).toBe(apiVersionString());
}

function expectNoCors(res: Response, label: string): void {
  expect(res.headers.get("Access-Control-Allow-Origin"), label).toBeNull();
  expect(res.headers.get("Access-Control-Allow-Methods"), label).toBeNull();
  expect(res.headers.get("Access-Control-Allow-Headers"), label).toBeNull();
}

describe("CORS on public reads", () => {
  it("[LDB-CORS1] a public GET answers with the wildcard origin and the exposed headers, with or without an Origin", async () => {
    for (const path of ["/v1/meta", "/v1/comment-counts", "/v1/wpm", "/v1/layouts?format=spark/1&limit=5"]) {
      const withOrigin = await SELF.fetch(`https://example.com${path}`, { headers: ORIGIN });
      expect(withOrigin.status, path).toBe(200);
      expectCors(withOrigin, `${path} (Origin)`);
      await withOrigin.arrayBuffer();
      const without = await SELF.fetch(`https://example.com${path}`);
      expectCors(without, `${path} (no Origin)`);
      await without.arrayBuffer();
    }
  });

  it("[LDB-CORS1] the conditional path keeps it: a revalidation's 304 carries the header and its ETag", async () => {
    const first = await SELF.fetch("https://example.com/v1/comment-counts", { headers: ORIGIN });
    const etag = first.headers.get("ETag");
    expect(etag).toBeTruthy();
    await first.arrayBuffer();
    const again = await SELF.fetch("https://example.com/v1/comment-counts", { headers: { ...ORIGIN, "If-None-Match": etag! } });
    expect(again.status).toBe(304);
    expect(again.headers.get("ETag")).toBe(etag);
    expectCors(again, "304");
  });

  it("[LDB-CORS1] HEAD and error answers to a GET are readable cross-origin too (the page sees the real status)", async () => {
    const head = await SELF.fetch("https://example.com/v1/meta", { method: "HEAD", headers: ORIGIN });
    expectCors(head, "HEAD");
    const missing = await SELF.fetch("https://example.com/v1/layouts/01ZZZZZZZZZZZZZZZZZZZZZZZZ/comments", { headers: ORIGIN });
    expect(missing.status).toBe(404);
    expectCors(missing, "404");
    await missing.arrayBuffer();
    const bad = await SELF.fetch("https://example.com/v1/layouts", { headers: ORIGIN });
    expect(bad.status).toBe(400); // format_required
    expectCors(bad, "400");
    await bad.arrayBuffer();
  });

  it("[LDB-CORS2] writes never carry it, and a preflight is never granted", async () => {
    const write = await SELF.fetch("https://example.com/v1/layouts", {
      method: "POST", headers: { ...ORIGIN, "Content-Type": "application/json" }, body: "{}",
    });
    expect(write.status).toBe(401); // no credentials
    expectNoCors(write, "POST");
    await write.arrayBuffer();
    const preflight = await SELF.fetch("https://example.com/v1/layouts/x/comment", {
      method: "OPTIONS",
      headers: { ...ORIGIN, "Access-Control-Request-Method": "GET", "Access-Control-Request-Headers": "authorization" },
    });
    expectNoCors(preflight, "OPTIONS");
    await preflight.arrayBuffer();
  });
});
