// [LDB-A1] Black-box: enumerate `app.routes` (exported from src/index.ts)
// and prove every non-GET/HEAD/OPTIONS route requires a resolved actor --
// behaviour, not Hono internals. Drives the real Worker via SELF.fetch, so
// requireActorOnWrites's production wiring (real global `fetch` to Discord)
// is stubbed per-request the same way tests/import/tick.test.ts stubs it
// for the import tick.
import { SELF } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import { app } from "../../src/index";

const TEST_ID = "01ARZ3NDEKTSV4RRFFQ69G5FAV"; // a syntactically-valid ref/id, whatever the route expects

afterEach(() => {
  vi.unstubAllGlobals();
});

// Substitutes any `:param` segment in a route's path with TEST_ID -- none
// of T1's routes have one, but this keeps the enumeration honest for
// later slices' routes too.
function concretePath(route: { basePath: string; path: string }): string {
  const full = route.path.startsWith("/") ? route.path : `${route.basePath}${route.path}`;
  return full.replace(/:[^/]+/g, TEST_ID);
}

function writeRoutes(): { method: string; path: string }[] {
  const SAFE = new Set(["GET", "HEAD", "OPTIONS", "ALL"]); // "ALL" is app.use()'s own registration, not a route
  const seen = new Set<string>();
  const out: { method: string; path: string }[] = [];
  for (const route of app.routes) {
    if (SAFE.has(route.method)) continue;
    const path = concretePath(route);
    const key = `${route.method} ${path}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ method: route.method, path });
  }
  return out;
}

describe("every write route requires a resolved actor", () => {
  it("[LDB-A1] the enumeration is non-empty (guards against an empty sweep)", () => {
    expect(writeRoutes().length).toBeGreaterThan(0);
  });

  it("[LDB-A1] no Authorization header -> 401 unauthorized, WWW-Authenticate: Bearer", async () => {
    for (const { method, path } of writeRoutes()) {
      const res = await SELF.fetch(`https://example.com${path}`, { method });
      expect(res.status, `${method} ${path}`).toBe(401);
      expect(res.headers.get("WWW-Authenticate"), `${method} ${path}`).toBe("Bearer");
      const body = await res.json<{ error: string }>();
      expect(body.error, `${method} ${path}`).toBe("unauthorized");
    }
  });

  it("[LDB-A1] a non-Bearer scheme -> 401 unauthorized", async () => {
    for (const { method, path } of writeRoutes()) {
      const res = await SELF.fetch(`https://example.com${path}`, {
        method,
        headers: { Authorization: "Basic eDp5" },
      });
      expect(res.status, `${method} ${path}`).toBe(401);
      const body = await res.json<{ error: string }>();
      expect(body.error, `${method} ${path}`).toBe("unauthorized");
    }
  });

  it("[LDB-A1] a bearer Discord rejects -> 401 token_invalid", async () => {
    vi.stubGlobal(
      "fetch",
      (() => Promise.resolve(new Response("no", { status: 401 }))) as typeof fetch,
    );
    for (const { method, path } of writeRoutes()) {
      const res = await SELF.fetch(`https://example.com${path}`, {
        method,
        headers: { Authorization: "Bearer whatever-discord-rejects" },
      });
      expect(res.status, `${method} ${path}`).toBe(401);
      const body = await res.json<{ error: string }>();
      expect(body.error, `${method} ${path}`).toBe("token_invalid");
    }
  });

  it("[LDB-A1] GET /v1/meta never requires auth", async () => {
    const res = await SELF.fetch("https://example.com/v1/meta");
    expect(res.status).toBe(200);
  });
});
