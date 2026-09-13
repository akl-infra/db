// [SITE-2] proxy header matrix (forward/add/strip, authed/anonymous)
// [SITE-3] CSRF
// [SITE-4] no path outside /v1/ is proxied
// [SITE-10] a 401 token_invalid on an authenticated request clears the
//           cookie and never retries
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import app from "../../server/index.ts";
import { sealSession, SESSION_COOKIE } from "../../server/session.ts";
import type { Env } from "../../server/env.ts";

const env: Env = {
  DB_BASE_URL: "https://akl-db.example.test",
  SITE_NAME: "akldb",
  SESSION_SECRET: "test-secret-do-not-use-in-prod",
};

async function sealedCookie(): Promise<string> {
  const token = await sealSession(
    { access_token: "discord-token-abc", expires_at: Date.now() + 60_000, user_id: "u1", name: "tester" },
    env.SESSION_SECRET!,
  );
  return `${SESSION_COOKIE}=${token}`;
}

function jsonResponse(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json", ...headers } });
}

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  fetchMock = vi.fn(async () => jsonResponse({ ok: true }));
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("[SITE-4] path scoping", () => {
  it("a path under /api/ but not /v1/ is not proxied", async () => {
    const res = await app.request("/api/not-v1", {}, env);
    expect(res.status).toBe(404);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("a completely unrelated path 404s without touching the DB", async () => {
    const res = await app.request("/something-else", {}, env);
    expect(res.status).toBe(404);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("/api/v1/... is proxied", async () => {
    const res = await app.request("/api/v1/meta", {}, env);
    expect(res.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const calledUrl = String(fetchMock.mock.calls[0]![0]);
    expect(calledUrl).toBe("https://akl-db.example.test/v1/meta");
  });
});

describe("[SITE-2] request header matrix", () => {
  it("anonymous GET: forwards allow-listed headers, no Authorization, strips Cookie and X-Akl-*", async () => {
    const res = await app.request("/api/v1/layouts?format=spark/1", {
      headers: {
        "If-None-Match": '"abc"',
        Accept: "application/json",
        Cookie: "unrelated=1",
        "X-Akl-Client": "sneaky-client-id",
        "X-Forwarded-For": "1.2.3.4",
      },
    }, env);
    expect(res.status).toBe(200);
    const sentHeaders = fetchMock.mock.calls[0]![1].headers as Headers;
    expect(sentHeaders.get("if-none-match")).toBe('"abc"');
    expect(sentHeaders.get("accept")).toBe("application/json");
    expect(sentHeaders.has("cookie")).toBe(false);
    expect(sentHeaders.has("x-akl-client")).toBe(false);
    expect(sentHeaders.has("x-forwarded-for")).toBe(false);
    expect(sentHeaders.has("authorization")).toBe(false);
    expect(sentHeaders.get("x-client-version")).toMatch(/^akldb-site\//);
  });

  it("authenticated GET: adds Authorization from the sealed cookie", async () => {
    const cookie = await sealedCookie();
    const res = await app.request("/api/v1/me", { headers: { Cookie: cookie } }, env);
    expect(res.status).toBe(200);
    const sentHeaders = fetchMock.mock.calls[0]![1].headers as Headers;
    expect(sentHeaders.get("authorization")).toBe("Bearer discord-token-abc");
  });

  it("`wait=` is stripped from the forwarded query string", async () => {
    await app.request("/api/v1/changes?since=0&wait=20", {}, env);
    const calledUrl = String(fetchMock.mock.calls[0]![0]);
    expect(calledUrl).not.toContain("wait=");
    expect(calledUrl).toContain("since=0");
  });
});

describe("[SITE-2] response header matrix", () => {
  it("forwards ETag/Cache-Control/Retry-After/X-Wait-Ignored; never Set-Cookie/WWW-Authenticate", async () => {
    fetchMock.mockImplementationOnce(async () =>
      jsonResponse(
        { ok: true },
        200,
        {
          ETag: '"7"',
          "Cache-Control": "public, max-age=60",
          "Retry-After": "5",
          "X-Wait-Ignored": "unauthorized",
          "Set-Cookie": "upstream_secret=leak",
          "WWW-Authenticate": "Bearer",
        },
      ),
    );
    const res = await app.request("/api/v1/layouts?format=spark/1", {}, env);
    expect(res.headers.get("etag")).toBe('"7"');
    expect(res.headers.get("retry-after")).toBe("5");
    expect(res.headers.get("x-wait-ignored")).toBe("unauthorized");
    expect(res.headers.get("set-cookie")).toBeNull();
    expect(res.headers.get("www-authenticate")).toBeNull();
  });

  it("an authenticated response gets Cache-Control: private, no-store regardless of upstream", async () => {
    fetchMock.mockImplementationOnce(async () => jsonResponse({ ok: true }, 200, { "Cache-Control": "public, max-age=600" }));
    const cookie = await sealedCookie();
    const res = await app.request("/api/v1/me", { headers: { Cookie: cookie } }, env);
    expect(res.headers.get("cache-control")).toBe("private, no-store");
  });

  it("an anonymous response keeps whatever Cache-Control upstream sent", async () => {
    fetchMock.mockImplementationOnce(async () => jsonResponse({ ok: true }, 200, { "Cache-Control": "public, max-age=600" }));
    const res = await app.request("/api/v1/layouts?format=spark/1", {}, env);
    expect(res.headers.get("cache-control")).toBe("public, max-age=600");
  });
});

describe("[SITE-3] CSRF", () => {
  it("a non-safe request without X-Requested-With is refused before the DB is called", async () => {
    const res = await app.request("/api/v1/layouts", { method: "POST", body: "{}" }, env);
    expect(res.status).toBe(403);
    expect((await res.json()) as { error: string }).toMatchObject({ error: "csrf" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("a non-safe request with the header but a cross-site Sec-Fetch-Site is refused", async () => {
    const res = await app.request(
      "/api/v1/layouts",
      { method: "POST", body: "{}", headers: { "X-Requested-With": "akldb", "Sec-Fetch-Site": "cross-site" } },
      env,
    );
    expect(res.status).toBe(403);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("a non-safe request with the header and same-origin Sec-Fetch-Site goes through", async () => {
    const res = await app.request(
      "/api/v1/layouts",
      { method: "POST", body: "{}", headers: { "X-Requested-With": "akldb", "Sec-Fetch-Site": "same-origin", "Content-Type": "application/json" } },
      env,
    );
    expect(res.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("a safe GET never needs the CSRF header", async () => {
    const res = await app.request("/api/v1/meta", {}, env);
    expect(res.status).toBe(200);
  });
});

describe("[SITE-10] token_invalid handling", () => {
  it("clears the cookie and answers reauth without retrying", async () => {
    fetchMock.mockImplementationOnce(async () => jsonResponse({ error: "token_invalid", message: "expired" }, 401));
    const cookie = await sealedCookie();
    const res = await app.request("/api/v1/me", { headers: { Cookie: cookie } }, env);
    expect(res.status).toBe(401);
    expect((await res.json()) as { error: string }).toMatchObject({ error: "reauth" });
    expect(fetchMock).toHaveBeenCalledTimes(1); // never retried -- no refresh token to retry with
    const setCookie = res.headers.get("set-cookie") ?? "";
    expect(setCookie).toContain("Max-Age=0");
  });

  it("an anonymous 401 (no session) passes through unchanged", async () => {
    fetchMock.mockImplementationOnce(async () => jsonResponse({ error: "unauthorized", message: "authentication required" }, 401));
    const res = await app.request("/api/v1/me", {}, env);
    expect(res.status).toBe(401);
    expect((await res.json()) as { error: string }).toMatchObject({ error: "unauthorized" });
    expect(res.headers.get("set-cookie")).toBeNull();
  });
});

describe("timeouts and body limits", () => {
  it("a body over 4 MiB is refused before the DB is called", async () => {
    const bigBody = "x".repeat(4 * 1024 * 1024 + 10);
    const res = await app.request(
      "/api/v1/layouts",
      { method: "POST", body: bigBody, headers: { "X-Requested-With": "akldb", "Content-Type": "application/json" } },
      env,
    );
    expect(res.status).toBe(413);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
