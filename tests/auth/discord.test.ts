// [LDB-A2] resolveBearer()'s cache dance: Discord's answer x cache state,
// against a fixed/manually-advanced clock and a Fetch-shaped FakeDiscord
// (09 §2.2). Unit-style -- calls resolveBearer directly, no SELF.fetch, no
// global fetch stubbing.
import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { resolveBearer } from "../../src/auth/discord";
import { ApiError } from "../../src/core/errors";
import type { Clock } from "../../src/core/time";
import type { Bindings } from "../../src/env";
import { FakeDiscord } from "./fake-discord";

const bindings = env as unknown as Bindings;
const db = bindings.DB;
const BASE_URL = "https://fake-discord.example/api";

// vitest-pool-workers isolates storage per TEST FILE, not per `it`
// (tests/import/tick.test.ts's own comment) -- every test here shares one
// D1, so each test needs a clean slate.
beforeEach(async () => {
  await db.batch([db.prepare("DELETE FROM auth_cache"), db.prepare("DELETE FROM authors")]);
});

// A manually-advanceable clock -- fixedClock never moves and steppingClock
// moves on every call, neither of which lets a test control exactly when
// a cache window expires.
function mutableClock(startIso: string): { clock: Clock; advanceMs: (ms: number) => void } {
  let t = new Date(startIso).getTime();
  return {
    clock: () => new Date(t).toISOString(),
    advanceMs: (ms: number) => {
      t += ms;
    },
  };
}

async function expectApiError(
  promise: Promise<unknown>,
  status: number,
  error: string,
  headers?: Record<string, string>,
): Promise<void> {
  try {
    await promise;
    expect.fail(`expected an ApiError (${status} ${error}), nothing thrown`);
  } catch (e) {
    if (!(e instanceof ApiError)) throw e;
    expect(e.status).toBe(status);
    expect(e.body.error).toBe(error);
    if (headers !== undefined) {
      for (const [k, v] of Object.entries(headers)) expect(e.headers?.[k]).toBe(v);
    }
  }
}

async function cacheRowCount(): Promise<number> {
  const row = await db.prepare("SELECT COUNT(*) AS n FROM auth_cache").first<{ n: number }>();
  return row?.n ?? 0;
}

async function authorRow(userId: string): Promise<{ name: string; first_seen_at: string; last_seen_at: string } | null> {
  return db
    .prepare("SELECT name, first_seen_at, last_seen_at FROM authors WHERE user_id = ?")
    .bind(userId)
    .first<{ name: string; first_seen_at: string; last_seen_at: string }>();
}

