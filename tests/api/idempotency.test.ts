// [LDB-K1]..[LDB-K7] `Idempotency-Key` (L3, design/layout-db/review/
// PROPOSAL.md §2.1): a replay of the same `(scope, key)` for the SAME
// method+path+body within 24h returns the stored response verbatim and
// writes nothing; a reuse with a DIFFERENT request is `422
// idempotency_mismatch`, also writing nothing; different actor scopes
// (client id / Discord user id) are independent; a key older than 24h is
// ignored; a request with no header is entirely unaffected; the write-rate
// counter is charged once per key, never again on a replay; two genuinely
// concurrent identical requests never both land (LDB-K7: the key is
// reserved before either handler runs).
import { env } from "cloudflare:test";
import fc from "fast-check";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Bindings } from "../../src/env";
import { commitWrite, rowToEvent, type CommitInput, type EventDbRow } from "../../src/core/events";
import { reserveIdempotency } from "../../src/core/idempotency";
import { fixedClock, type Clock } from "../../src/core/time";
import { ulid } from "ulidx";
import { generateKeyPair, seedClient, signHeaders } from "../auth/client-support";
import { AKL_PAYLOAD, actorFixture, pinTestClock, register, uniqueName, writeFetch } from "./write-support";

const bindings = env as unknown as Bindings;
const db = bindings.DB;
const SOURCE = { client: "discord-app:test", version: null };

afterEach(() => {
  vi.unstubAllGlobals();
  delete (bindings as unknown as { TEST_CLOCK?: Clock }).TEST_CLOCK;
  delete (bindings as unknown as { TEST_RATE_LIMITS?: unknown }).TEST_RATE_LIMITS;
});

async function seed(owner: string, name = uniqueName("idem-seed")): Promise<{ id: string; name: string }> {
  const clock = fixedClock("2026-09-01T00:00:00.000Z");
  const input: CommitInput = {
    layoutId: ulid(),
    creating: true,
    currentN: 0,
    currentLayout: null,
    currentFormats: new Map(),
    layout: { kind: "created", name, owner, created_at: clock(), deleted: false },
    format: { kind: "format_added", lineage: "spark", format: "spark/1", payload: AKL_PAYLOAD, hasMagic: false },
    modified_at: clock(),
    actor: owner,
    via: "discord",
    source: SOURCE,
    upstream: null,
  };
  const { layout } = await commitWrite(db, clock, input);
  return { id: layout.id, name: layout.name };
}

async function eventsOf(layoutId: string, kind?: string) {
  const { results } = await db.prepare("SELECT * FROM events WHERE layout_id = ? ORDER BY seq ASC").bind(layoutId).all<EventDbRow>();
  const events = results.map(rowToEvent);
  return kind === undefined ? events : events.filter((e) => e.kind === kind);
}

describe("[LDB-K5] Idempotency-Key is entirely optional", () => {
  it("[LDB-K5] a request with no header behaves exactly as before -- ordinary write, no idempotency row", async () => {
    const owner = uniqueName("idem-noop-owner");
    const fake = actorFixture();
    const headers = register(fake, `tok-${uniqueName("idem-noop")}`, owner);
    const seeded = await seed(owner);

    const res = await writeFetch(`/v1/layouts/${seeded.id}`, "PATCH", { ...headers, "If-Match": '"layout:1"' }, { name: uniqueName("idem-noop-renamed") });
    expect(res.status).toBe(200);
    expect(res.headers.get("Idempotency-Replayed")).toBeNull();

    const row = await db.prepare("SELECT COUNT(*) AS n FROM idempotency").first<{ n: number }>();
    expect(row?.n).toBe(0);
  });

  it("[LDB-K5] a malformed key (empty, over-length, or non-printable-ASCII) is 400 bad_request, nothing written", async () => {
    const owner = uniqueName("idem-bad-owner");
    const fake = actorFixture();
    const headers = register(fake, `tok-${uniqueName("idem-bad")}`, owner);
    const seeded = await seed(owner);

    for (const bad of ["", "x".repeat(129), "has\ttab"]) {
      const res = await writeFetch(`/v1/layouts/${seeded.id}`, "PATCH", { ...headers, "If-Match": '"layout:1"', "Idempotency-Key": bad }, { name: uniqueName("idem-bad-renamed") });
      expect(res.status, JSON.stringify(bad)).toBe(400);
      const body = await res.json<{ error: string }>();
      expect(body.error).toBe("bad_request");
    }
    expect(await eventsOf(seeded.id, "renamed")).toHaveLength(0);
  });
});

