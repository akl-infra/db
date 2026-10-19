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
    ["adminApproveWpm", () => api.adminApproveWpm("id1")],
    ["adminRejectWpm", () => api.adminRejectWpm("id1", "reason")],
    ["adminSubmitWpm", () => api.adminSubmitWpm({ user_id: "184412255822020608", layout: "io", wpm: 90, proof: "https://example.org/p" })],
    ["adminApproveComment", () => api.adminApproveComment("id1")],
    ["adminRejectComment", () => api.adminRejectComment("id1", "reason")],
    ["adminRemoveComment", () => api.adminRemoveComment("id1", "reason")],
    ["adminAddAdmin", () => api.adminAddAdmin("u1", "note")],
    ["adminRemoveAdmin", () => api.adminRemoveAdmin("u1")],
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
    ["adminWpmQueue", () => api.adminWpmQueue("pending")],
    ["adminCommentQueue", () => api.adminCommentQueue("pending")],
    ["adminListAdmins", () => api.adminListAdmins()],
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

// [SITE-42] the WPM admin calls (db decision 28) hit the exact route/method/
// body the DB expects.
describe("[SITE-42] WPM admin calls hit the exact route/method/body", () => {
  it("adminWpmQueue: GET .../wpm-queue?status=", async () => {
    stubFetch();
    await api.adminWpmQueue("approved");
    expect(lastUrl).toBe("/api/v1/admin/wpm-queue?status=approved");
    expect(lastMethod).toBe("GET");
  });

  it("adminApproveWpm: POST .../wpm-queue/:id/approve, no body", async () => {
    stubFetch();
    await api.adminApproveWpm("sub 1");
    expect(lastUrl).toBe("/api/v1/admin/wpm-queue/sub%201/approve");
    expect(lastMethod).toBe("POST");
    expect(lastBody).toBeUndefined();
  });

  it("adminRejectWpm: POST .../wpm-queue/:id/reject with {reason}, or {} when omitted", async () => {
    stubFetch();
    await api.adminRejectWpm("sub1", "no proof");
    expect(lastUrl).toBe("/api/v1/admin/wpm-queue/sub1/reject");
    expect(lastMethod).toBe("POST");
    expect(lastBody).toBe(JSON.stringify({ reason: "no proof" }));
    stubFetch();
    await api.adminRejectWpm("sub1");
    expect(lastBody).toBe("{}");
  });

  it("adminSubmitWpm: POST /v1/admin/wpm with {user_id, layout, wpm, proof}", async () => {
    stubFetch();
    const body = { user_id: "184412255822020608", layout: "io", wpm: 120, proof: "https://example.org/p" };
    await api.adminSubmitWpm(body);
    expect(lastUrl).toBe("/api/v1/admin/wpm");
    expect(lastMethod).toBe("POST");
    expect(JSON.parse(lastBody!)).toEqual(body);
  });
});

