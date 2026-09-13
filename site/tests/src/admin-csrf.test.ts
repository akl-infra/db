// [SITE-13] every admin call goes through `/api/v1/admin/*` (the site
// Worker's proxy, never akl-db directly -- S3) carrying the CSRF header
// `server/proxy.ts` requires on every non-safe request. `src/api.ts`'s
// shared `request()` wrapper adds `X-Requested-With: akldb` to every
// non-GET/HEAD call unconditionally (SITE-3's own proxy-side half); this
// checks the ADMIN builders specifically actually go through that one
// wrapper (never a bespoke `fetch`) and land on the right path+header pair,
// the same way tests/src/ifmatch-builders.test.ts checks `If-Match`.
import { afterEach, describe, expect, it, vi } from "vitest";
import * as api from "../../src/api.ts";

function jsonResponse(body: unknown = {}): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });
}

let lastUrl: string | undefined;
let lastHeaders: Headers | undefined;

function stubFetch(): void {
  lastUrl = undefined;
  lastHeaders = undefined;
  vi.stubGlobal(
    "fetch",
    vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      lastUrl = typeof input === "string" ? input : input.toString();
      lastHeaders = new Headers(init?.headers);
      return Promise.resolve(jsonResponse());
    }),
  );
}

afterEach(() => vi.unstubAllGlobals());

describe("[SITE-13] every admin* mutation targets /api/v1/admin/* with the CSRF header", () => {
  const mutations: Array<[string, () => Promise<unknown>]> = [
    ["adminBanUser", () => api.adminBanUser("u1", "reason")],
    ["adminUnbanUser", () => api.adminUnbanUser("u1")],
    ["adminSetLikes", () => api.adminSetLikes("ref", 3)],
    ["adminSetAuthorName", () => api.adminSetAuthorName("u1", "name")],
    ["adminApproveLink", () => api.adminApproveLink("id1")],
    ["adminRejectLink", () => api.adminRejectLink("id1", "reason")],
    ["adminAddAdmin", () => api.adminAddAdmin("u1", "note")],
    ["adminRemoveAdmin", () => api.adminRemoveAdmin("u1")],
    ["adminImportPause", () => api.adminImportPause()],
    ["adminImportResume", () => api.adminImportResume()],
    ["adminImportTick", () => api.adminImportTick()],
  ];

  for (const [name, call] of mutations) {
    it(`${name} hits /api/v1/admin/* with X-Requested-With: akldb`, async () => {
      stubFetch();
      await call();
      expect(lastUrl).toMatch(/^\/api\/v1\/admin\//);
      expect(lastHeaders?.get("X-Requested-With")).toBe("akldb");
    });
  }

  const reads: Array<[string, () => Promise<unknown>]> = [
    ["adminListBans", () => api.adminListBans()],
    ["adminLinkQueue", () => api.adminLinkQueue("pending")],
    ["adminListAdmins", () => api.adminListAdmins()],
    ["adminHealth", () => api.adminHealth()],
  ];

  for (const [name, call] of reads) {
    it(`${name} (a safe GET) still targets /api/v1/admin/*`, async () => {
      stubFetch();
      await call();
      expect(lastUrl).toMatch(/^\/api\/v1\/admin\//);
    });
  }
});
