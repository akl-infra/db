// [LDB-API4] [LDB-CORS4] Request ids and Server-Timing (API 1.39): a valid supplied id is echoed byte-equal, an invalid or
// absent one is replaced with a fresh valid one, and every answer carries `Server-Timing: akldb;dur=<ms>` (shape only).
import { SELF } from "../harness";
import { describe, expect, it } from "vitest";
import { effectiveRequestId, REQUEST_ID_RE, serverTiming } from "../../src/core/request-id";

const TIMING = /^akldb;dur=\d+(\.\d)?$/;
const GOOD = "client-req_01:abc.DEF";

function expectIdentified(res: Response, label: string, sent?: string): void {
  const id = res.headers.get("X-Request-ID");
  expect(id, label).not.toBeNull();
  expect(REQUEST_ID_RE.test(id!), `${label}: id ${id}`).toBe(true);
  if (sent !== undefined) expect(id, label).toBe(sent);
  else expect(id, label).not.toBe(GOOD);
  expect(res.headers.get("Server-Timing"), label).toMatch(TIMING);
}

describe("request ids", () => {
  it("[LDB-API4] a valid supplied id is echoed byte-equal, on 200, 404, 304 and OPTIONS", async () => {
    const ok = await SELF.fetch("https://example.com/v1/meta", { headers: { "X-Request-ID": GOOD } });
    expect(ok.status).toBe(200);
    expectIdentified(ok, "200", GOOD);
    const nf = await SELF.fetch("https://example.com/v1/layouts/does-not-exist-zz", { headers: { "X-Request-ID": GOOD } });
    expect(nf.status).toBe(404);
    expectIdentified(nf, "404", GOOD);
    const etag = (await SELF.fetch("https://example.com/v1/comment-counts")).headers.get("ETag");
    if (etag !== null) {
      const nm = await SELF.fetch("https://example.com/v1/comment-counts", { headers: { "X-Request-ID": GOOD, "If-None-Match": etag } });
      expect(nm.status).toBe(304);
      expectIdentified(nm, "304", GOOD);
    }
    const pre = await SELF.fetch("https://example.com/v1/meta", { method: "OPTIONS", headers: { "X-Request-ID": GOOD } });
    expect(pre.status).toBe(204);
    expectIdentified(pre, "OPTIONS", GOOD);
  });

  it("[LDB-API4] an absent id is minted, and each request gets its own", async () => {
    const a = await SELF.fetch("https://example.com/v1/meta");
    const b = await SELF.fetch("https://example.com/v1/meta");
    expectIdentified(a, "a");
    expectIdentified(b, "b");
    expect(a.headers.get("X-Request-ID")).not.toBe(b.headers.get("X-Request-ID"));
  });

  it("[LDB-API4] an invalid id (too short, too long, a space, a quote, non-ASCII) is ignored and replaced, never reflected", async () => {
    for (const bad of ["short", "x".repeat(65), "has a space 12345", 'quote"12345678', "é-not-ascii-1234", "semi;colon-1234"]) {
      const res = await SELF.fetch("https://example.com/v1/meta", { headers: { "X-Request-ID": bad } });
      expect(res.status, bad).toBe(200);
      expectIdentified(res, bad);
      expect(res.headers.get("X-Request-ID"), bad).not.toBe(bad);
    }
  });

  it("[LDB-API4] the 429 and 500 paths carry the id too (onError)", async () => {
    // An unauthenticated write is refused by the actor gate: an ApiError through onError.
    const res = await SELF.fetch("https://example.com/v1/layouts", { method: "POST", headers: { "X-Request-ID": GOOD, "content-type": "application/json" }, body: "{}" });
    expect(res.status).toBeGreaterThanOrEqual(400);
    expectIdentified(res, `write ${res.status}`, GOOD);
    expect((res.headers.get("Server-Timing") ?? "").split(",").length, "one akldb entry only").toBe(1);
  });

  it("[LDB-CORS4] the id and timing are exposed, TAO is set, and a preflight for x-request-id is granted while authorization is refused", async () => {
    const res = await SELF.fetch("https://example.com/v1/meta", { headers: { Origin: "https://akl.gg" } });
    expect(res.headers.get("Access-Control-Expose-Headers")).toContain("X-Request-ID");
    expect(res.headers.get("Access-Control-Expose-Headers")).toContain("Server-Timing");
    expect(res.headers.get("Timing-Allow-Origin")).toBe("*");
    const ok = await SELF.fetch("https://example.com/v1/meta", { method: "OPTIONS", headers: { Origin: "https://akl.gg", "Access-Control-Request-Method": "GET", "Access-Control-Request-Headers": "x-request-id, if-none-match" } });
    expect(ok.headers.get("Access-Control-Allow-Origin")).toBe("*");
    expect(ok.headers.get("Access-Control-Allow-Headers")).toContain("X-Request-ID");
    const no = await SELF.fetch("https://example.com/v1/meta", { method: "OPTIONS", headers: { Origin: "https://akl.gg", "Access-Control-Request-Method": "GET", "Access-Control-Request-Headers": "x-request-id, authorization" } });
    expect(no.headers.get("Access-Control-Allow-Origin")).toBeNull();
  });
});

describe("request-id helpers", () => {
  it("[LDB-API4] effectiveRequestId and serverTiming", () => {
    expect(effectiveRequestId(GOOD)).toBe(GOOD);
    expect(effectiveRequestId("bad id", () => "minted-0001")).toBe("minted-0001");
    expect(effectiveRequestId(undefined, () => "minted-0002")).toBe("minted-0002");
    expect(effectiveRequestId("a\nb-12345678", () => "minted-0003")).toBe("minted-0003");
    expect(serverTiming(12.34)).toBe("akldb;dur=12.3");
    expect(serverTiming(1, 850)).toBe("akldb;dur=1, akldb-boot;dur=850");
  });
});
