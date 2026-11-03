// [LDB-PV1] [LDB-PV2] The shadow stage through the real Lambda handler: read-only to the world, no scheduled Worker jobs, the
// seed job only on STAGE=shadow, and after a seed and a tick the handler's answers equal production's. The commit log is
// in memory, AWS is a fake, "production" is the harness app.
import path from "node:path";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { SELF, env } from "../harness";
import type { Bindings } from "../../src/env";
import { writeDump } from "../../src/dump/write";
import worker from "../../src/index";
import { createLambdaHandler, ORIGIN_HEADER, type LambdaHandler } from "../../src/platform/lambda";
import type { Aws } from "../../src/platform/lambda-aws";
import { FAKE_DISCORD_BASE } from "../../src/platform/fake-discord";
import { memoryBlobs } from "../../src/platform/node";
import { bootReplica } from "../../src/replica/boot";
import { UPSTREAM_BASE } from "../../src/replica/shadow/upstream";
import { registerForTest } from "../../formats/registry.ts";
import { T1 } from "../formats/stub-lineage.ts";
import { FAST, migratedLog } from "../shim/support";
import { scenario } from "./shadow-scenario";
import { SHADOW_MIGRATIONS } from "./shadow-support";

const unregister = registerForTest(T1);
afterAll(unregister);
const bindings = env as unknown as Bindings;
const SECRET = "shadow-origin-secret-0123456789abcdef";
const MIGRATIONS = path.resolve(import.meta.dirname, "..", "..", "migrations");
const uninstallers: (() => void)[] = [];
afterEach(() => {
  while (uninstallers.length > 0) uninstallers.pop()!();
});

function fakeAws(): Aws & { blobs: ReturnType<typeof memoryBlobs> } {
  const blobs = memoryBlobs();
  return {
    blobs,
    dumps: blobs,
    async getParameters(names) {
      const values: Record<string, string> = { "origin-secret": SECRET, "discord-bot-token": "must-not-be-used" };
      return { values: Object.fromEntries(names.filter((n) => n in values).map((n) => [n, values[n]!])), missing: [] };
    },
    async invokeAsync() {},
    async invokeLive() {
      return { ok: true };
    },
  };
}

/** The harness app as production's public API, for the handler's follower and seed. */
const viaHarness = (input: string | URL | Request, init?: RequestInit): Promise<Response> => SELF.fetch(input instanceof Request ? input.url : String(input), init);

async function shadowHandler(stage = "shadow", lines: string[] = [], guard = false): Promise<{ handler: LambdaHandler; lines: string[]; aws: ReturnType<typeof fakeAws> }> {
  const aws = fakeAws();
  const handler = createLambdaHandler({
    env: { STAGE: stage, DISCORD_API_URL: "https://discord.com/api", MODQUEUE_DISCORD_COMPONENTS: "false" },
    aws,
    log: await migratedLog(),
    migrationsDir: MIGRATIONS,
    boot: (l) => bootReplica(l, FAST),
    logError: () => {},
    logLine: (l) => void lines.push(l),
    shadow: { fetch: viaHarness, migrationsDir: SHADOW_MIGRATIONS, installGuard: guard },
  });
  if (handler.shadow !== undefined) uninstallers.push(handler.shadow.uninstallGuard);
  await handler.ready();
  return { handler, lines, aws };
}

function event(rawPath: string, over: { method?: string; headers?: Record<string, string>; query?: string } = {}) {
  const method = over.method ?? "GET";
  return {
    version: "2.0", routeKey: "$default", rawPath, rawQueryString: over.query ?? "",
    headers: { host: "shadow-api.akldb.org", [ORIGIN_HEADER]: SECRET, ...over.headers },
    requestContext: { accountId: "335937358231", apiId: "abc", domainName: "shadow-api.akldb.org", domainPrefix: "shadow-api", http: { method, path: rawPath, protocol: "HTTP/1.1", sourceIp: "203.0.113.9", userAgent: "vitest" }, requestId: "r1", routeKey: "$default", stage: "$default", time: "02/Nov/2026:03:02:10 +0000", timeEpoch: Date.parse("2026-11-02T03:02:10Z") },
    isBase64Encoded: false,
  };
}
type Http = { statusCode: number; body: string; headers: Record<string, string> };

