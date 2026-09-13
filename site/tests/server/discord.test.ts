// Sign-in degrades cleanly when DISCORD_CLIENT_ID/_SECRET aren't set yet
// (design/akldb-site/01-plan.md §7 -- the Discord app doesn't exist until
// saltorbit creates it), and the real flow's plumbing (state cookie round trip,
// session sealing from the DB's own /v1/me answer) works when they are.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import app from "../../server/index.ts";
import type { Env } from "../../server/env.ts";
import { OAUTH_STATE_COOKIE } from "../../server/session.ts";

const unconfigured: Env = { DB_BASE_URL: "https://akl-db.example.test", SITE_NAME: "akldb" };
const configured: Env = {
  ...unconfigured,
  DISCORD_CLIENT_ID: "client-id",
  DISCORD_CLIENT_SECRET: "client-secret",
  SESSION_SECRET: "test-secret",
};

let fetchMock: ReturnType<typeof vi.fn>;
beforeEach(() => {
  fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => vi.unstubAllGlobals());

describe("sign-in degrades cleanly when unconfigured", () => {
  it("/auth/login 404s", async () => {
    const res = await app.request("/auth/login", {}, unconfigured);
    expect(res.status).toBe(404);
  });

  it("/auth/callback 404s", async () => {
    const res = await app.request("/auth/callback?code=abc&state=xyz", {}, unconfigured);
    expect(res.status).toBe(404);
  });

  it("/auth/me reports signin:false so the UI hides the button", async () => {
    const res = await app.request("/auth/me", {}, unconfigured);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ user: null, signin: false });
  });
});

describe("login", () => {
  it("redirects to Discord with a state cookie set", async () => {
    const res = await app.request("/auth/login", {}, configured);
    expect(res.status).toBe(302);
    const location = new URL(res.headers.get("Location")!);
    expect(location.origin).toBe("https://discord.com");
    expect(location.searchParams.get("client_id")).toBe("client-id");
    expect(location.searchParams.get("scope")).toBe("identify");
    expect(location.searchParams.get("redirect_uri")).toMatch(/\/auth\/callback$/);
    const setCookie = res.headers.get("set-cookie") ?? "";
    expect(setCookie).toContain(OAUTH_STATE_COOKIE);
  });
});

describe("callback", () => {
  it("rejects a state mismatch without calling Discord", async () => {
    const res = await app.request(
      "/auth/callback?code=abc&state=wrong",
      { headers: { Cookie: `${OAUTH_STATE_COOKIE}=right` } },
      configured,
    );
    expect(res.status).toBe(400);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("on success, seals a session from the DB's /v1/me and redirects home", async () => {
    fetchMock.mockImplementation(async (url: string) => {
      if (String(url).includes("discord.com/api/oauth2/token")) {
        return new Response(JSON.stringify({ access_token: "discord-tok", expires_in: 604800 }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      if (String(url).includes("/v1/me")) {
        return new Response(JSON.stringify({ user_id: "u1", name: "tester", via: "discord", admin: false }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      throw new Error(`unexpected fetch ${url}`);
    });
    const res = await app.request(
      "/auth/callback?code=abc&state=match",
      { headers: { Cookie: `${OAUTH_STATE_COOKIE}=match` } },
      configured,
    );
    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toBe("/");
    const cookies = res.headers.getSetCookie ? res.headers.getSetCookie() : [res.headers.get("set-cookie") ?? ""];
    expect(cookies.some((c) => c.includes("__Host-akldb_session"))).toBe(true);
  });
});

describe("logout", () => {
  it("[SITE-3] clears the session cookie when the CSRF header is present", async () => {
    const res = await app.request("/auth/logout", { method: "POST", headers: { "X-Requested-With": "akldb" } }, configured);
    expect(res.status).toBe(200);
    expect(res.headers.get("set-cookie")).toContain("Max-Age=0");
  });
  it("[SITE-3] refuses a cross-site POST (no CSRF header): 403, cookie untouched", async () => {
    const res = await app.request("/auth/logout", { method: "POST" }, configured);
    expect(res.status).toBe(403);
    expect(res.headers.get("set-cookie")).toBeNull();
  });
});