describe("[LDB-K1] replay: same (scope, key) + same method/path/body", () => {
  it("[LDB-K1] a repeat within 24h returns the stored status+body verbatim, Idempotency-Replayed: true, and writes nothing", async () => {
    const owner = uniqueName("idem-replay-owner");
    const fake = actorFixture();
    const headers = register(fake, `tok-${uniqueName("idem-replay")}`, owner);
    const seeded = await seed(owner);
    const key = uniqueName("idem-key-replay");
    const newName = uniqueName("idem-replay-renamed");
    const reqHeaders = { ...headers, "If-Match": '"layout:1"', "Idempotency-Key": key };

    const first = await writeFetch(`/v1/layouts/${seeded.id}`, "PATCH", reqHeaders, { name: newName });
    expect(first.status).toBe(200);
    expect(first.headers.get("Idempotency-Replayed")).toBeNull();
    const firstBody = await first.json();

    expect(await eventsOf(seeded.id, "renamed")).toHaveLength(1);

    for (let i = 0; i < 3; i++) {
      const replay = await writeFetch(`/v1/layouts/${seeded.id}`, "PATCH", reqHeaders, { name: newName });
      expect(replay.status, `replay ${i}`).toBe(200);
      expect(replay.headers.get("Idempotency-Replayed"), `replay ${i}`).toBe("true");
      await expect(replay.json(), `replay ${i}`).resolves.toEqual(firstBody);
    }

    // Still exactly one 'renamed' event -- every replay wrote nothing.
    expect(await eventsOf(seeded.id, "renamed")).toHaveLength(1);
  });

  it("[LDB-K1] PUT /v1/layouts/{ref}/like: a replayed like does not re-like or double the count", async () => {
    const owner = uniqueName("idem-like-owner");
    const fake = actorFixture();
    const headers = register(fake, `tok-${uniqueName("idem-like")}`, owner);
    const seeded = await seed(owner);
    const key = uniqueName("idem-like-key");
    const reqHeaders = { ...headers, "Idempotency-Key": key };

    const first = await writeFetch(`/v1/layouts/${seeded.id}/like`, "PUT", reqHeaders);
    expect(first.status).toBe(200);
    await expect(first.json()).resolves.toEqual({ like_count: 1 });

    const replay = await writeFetch(`/v1/layouts/${seeded.id}/like`, "PUT", reqHeaders);
    expect(replay.status).toBe(200);
    expect(replay.headers.get("Idempotency-Replayed")).toBe("true");
    await expect(replay.json()).resolves.toEqual({ like_count: 1 });

    expect(await eventsOf(seeded.id, "liked")).toHaveLength(1);
  });

  it("[LDB-K1] a 4xx response is also stored -- a retry replays the SAME 4xx (not a fresh, possibly different, one)", async () => {
    const owner = uniqueName("idem-404-owner");
    const fake = actorFixture();
    const headers = register(fake, `tok-${uniqueName("idem-404")}`, owner);
    const key = uniqueName("idem-404-key");
    const reqHeaders = { ...headers, "If-Match": '"layout:1"', "Idempotency-Key": key };
    const body = { name: uniqueName("nope") };

    const first = await writeFetch("/v1/layouts/no-such-layout-at-all", "PATCH", reqHeaders, body);
    expect(first.status).toBe(404);

    const replay = await writeFetch("/v1/layouts/no-such-layout-at-all", "PATCH", reqHeaders, body);
    expect(replay.status).toBe(404);
    expect(replay.headers.get("Idempotency-Replayed")).toBe("true");
  });
});

