// [LDB-PG1..PG5] the lab entries (src/platform/lab-entry.ts, scripts/lab/entry/workers-lab.ts). They patch the
// globals of a stand-in object, never the test process's own.
import { describe, expect, it, vi } from "vitest";
import { createLabEntry, labRandom, PINNED_DISCORD_API_URL, type LabGlobals } from "../../src/platform/lab-entry";
import workersLab from "../../scripts/lab/entry/workers-lab";

function globals(realFetch: typeof fetch = vi.fn(async () => new Response("real")) as never): LabGlobals & { caches: { default: any } } {
  const realCrypto = (globalThis as unknown as { crypto: Crypto }).crypto;
  return {
    Date,
    crypto: { getRandomValues: (a: any) => realCrypto.getRandomValues(a), randomUUID: () => realCrypto.randomUUID() } as unknown as Crypto,
    fetch: realFetch,
    caches: { default: { match: async () => new Response("cached") } },
  };
}

// A worker that reads the clock and randomness through the stand-in globals the entry patched.
function app(g: LabGlobals) {
  const seen: { env: any; body: string }[] = [];
  return {
    seen,
    worker: {
      async fetch(req: Request, env: any) {
        seen.push({ env, body: await req.text() });
        return Response.json({ date: new g.Date().toISOString(), now: g.Date.now(), id: g.crypto.randomUUID(), dsc: env.DISCORD_API_URL });
      },
    },
  };
}

const req = (path = "/v1/meta", headers: Record<string, string> = {}, host = "127.0.0.1:18403") => new Request(`http://${host}${path}`, { headers });
const ctx = {} as ExecutionContext;

