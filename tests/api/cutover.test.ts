// [LDB-CV1..CV9] The dormant write freeze of the current Worker (docs/technical-reference.md "Cutover modes"): `import_state['cutover.mode']`
// absent (today's behaviour) and `read_only` (503 on every write). Runs in the workers project.
import { SELF, env as harnessEnv, store, testStore } from "../harness";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fixedClock } from "../../src/core/time";
import { d1CutoverStore } from "../../src/store/d1/holds";
import { generateKeyPair, seedClient, signHeaders } from "../auth/client-support";
import { bindings } from "./support";

const NOW = fixedClock("2026-09-12T00:00:00.000Z");
const db = (harnessEnv as unknown as { DB: D1Database }).DB;

// The mode is cached for 1 s per isolate (store.cutover.mode), so a flip is visible after the cache has run out.
const cacheExpiry = () => new Promise<void>((r) => setTimeout(r, 1100));
async function setMode(mode: string | null): Promise<void> {
  if (mode === null) await store.state.delete("cutover.mode");
  else await store.state.put("cutover.mode", mode);
  await cacheExpiry();
}
beforeEach(async () => {
  await setMode(null);
});
afterEach(async () => {
  await setMode(null);
});

async function signedPost(clientId: string, privateKey: CryptoKey, actor: string, path: string, body: string, extra: Record<string, string> = {}): Promise<Response> {
  const bytes = new TextEncoder().encode(body);
  const headers = await signHeaders({ privateKey, clientId, actor, method: "POST", pathWithQuery: path, body: bytes });
  return SELF.fetch(`https://example.com${path}`, { method: "POST", headers: { ...headers, "Content-Type": "application/json", ...extra }, body });
}
async function newClient(): Promise<{ clientId: string; privateKey: CryptoKey; actor: string }> {
  const { privateKey, pubkeyB64url } = await generateKeyPair();
  const clientId = `cv-mode-${crypto.randomUUID()}`;
  const actor = "800000000000000202";
  await seedClient(NOW, { id: clientId, pubkeyB64url, ownerUserId: actor, caps: "act-as-owner-only" });
  return { clientId, privateKey, actor };
}

async function runScheduled(isoTime: string): Promise<string[]> {
  const { createExecutionContext, createScheduledController, waitOnExecutionContext } = await import("../harness");
  const worker = (await import("../../src/index")).default;
  const logs: string[] = [];
  const spy = vi.spyOn(console, "log").mockImplementation((m: unknown) => void logs.push(String(m)));
  try {
    const ctx = createExecutionContext();
    await worker.scheduled(createScheduledController({ scheduledTime: new Date(isoTime), cron: "*/5 * * * *" }), bindings, ctx);
    await waitOnExecutionContext(ctx);
  } finally {
    spy.mockRestore();
  }
  return logs;
}

