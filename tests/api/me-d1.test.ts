// D1-only (design/p1-briefs.md E).
// GET /v1/me, the one test that counts the D1 statements a request prepares
// (split out of me.test.ts, which runs on every backend).
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
});