describe("[LDB-K2] mismatch: same (scope, key), different request", () => {
  it("[LDB-K2] a different body under the same key is 422 idempotency_mismatch, nothing written", async () => {
    const owner = uniqueName("idem-mismatch-owner");
    const fake = actorFixture();
    const headers = register(fake, `tok-${uniqueName("idem-mismatch")}`, owner);
    const seeded = await seed(owner);
    const key = uniqueName("idem-mismatch-key");

    const first = await writeFetch(`/v1/layouts/${seeded.id}`, "PATCH", { ...headers, "If-Match": '"layout:1"', "Idempotency-Key": key }, { name: uniqueName("idem-mismatch-a") });
    expect(first.status).toBe(200);
    expect(await eventsOf(seeded.id, "renamed")).toHaveLength(1);

    const mismatched = await writeFetch(`/v1/layouts/${seeded.id}`, "PATCH", { ...headers, "If-Match": '"layout:2"', "Idempotency-Key": key }, { name: uniqueName("idem-mismatch-b") });
    expect(mismatched.status).toBe(422);
    const body = await mismatched.json<{ error: string }>();
    expect(body.error).toBe("idempotency_mismatch");

    // Still exactly one 'renamed' event -- the mismatch wrote nothing.
    expect(await eventsOf(seeded.id, "renamed")).toHaveLength(1);
  });

  it("[LDB-K2] a different path (same key) is also 422 idempotency_mismatch", async () => {
    const owner = uniqueName("idem-mismatch-path-owner");
    const fake = actorFixture();
    const headers = register(fake, `tok-${uniqueName("idem-mismatch-path")}`, owner);
    const a = await seed(owner, uniqueName("idem-mismatch-path-a"));
    const b = await seed(owner, uniqueName("idem-mismatch-path-b"));
    const key = uniqueName("idem-mismatch-path-key");

    const first = await writeFetch(`/v1/layouts/${a.id}`, "PATCH", { ...headers, "If-Match": '"layout:1"', "Idempotency-Key": key }, { name: uniqueName("renamed-a") });
    expect(first.status).toBe(200);

    const mismatched = await writeFetch(`/v1/layouts/${b.id}`, "PATCH", { ...headers, "If-Match": '"layout:1"', "Idempotency-Key": key }, { name: uniqueName("renamed-b") });
    expect(mismatched.status).toBe(422);
    expect(await eventsOf(b.id, "renamed")).toHaveLength(0);
  });
});

describe("[LDB-K3] scope isolation: (actor scope, key) never collides across callers", () => {
  it("[LDB-K3] two different Discord users reusing the identical key are fully independent", async () => {
    const fake = actorFixture();
    const ownerA = uniqueName("idem-scope-a");
    const ownerB = uniqueName("idem-scope-b");
    const headersA = register(fake, `tok-${uniqueName("idem-scope-a")}`, ownerA);
    const headersB = register(fake, `tok-${uniqueName("idem-scope-b")}`, ownerB);
    const layoutA = await seed(ownerA);
    const layoutB = await seed(ownerB);
    const sameKey = uniqueName("idem-shared-key");

    const resA = await writeFetch(`/v1/layouts/${layoutA.id}/like`, "PUT", { ...headersA, "Idempotency-Key": sameKey });
    expect(resA.status).toBe(200);
    const resB = await writeFetch(`/v1/layouts/${layoutB.id}/like`, "PUT", { ...headersB, "Idempotency-Key": sameKey });
    expect(resB.status).toBe(200);

    expect(await eventsOf(layoutA.id, "liked")).toHaveLength(1);
    expect(await eventsOf(layoutB.id, "liked")).toHaveLength(1);

    // B's own replay of the SAME key still replays B's own response, never
    // A's (a byte-identical body would only prove that by coincidence --
    // the real proof is that B's own second like was NOT double-counted,
    // i.e. its own scope's row, not A's, is what answered).
    const replayB = await writeFetch(`/v1/layouts/${layoutB.id}/like`, "PUT", { ...headersB, "Idempotency-Key": sameKey });
    expect(replayB.status).toBe(200);
    expect(replayB.headers.get("Idempotency-Replayed")).toBe("true");
    expect(await eventsOf(layoutB.id, "liked")).toHaveLength(1);
  });

  it("[LDB-K3] the Ed25519 client lane and the bearer lane scope independently even for the same underlying Discord user id", async () => {
    const fake = actorFixture();
    const discordUserId = "70000000000000001";
    const bearerHeaders = register(fake, `tok-${uniqueName("idem-lane-bearer")}`, discordUserId);
    const bearerLayout = await seed(discordUserId);

    const { privateKey, pubkeyB64url } = await generateKeyPair();
    const clientId = uniqueName("idem-lane-client");
    await seedClient(db, fixedClock("2026-09-01T00:00:00.000Z"), { id: clientId, pubkeyB64url, ownerUserId: discordUserId, caps: "act-as-user" });
    const clientLayout = await seed(discordUserId);
    const sameKey = uniqueName("idem-lane-shared-key");

    const bearerRes = await writeFetch(`/v1/layouts/${bearerLayout.id}/like`, "PUT", { ...bearerHeaders, "Idempotency-Key": sameKey });
    expect(bearerRes.status).toBe(200);

    const clientHeaders = await signHeaders({
      privateKey,
      clientId,
      actor: discordUserId,
      method: "PUT",
      pathWithQuery: `/v1/layouts/${clientLayout.id}/like`,
      timestamp: Math.floor(Date.now() / 1000),
    });
    const clientRes = await writeFetch(`/v1/layouts/${clientLayout.id}/like`, "PUT", { ...clientHeaders, "Idempotency-Key": sameKey });
    expect(clientRes.status).toBe(200);

    expect(await eventsOf(bearerLayout.id, "liked")).toHaveLength(1);
    expect(await eventsOf(clientLayout.id, "liked")).toHaveLength(1);
  });
});