describe("read_only", () => {
  it("[LDB-CV1] every write gets 503 read_only with Retry-After: 30; GET and HEAD continue; clearing the flag reopens writes", async () => {
    const c = await newClient();
    await setMode("read_only");
    for (const method of ["POST", "PUT", "PATCH", "DELETE"]) {
      const path = method === "POST" ? "/v1/layouts" : "/v1/layouts/cv-none";
      const bytes = new TextEncoder().encode("{}");
      const headers = await signHeaders({ privateKey: c.privateKey, clientId: c.clientId, actor: c.actor, method, pathWithQuery: path, body: bytes });
      const w = await SELF.fetch(`https://example.com${path}`, { method, headers: { ...headers, "Content-Type": "application/json" }, body: "{}" });
      expect(w.status, method).toBe(503);
      expect(w.headers.get("Retry-After"), method).toBe("30");
      expect(w.headers.get("X-AKLDB-API"), method).not.toBeNull();
      expect(await w.json(), method).toEqual({ error: "read_only", message: "akldb is read-only for a moment (a planned switch); retry the write shortly", retry_after: 30 });
    }
    for (const method of ["GET", "HEAD"]) expect((await SELF.fetch("https://example.com/v1/meta", { method })).status, method).toBe(200);
    await setMode(null);
    expect((await signedPost(c.clientId, c.privateKey, c.actor, "/v1/layouts", "{}")).status).not.toBe(503);
  });

  it("[LDB-CV2] the gate sits after the actor and before idempotency and the rate limit: anonymous is still 401, a frozen write is neither charged nor stored", async () => {
    const c = await newClient();
    await setMode("read_only");
    const anon = await SELF.fetch("https://example.com/v1/layouts", { method: "POST", body: "{}" });
    expect(anon.status).toBe(401);
    const before = await testStore.count("ratelimit");
    const idemBefore = await testStore.count("idempotency");
    const res = await signedPost(c.clientId, c.privateKey, c.actor, "/v1/layouts", "{}", { "Idempotency-Key": `k-${crypto.randomUUID()}` });
    expect(res.status).toBe(503);
    expect(await testStore.count("ratelimit")).toBe(before);
    expect(await testStore.count("idempotency")).toBe(idemBefore);
  });

  it("[LDB-CV3] the Discord interaction POST is refused the same way", async () => {
    await setMode("read_only");
    const res = await SELF.fetch("https://example.com/discord/interactions", { method: "POST", body: "{}" });
    expect(res.status).toBe(503);
    expect(res.headers.get("Retry-After")).toBe("30");
    expect((await res.json<{ error: string }>()).error).toBe("read_only");
  });

  it("[LDB-CV4] the scheduled jobs write nothing while a mode is on, the nightly dump included; with the flag off the same tick dumps", async () => {
    const nightly = "2031-05-05T03:00:00Z";
    const dumps = async () => (await (bindings.DUMPS as R2Bucket).list()).objects.length;
    await setMode("read_only");
    const before = await dumps();
    const logs = await runScheduled(nightly);
    expect(logs.some((l) => l.includes("skipped, a cutover mode is on"))).toBe(true);
    expect(await dumps()).toBe(before);
    expect(await testStore.count("import_state", { key: "dump.last_at" })).toBe(0);
    // A failed work probe still honours the flag (it asks the flag's own read).
    {
      const { createExecutionContext, createScheduledController, waitOnExecutionContext } = await import("../harness");
      const worker = (await import("../../src/index")).default;
      const broken = new Proxy(db, {
        get(target, prop) {
          if (prop === "prepare") return (sql: string) => (sql.includes("AS cutover_mode") ? (() => { throw new Error("probe down"); })() : target.prepare(sql));
          const v = Reflect.get(target, prop);
          return typeof v === "function" ? v.bind(target) : v;
        },
      });
      const logs: string[] = [];
      const spies = [vi.spyOn(console, "log").mockImplementation((m: unknown) => void logs.push(String(m))), vi.spyOn(console, "error").mockImplementation(() => {})];
      try {
        const ctx = createExecutionContext();
        await worker.scheduled(createScheduledController({ scheduledTime: new Date(nightly), cron: "*/5 * * * *" }), { ...(bindings as object), DB: broken } as never, ctx);
        await waitOnExecutionContext(ctx);
      } finally {
        for (const sp of spies) sp.mockRestore();
      }
      expect(logs.some((l) => l.includes("skipped, a cutover mode is on"))).toBe(true);
      expect(await dumps()).toBe(before);
    }
    await setMode(null);
    const off = await runScheduled(nightly);
    expect(off.some((l) => l.includes("skipped, a cutover mode is on"))).toBe(false);
    expect(await dumps()).toBeGreaterThan(before);
  });
});

