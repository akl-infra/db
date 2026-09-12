// [LDB-CH1..CH5] GET /v1/changes?wait= (LEDGER.md L4): a long-poll,
// honoured only for a registered client with the `feed:wait` capability.
// `TEST_LONGPOLL_SLEEP` (a miniflare binding pinned per test, `src/routes/
// changes.ts`'s `resolveSleep`) replaces the real 1s `setTimeout` so these
// run fast and deterministic -- no real waiting anywhere in this file.
import { SELF, env } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Bindings } from "../../src/env";
import { appendAdmin } from "../../src/core/events";
import { fixedClock } from "../../src/core/time";
import { clampWaitSeconds, MAX_WAIT_SECONDS } from "../../src/core/longpoll";
import { generateKeyPair, seedClient, signHeaders } from "../auth/client-support";
import { bindings, db } from "./support";

const NOW = fixedClock("2026-09-12T00:00:00.000Z");

async function appendBareAdminEvent(): Promise<void> {
  await appendAdmin(db, NOW, { kind: "admin.import_paused", actor: "system:test" });
}

function setSleepSpy(): { calls: number[]; sideEffects: (() => void | Promise<void>)[] } {
  const state = { calls: [] as number[], sideEffects: [] as (() => void | Promise<void>)[] };
  let i = 0;
  (bindings as unknown as { TEST_LONGPOLL_SLEEP: (ms: number) => Promise<void> }).TEST_LONGPOLL_SLEEP = async (ms: number) => {
    state.calls.push(ms);
    const effect = state.sideEffects[i];
    i++;
    if (effect !== undefined) await effect();
  };
  return state;
}

async function signedGetChanges(privateKey: CryptoKey, clientId: string, actor: string, query: string): Promise<Response> {
  const path = `/v1/changes${query}`;
  const headers = await signHeaders({ privateKey, clientId, actor, method: "GET", pathWithQuery: path });
  return SELF.fetch(`https://example.com${path}`, { method: "GET", headers });
}

beforeEach(async () => {
  await db.batch([db.prepare("DELETE FROM events"), db.prepare("DELETE FROM layout_revs")]);
});

afterEach(() => {
  delete (bindings as unknown as { TEST_LONGPOLL_SLEEP?: unknown }).TEST_LONGPOLL_SLEEP;
});

describe("clampWaitSeconds (pure)", () => {
  it("[LDB-CH4] clamps to [0, MAX_WAIT_SECONDS]", () => {
    expect(clampWaitSeconds(-5)).toBe(0);
    expect(clampWaitSeconds(0)).toBe(0);
    expect(clampWaitSeconds(10)).toBe(10);
    expect(clampWaitSeconds(MAX_WAIT_SECONDS)).toBe(MAX_WAIT_SECONDS);
    expect(clampWaitSeconds(9999)).toBe(MAX_WAIT_SECONDS);
    // Non-finite input (never reached through the route -- `parseWait`
    // rejects it with `400 bad_request` first) is defensively 0, not MAX.
    expect(clampWaitSeconds(Number.POSITIVE_INFINITY)).toBe(0);
    expect(clampWaitSeconds(Number.NaN)).toBe(0);
  });
});