describe("[LDB-K4] a key older than 24h is ignored", () => {
  it("[LDB-K4] resending the identical request past the window is reprocessed fresh, not replayed", async () => {
    const owner = uniqueName("idem-expiry-owner");
    const fake = actorFixture();
    const headers = register(fake, `tok-${uniqueName("idem-expiry")}`, owner);
    const seeded = await seed(owner);
    const key = uniqueName("idem-expiry-key");
    const reqHeaders = { ...headers, "If-Match": '"layout:1"', "Idempotency-Key": key };
    const t0 = "2026-09-10T00:00:00.000Z";
    const t0Plus25h = "2026-09-11T01:00:00.000Z";

    const targetName = uniqueName("idem-expiry-renamed");

    pinTestClock(bindings as unknown as { TEST_CLOCK?: Clock }, fixedClock(t0));
    const first = await writeFetch(`/v1/layouts/${seeded.id}`, "PATCH", reqHeaders, { name: targetName });
    expect(first.status).toBe(200);

    // Still within the window: a genuine replay of the exact same request.
    const withinWindow = await writeFetch(`/v1/layouts/${seeded.id}`, "PATCH", reqHeaders, { name: targetName });
    expect(withinWindow.status).toBe(200);
    expect(withinWindow.headers.get("Idempotency-Replayed")).toBe("true");

    // Past the window: the SAME request (same stale If-Match: "layout:1")
    // is reprocessed for real -- and since the layout's real rev already
    // moved to 2 from the first accepted write, it now correctly fails
    // 409 stale (proof this was NOT served from the idempotency cache,
    // which would have returned the original 200 forever).
    pinTestClock(bindings as unknown as { TEST_CLOCK?: Clock }, fixedClock(t0Plus25h));
    const pastWindow = await writeFetch(`/v1/layouts/${seeded.id}`, "PATCH", reqHeaders, { name: targetName });
    expect(pastWindow.status).toBe(409);
    expect(pastWindow.headers.get("Idempotency-Replayed")).toBeNull();
    const body = await pastWindow.json<{ error: string }>();
    expect(body.error).toBe("stale");
  });
});

describe("[LDB-K6] the write-rate counter is charged once per key, never again on a replay", () => {
  it("[LDB-K6] N replays of an accepted write cost nothing extra against the per-actor limit", async () => {
    (bindings as unknown as { TEST_RATE_LIMITS?: { write: number; client: number } }).TEST_RATE_LIMITS = { write: 2, client: 10 };
    const owner = uniqueName("idem-rl-owner");
    const fake = actorFixture();
    const headers = register(fake, `tok-${uniqueName("idem-rl")}`, owner);
    const seeded = await seed(owner);
    const key = uniqueName("idem-rl-key");
    const reqHeaders = { ...headers, "If-Match": '"layout:1"', "Idempotency-Key": key };
    const name = uniqueName("idem-rl-renamed");

    const first = await writeFetch(`/v1/layouts/${seeded.id}`, "PATCH", reqHeaders, { name });
    expect(first.status).toBe(200); // write #1 of 2

    for (let i = 0; i < 5; i++) {
      const replay = await writeFetch(`/v1/layouts/${seeded.id}`, "PATCH", reqHeaders, { name });
      expect(replay.status, `replay ${i}`).toBe(200);
      expect(replay.headers.get("Idempotency-Replayed"), `replay ${i}`).toBe("true");
    }

    // The limit is 2/actor; only ONE real write happened above, so a
    // second, DIFFERENT write (a fresh key) still fits under the limit.
    const second = await writeFetch(`/v1/layouts/${seeded.id}`, "PATCH", { ...headers, "If-Match": '"layout:2"', "Idempotency-Key": uniqueName("idem-rl-key-2") }, { name: uniqueName("idem-rl-renamed-2") });
    expect(second.status).toBe(200); // write #2 of 2

    const third = await writeFetch(`/v1/layouts/${seeded.id}`, "PATCH", { ...headers, "If-Match": '"layout:3"', "Idempotency-Key": uniqueName("idem-rl-key-3") }, { name: uniqueName("idem-rl-renamed-3") });
    expect(third.status).toBe(429);
  });
});

