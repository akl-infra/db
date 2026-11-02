// [LDB-CORS1] [LDB-CORS2] [LDB-CORS3] Public browser reads from any origin (src/core/cors.ts): every GET/HEAD answer
// carries `Access-Control-Allow-Origin: *` and `Cross-Origin-Resource-Policy: cross-origin`, success, 304 or error
// alike; writes never do; the only preflight granted is a GET/HEAD asking for the revalidation headers.
import { SELF } from "../harness";
import { describe, expect, it } from "vitest";
import { CORS_EXPOSE_HEADERS, preflightHeadersFor } from "../../src/core/cors";
import { API_VERSION_HEADER, apiVersionString } from "../../src/core/version";

const ORIGIN = { Origin: "https://akl.gg" };

function expectCors(res: Response, label: string): void {
  expect(res.headers.get("Access-Control-Allow-Origin"), label).toBe("*");
  expect(res.headers.get("Access-Control-Expose-Headers"), label).toBe(CORS_EXPOSE_HEADERS);
  expect(res.headers.get("Cross-Origin-Resource-Policy"), label).toBe("cross-origin"); // LDB-CORS3
  // The version header still rides beside it (LDB-V2): the CORS headers join the same rebuild.
  expect(res.headers.get(API_VERSION_HEADER), label).toBe(apiVersionString());
}

function expectNoCors(res: Response, label: string): void {
  expect(res.headers.get("Access-Control-Allow-Origin"), label).toBeNull();
  expect(res.headers.get("Access-Control-Allow-Methods"), label).toBeNull();
  expect(res.headers.get("Access-Control-Allow-Headers"), label).toBeNull();
  expect(res.headers.get("Access-Control-Allow-Credentials"), label).toBeNull();
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
    expect(write.headers.get("Cross-Origin-Resource-Policy")).toBeNull();
    // a preflight asking for Authorization, or for any write method, is never granted (LDB-CORS3 keeps this)
    for (const [method, headers] of [["GET", "authorization"], ["GET", "if-none-match, authorization"], ["GET", "x-akl-client"], ["POST", ""], ["PUT", "content-type"], ["DELETE", ""], ["PATCH", "if-match"]] as const) {
      const preflight = await SELF.fetch("https://example.com/v1/layouts/x/comment", {
        method: "OPTIONS",
        headers: { ...ORIGIN, "Access-Control-Request-Method": method, ...(headers ? { "Access-Control-Request-Headers": headers } : {}) },
      });
      expect(preflight.status, `${method} ${headers}`).toBe(204);
      expectNoCors(preflight, `OPTIONS ${method} ${headers}`);
      await preflight.arrayBuffer();
    }
    // a bare OPTIONS (no preflight) grants nothing either
    const bare = await SELF.fetch("https://example.com/v1/meta", { method: "OPTIONS" });
    expect(bare.status).toBe(204);
    expectNoCors(bare, "bare OPTIONS");
  });
});

describe("[LDB-CORS3] the one preflight akldb grants", () => {
  it("[LDB-CORS3] a GET/HEAD preflight asking for nothing, or only for If-None-Match, Cache-Control, Pragma (any case, any order), gets 204 with exactly those, GET, HEAD and a day's Max-Age, never credentials", async () => {
    for (const [method, asked] of [["GET", undefined], ["GET", "if-none-match"], ["HEAD", "Cache-Control"], ["GET", "pragma, cache-control, If-None-Match"], ["GET", " "]] as const) {
      for (const path of ["/v1/comment-counts", "/v1/comments?ids=01A", "/v1/layouts/01ZZZZZZZZZZZZZZZZZZZZZZZZ/comments", "/v1/meta"]) {
        const res = await SELF.fetch(`https://example.com${path}`, {
          method: "OPTIONS",
          headers: { ...ORIGIN, "Access-Control-Request-Method": method, ...(asked !== undefined ? { "Access-Control-Request-Headers": asked } : {}) },
        });
        const label = `${path} ${method} ${asked}`;
        expect(res.status, label).toBe(204);
        expect(res.headers.get("Access-Control-Allow-Origin"), label).toBe("*");
        expect(res.headers.get("Access-Control-Allow-Methods"), label).toBe("GET, HEAD");
        expect(res.headers.get("Access-Control-Allow-Headers"), label).toBe("If-None-Match, Cache-Control, Pragma");
        expect(res.headers.get("Access-Control-Max-Age"), label).toBe("86400");
        expect(res.headers.get("Cross-Origin-Resource-Policy"), label).toBe("cross-origin");
        expect(res.headers.get("Access-Control-Allow-Credentials"), label).toBeNull();
        expect(await res.text(), label).toBe("");
      }
    }
  });

  it("[LDB-CORS3] the rule itself: only GET/HEAD, only the three revalidation headers", () => {
    expect(preflightHeadersFor(undefined, undefined)).toEqual({});
    for (const m of ["POST", "PUT", "PATCH", "DELETE", "OPTIONS", "get "]) expect(Object.keys(preflightHeadersFor(m, undefined)).length > 0, m).toBe(m === "get ");
    expect(preflightHeadersFor("GET", "if-none-match,authorization")).toEqual({});
    expect(preflightHeadersFor("GET", "content-type")).toEqual({});
    expect(preflightHeadersFor("HEAD", "PRAGMA")["Access-Control-Allow-Methods"]).toBe("GET, HEAD");
  });
});