// [SITE-45] the comment admin calls (db decision 29) hit the exact route/
// method/body the DB expects; the public read is a plain GET of the layout's
// comments by ref.
describe("[SITE-45] comment calls hit the exact route/method/body", () => {
  it("adminCommentQueue: GET .../comment-queue?status=", async () => {
    stubFetch();
    await api.adminCommentQueue("rejected");
    expect(lastUrl).toBe("/api/v1/admin/comment-queue?status=rejected");
    expect(lastMethod).toBe("GET");
  });

  it("adminApproveComment: POST .../comment-queue/:id/approve, no body", async () => {
    stubFetch();
    await api.adminApproveComment("sub 1");
    expect(lastUrl).toBe("/api/v1/admin/comment-queue/sub%201/approve");
    expect(lastMethod).toBe("POST");
    expect(lastBody).toBeUndefined();
  });

  it("adminRejectComment: POST .../comment-queue/:id/reject with {reason}, or {} when omitted", async () => {
    stubFetch();
    await api.adminRejectComment("sub1", "off topic");
    expect(lastUrl).toBe("/api/v1/admin/comment-queue/sub1/reject");
    expect(lastMethod).toBe("POST");
    expect(lastBody).toBe(JSON.stringify({ reason: "off topic" }));
    stubFetch();
    await api.adminRejectComment("sub1");
    expect(lastBody).toBe("{}");
  });

  it("adminRemoveComment: POST .../comments/:id/remove with {reason}, or {} when omitted", async () => {
    stubFetch();
    await api.adminRemoveComment("c 1", "spam");
    expect(lastUrl).toBe("/api/v1/admin/comments/c%201/remove");
    expect(lastMethod).toBe("POST");
    expect(lastBody).toBe(JSON.stringify({ reason: "spam" }));
    stubFetch();
    await api.adminRemoveComment("c1");
    expect(lastBody).toBe("{}");
  });

  it("getComments: GET /api/v1/layouts/:ref/comments, no CSRF header", async () => {
    stubFetch();
    await api.getComments("my layout");
    expect(lastUrl).toBe("/api/v1/layouts/my%20layout/comments");
    expect(lastMethod).toBe("GET");
    expect(lastHeaders?.has("X-Requested-With")).toBe(false);
  });
});

describe("[SITE-46] versioned moderation and private history", () => {
  for (const kind of ["Comment", "Wpm"] as const) {
    it(`${kind}: reopen includes the displayed decision and review version`, async () => {
      stubFetch();
      await api[`adminReopen${kind}`]("sub 1", "approved", 3);
      expect(lastUrl).toBe(`/api/v1/admin/${kind.toLowerCase()}-queue/sub%201/reopen`);
      expect(lastMethod).toBe("POST");
      expect(JSON.parse(lastBody!)).toEqual({ status: "approved", review_version: 3 });
      expect(lastHeaders?.get("X-Requested-With")).toBe("akldb");
      expect(lastHeaders?.has("If-Match")).toBe(false);
      await api[`adminReopen${kind}`]("sub 1", "rejected", 0);
      expect(JSON.parse(lastBody!)).toEqual({ status: "rejected", review_version: 0 });
    });

    it(`${kind}: approve and reject carry the current version after reopening`, async () => {
      stubFetch();
      await api[`adminApprove${kind}`]("sub 1", 4);
      expect(lastUrl).toBe(`/api/v1/admin/${kind.toLowerCase()}-queue/sub%201/approve`);
      expect(JSON.parse(lastBody!)).toEqual({ review_version: 4 });
      await api[`adminReject${kind}`]("sub 1", "off topic", 4);
      expect(lastUrl).toBe(`/api/v1/admin/${kind.toLowerCase()}-queue/sub%201/reject`);
      expect(JSON.parse(lastBody!)).toEqual({ reason: "off topic", review_version: 4 });
      await api[`adminReject${kind}`]("sub 1", undefined, 4);
      expect(JSON.parse(lastBody!)).toEqual({ review_version: 4 });
      expect(lastHeaders?.get("X-Requested-With")).toBe("akldb");
    });

    it(`${kind}: history is a private admin GET`, async () => {
      stubFetch();
      await api[`admin${kind}History`]("sub 1");
      expect(lastUrl).toBe(`/api/v1/admin/${kind.toLowerCase()}-queue/sub%201/history`);
      expect(lastMethod).toBe("GET");
      expect(lastBody).toBeUndefined();
      expect(lastHeaders?.has("If-Match")).toBe(false);
      expect(lastHeaders?.has("X-Requested-With")).toBe(false);
    });
  }

  it("returns a review conflict without retrying the mutation", async () => {
    const fetcher = vi.fn(() => Promise.resolve(new Response(JSON.stringify({ error: "review_conflict" }), { status: 409 })));
    vi.stubGlobal("fetch", fetcher);
    expect(await api.adminReopenComment("old", "rejected", 2)).toEqual({ ok: false, status: 409, error: "review_conflict", message: undefined });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
});