describe("[LDB-K6] [property] a sequence of writes, each sent 1-3 times with the same key, equals sending each once", () => {
  it("[LDB-K6] [property] any repeat-count sequence produces exactly one 'renamed' event per logical op", async () => {
    await fc.assert(
      fc.asyncProperty(fc.array(fc.integer({ min: 1, max: 3 }), { minLength: 1, maxLength: 5 }), async (repeats) => {
        const owner = uniqueName("idem-prop-owner");
        const fake = actorFixture();
        const headers = register(fake, `tok-${uniqueName("idem-prop")}`, owner);
        const seeded = await seed(owner, uniqueName("idem-prop-seed"));

        let rev = 1;
        for (let i = 0; i < repeats.length; i++) {
          const key = `${uniqueName("idem-prop-key")}-${i}`;
          const name = `${uniqueName("idem-prop-renamed")}-${i}`;
          const reqHeaders = { ...headers, "If-Match": `"layout:${rev}"`, "Idempotency-Key": key };
          for (let send = 0; send < repeats[i]!; send++) {
            const res = await writeFetch(`/v1/layouts/${seeded.id}`, "PATCH", reqHeaders, { name });
            expect(res.status, `op ${i} send ${send}`).toBe(200);
          }
          rev += 1; // exactly one accepted write per logical op, however many times it was sent
        }

        expect(await eventsOf(seeded.id, "renamed")).toHaveLength(repeats.length);
      }),
      { numRuns: 8 },
    );
  });
});

