// [LDB-J2] The app routes through Hono's TrieRouter directly (src/index.ts):
// no failed RegExpRouter attempt on an isolate's first request. Matching
// itself is proven by the conformance and route-gate suites over the same
// table; this pins the router choice and that a param route still resolves.
import { describe, expect, it } from "vitest";
import { SELF } from "../harness";
import { app } from "../../src/index";

describe("[LDB-J2] the router", () => {
  it("[LDB-J2] is TrieRouter from the start, and still matches a static route and the param route RegExpRouter refused", async () => {
    expect(app.router.name).toBe("TrieRouter");
    expect((await SELF.fetch("https://example.com/v1/formats")).status).toBe(200);
    expect((await SELF.fetch("https://example.com/v1/dump/not-a-real-key.json.gz")).status).toBe(404);
    expect(app.router.name).toBe("TrieRouter");
  });
});