describe("[LDB-CH1..CH5] GET /v1/changes?wait= gating and behavior", () => {
  it("[LDB-CH3] wait= without the feed:wait cap is ignored: immediate answer, X-Wait-Ignored header, no error", async () => {
    const before = await appendBareAdminEvent().then(() => SELF.fetch("https://example.com/v1/changes"));
    const beforeBody = await before.json<{ next: number }>();

    // Totally unauthenticated -- no signature at all.
    const res = await SELF.fetch("https://example.com/v1/changes?wait=25");
    expect(res.status).toBe(200);
    expect(res.headers.get("X-Wait-Ignored")).toBe("unauthorized");
    const body = await res.json<{ next: number }>();
    expect(body.next).toBe(beforeBody.next); // the immediate page, nothing waited for
  });

  it("[LDB-CH3] a signed client WITHOUT feed:wait is also ignored (immediate + header)", async () => {
    const { privateKey, pubkeyB64url } = await generateKeyPair();
    const clientId = `test-client-nowait-${crypto.randomUUID()}`;
    const actor = "800000000000000101";
    await seedClient(db, NOW, { id: clientId, pubkeyB64url, ownerUserId: actor, caps: "act-as-owner-only" }); // no feed:wait

    const res = await signedGetChanges(privateKey, clientId, actor, "?wait=5");
    expect(res.status).toBe(200);
    expect(res.headers.get("X-Wait-Ignored")).toBe("unauthorized");
  });

  it("[LDB-CH1] [LDB-CH5] with nothing happening, a held wait returns the immediate page within its budget, at <= wait+1 D1 head-reads", async () => {
    const { privateKey, pubkeyB64url } = await generateKeyPair();
    const clientId = `test-client-wait-${crypto.randomUUID()}`;
    const actor = "800000000000000102";
    await seedClient(db, NOW, { id: clientId, pubkeyB64url, ownerUserId: actor, caps: "act-as-owner-only,feed:wait" });

    const sleeps = setSleepSpy();
    const waitSeconds = 3;
    const res = await signedGetChanges(privateKey, clientId, actor, `?wait=${waitSeconds}`);
    expect(res.status).toBe(200);
    expect(res.headers.get("X-Wait-Ignored")).toBeNull();
    const body = await res.json<{ next: number; items: unknown[] }>();
    expect(Array.isArray(body.items)).toBe(true);

    // waitForChanges sleeps once per check except the last -- ceil(wait)
    // checks total, ceil(wait)-1 sleeps in between (invariant (e): reads
    // during the hold <= wait+1; sleeps are one fewer than reads).
    expect(sleeps.calls.length).toBeLessThanOrEqual(waitSeconds);
    for (const ms of sleeps.calls) expect(ms).toBe(1000);
  });

  it("[LDB-CH2] returns as soon as an event lands mid-wait, without exhausting the full budget", async () => {
    const { privateKey, pubkeyB64url } = await generateKeyPair();
    const clientId = `test-client-wait2-${crypto.randomUUID()}`;
    const actor = "800000000000000103";
    await seedClient(db, NOW, { id: clientId, pubkeyB64url, ownerUserId: actor, caps: "act-as-owner-only,feed:wait" });

    const before = await SELF.fetch("https://example.com/v1/changes");
    const beforeBody = await before.json<{ next: number }>();

    const sleeps = setSleepSpy();
    // On the FIRST sleep (between the 1st and 2nd head-check), append a
    // real event -- the 2nd check should then see it and return, well
    // short of the 20s budget.
    sleeps.sideEffects[0] = async () => {
      await appendBareAdminEvent();
    };

    const res = await signedGetChanges(privateKey, clientId, actor, `?wait=20&since=${beforeBody.next}`);
    expect(res.status).toBe(200);
    const body = await res.json<{ next: number; items: { kind: string }[] }>();
    expect(body.next).toBeGreaterThan(beforeBody.next);
    expect(body.items.some((i) => i.kind === "admin.import_paused")).toBe(true);
    // Returned after the FIRST sleep resolved the event, not all 20.
    expect(sleeps.calls.length).toBeLessThan(20);
  });

  it("[LDB-CH4] wait is clamped to MAX_WAIT_SECONDS even when a caller asks for more", async () => {
    const { privateKey, pubkeyB64url } = await generateKeyPair();
    const clientId = `test-client-wait3-${crypto.randomUUID()}`;
    const actor = "800000000000000104";
    await seedClient(db, NOW, { id: clientId, pubkeyB64url, ownerUserId: actor, caps: "act-as-owner-only,feed:wait" });

    const sleeps = setSleepSpy();
    const res = await signedGetChanges(privateKey, clientId, actor, "?wait=9999");
    expect(res.status).toBe(200);
    // ceil(MAX_WAIT_SECONDS) + 1 reads total -> at most MAX_WAIT_SECONDS
    // sleeps in between, never anywhere near 9999.
    expect(sleeps.calls.length).toBeLessThanOrEqual(MAX_WAIT_SECONDS);
  });

  it("without wait=, behavior is unchanged: immediate, cacheable, no header", async () => {
    const res = await SELF.fetch("https://example.com/v1/changes");
    expect(res.status).toBe(200);
    expect(res.headers.get("X-Wait-Ignored")).toBeNull();
    expect(res.headers.get("Cache-Control")).toBe("public, max-age=10");
    expect(res.headers.get("ETag")).not.toBeNull();
  });
});
