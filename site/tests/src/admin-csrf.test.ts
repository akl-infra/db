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
let lastMethod: string | undefined;
let lastBody: string | undefined;

function stubFetch(): void {
  lastUrl = undefined;
  lastHeaders = undefined;
  lastMethod = undefined;
  lastBody = undefined;
  vi.stubGlobal(
    "fetch",
    vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      lastUrl = typeof input === "string" ? input : input.toString();
      lastHeaders = new Headers(init?.headers);
      lastMethod = init?.method;
      lastBody = typeof init?.body === "string" ? init.body : undefined;
      return Promise.resolve(jsonResponse());
    }),
  );
}

afterEach(() => vi.unstubAllGlobals());

describe("[SITE-13] every admin* mutation targets /api/v1/admin/* with the CSRF header", () => {
  const mutations: Array<[string, () => Promise<unknown>]> = [
    ["adminBanUser", () => api.adminBanUser("u1", "reason")],
    ["adminUnbanUser", () => api.adminUnbanUser("u1")],
    ["adminSetAuthorName", () => api.adminSetAuthorName("u1", "name")],
    ["adminApproveLink", () => api.adminApproveLink("id1")],
    ["adminRejectLink", () => api.adminRejectLink("id1", "reason")],
    ["adminAddAdmin", () => api.adminAddAdmin("u1", "note")],
    ["adminRemoveAdmin", () => api.adminRemoveAdmin("u1")],
    ["adminImportPause", () => api.adminImportPause()],
    ["adminImportResume", () => api.adminImportResume()],
    ["adminImportTick", () => api.adminImportTick()],
    ["adminSuspendClient", () => api.adminSuspendClient("c1", "reason")],
    ["adminReactivateClient", () => api.adminReactivateClient("c1")],
    ["adminRevokeClient", () => api.adminRevokeClient("c1")],
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
    ["adminListClients", () => api.adminListClients()],
  ];

  for (const [name, call] of reads) {
    it(`${name} (a safe GET) still targets /api/v1/admin/*`, async () => {
      stubFetch();
      await call();
      expect(lastUrl).toMatch(/^\/api\/v1\/admin\//);
    });
  }
});

// [SITE-36] the Clients tab's three moderation actions each call the exact
// route/method/body the DB expects (`db/src/routes/admin.ts`): suspend
// sends `{reason}` (or `{}` when omitted -- `JSON.stringify` drops an
// `undefined` value, matching the DB's own conformance fixture body for
// that case), reactivate sends no body at all, and revoke is a bare
// `DELETE` (terminal, no `If-Match` -- client rows aren't rev'd the way
// layouts are, SITE-14 covers the "never sent on any admin route" half).
describe("[SITE-36] client moderation actions hit the exact route/method/body", () => {
  it("adminSuspendClient: POST .../clients/:id/suspend with {reason}", async () => {
    stubFetch();
    await api.adminSuspendClient("c1", "abuse");
    expect(lastUrl).toBe("/api/v1/admin/clients/c1/suspend");
    expect(lastMethod).toBe("POST");
    expect(lastBody).toBe(JSON.stringify({ reason: "abuse" }));
  });

  it("adminSuspendClient with no reason sends {} (never null/omitted key)", async () => {
    stubFetch();
    await api.adminSuspendClient("c1");
    expect(lastBody).toBe("{}");
  });

  it("adminReactivateClient: POST .../clients/:id/reactivate, no body", async () => {
    stubFetch();
    await api.adminReactivateClient("c1");
    expect(lastUrl).toBe("/api/v1/admin/clients/c1/reactivate");
    expect(lastMethod).toBe("POST");
    expect(lastBody).toBeUndefined();
  });

  it("adminRevokeClient: DELETE .../clients/:id", async () => {
    stubFetch();
    await api.adminRevokeClient("c1");
    expect(lastUrl).toBe("/api/v1/admin/clients/c1");
    expect(lastMethod).toBe("DELETE");
    expect(lastBody).toBeUndefined();
  });

  it("every client id is URL-encoded", async () => {
    stubFetch();
    await api.adminSuspendClient("weird id/x");
    expect(lastUrl).toBe("/api/v1/admin/clients/weird%20id%2Fx/suspend");
  });
});
