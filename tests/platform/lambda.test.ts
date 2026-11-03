// The Lambda host (src/platform/lambda.ts, design A phase C): the origin secret (AX2), the scheduler events and the
// keep-warm fan-out (AX6), migrate, and a GET through the handler on a memory-log replica. No AWS: the Aws seam is a
// fake, the commit log is in memory.
import path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { createLambdaHandler, safeEqual, tickTime, ORIGIN_HEADER, WARM_HOLD_MS, type LambdaOptions } from "../../src/platform/lambda";
import type { Aws } from "../../src/platform/lambda-aws";
import { memoryBlobs } from "../../src/platform/node";
import { bootReplica } from "../../src/replica/boot";
import { MemoryLog } from "../../src/replica/log-memory";
import type { CommitLog, LogEntry } from "../../src/replica/log";
import { applyMigrations, readMigrationFiles } from "../../src/replica/migrations";
import { Replica, ReplicaDivergedError } from "../../src/replica/replica";

const MIGRATIONS = path.resolve(import.meta.dirname, "..", "..", "migrations");
const SECRET = "s3cret-origin-value-0123456789abcdef";
const FAST = { sleep: async () => {}, backoffMs: 0 };

/** A log with every migration applied, built once; handlers boot replicas from it. */
let seeded: MemoryLog;
beforeAll(async () => {
  seeded = new MemoryLog();
  const seed = new Replica(seeded, FAST);
  await applyMigrations(seed, MIGRATIONS);
  seed.close();
}, 60_000);

interface FakeAws extends Aws {
  calls: { params: number; invokes: unknown[] };
  blobs: ReturnType<typeof memoryBlobs>;
}

function fakeAws(over: { secrets?: Record<string, string>; invoke?: (payload: unknown) => Promise<unknown> } = {}): FakeAws {
  const blobs = memoryBlobs();
  const values: Record<string, string> = { "origin-secret": SECRET, "discord-bot-token": "bot-token", ...over.secrets };
  const calls = { params: 0, invokes: [] as unknown[] };
  return {
    calls,
    blobs,
    dumps: blobs,
    async getParameters(names) {
      calls.params++;
      return { values: Object.fromEntries(names.filter((n) => n in values).map((n) => [n, values[n]!])), missing: names.filter((n) => !(n in values)) };
    },
    async invokeLive(payload) {
      calls.invokes.push(payload);
      return over.invoke ? over.invoke(payload) : { ok: true, container: "other" };
    },
  };
}

function handlerOn(log: CommitLog, aws: Aws, extra: Partial<LambdaOptions> = {}) {
  let booted!: Promise<Replica>;
  const handler = createLambdaHandler({
    env: { STAGE: "staging", DISCORD_API_URL: "http://127.0.0.1:1/discord", MODQUEUE_DISCORD_COMPONENTS: "false", AWS_LAMBDA_FUNCTION_VERSION: "7" },
    aws,
    log,
    migrationsDir: MIGRATIONS,
    boot: (l) => (booted = bootReplica(l, FAST)),
    logError: () => {},
    ...extra,
  });
  // `booted()` resolves when the replica is booted AND the init warm-up has finished (it reads the log head once, which these tests count).
  return { handler, booted: async () => (await handler.ready(), booted) };
}

function event(rawPath: string, headers: Record<string, string> = {}, method = "GET") {
  return {
    version: "2.0",
    routeKey: "$default",
    rawPath,
    rawQueryString: "",
    headers: { host: "staging-api.akldb.org", ...headers },
    requestContext: {
      accountId: "335937358231",
      apiId: "abc",
      domainName: "staging-api.akldb.org",
      domainPrefix: "staging-api",
      http: { method, path: rawPath, protocol: "HTTP/1.1", sourceIp: "203.0.113.9", userAgent: "vitest" },
      requestId: "r1",
      routeKey: "$default",
      stage: "$default",
      time: "02/Nov/2026:03:02:10 +0000",
      timeEpoch: Date.parse("2026-11-02T03:02:10Z"),
    },
    isBase64Encoded: false,
  };
}

type Http = { statusCode: number; body: string; headers: Record<string, string> };

