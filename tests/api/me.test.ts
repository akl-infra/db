// GET /v1/me: body shape, admin reflecting the admins table, 401/503
// bodies matching 09 §2.1. Black-box via SELF.fetch, global fetch stubbed
// with FakeDiscord (same pattern tests/import/tick.test.ts uses for the
// cron's Discord/upstream call).
import { SELF, testStore } from "../harness";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FakeDiscord } from "../auth/fake-discord";

const ME_URL = "https://example.com/v1/me";
const BOOTSTRAP_ADMIN = "184412255822020608"; // migrations/0001_init.sql's seed row

beforeEach(async () => {
  await testStore.remove("auth_cache", {});
  await testStore.remove("authors", {});
  for (const admin of await testStore.rows<{ user_id: string }>("admins")) {
    if (admin.user_id !== BOOTSTRAP_ADMIN) await testStore.remove("admins", { user_id: admin.user_id });
  }
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("GET /v1/me", () => {
  it("answers { user_id, name, via, admin, banned } for a resolved actor", async () => {
    const fake = new FakeDiscord();
    fake.setAnswer("tok-1", { kind: "ok", id: "2001", username: "finn", global_name: "Finn F" });
    vi.stubGlobal("fetch", fake.fetchImpl);

    const res = await SELF.fetch(ME_URL, { headers: { Authorization: "Bearer tok-1" } });
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ user_id: "2001", name: "finn", via: "discord", admin: false, banned: false });
  });

  it("[LDB-A2] admin is true iff a row in admins, read fresh (not cached with identity)", async () => {
    const fake = new FakeDiscord();
    fake.setAnswer("tok-2", { kind: "ok", id: "2002", username: "gale", global_name: null });
    vi.stubGlobal("fetch", fake.fetchImpl);

    let res = await SELF.fetch(ME_URL, { headers: { Authorization: "Bearer tok-2" } });
    expect((await res.json<{ admin: boolean }>()).admin).toBe(false);

    await testStore.insert("admins", { user_id: "2002", added_by: null, added_at: "2026-01-01T00:00:00.000Z", note: "test" });
    res = await SELF.fetch(ME_URL, { headers: { Authorization: "Bearer tok-2" } }); // identity still cached; admin is not
    expect((await res.json<{ admin: boolean }>()).admin).toBe(true);

    await testStore.remove("admins", { user_id: "2002" });
    res = await SELF.fetch(ME_URL, { headers: { Authorization: "Bearer tok-2" } });
    expect((await res.json<{ admin: boolean }>()).admin).toBe(false);
  });

  it("via is always discord", async () => {
    const fake = new FakeDiscord();
    fake.setAnswer("tok-4", { kind: "ok", id: "2004", username: "iris", global_name: null });
    vi.stubGlobal("fetch", fake.fetchImpl);

    const res = await SELF.fetch(ME_URL, { headers: { Authorization: "Bearer tok-4" } });
    expect((await res.json<{ via: string }>()).via).toBe("discord");
  });

  it("no Authorization header -> 401 unauthorized", async () => {
    const res = await SELF.fetch(ME_URL);
    expect(res.status).toBe(401);
    expect(res.headers.get("WWW-Authenticate")).toBe("Bearer");
    await expect(res.json()).resolves.toMatchObject({ error: "unauthorized" });
  });

  it("Discord says 401 -> 401 token_invalid", async () => {
    vi.stubGlobal("fetch", (() => Promise.resolve(new Response("no", { status: 401 }))) as typeof fetch);
    const res = await SELF.fetch(ME_URL, { headers: { Authorization: "Bearer bad-token" } });
    expect(res.status).toBe(401);
    await expect(res.json()).resolves.toMatchObject({ error: "token_invalid" });
  });

  it("Discord unreachable -> 503 identity_unavailable", async () => {
    vi.stubGlobal("fetch", (() => Promise.reject(new Error("network down"))) as typeof fetch);
    const res = await SELF.fetch(ME_URL, { headers: { Authorization: "Bearer whatever" } });
    expect(res.status).toBe(503);
    await expect(res.json()).resolves.toMatchObject({ error: "identity_unavailable" });
  });
});
