import { env } from "cloudflare:test";
import { describe, expect, it, vi } from "vitest";
import type { Bindings } from "../../src/env";
import { deliver, DeliveryDeferred, discordJson, retryDelay } from "../../src/core/modqueue-delivery";

const db = (env as unknown as Bindings).DB;
const url = "https://discord.test/messages/1";
const consume = async (response: Response) => response.status;

describe("[LDB-MD24] durable moderation delivery gate", () => {
  it("honors decimal seconds and HTTP dates, taking the safest supplied delay", () => {
    expect(retryDelay(new Headers({ "Retry-After": "1.25" }), { retry_after: 2.5 }, 0)).toBe(2500);
    expect(retryDelay(new Headers({ "Retry-After": "Thu, 01 Jan 1970 00:01:00 GMT" }), null, 1000)).toBe(59000);
    expect(retryDelay(new Headers(), { retry_after: "bogus" }, 0)).toBe(1000);
  });

  it("serializes concurrent calls without sending the loser", async () => {
    let started!: () => void;
    const ready = new Promise<void>((resolve) => { started = resolve; });
    let finish!: () => void;
    const blocked = new Promise<void>((resolve) => { finish = resolve; });
    let calls = 0;
    const fetcher: typeof fetch = async () => { calls++; started(); await blocked; return new Response(null, { status: 204 }); };
    const first = deliver(db, fetcher, url, {}, consume);
    await ready;
    await expect(deliver(db, fetcher, url, {}, consume)).rejects.toBeInstanceOf(DeliveryDeferred);
    finish();
    expect(await first).toBe(204);
    expect(calls).toBe(1);
  });

  it("persists 429 cooldown across fresh callers and resumes after expiry", async () => {
    let calls = 0;
    const limited: typeof fetch = async () => { calls++; return Response.json({ retry_after: 60 }, { status: 429 }); };
    await expect(deliver(db, limited, url, {}, consume)).rejects.toBeInstanceOf(DeliveryDeferred);
    await expect(deliver(db, limited, url, {}, consume)).rejects.toBeInstanceOf(DeliveryDeferred);
    expect(calls).toBe(1);
    const gate = await db.prepare("SELECT retry_at, lease_token FROM modqueue_delivery_gate WHERE id = 1").first<{ retry_at: number; lease_token: string | null }>();
    expect(gate!.retry_at).toBeGreaterThan(Date.now());
    expect(gate!.lease_token).toBeNull();
    await db.prepare("UPDATE modqueue_delivery_gate SET retry_at = 0 WHERE id = 1").run();
    expect(await deliver(db, async () => new Response(null, { status: 204 }), url, {}, consume)).toBe(204);
  });

  it("expires crashed leases and fences stale owners from cooldown and cleanup", async () => {
    await db.prepare("UPDATE modqueue_delivery_gate SET lease_token = 'crashed', lease_until = 1 WHERE id = 1").run();
    const stale: typeof fetch = async () => {
      await db.prepare("UPDATE modqueue_delivery_gate SET lease_token = 'new-owner', lease_until = ?, retry_at = 123 WHERE id = 1").bind(Date.now() + 30000).run();
      return Response.json({ retry_after: 60 }, { status: 429 });
    };
    await expect(deliver(db, stale, url, {}, consume)).rejects.toBeInstanceOf(DeliveryDeferred);
    expect(await db.prepare("SELECT lease_token, retry_at FROM modqueue_delivery_gate WHERE id = 1").first()).toEqual({ lease_token: "new-owner", retry_at: 123 });
    await db.prepare("UPDATE modqueue_delivery_gate SET lease_token = NULL, lease_until = 0, retry_at = 0 WHERE id = 1").run();
  });

  it("[LDB-MD24] a stalled body and cancellation cannot hold the gate forever", async () => {
    vi.useFakeTimers();
    try {
      const response = new Response(new ReadableStream({ pull: () => new Promise(() => {}), cancel: () => new Promise(() => {}) }));
      const reading = deliver(db, async () => response, url, {}, discordJson);
      const rejected = expect(reading).rejects.toThrow("timeout");
      // Let the D1 claim settle and arm the reader deadline before advancing it.
      await vi.waitFor(async () => { expect((await db.prepare("SELECT lease_token FROM modqueue_delivery_gate WHERE id = 1").first<{ lease_token: string | null }>())!.lease_token).not.toBeNull(); });
      await vi.advanceTimersByTimeAsync(5001);
      await rejected;
      expect(await deliver(db, async () => new Response(null, { status: 204 }), url, {}, consume)).toBe(204);
    } finally { vi.useRealTimers(); }
  });

  it("releases on error statuses and bounds JSON bodies", async () => {
    expect(await deliver(db, async () => new Response("unavailable", { status: 503 }), url, {}, consume)).toBe(503);
    await expect(deliver(db, async () => new Response("x".repeat(300000)), url, {}, discordJson)).rejects.toThrow("too large");
    expect(await deliver(db, async () => new Response(null, { status: 204 }), url, {}, consume)).toBe(204);
  });
});