describe("flag off", () => {
  it("[LDB-CV5] with the flag absent, or holding an unrecognised value, nothing changes: reads, writes and the Discord POST are handled as ever", async () => {
    const c = await newClient();
    for (const value of [null, "", "garbage", "READ_ONLY", "off", "proxy"]) {
      await setMode(value);
      expect((await SELF.fetch("https://example.com/v1/meta")).status, String(value)).toBe(200);
      const w = await signedPost(c.clientId, c.privateKey, c.actor, "/v1/layouts", "{}");
      expect(w.status, String(value)).not.toBe(503);
      expect(w.status, String(value)).toBeLessThan(500);
      expect((await SELF.fetch("https://example.com/discord/interactions", { method: "POST", body: "{}" })).status, String(value)).not.toBe(503);
    }
    // `proxy` was a planned mode and is not one: the scheduled tick is not skipped by it, or by any other unrecognised value.
    expect((await runScheduled("2031-05-05T03:00:00Z")).some((l) => l.includes("skipped, a cutover mode is on"))).toBe(false);
  });
});

describe("the flag as data", () => {
  it("[LDB-CV7] the mode is read from D1 import_state and reused for at most 1 s, so an operator's flip needs no deploy", async () => {
    // A separate binding wrapper is a separate cache key; the clock is injected, so the 1 s boundary is exact without sleeping.
    const wrapped = { prepare: (q: string) => db.prepare(q) } as unknown as D1Database;
    let t = 1_000_000;
    const s = d1CutoverStore(wrapped, { nowMs: () => t });
    expect(await s.mode()).toBeNull();
    await testStore.insert("import_state", { key: "cutover.mode", value: "read_only" });
    expect(await s.mode()).toBeNull(); // still cached
    t += 999;
    expect(await s.mode()).toBeNull();
    t += 1;
    expect(await s.mode()).toBe("read_only");
    await testStore.patch("import_state", { key: "cutover.mode" }, { value: "proxy" }); // no longer a mode: normal
    t += 1000;
    expect(await s.mode()).toBeNull();
    await testStore.patch("import_state", { key: "cutover.mode" }, { value: "nonsense" });
    t += 1000;
    expect(await s.mode()).toBeNull();
    await testStore.remove("import_state", { key: "cutover.mode" });
    await testStore.insert("import_state", { key: "cutover.mode", value: "read_only" });
    t += 1000;
    expect(await s.mode()).toBe("read_only");
    await testStore.remove("import_state", { key: "cutover.mode" });
    t += 1000;
    expect(await s.mode()).toBeNull();
    // End to end: the plain-SQL write an operator makes (no deploy) is live for the Worker within the cache window.
    await db.prepare("INSERT INTO import_state (key, value) VALUES ('cutover.mode', 'read_only') ON CONFLICT(key) DO UPDATE SET value = excluded.value").run();
    await cacheExpiry();
    const c = await newClient();
    expect((await signedPost(c.clientId, c.privateKey, c.actor, "/v1/layouts", "{}")).status).toBe(503);
    await db.prepare("DELETE FROM import_state WHERE key = 'cutover.mode'").run();
    await cacheExpiry();
    expect((await signedPost(c.clientId, c.privateKey, c.actor, "/v1/layouts", "{}")).status).not.toBe(503);
  });

  it("[LDB-CV9] a failed read of the flag never turns a working request into an error: it keeps the last known mode, else normal", async () => {
    let fail = false;
    const flaky = {
      prepare: (q: string) => {
        if (fail) throw new Error("D1 unavailable");
        return db.prepare(q);
      },
    } as unknown as D1Database;
    let t = 5_000_000;
    const s = d1CutoverStore(flaky, { nowMs: () => t });
    await testStore.insert("import_state", { key: "cutover.mode", value: "read_only" });
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      fail = true;
      expect(await s.mode()).toBeNull(); // never read: normal
      fail = false;
      t += 1000;
      expect(await s.mode()).toBe("read_only");
      fail = true;
      t += 1000;
      expect(await s.mode()).toBe("read_only"); // a freeze in force stays in force
    } finally {
      spy.mockRestore();
      await testStore.remove("import_state", { key: "cutover.mode" });
    }
  });
});