describe("shadow stage through the handler", () => {
  it("[LDB-PV2] the seed job and shadow-status are refused unless STAGE=shadow", async () => {
    const { handler } = await shadowHandler("staging");
    await expect(handler({ akldb: "seed", dumpUrl: `${UPSTREAM_BASE}/v1/dump/latest.json` })).rejects.toThrow(/only on the shadow stage/);
    await expect(handler({ akldb: "shadow-status" })).rejects.toThrow(/only on the shadow stage/);
    expect((await handler({ akldb: "warm" })) as { ok: boolean }).toMatchObject({ ok: true });
  });

  it("[LDB-PV1] shadow answers reads only: a write method gets 405 and a credential gets 403, before the replica is touched", async () => {
    const { handler } = await shadowHandler();
    for (const method of ["POST", "PUT", "PATCH", "DELETE"]) {
      const res = (await handler(event("/v1/layouts", { method }))) as Http;
      expect(res.statusCode, method).toBe(405);
      expect(JSON.parse(res.body).error).toBe("shadow_read_only");
    }
    for (const h of [{ authorization: "Bearer x" }, { "x-akl-client": "c1" }] as Record<string, string>[]) {
      const res = (await handler(event("/v1/me", { headers: h }))) as Http;
      expect(res.statusCode).toBe(403);
      expect(JSON.parse(res.body).error).toBe("shadow_no_credentials");
    }
    expect(((await handler(event("/v1/meta", { method: "OPTIONS" }))) as Http).statusCode).toBeLessThan(300);
    expect(((await handler(event("/v1/meta"))) as Http).statusCode).toBe(200);
  });

  it("[LDB-PV1] the handler installs the egress guard, points Discord at the fake whatever the environment says, and ignores SSM's Discord settings", async () => {
    const lines: string[] = [];
    const { handler } = await shadowHandler("shadow", lines, true);
    expect(lines).toContain("akldb-alarm: shadow-egress: DISCORD_API_URL is not the fake Discord; using " + FAKE_DISCORD_BASE);
    await expect(fetch("https://discord.com/api/v10/channels/1/messages", { method: "POST", body: "{}" })).rejects.toThrow(/shadow egress refused/);
    expect(lines.some((l) => l === "akldb-alarm: shadow-egress: refused POST discord.com")).toBe(true);
    const r = await fetch(`${FAKE_DISCORD_BASE}/v10/interactions/9/t/callback`, { method: "POST", body: "{}" });
    expect(r.status).toBe(204);
    expect(handler.shadow?.fakeDiscord.total()).toBe(1);
  });

  it("[LDB-PV1] [LDB-PV2] seed, then a tick that follows the feed WITHOUT the Worker's scheduled jobs; afterwards the handler answers what production answers", async () => {
    const sc = await scenario(71);
    await sc.run(25);
    await sc.stateChange("lambda");
    await writeDump(bindings, sc.clock);
    const { handler, aws } = await shadowHandler();
    const scheduled = vi.spyOn(worker, "scheduled");

    // before the seed: a tick says so and does nothing
    const early = (await handler({ akldb: "tick", time: "2026-11-02T03:05:00Z" })) as { shadow: { status: string } };
    expect(early.shadow.status).toBe("not-seeded");

    const seeded = (await handler({ akldb: "seed", dumpUrl: `${UPSTREAM_BASE}/v1/dump/latest.json` })) as { ok: boolean; seq: number; layouts: number };
    expect(seeded.ok).toBe(true);
    await expect(handler({ akldb: "seed" })).rejects.toThrow(/not empty/);
    // the dump was mirrored into shadow's own bucket, so shadow's /v1/dump/latest.json names the seed
    const latest = await aws.blobs.get("latest.json");
    expect(JSON.parse(await new Response(latest!.body).text()).seq).toBe(seeded.seq);

    await sc.run(30);
    const tick = (await handler({ akldb: "tick", time: "2026-11-02T03:10:00Z" })) as { shadow: { status: string; applied: number; discordCalls: number } };
    expect(tick.shadow.status).toBe("ok");
    expect(tick.shadow.applied).toBeGreaterThan(0);
    expect(tick.shadow.discordCalls).toBe(0);
    expect(scheduled).not.toHaveBeenCalled();

    for (const [p, q] of [["/v1/meta", ""], ["/v1/layouts", "format=spark/1&limit=50"], ["/v1/changes", "since=0&limit=1000"], ["/v1/formats", ""]] as const) {
      const mine = (await handler(event(p, { query: q }))) as Http;
      const theirs = await SELF.fetch(`${UPSTREAM_BASE}${p}${q === "" ? "" : `?${q}`}`);
      expect(mine.statusCode, p).toBe(200);
      if (p === "/v1/meta") {
        // `health` is live bookkeeping (dump.last_at, ages) that production's own jobs write; the replay differ masks it too
        const { health: _a, ...a } = JSON.parse(mine.body) as Record<string, unknown>;
        const { health: _b, ...b } = (await theirs.json()) as Record<string, unknown>;
        expect(a).toEqual(b);
      } else {
        expect(mine.body, p).toBe(await theirs.text());
        expect(mine.headers.etag ?? null, p).toBe(theirs.headers.get("etag"));
      }
    }
    const status = (await handler({ akldb: "shadow-status" })) as { follower: { cursor: number; stale: Record<string, number> } };
    expect(status.follower.cursor).toBeGreaterThan(seeded.seq);
    expect(Object.keys(status.follower.stale).length).toBeGreaterThanOrEqual(0);
  }, 60_000);
});
