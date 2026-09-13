// GET /v1/me: body shape, admin reflecting the admins table, 401/503
// bodies matching 09 §2.1. Black-box via SELF.fetch, global fetch stubbed
// with FakeDiscord (same pattern tests/import/tick.test.ts uses for the
// cron's Discord/upstream call).
import { env, SELF } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Bindings } from "../../src/env";
import { FakeDiscord } from "../auth/fake-discord";

const bindings = env as unknown as Bindings;
const db = bindings.DB;
const ME_URL = "https://example.com/v1/me";
const BOOTSTRAP_ADMIN = "184412255822020608"; // migrations/0001_init.sql's seed row

beforeEach(async () => {
  await db.batch([
    db.prepare("DELETE FROM auth_cache"),
    db.prepare("DELETE FROM authors"),
    db.prepare("DELETE FROM admins WHERE user_id != ?").bind(BOOTSTRAP_ADMIN),
  ]);
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
    await expect(res.json()).resolves.toEqual({ user_id: "2001", name: "Finn F", via: "discord", admin: false, banned: false });
  });

  it("[LDB-A2] admin is true iff a row in admins, read fresh (not cached with identity)", async () => {
    const fake = new FakeDiscord();
    fake.setAnswer("tok-2", { kind: "ok", id: "2002", username: "gale", global_name: null });
    vi.stubGlobal("fetch", fake.fetchImpl);

    let res = await SELF.fetch(ME_URL, { headers: { Authorization: "Bearer tok-2" } });
    expect((await res.json<{ admin: boolean }>()).admin).toBe(false);

    await db.prepare("INSERT INTO admins (user_id, added_by, added_at, note) VALUES (?, NULL, ?, 'test')").bind("2002", "2026-01-01T00:00:00.000Z").run();
    res = await SELF.fetch(ME_URL, { headers: { Authorization: "Bearer tok-2" } }); // identity still cached; admin is not
    expect((await res.json<{ admin: boolean }>()).admin).toBe(true);

    await db.prepare("DELETE FROM admins WHERE user_id = ?").bind("2002").run();
    res = await SELF.fetch(ME_URL, { headers: { Authorization: "Bearer tok-2" } });
    expect((await res.json<{ admin: boolean }>()).admin).toBe(false);
  });

  it("reads admin status with exactly one D1 statement per request", async () => {
    const fake = new FakeDiscord();
    fake.setAnswer("tok-3", { kind: "ok", id: "2003", username: "hale", global_name: null });
    vi.stubGlobal("fetch", fake.fetchImpl);

    // A counting wrapper over the shared DB binding -- valid only because
    // SELF.fetch and this test file run against the same D1 object
    // (as tests/import/tick.test.ts's direct `bindings` passing to
    // worker.scheduled() also relies on).
    const originalPrepare = db.prepare.bind(db);
    let adminReads = 0;
    (db as unknown as { prepare: typeof db.prepare }).prepare = ((sql: string) => {
      if (sql.includes("FROM admins")) adminReads++;
      return originalPrepare(sql);
    }) as typeof db.prepare;

    try {
      const res = await SELF.fetch(ME_URL, { headers: { Authorization: "Bearer tok-3" } });
      expect(res.status).toBe(200);
    } finally {
      (db as unknown as { prepare: typeof db.prepare }).prepare = originalPrepare;
    }
    expect(adminReads).toBe(1);
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