describe("resolveBearer()", () => {
  it("[LDB-A2] a 200 resolves the actor, makes one Discord request, and upserts authors", async () => {
    const fake = new FakeDiscord();
    fake.setAnswer("tok-a", { kind: "ok", id: "1001", username: "alice", global_name: "Alice A" });
    const { clock } = mutableClock("2026-09-09T00:00:00.000Z");

    const actor = await resolveBearer(db, clock, "tok-a", fake.fetchImpl, BASE_URL);
    expect(actor).toEqual({ user_id: "1001", name: "Alice A", via: "discord", admin: false });
    expect(fake.requestLog.length).toBe(1);
    expect(fake.requestLog[0]!.authorization).toBe("Bearer tok-a");

    const author = await authorRow("1001");
    expect(author).toEqual({
      name: "Alice A",
      first_seen_at: "2026-09-09T00:00:00.000Z",
      last_seen_at: "2026-09-09T00:00:00.000Z",
    });
  });

  it("[LDB-A2] global_name null falls back to username", async () => {
    const fake = new FakeDiscord();
    fake.setAnswer("tok-b", { kind: "ok", id: "1002", username: "bobby", global_name: null });
    const { clock } = mutableClock("2026-09-09T00:00:00.000Z");

    const actor = await resolveBearer(db, clock, "tok-b", fake.fetchImpl, BASE_URL);
    expect(actor.name).toBe("bobby");
    expect((await authorRow("1002"))?.name).toBe("bobby");
  });

  it("[LDB-A2] a second call inside 300s makes no Discord request; at 300s+1 it does", async () => {
    const fake = new FakeDiscord();
    fake.setAnswer("tok-c", { kind: "ok", id: "1003", username: "carl", global_name: null });
    const { clock, advanceMs } = mutableClock("2026-09-09T00:00:00.000Z");

    await resolveBearer(db, clock, "tok-c", fake.fetchImpl, BASE_URL);
    expect(fake.requestLog.length).toBe(1);

    advanceMs(299_000);
    await resolveBearer(db, clock, "tok-c", fake.fetchImpl, BASE_URL);
    expect(fake.requestLog.length).toBe(1); // still cached

    advanceMs(2_000); // now at +301s, past the 300s window
    await resolveBearer(db, clock, "tok-c", fake.fetchImpl, BASE_URL);
    expect(fake.requestLog.length).toBe(2);
  });

  it("[LDB-A2] a 401 is cached 60s, not 5min, and never as a success", async () => {
    const fake = new FakeDiscord();
    fake.setAnswer("tok-d", { kind: "status", status: 401 });
    const { clock, advanceMs } = mutableClock("2026-09-09T00:00:00.000Z");

    await expectApiError(resolveBearer(db, clock, "tok-d", fake.fetchImpl, BASE_URL), 401, "token_invalid", {
      "WWW-Authenticate": 'Bearer error="invalid_token"',
    });
    expect(fake.requestLog.length).toBe(1);

    advanceMs(59_000);
    await expectApiError(resolveBearer(db, clock, "tok-d", fake.fetchImpl, BASE_URL), 401, "token_invalid");
    expect(fake.requestLog.length).toBe(1); // still cached

    advanceMs(2_000); // now at +61s, past the 60s window
    await expectApiError(resolveBearer(db, clock, "tok-d", fake.fetchImpl, BASE_URL), 401, "token_invalid");
    expect(fake.requestLog.length).toBe(2);

    expect(await authorRow("anything")).toBeNull(); // no identity was ever resolved
  });

  it("[LDB-A2] 429 with Retry-After answers 503 with it copied, and caches nothing", async () => {
    const fake = new FakeDiscord();
    fake.setAnswer("tok-e", { kind: "status", status: 429, retryAfter: "7" });
    const { clock } = mutableClock("2026-09-09T00:00:00.000Z");

    await expectApiError(resolveBearer(db, clock, "tok-e", fake.fetchImpl, BASE_URL), 503, "identity_unavailable", {
      "Retry-After": "7",
    });
    expect(await cacheRowCount()).toBe(0);
  });

  it.each([
    ["a 500", { kind: "status", status: 500 } as const],
    ["a thrown/network error", { kind: "throw" } as const],
    ["a non-JSON 200 body", { kind: "malformed" } as const],
  ])("[LDB-A2] %s answers 503 and caches nothing", async (_label, answer) => {
    const fake = new FakeDiscord();
    fake.setAnswer("tok-f", answer);
    const { clock } = mutableClock("2026-09-09T00:00:00.000Z");

    await expectApiError(resolveBearer(db, clock, "tok-f", fake.fetchImpl, BASE_URL), 503, "identity_unavailable");
    expect(await cacheRowCount()).toBe(0);
  });

  it("[LDB-A2] two different tokens for one user: two cache rows, one authors row", async () => {
    const fake = new FakeDiscord();
    fake.setAnswer("tok-g1", { kind: "ok", id: "1004", username: "dana", global_name: "Dana" });
    fake.setAnswer("tok-g2", { kind: "ok", id: "1004", username: "dana", global_name: "Dana" });
    const { clock } = mutableClock("2026-09-09T00:00:00.000Z");

    await resolveBearer(db, clock, "tok-g1", fake.fetchImpl, BASE_URL);
    await resolveBearer(db, clock, "tok-g2", fake.fetchImpl, BASE_URL);

    expect(await cacheRowCount()).toBe(2);
    const authorCount = await db.prepare("SELECT COUNT(*) AS n FROM authors WHERE user_id = '1004'").first<{ n: number }>();
    expect(authorCount?.n).toBe(1);
  });

  it("[LDB-A2] the raw token string never appears in auth_cache or authors", async () => {
    const fake = new FakeDiscord();
    const rawToken = "super-secret-raw-discord-token-do-not-store";
    fake.setAnswer(rawToken, { kind: "ok", id: "1005", username: "erin", global_name: null });
    const { clock } = mutableClock("2026-09-09T00:00:00.000Z");

    await resolveBearer(db, clock, rawToken, fake.fetchImpl, BASE_URL);

    const cacheRows = await db.prepare("SELECT * FROM auth_cache").all();
    const authorRows = await db.prepare("SELECT * FROM authors").all();
    expect(JSON.stringify(cacheRows.results)).not.toContain(rawToken);
    expect(JSON.stringify(authorRows.results)).not.toContain(rawToken);
  });

  it("[LDB-A2] admin reflects the admins table, read fresh (not cached)", async () => {
    const fake = new FakeDiscord();
    fake.setAnswer("tok-h", { kind: "ok", id: "184412255822020608", username: "deeroh", global_name: null });
    const { clock } = mutableClock("2026-09-09T00:00:00.000Z");

    // '184412255822020608' is the bootstrap admin seeded by migrations/0001_init.sql.
    const actor = await resolveBearer(db, clock, "tok-h", fake.fetchImpl, BASE_URL);
    expect(actor.admin).toBe(true);
  });
});
