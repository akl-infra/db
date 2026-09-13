// [SITE-14] an `If-Match` header is sent on every rev'd write (rename,
// delete, transfer -- `PATCH`/`DELETE`/`POST .../transfer` on `/v1/
// layouts/:ref`, db/docs/adoption.md §9) and NEVER on like, link, or any
// admin route -- those either take no `If-Match` at all (likes, `link` is
// explicitly exempt per design/akldb-site/01-plan.md §4.4) or aren't
// rev'd writes (every `/v1/admin/*` route). One capturing fetch stub, one
// call per builder in `src/api.ts`, read the ACTUAL `Headers` sent rather
// than trusting the function's own intent.
import { afterEach, describe, expect, it, vi } from "vitest";
import * as api from "../../src/api.ts";

function jsonResponse(body: unknown = {}): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });
}

let lastHeaders: Headers | undefined;

function stubFetch(): void {
  lastHeaders = undefined;
  vi.stubGlobal(
    "fetch",
    vi.fn((_input: RequestInfo | URL, init?: RequestInit) => {
      lastHeaders = new Headers(init?.headers);
      return Promise.resolve(jsonResponse());
    }),
  );
}

afterEach(() => vi.unstubAllGlobals());

describe("[SITE-14] If-Match is sent on rev'd writes", () => {
  it("renameLayout sends the exact If-Match token it was given", async () => {
    stubFetch();
    await api.renameLayout("ref", "new-name", '"layout:3"');
    expect(lastHeaders?.get("If-Match")).toBe('"layout:3"');
  });

  it("deleteLayout sends If-Match", async () => {
    stubFetch();
    await api.deleteLayout("ref", '"layout:5"');
    expect(lastHeaders?.get("If-Match")).toBe('"layout:5"');
  });

  it("transferLayout sends If-Match", async () => {
    stubFetch();
    await api.transferLayout("ref", "999", '"layout:2"');
    expect(lastHeaders?.get("If-Match")).toBe('"layout:2"');
  });
});

describe("[SITE-14] If-Match is never sent on like, link, or any admin route", () => {
  it("likeLayout / unlikeLayout carry no If-Match", async () => {
    stubFetch();
    await api.likeLayout("ref");
    expect(lastHeaders?.has("If-Match")).toBe(false);
    stubFetch();
    await api.unlikeLayout("ref");
    expect(lastHeaders?.has("If-Match")).toBe(false);
  });

  it("getLink / submitLink / clearLink carry no If-Match", async () => {
    stubFetch();
    await api.getLink("ref");
    expect(lastHeaders?.has("If-Match")).toBe(false);
    stubFetch();
    await api.submitLink("ref", "https://example.com");
    expect(lastHeaders?.has("If-Match")).toBe(false);
    stubFetch();
    await api.clearLink("ref");
    expect(lastHeaders?.has("If-Match")).toBe(false);
  });

  it("restoreLayout carries no If-Match (not a rev'd write against an existing token)", async () => {
    stubFetch();
    await api.restoreLayout("ref");
    expect(lastHeaders?.has("If-Match")).toBe(false);
  });

  it("every admin* function carries no If-Match", async () => {
    const calls: Array<() => Promise<unknown>> = [
      () => api.adminListBans(),
      () => api.adminBanUser("u1", "reason"),
      () => api.adminUnbanUser("u1"),
      () => api.adminSetAuthorName("u1", "name"),
      () => api.adminLinkQueue("pending"),
      () => api.adminApproveLink("id1"),
      () => api.adminRejectLink("id1", "reason"),
      () => api.adminListAdmins(),
      () => api.adminAddAdmin("u1", "note"),
      () => api.adminRemoveAdmin("u1"),
      () => api.adminImportPause(),
      () => api.adminImportResume(),
      () => api.adminImportTick(),
      () => api.adminHealth(),
    ];
    for (const call of calls) {
      stubFetch();
      await call();
      expect(lastHeaders?.has("If-Match")).toBe(false);
    }
  });
});