describe("origin secret (AX2)", () => {
  it("[LDB-AX2] a request without the origin header is a 403 before SSM, the replica or any store work", async () => {
    const aws = fakeAws();
    const log = seeded; // counts below are the shared log's: only the delta around the request matters
    const { handler, booted } = handlerOn(log, aws);
    await booted();
    const before = { ...log.counts };
    const res = (await handler(event("/v1/meta"))) as Http;
    expect(res.statusCode).toBe(403);
    expect(res.body).toBe("forbidden");
    expect(aws.calls.params).toBe(0);
    expect(log.counts).toEqual(before);
    expect(aws.blobs.objects.size).toBe(0);
  });

  it("[LDB-AX2] a wrong origin value is a 403 with no log call (no head read, no catch-up), whatever its length", async () => {
    const aws = fakeAws();
    const { handler, booted } = handlerOn(seeded, aws);
    await booted();
    const before = { ...seeded.counts };
    for (const wrong of ["x", SECRET + "x", SECRET.slice(0, -1), SECRET.toUpperCase(), ""]) {
      const res = (await handler(event("/v1/meta", { [ORIGIN_HEADER]: wrong }))) as Http;
      expect(res.statusCode, wrong).toBe(403);
    }
    expect(seeded.counts).toEqual(before);
  });

  it("[LDB-AX2] the comparison is constant-time shaped: equal strings match, any other does not, a missing value never does", () => {
    expect(safeEqual(SECRET, SECRET)).toBe(true);
    expect(safeEqual(SECRET + "0", SECRET)).toBe(false);
    expect(safeEqual("", SECRET)).toBe(false);
    expect(safeEqual(undefined, SECRET)).toBe(false);
  });

  it("[LDB-AX2] with the right header one GET goes through the app on the replica", async () => {
    const aws = fakeAws();
    const { handler } = handlerOn(seeded, aws);
    const res = (await handler(event("/v1/meta", { [ORIGIN_HEADER]: SECRET }))) as Http;
    expect(res.statusCode).toBe(200);
    const meta = JSON.parse(res.body) as Record<string, unknown>;
    expect(meta).toHaveProperty("seq");
    expect(aws.calls.params).toBe(1);
  });

  it("[LDB-AX2] the optional secrets are tolerated missing; a missing origin secret refuses to serve (fail closed)", async () => {
    const ok = handlerOn(seeded, fakeAws({ secrets: {} })).handler;
    expect(((await ok(event("/v1/meta", { [ORIGIN_HEADER]: SECRET }))) as Http).statusCode).toBe(200);
    const aws = fakeAws();
    aws.getParameters = async (names) => ({ values: {}, missing: names });
    const closed = handlerOn(seeded, aws).handler;
    await expect(closed(event("/v1/meta", { [ORIGIN_HEADER]: SECRET }))).resolves.toMatchObject({ statusCode: 500 });
  });

  it("the parameters are cached per container and read again after the TTL, keeping the old value if the refresh fails", async () => {
    let t = 0;
    const aws = fakeAws();
    const { handler } = handlerOn(seeded, aws, { now: () => t, paramsTtlMs: 1000 });
    const get = () => handler(event("/v1/meta", { [ORIGIN_HEADER]: SECRET })) as Promise<Http>;
    expect((await get()).statusCode).toBe(200);
    expect((await get()).statusCode).toBe(200);
    expect(aws.calls.params).toBe(1);
    t = 5000;
    aws.getParameters = async () => {
      throw new Error("ssm down");
    };
    expect((await get()).statusCode).toBe(200); // stale value kept
  });
});

describe("scheduler events", () => {
  it("a tick floors to the five-minute boundary and runs the Worker's scheduled() dispatch (the 03:00 tick writes the nightly dump)", async () => {
    expect(new Date(tickTime(Date.parse("2026-11-02T03:04:59Z"))).toISOString()).toBe("2026-11-02T03:00:00.000Z");
    const aws = fakeAws();
    const { handler } = handlerOn(seeded, aws);
    const out = (await handler({ akldb: "tick", time: "2026-11-02T03:02:10Z" })) as { ok: boolean; tick: string };
    expect(out).toMatchObject({ ok: true, tick: "2026-11-02T03:00:00.000Z" });
    expect(aws.blobs.objects.has("latest.json")).toBe(true);
  });

  it("an unrecognized event throws", async () => {
    const { handler } = handlerOn(seeded, fakeAws());
    await expect(handler({ hello: 1 })).rejects.toThrow(/unrecognized event/);
  });
});

