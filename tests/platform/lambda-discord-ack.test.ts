// [LDB-CV28] A Discord ACK must reach Discord within 3 s, and the Lambda host answers only after its background work has
// ended. So on Lambda the work an ACK leaves behind (the persisted actions, the moderation DMs) runs in the jobs function,
// started by an async invoke, and the ACK goes back at once; without a jobs function it stays in-process, as on the Worker.
// The interaction handler itself is stubbed to a deferred update (type 6): its own behaviour is tests/auth/discord-interactions.
import path from "node:path";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const calls = vi.hoisted(() => ({ drains: 0, dms: 0 }));
vi.mock("../../src/core/discord-interactions", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/core/discord-interactions")>()),
  handleDiscordInteraction: async () => new Response(JSON.stringify({ type: 6 }), { status: 200, headers: { "content-type": "application/json" } }),
  drainDiscordActions: async () => {
    calls.drains++;
  },
}));
vi.mock("../../src/core/rejection-dm", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/core/rejection-dm")>()),
  dispatchRejectionDms: async () => {
    calls.dms++;
  },
}));

import { createLambdaHandler, ORIGIN_HEADER } from "../../src/platform/lambda";
import type { Aws } from "../../src/platform/lambda-aws";
import { memoryBlobs } from "../../src/platform/node";
import { bootReplica } from "../../src/replica/boot";
import { MemoryLog } from "../../src/replica/log-memory";
import { applyMigrations } from "../../src/replica/migrations";
import { Replica } from "../../src/replica/replica";

const MIGRATIONS = path.resolve(import.meta.dirname, "..", "..", "migrations");
const SECRET = "s3cret-origin-value-0123456789abcdef";
const FAST = { sleep: async () => {}, backoffMs: 0 };

let seeded: MemoryLog;
beforeAll(async () => {
  seeded = new MemoryLog();
  const seed = new Replica(seeded, FAST);
  await applyMigrations(seed, MIGRATIONS);
  seed.close();
}, 60_000);

beforeEach(() => {
  calls.drains = 0;
  calls.dms = 0;
});

function fakeAws(): Aws & { async: { fn: string; payload: unknown }[] } {
  const blobs = memoryBlobs();
  const async: { fn: string; payload: unknown }[] = [];
  return {
    async,
    dumps: blobs,
    async getParameters(names) {
      const values: Record<string, string> = { "origin-secret": SECRET };
      return { values: Object.fromEntries(names.filter((n) => n in values).map((n) => [n, values[n]!])), missing: names.filter((n) => !(n in values)) };
    },
    async invokeAsync(fn, payload) {
      async.push({ fn, payload });
    },
    async invokeLive() {
      return { ok: true, container: "other" };
    },
  };
}

function handlerWith(aws: Aws, jobs: string | undefined) {
  return createLambdaHandler({
    env: {
      STAGE: "staging", DISCORD_API_URL: "http://127.0.0.1:1/discord", MODQUEUE_DISCORD_COMPONENTS: "false",
      ...(jobs !== undefined ? { JOBS_FUNCTION: jobs } : {}),
    },
    aws,
    log: seeded,
    migrationsDir: MIGRATIONS,
    boot: (l) => bootReplica(l, FAST),
    logError: () => {},
  });
}

function interaction() {
  return {
    version: "2.0",
    routeKey: "$default",
    rawPath: "/discord/interactions",
    rawQueryString: "",
    headers: { host: "staging-api.akldb.org", "content-type": "application/json", [ORIGIN_HEADER]: SECRET },
    body: JSON.stringify({ type: 3 }),
    requestContext: {
      accountId: "335937358231", apiId: "abc", domainName: "staging-api.akldb.org", domainPrefix: "staging-api",
      http: { method: "POST", path: "/discord/interactions", protocol: "HTTP/1.1", sourceIp: "203.0.113.9", userAgent: "Discord-Interactions/1.0" },
      requestId: "r1", routeKey: "$default", stage: "$default", time: "03/Nov/2026:15:38:03 +0000", timeEpoch: Date.parse("2026-11-03T15:38:03Z"),
    },
    isBase64Encoded: false,
  };
}

describe("the work after a Discord ACK", () => {
  it("[LDB-CV28] with a jobs function: the ACK returns after one async invoke of {akldb: discord}, and nothing is drained in-process", async () => {
    const aws = fakeAws();
    const res = (await handlerWith(aws, "akldb-staging-jobs:live")(interaction())) as { statusCode: number; body: string };
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ type: 6 });
    expect(aws.async).toEqual([{ fn: "akldb-staging-jobs:live", payload: { akldb: "discord" } }]);
    expect(calls).toEqual({ drains: 0, dms: 0 });
  });

  it("[LDB-CV28] without one (tests, local): the work runs in-process before the handler returns, as before", async () => {
    const aws = fakeAws();
    const res = (await handlerWith(aws, undefined)(interaction())) as { statusCode: number };
    expect(res.statusCode).toBe(200);
    expect(aws.async).toEqual([]);
    expect(calls).toEqual({ drains: 1, dms: 1 });
  });

  it("[LDB-CV28] the {akldb: discord} event (the jobs function's half) drains the actions, then the DMs", async () => {
    const out = await handlerWith(fakeAws(), undefined)({ akldb: "discord" });
    expect(out).toMatchObject({ ok: true });
    expect(calls).toEqual({ drains: 1, dms: 1 });
  });
});