describe("lab entry", () => {
  it("[LDB-PG1] refuses every request, and patches nothing, while LAB_MODE is unset", async () => {
    const g = globals();
    const before = { fetch: g.fetch, date: g.Date };
    const a = app(g);
    const entry = createLabEntry(a.worker as never, { globals: g });
    for (const env of [{}, { LAB_MODE: "" }, { LAB_MODE: "off" }]) {
      const res = await entry.fetch(req(), env as never, ctx);
      expect(res.status).toBe(503);
      expect(await res.json()).toMatchObject({ error: "lab_mode_unset" });
    }
    expect(a.seen).toEqual([]);
    expect(g.fetch).toBe(before.fetch);
    expect(g.Date).toBe(before.date);
    await expect(entry.scheduled!({}, {} as never, ctx)).rejects.toMatchObject({ code: "lab_mode_unset" });
  });

  it("[LDB-PG2] refuses a request addressed to api.akldb.org, by URL host or Host header", async () => {
    const g = globals();
    const a = app(g);
    const entry = createLabEntry(a.worker as never, { globals: g });
    const env = { LAB_MODE: "1" } as never;
    const byUrl = await entry.fetch(new Request("https://api.akldb.org/v1/meta"), env, ctx);
    expect(byUrl.status).toBe(403);
    const hostHeader = new Request("http://127.0.0.1:18403/v1/meta");
    Object.defineProperty(hostHeader, "headers", { value: new Headers({ host: "API.akldb.org:443" }) });
    expect((await entry.fetch(hostHeader, env, ctx)).status).toBe(403);
    expect(a.seen).toEqual([]);
    expect((await entry.fetch(req(), env, ctx)).status).toBe(200);
  });

  it("[LDB-PG3] freezes Date and reseeds randomness from x-lab-now / x-lab-seed, with the oracle's generator", async () => {
    // the literals are what scripts/lab/fuzz/d1-lab-entry.ts and p1-crawl-diff.mjs's entry draw for these seeds
    const rng = labRandom(1);
    expect([rng.next(), rng.next(), rng.next()]).toEqual([2693262067, 11749833, 2265367787]);
    rng.seed(42);
    expect([...rng.fill(new Uint8Array(4))]).toEqual([124, 138, 192, 173]);

    const g = globals();
    const a = app(g);
    const entry = createLabEntry(a.worker as never, { globals: g });
    const env = { LAB_MODE: "1" } as never;
    const call = async (headers: Record<string, string>) => (await entry.fetch(req("/x", headers), env, ctx)).json() as Promise<{ date: string; now: number; id: string }>;
    const one = await call({ "x-lab-now": "2026-11-01T00:00:00.000Z", "x-lab-seed": "7" });
    const two = await call({ "x-lab-now": "2026-11-01T00:00:00.000Z", "x-lab-seed": "7" });
    expect(two).toEqual(one);
    expect(one.date).toBe("2026-11-01T00:00:00.000Z");
    expect((await call({ "x-lab-seed": "8" })).id).not.toBe(one.id);
    // the clock stays where the last header put it
    expect((await call({})).date).toBe("2026-11-01T00:00:00.000Z");
    // getRandomValues draws the same stream
    const g3 = globals();
    await createLabEntry({ fetch: async () => new Response("") } as never, { globals: g3 }).fetch(req("/x", { "x-lab-seed": "42" }), env, ctx);
    expect([...g3.crypto.getRandomValues(new Uint8Array(4))]).toEqual([124, 138, 192, 173]);
    // exempt scope (the AWS SDK's own ids) sees real randomness
    const g2 = globals();
    let exempt = false;
    createLabEntry(app(g2).worker as never, { globals: g2, exempt: () => exempt }).fetch(req(), env, ctx);
    await new Promise((r) => setTimeout(r));
    exempt = true;
    expect(g2.crypto.randomUUID()).not.toBe(g2.crypto.randomUUID());
    exempt = false;
  });

  it("[LDB-PG4] reaches 127.0.0.1 only, and falls back to the pinned Discord base", async () => {
    const real = vi.fn(async () => new Response("real"));
    const g = globals(real as never);
    const a = app(g);
    const entry = createLabEntry(a.worker as never, { globals: g });
    const body = (await (await entry.fetch(req(), { LAB_MODE: "1" } as never, ctx)).json()) as { dsc: string };
    expect(body.dsc).toBe(PINNED_DISCORD_API_URL);
    expect(PINNED_DISCORD_API_URL).toBe("https://discord.com/api");
    expect((await (await entry.fetch(req(), { LAB_MODE: "1", DISCORD_API_URL: "http://127.0.0.1:18402/api" } as never, ctx)).json() as { dsc: string }).dsc).toBe("http://127.0.0.1:18402/api");
    await expect(g.fetch("https://discord.com/api/oauth2/@me")).rejects.toThrow(/not 127\.0\.0\.1/);
    await expect(g.fetch("https://api.akldb.org/v1/meta")).rejects.toThrow(/lab fetch refused/);
    await expect(g.fetch("http://localhost:18402/")).rejects.toThrow(/lab fetch refused/);
    expect(real).not.toHaveBeenCalled();
    await g.fetch("http://127.0.0.1:18402/api/oauth2/@me");
    expect(real).toHaveBeenCalledTimes(1);
  });

  it("[LDB-PG5] serves no cached response (the fuzzer oracle's rule), in the generalised workers entry too", async () => {
    const g = globals();
    const a = app(g);
    await createLabEntry(a.worker as never, { globals: g }).fetch(req(), { LAB_MODE: "1" } as never, ctx);
    expect(await g.caches.default.match(new Request("http://127.0.0.1/x"))).toBeUndefined();
    await g.caches.default.put();
    expect(await g.caches.default.delete()).toBe(false);
    // workers-lab is that entry around src/index.ts: it refuses without LAB_MODE and keeps the oracle's reset route
    expect(typeof workersLab.fetch).toBe("function");
    expect((await workersLab.fetch(req(), {} as never, ctx)).status).toBe(503);
    const reset = await workersLab.fetch(new Request("http://127.0.0.1/__lab/reset", { method: "POST" }), {} as never, ctx);
    expect(reset.status).toBe(503);
  });
});
