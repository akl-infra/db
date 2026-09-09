import { SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";

// The S1 skeleton's only route. Once formats/import land, this test is
// superseded by tests/api/conformance.test.ts (S6); the invariant id moves
// with it (see the S1 table in 07-implementation-phase1.md).
describe("GET /v1/meta", () => {
  it("answers the zero body on a fresh database", async () => {
    const res = await SELF.fetch("https://example.com/v1/meta");
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toContain("application/json");
    await expect(res.json()).resolves.toEqual({
      layout_count: 0,
      author_count: 0,
      seq: 0,
      revision: null,
      layouts_modified_at: null,
      authors_modified_at: null,
      formats: [],
    });
  });
});
