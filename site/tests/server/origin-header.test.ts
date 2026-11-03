// [SITE-48] akldb on AWS: every call this Worker makes to the akldb API (the /api/v1/* proxy, the OAuth callback's and
// /auth/me's /v1/me check) carries `x-akldb-origin` from the AKLDB_ORIGIN_SECRET secret when it is set, and omits it when
// unset (today's behaviour). A client cannot supply or learn it: the proxy forwards an allow-list of headers only, and the
// value never appears in a response.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import app from "../../server/index.ts";
import { ORIGIN_HEADER, type Env } from "../../server/env.ts";
import { sealSession, SESSION_COOKIE } from "../../server/session.ts";

const SECRET = "origin-secret-for-tests-only-0123456789";
const base: Env = { DB_BASE_URL: "https://akl-db.example.test", SITE_NAME: "akldb", DISCORD_CLIENT_ID: "client-id", DISCORD_CLIENT_SECRET: "client-secret", SESSION_SECRET: "test-secret-do-not-use-in-prod" };
const withSecret: Env = { ...base, AKLDB_ORIGIN_SECRET: SECRET };

let fetchMock: ReturnType<typeof vi.fn>;
beforeEach(() => {
  fetchMock = vi.fn(async () => new Response(JSON.stringify({ ok: true, user_id: "u1", name: "tester" }), { status: 200, headers: { "Content-Type": "application/json" } }));
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => vi.unstubAllGlobals());

const sentHeader = (call: number): string | null => new Headers((fetchMock.mock.calls[call]![1] as RequestInit).headers).get(ORIGIN_HEADER);

async function cookie(env: Env): Promise<string> {
  const token = await sealSession({ access_token: "discord-token-abc", expires_at: Date.now() + 60_000, user_id: "u1", name: "tester" }, env.SESSION_SECRET!);
  return `${SESSION_COOKIE}=${token}`;
}

describe("[SITE-48] the origin-secret header", () => {
  it("the /api/v1 proxy sends it when the secret is set, and omits it when unset", async () => {
    await app.request("/api/v1/meta", {}, withSecret);
    expect(sentHeader(0)).toBe(SECRET);
    await app.request("/api/v1/meta", {}, base);
    expect(sentHeader(1)).toBeNull();
  });

  it("a client-supplied x-akldb-origin is never forwarded, and the response never carries the secret", async () => {
    const res = await app.request("/api/v1/meta", { headers: { [ORIGIN_HEADER]: "client-guess" } }, base);
    expect(sentHeader(0)).toBeNull();
    const res2 = await app.request("/api/v1/meta", { headers: { [ORIGIN_HEADER]: "client-guess" } }, withSecret);
    expect(sentHeader(1)).toBe(SECRET);
    for (const r of [res, res2]) {
      for (const [, v] of r.headers) expect(v).not.toContain(SECRET);
      expect(await r.text()).not.toContain(SECRET);
    }
  });

  it("/auth/me's /v1/me check sends it when set", async () => {
    await app.request("/auth/me", { headers: { Cookie: await cookie(withSecret) } }, withSecret);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(String(fetchMock.mock.calls[0]![0])).toBe("https://akl-db.example.test/v1/me");
    expect(sentHeader(0)).toBe(SECRET);
  });
});
