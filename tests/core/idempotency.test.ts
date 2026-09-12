// [LDB-K1]..[LDB-K5] pure-function coverage for `core/idempotency.ts` --
// the D1-backed half (`getIdempotency`/`storeIdempotency`/`pruneIdempotency`)
// and the middleware's own HTTP behavior are covered live in
// `tests/api/idempotency.test.ts` (a "workers" project test); this file is
// the "node" project half: key validation, scope derivation, hashing and
// the 24h expiry boundary, none of which need D1 or a real request.
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import type { Actor } from "../../src/auth/actor";
import { fixedClock } from "../../src/core/time";
import {
  IDEMPOTENCY_WINDOW_MS,
  idempotencyScope,
  isExpired,
  isValidIdempotencyKey,
  requestHash,
  shouldStoreStatus,
} from "../../src/core/idempotency";

function actor(via: Actor["via"], user_id = "800000000000000001"): Actor {
  return { user_id, name: "n", via, admin: false, source_client: via === "discord" ? "discord-app:test" : via };
}

describe("[LDB-K5] isValidIdempotencyKey", () => {
  it("accepts 1-128 printable ASCII characters", () => {
    expect(isValidIdempotencyKey("a")).toBe(true);
    expect(isValidIdempotencyKey("x".repeat(128))).toBe(true);
    expect(isValidIdempotencyKey("4f2c-swap-1")).toBe(true);
    expect(isValidIdempotencyKey("has spaces and !@#$%^&*()")).toBe(true);
  });

  it("refuses empty, over-length, or non-printable-ASCII keys", () => {
    expect(isValidIdempotencyKey("")).toBe(false);
    expect(isValidIdempotencyKey("x".repeat(129))).toBe(false);
    expect(isValidIdempotencyKey("tab\tinside")).toBe(false);
    expect(isValidIdempotencyKey("newline\ninside")).toBe(false);
    expect(isValidIdempotencyKey("emoji-\u{1F600}")).toBe(false);
  });
});

describe("[LDB-K3] idempotencyScope", () => {
  it("[LDB-K3] scopes the bearer lane on the actor's own Discord user id", () => {
    expect(idempotencyScope(actor("discord", "12345"))).toBe("user:12345");
  });

  it("[LDB-K3] scopes the Ed25519 client lane on the client's own id (Actor.via, verbatim)", () => {
    expect(idempotencyScope(actor("client:abc123"))).toBe("client:abc123");
  });

  it("[LDB-K3] two different scopes never collide even with the exact same user id string appearing in both", () => {
    const bearerScope = idempotencyScope(actor("discord", "client:abc123"));
    const clientScope = idempotencyScope(actor("client:abc123"));
    expect(bearerScope).not.toBe(clientScope);
  });
});

describe("requestHash", () => {
  it("is deterministic for the same bytes", async () => {
    const body = new TextEncoder().encode(JSON.stringify({ a: 1 }));
    const h1 = await requestHash(body);
    const h2 = await requestHash(body);
    expect(h1).toBe(h2);
    expect(h1).toMatch(/^[0-9a-f]{64}$/);
  });

  it("differs for different bytes", async () => {
    const a = await requestHash(new TextEncoder().encode('{"a":1}'));
    const b = await requestHash(new TextEncoder().encode('{"a":2}'));
    expect(a).not.toBe(b);
  });

  it("the empty body (DELETE, bodyless restore) hashes consistently", async () => {
    const a = await requestHash(new TextEncoder().encode(""));
    const b = await requestHash(new TextEncoder().encode(""));
    expect(a).toBe(b);
  });
});

describe("[LDB-K4] isExpired", () => {
  const at = "2026-09-12T00:00:00.000Z";

  it("[LDB-K4] a row exactly at the window boundary is expired (>=)", () => {
    const now = fixedClock(new Date(new Date(at).getTime() + IDEMPOTENCY_WINDOW_MS).toISOString());
    expect(isExpired({ at }, now)).toBe(true);
  });

  it("[LDB-K4] a row one millisecond inside the window is not expired", () => {
    const now = fixedClock(new Date(new Date(at).getTime() + IDEMPOTENCY_WINDOW_MS - 1).toISOString());
    expect(isExpired({ at }, now)).toBe(false);
  });

  it("a fresh row (now === at) is never expired", () => {
    expect(isExpired({ at }, fixedClock(at))).toBe(false);
  });
});

describe("shouldStoreStatus", () => {
  it("stores 2xx and 4xx", () => {
    for (const s of [200, 201, 400, 403, 404, 409, 422]) expect(shouldStoreStatus(s)).toBe(true);
  });

  it("never stores 429 or 5xx -- a fresh retry should get a fresh judgement, not a frozen one", () => {
    for (const s of [429, 500, 502, 503]) expect(shouldStoreStatus(s)).toBe(false);
  });

  it("[property] shouldStoreStatus is exactly {2xx, 4xx} minus 429", () => {
    fc.assert(
      fc.property(fc.integer({ min: 100, max: 599 }), (status) => {
        const expected = status !== 429 && status >= 200 && status < 500;
        expect(shouldStoreStatus(status)).toBe(expected);
      }),
    );
  });
});
