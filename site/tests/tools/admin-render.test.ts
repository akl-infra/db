// [SITE-18] the moderation UI is unreachable -- not merely hidden -- when
// `/auth/me` says `admin: false`. Rendered with `@solidjs/web`'s
// `renderToString` (its SSR build, which vitest's node environment
// resolves for free with no jsdom/DOM needed) against a real `pages/
// Admin.tsx` fed a stubbed `fetch` for `/auth/me`, so this exercises the
// actual component tree Admin.tsx mounts, not a re-statement of
// `canSeeAdmin`'s own unit test (tests/tools/admin-gate.test.ts covers
// that pure function directly).
import { afterEach, describe, expect, it, vi } from "vitest";
import { renderToString } from "@solidjs/web";
import { copy } from "../../src/copy.ts";
import type { MeResponse } from "../../src/lib/types.ts";

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });
}

/** `session.ts`'s `void refreshMe()` fires at import time and is async;
 * `vi.resetModules()` + a fresh dynamic import per case gives each render
 * its own module-scope `meResource` signal, seeded by the stubbed fetch
 * response below -- a few microtask flushes let that promise settle
 * before `renderToString` reads the signal synchronously. */
async function renderAdminAs(me: MeResponse): Promise<string> {
  vi.resetModules();
  // A fresh Response per call (a Response body can only be read once) --
  // `authorNames.ts`'s `void loadAuthorNames()` also fires at import time
  // and hits `/api/v1/authors`, which must not see the SAME `/auth/me`
  // response object `session.ts`'s `void refreshMe()` already consumed.
  vi.stubGlobal(
    "fetch",
    vi.fn((input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.includes("/auth/me")) return Promise.resolve(jsonResponse(me));
      if (url.includes("/api/v1/authors")) return Promise.resolve(jsonResponse({})); // {"<user_id>": "<name>"}, not an array
      return Promise.resolve(jsonResponse({}));
    }),
  );
  const { default: Admin } = await import("../../src/pages/Admin.tsx");
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
  const html = renderToString(() => Admin({}));
  vi.unstubAllGlobals();
  return html;
}

const NON_ADMIN: MeResponse = { user: { user_id: "1", name: "n", via: "discord", admin: false }, signin: true };
const SIGNED_OUT: MeResponse = { user: null, signin: true };
const ADMIN: MeResponse = { user: { user_id: "1", name: "n", via: "discord", admin: true }, signin: true };

describe("[SITE-18] Admin.tsx renders no moderation markup without admin:true", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("a signed-in non-admin sees only the not-admin page -- no tab bar, no tab content", async () => {
    const html = await renderAdminAs(NON_ADMIN);
    expect(html).toContain(copy.admin.notAdmin);
    expect(html).not.toContain(copy.admin.tabLayouts);
    expect(html).not.toContain(copy.admin.tabBans);
    expect(html).not.toContain(copy.admin.layouts.searchPlaceholder);
    expect(html).not.toContain(copy.admin.bans.banButton);
  });

  it("a signed-out visitor sees only the not-admin page", async () => {
    const html = await renderAdminAs(SIGNED_OUT);
    expect(html).toContain(copy.admin.notAdmin);
    expect(html).not.toContain(copy.admin.tabLayouts);
  });

  it("an admin sees the tab bar and the default (Layouts) tab's content", async () => {
    const html = await renderAdminAs(ADMIN);
    expect(html).not.toContain(copy.admin.notAdmin);
    expect(html).toContain(copy.admin.tabLayouts);
    expect(html).toContain(copy.admin.tabBans);
    expect(html).toContain(copy.admin.layouts.searchPlaceholder);
  });
});
