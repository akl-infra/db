// [LDB-MD1] [LDB-MD10] Black-box: a banned actor's non-safe request is
// `403 banned` on EVERY non-GET/HEAD/OPTIONS route (enumerated from
// `app.routes`, same technique tests/auth/routes.test.ts's [LDB-A1] uses),
// on both auth lanes; reads and `GET /v1/me` are never refused.
import { SELF, env } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Bindings } from "../../src/env";
import { app } from "../../src/index";
import { generateKeyPair, seedClient, signHeaders } from "./client-support";
import { FakeDiscord } from "./fake-discord";

const bindings = env as unknown as Bindings;
const db = bindings.DB;

const TEST_ID = "01ARZ3NDEKTSV4RRFFQ69G5FAV";

afterEach(() => {
  vi.unstubAllGlobals();
});

function concretePath(route: { basePath: string; path: string }): string {
  const full = route.path.startsWith("/") ? route.path : `${route.basePath}${route.path}`;
  return full.replace(/:[^/]+/g, TEST_ID);
}

function writeRoutes(): { method: string; path: string }[] {
  const SAFE = new Set(["GET", "HEAD", "OPTIONS", "ALL"]);
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

describe("[LDB-MD1] a banned actor's write is refused on every non-GET route (bearer lane)", () => {
  it("[LDB-MD1] every non-GET route is 403 banned for a banned user", async () => {
    const bannedId = "890000000000000001";
    const now = new Date().toISOString();
    await db.prepare("INSERT INTO bans (user_id, by, at, reason) VALUES (?, ?, ?, ?)").bind(bannedId, "some-admin", now, "test ban").run();

    const fake = new FakeDiscord();
    fake.setAnswer("tok-banned", { kind: "ok", id: bannedId, username: "banned-user", global_name: null });
    vi.stubGlobal("fetch", fake.fetchImpl);

    const routes = writeRoutes();
    expect(routes.length).toBeGreaterThan(0);
    for (const { method, path } of routes) {
      const res = await SELF.fetch(`https://example.com${path}`, { method, headers: { Authorization: "Bearer tok-banned" } });
      expect(res.status, `${method} ${path}`).toBe(403);
      const body = await res.json<{ error: string }>();
      expect(body.error, `${method} ${path}`).toBe("banned");
    }
  });

  it("[LDB-MD1] a non-banned user on the same routes is never refused with 'banned' (control)", async () => {
    const fake = new FakeDiscord();
    fake.setAnswer("tok-clean", { kind: "ok", id: "890000000000000002", username: "clean-user", global_name: null });
    vi.stubGlobal("fetch", fake.fetchImpl);
    // Spot-check one representative route rather than the whole sweep --
    // most will 400/403/404 on missing setup, which is fine; none may be
    // 403 `banned`.
    const res = await SELF.fetch("https://example.com/v1/layouts/does-not-exist/like", {
      method: "PUT",
      headers: { Authorization: "Bearer tok-clean" },
    });
    const body = await res.json<{ error: string }>();
    expect(body.error).not.toBe("banned");
  });
});

describe("[LDB-MD1] the same gate applies to the client lane", () => {
  it("[LDB-MD1] a banned actor signing via the client lane is 403 banned on a write", async () => {
    const bannedId = "890000000000000003";
    const now = new Date().toISOString();
    await db.prepare("INSERT INTO bans (user_id, by, at, reason) VALUES (?, ?, ?, ?)").bind(bannedId, "some-admin", now, null).run();

    const pair = await generateKeyPair();
    await seedClient(db, () => now, { id: "mod-client-1", pubkeyB64url: pair.pubkeyB64url, ownerUserId: bannedId, caps: "act-as-owner-only" });

    const headers = await signHeaders({
      privateKey: pair.privateKey,
      clientId: "mod-client-1",
      actor: bannedId,
      method: "PUT",
      pathWithQuery: "/v1/layouts/does-not-exist/like",
      timestamp: Math.floor(Date.now() / 1000),
    });
    const res = await SELF.fetch("https://example.com/v1/layouts/does-not-exist/like", { method: "PUT", headers });
    expect(res.status).toBe(403);
    const body = await res.json<{ error: string }>();
    expect(body.error).toBe("banned");
  });
});

describe("[LDB-MD10] GET /v1/me reports banned/admin fresh, never from auth_cache", () => {
  it("[LDB-MD10] a ban applied AFTER a cached-ok bearer lookup still takes effect on the next request", async () => {
    const userId = "890000000000000004";
    const fake = new FakeDiscord();
    fake.setAnswer("tok-cache-then-ban", { kind: "ok", id: userId, username: "cache-then-ban", global_name: null });
    vi.stubGlobal("fetch", fake.fetchImpl);

    const first = await SELF.fetch("https://example.com/v1/me", { headers: { Authorization: "Bearer tok-cache-then-ban" } });
    expect((await first.json<{ banned: boolean }>()).banned).toBe(false);

    const now = new Date().toISOString();
    await db.prepare("INSERT INTO bans (user_id, by, at, reason) VALUES (?, ?, ?, ?)").bind(userId, "some-admin", now, null).run();

    // Same token, still within the 5-min identity cache window -- `roleOf`
    // is never part of that cache, so `banned` must flip immediately.
    const second = await SELF.fetch("https://example.com/v1/me", { headers: { Authorization: "Bearer tok-cache-then-ban" } });
    expect((await second.json<{ banned: boolean }>()).banned).toBe(true);
  });

  it("[LDB-MD10] an admin is never reported banned even if a stray ban row exists for them", async () => {
    const adminId = "184412255822020608"; // migrations/0001_init.sql's bootstrap admin
    await db.prepare("INSERT OR IGNORE INTO bans (user_id, by, at, reason) VALUES (?, ?, ?, ?)").bind(adminId, "someone", new Date().toISOString(), null).run();
    const fake = new FakeDiscord();
    fake.setAnswer("tok-admin-not-banned", { kind: "ok", id: adminId, username: "admin", global_name: null });
    vi.stubGlobal("fetch", fake.fetchImpl);
    const res = await SELF.fetch("https://example.com/v1/me", { headers: { Authorization: "Bearer tok-admin-not-banned" } });
    const body = await res.json<{ admin: boolean; banned: boolean }>();
    expect(body.admin).toBe(true);
    expect(body.banned).toBe(false);
  });
});