describe("keep-warm (AX6)", () => {
  it("[LDB-AX6] the parent invokes k-1 children at once, holds itself ~150 ms, and every answer carries a container id", async () => {
    const holds: number[] = [];
    let inFlight = 0;
    let maxInFlight = 0;
    let started!: () => void;
    const allStarted = new Promise<void>((r) => (started = r));
    const aws = fakeAws({
      // A fake invoker: each child is its own container. Children answer only once all of them have started, so
      // the test sees them in flight together, which is what makes them distinct containers in the real thing.
      invoke: async (payload) => {
        expect(payload).toEqual({ akldb: "warm", child: true });
        const n = ++inFlight;
        maxInFlight = Math.max(maxInFlight, n);
        if (n === 3) started();
        await allStarted;
        return { ok: true, container: `child-${n}`, child: true };
      },
    });
    const { handler } = handlerOn(seeded, aws, { containerId: "parent", sleep: async (ms) => void holds.push(ms) });
    const out = (await handler({ akldb: "warm", k: 4 })) as { container: string; child: boolean; requested: number; containers: string[]; version: string };
    expect(aws.calls.invokes).toHaveLength(3);
    expect(maxInFlight).toBe(3);
    expect(holds).toEqual([WARM_HOLD_MS]);
    expect(WARM_HOLD_MS).toBeGreaterThanOrEqual(100);
    expect(out).toMatchObject({ ok: true, container: "parent", child: false, requested: 4, version: "7" });
    expect(out.containers).toEqual(["child-1", "child-2", "child-3", "parent"]);
    expect(new Set(out.containers).size).toBe(4);
  });

  it("[LDB-AX6] a child only holds and answers with its container id; it never fans out", async () => {
    const holds: number[] = [];
    const aws = fakeAws();
    const { handler } = handlerOn(seeded, aws, { containerId: "kid", sleep: async (ms) => void holds.push(ms) });
    const out = (await handler({ akldb: "warm", child: true })) as Record<string, unknown>;
    expect(out).toMatchObject({ ok: true, container: "kid", child: true });
    expect(out).not.toHaveProperty("children");
    expect(aws.calls.invokes).toHaveLength(0);
    expect(holds).toEqual([WARM_HOLD_MS]);
  });

  it("[LDB-AX6] k is clamped to the account's concurrency (8), a failed child is reported and does not fail the parent, and a warm container has booted its replica", async () => {
    const errors: string[] = [];
    const aws = fakeAws({ invoke: async () => { throw new Error("throttled"); } });
    const { handler, booted } = handlerOn(seeded, aws, { containerId: "p", sleep: async () => {}, logError: (m) => errors.push(m) });
    const out = (await handler({ akldb: "warm", k: 99 })) as { requested: number; containers: string[]; children: unknown[]; seq: number };
    expect(aws.calls.invokes).toHaveLength(7);
    expect(out.requested).toBe(8);
    expect(out.containers).toEqual(["p"]);
    expect(out.children).toHaveLength(7);
    expect(errors.length).toBe(7);
    expect(out.seq).toBe((await booted()).seq);
    expect(out.seq).toBeGreaterThan(0);
  });
});

describe("migrate", () => {
  it("applies every pending migration through the log and returns the names; a second call applies none", async () => {
    const log = new MemoryLog();
    const { handler } = handlerOn(log, fakeAws());
    const names = readMigrationFiles(MIGRATIONS).map((m) => m.name);
    const first = (await handler({ akldb: "migrate" })) as { applied: string[]; seq: number };
    expect(first.applied).toEqual(names);
    expect(first.seq).toBe(names.length);
    const second = (await handler({ akldb: "migrate" })) as { applied: string[] };
    expect(second.applied).toEqual([]);
  }, 60_000);
});

describe("a halted replica fails the invocation", () => {
  it("a divergence is a thrown error (Lambda Errors), not just a 500 body, and the next invocation boots a fresh replica", async () => {
    let corrupt = false;
    const view: CommitLog = {
      head: () => seeded.head(),
      append: (h, e) => seeded.append(h, e),
      get: async (s) => tamper(await seeded.get(s)),
      read: async (a, b) => (await seeded.read(a, b)).map((e) => tamper(e) as LogEntry),
    };
    let target = -1;
    const tamper = <T extends LogEntry | null>(e: T): T => (corrupt && e !== null && e.seq === target ? ({ ...e, hash: "f".repeat(64) } as T) : e);
    const aws = fakeAws();
    const { handler } = handlerOn(view, aws);
    const ok = (await handler(event("/v1/meta", { [ORIGIN_HEADER]: SECRET }))) as Http;
    expect(ok.statusCode).toBe(200);

    // Another writer commits one more unit; this container then replays it under a corrupted hash.
    const writer = new Replica(seeded, FAST);
    await writer.catchUp();
    const t = "2026-11-02T00:00:00.000Z";
    const headBefore = await seeded.head();
    await writer.runUnit([{ sql: "INSERT INTO layouts (id, name, owner, n, layout_rev, created_at, modified_at) VALUES ('L-ax', 'One', 'u-ax', 1, 1, ?, ?)", params: [t, t] }]);
    target = await seeded.head();
    expect(target).toBe(headBefore + 1);
    corrupt = true;
    await expect(handler(event("/v1/meta", { [ORIGIN_HEADER]: SECRET }))).rejects.toBeInstanceOf(ReplicaDivergedError);

    corrupt = false;
    const healed = (await handler(event("/v1/meta", { [ORIGIN_HEADER]: SECRET }))) as Http;
    expect(healed.statusCode).toBe(200);
    writer.close();
  }, 60_000);
});