describe("[LDB-K7] the key is reserved before the handler runs -- no concurrent double-apply", () => {
  it("[LDB-K7] two truly concurrent identical requests: exactly one write lands, one event, the loser gets 409 in_progress or the replay", async () => {
    const owner = uniqueName("idem-race-owner");
    const fake = actorFixture();
    const headers = register(fake, `tok-${uniqueName("idem-race")}`, owner);
    const seeded = await seed(owner);
    const key = uniqueName("idem-race-key");
    const reqHeaders = { ...headers, "If-Match": '"layout:1"', "Idempotency-Key": key };
    const name = uniqueName("idem-race-renamed");

    const [a, b] = await Promise.all([
      writeFetch(`/v1/layouts/${seeded.id}`, "PATCH", reqHeaders, { name }),
      writeFetch(`/v1/layouts/${seeded.id}`, "PATCH", reqHeaders, { name }),
    ]);

    // Never both "acquired and ran the handler": the loser is EITHER a
    // replay of the winner's own 200 (Idempotency-Replayed: true) or a
    // fresh 409 idempotency_in_progress -- never a second real write, and
    // never anything else (in particular, never 409 stale, which is what
    // the SECOND request would get if it were mistakenly allowed to run
    // the handler for real against the now-already-renamed layout).
    const statuses = [a.status, b.status].sort((x, y) => x - y);
    expect(statuses[0], `got statuses ${JSON.stringify(statuses)}`).toBe(200);
    expect([200, 409], `got statuses ${JSON.stringify(statuses)}`).toContain(statuses[1]);

    if (a.status === 200 && b.status === 200) {
      const [bodyA, bodyB] = await Promise.all([a.clone().json(), b.clone().json()]);
      expect(bodyA).toEqual(bodyB);
      // Exactly one of the two carries the replay marker -- the OTHER is
      // the real, acquired write.
      const replayedFlags = [a.headers.get("Idempotency-Replayed"), b.headers.get("Idempotency-Replayed")];
      expect(replayedFlags.filter((f) => f === "true")).toHaveLength(1);
    } else {
      const loser = a.status === 409 ? a : b;
      const loserBody = await loser.json<{ error: string }>();
      expect(loserBody.error).toBe("idempotency_in_progress");
    }

    // Whatever the two responses were, exactly ONE real write happened.
    expect(await eventsOf(seeded.id, "renamed")).toHaveLength(1);
  });

  it("[LDB-K7] PUT /v1/layouts/{ref}/like: two concurrent identical likes never both count", async () => {
    const owner = uniqueName("idem-race-like-owner");
    const fake = actorFixture();
    const headers = register(fake, `tok-${uniqueName("idem-race-like")}`, owner);
    const seeded = await seed(owner);
    const key = uniqueName("idem-race-like-key");
    const reqHeaders = { ...headers, "Idempotency-Key": key };

    const [a, b] = await Promise.all([writeFetch(`/v1/layouts/${seeded.id}/like`, "PUT", reqHeaders), writeFetch(`/v1/layouts/${seeded.id}/like`, "PUT", reqHeaders)]);

    for (const res of [a, b]) expect([200, 409]).toContain(res.status);
    expect(await eventsOf(seeded.id, "liked")).toHaveLength(1);
    const likeCount = await db.prepare("SELECT like_count FROM layouts WHERE id = ?").bind(seeded.id).first<{ like_count: number }>();
    expect(likeCount?.like_count).toBe(1);
  });

  it("[LDB-K7] a pending reservation older than ~60s (but well under the 24h key window) is treated as abandoned and taken over", async () => {
    const owner = uniqueName("idem-stale-owner");
    const fake = actorFixture();
    const headers = register(fake, `tok-${uniqueName("idem-stale")}`, owner);
    const seeded = await seed(owner);
    const key = uniqueName("idem-stale-key");
    const path = `/v1/layouts/${seeded.id}`;
    const scope = `user:${owner}`;

    // Pin "now" so the reservation's own `at` can be placed EXACTLY 90s in
    // the past -- stale by the ~60s pending bound, but nowhere near the
    // 24h key-expiry bound (LDB-K4), so this exercises the pending-
    // takeover branch specifically, not the "key expired" one.
    const t0 = "2026-09-10T00:00:00.000Z";
    pinTestClock(bindings as unknown as { TEST_CLOCK?: Clock }, fixedClock(t0));
    const staleAt = new Date(new Date(t0).getTime() - 90_000).toISOString();

    // Simulate a crashed reserver: a pending row (status 0) with that
    // stale `at`, inserted directly (bypassing HTTP) the same way
    // `acquireIdempotencySlot`'s own reservation would.
    const claimed = await reserveIdempotency(db, { scope, key, method: "PATCH", path, request_hash: "stale-hash-does-not-matter", at: staleAt });
    expect(claimed).toBe(true);

    // A real request now is NOT blocked by the abandoned reservation -- it
    // takes it over and proceeds like a fresh acquire.
    const res = await writeFetch(path, "PATCH", { ...headers, "If-Match": '"layout:1"', "Idempotency-Key": key }, { name: uniqueName("idem-stale-renamed") });
    expect(res.status).toBe(200);
    expect(res.headers.get("Idempotency-Replayed")).toBeNull();
    expect(await eventsOf(seeded.id, "renamed")).toHaveLength(1);

    const row = await db.prepare("SELECT status FROM idempotency WHERE scope = ? AND key = ?").bind(scope, key).first<{ status: number }>();
    expect(row?.status).toBe(200); // completed for real, no longer pending
  });

  it("[LDB-K7] a 429/5xx response drops the reservation so a retry with the same key runs completely fresh", async () => {
    (bindings as unknown as { TEST_RATE_LIMITS?: { write: number; client: number } }).TEST_RATE_LIMITS = { write: 1, client: 10 };
    const owner = uniqueName("idem-drop-owner");
    const fake = actorFixture();
    const headers = register(fake, `tok-${uniqueName("idem-drop")}`, owner);
    const seeded = await seed(owner);
    // Exhaust the (very low) per-actor limit with an unrelated write first.
    await writeFetch(`/v1/layouts/${seeded.id}`, "PATCH", { ...headers, "If-Match": '"layout:1"' }, { name: uniqueName("idem-drop-burn") });

    const key = uniqueName("idem-drop-key");
    const reqHeaders = { ...headers, "If-Match": '"layout:2"', "Idempotency-Key": key };
    const name = uniqueName("idem-drop-renamed");

    const limited = await writeFetch(`/v1/layouts/${seeded.id}`, "PATCH", reqHeaders, { name });
    expect(limited.status).toBe(429);

    // The reservation was dropped, not left pending -- nothing in the
    // table for this (scope, key) at all.
    const scope = `user:${owner}`;
    const gone = await db.prepare("SELECT 1 FROM idempotency WHERE scope = ? AND key = ?").bind(scope, key).first();
    expect(gone).toBeNull();
  });
});
