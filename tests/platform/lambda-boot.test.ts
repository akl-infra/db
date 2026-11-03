// The Lambda host with snapshots (design A phase B): RP2 at the handler (nothing is served before the snapshot is verified
// and the tail is replayed to HEAD), RP8 (the init warm-up is one read-only GET /v1/meta through the app and never appends),
// and the tick running the snapshot jobs. Memory log, memory object store, fake AWS seam.
import { describe, expect, it } from "vitest";
import { createLambdaHandler, ORIGIN_HEADER, type LambdaOptions } from "../../src/platform/lambda";
import type { Aws } from "../../src/platform/lambda-aws";
import { memoryBlobs } from "../../src/platform/node";
import { bootReplica } from "../../src/replica/boot";
import type { CommitLog } from "../../src/replica/log";
import { writeSnapshot } from "../../src/replica/snapshot";
import { FAST, MIGRATIONS_DIR, churn, digestOf, replayFrom0, world, type World } from "../replica/support";

const SECRET = "s3cret-origin-value-0123456789abcdef";

function fakeAws(): Aws & { params: number; async: { fn: string; payload: unknown }[]; failAsync: boolean } {
  const blobs = memoryBlobs();
  const self = {
    params: 0,
    async: [] as { fn: string; payload: unknown }[],
    failAsync: false,
    async invokeAsync(fn: string, payload: unknown) {
      if (self.failAsync) throw new Error("Lambda Invoke (Event): 500");
      self.async.push({ fn, payload });
    },
    dumps: blobs,
    async getParameters(names: string[]) {
      self.params++;
      return { values: Object.fromEntries(names.filter((n) => n === "origin-secret").map((n) => [n, SECRET])), missing: [] };
    },
    async invokeLive() {
      return { ok: true, container: "other" };
    },
  };
  return self;
}

const get = (rawPath: string) => ({
  version: "2.0",
  routeKey: "$default",
  rawPath,
  rawQueryString: "",
  headers: { host: "staging-api.akldb.org", [ORIGIN_HEADER]: SECRET },
  requestContext: {
    accountId: "1", apiId: "a", domainName: "staging-api.akldb.org", domainPrefix: "staging-api",
    http: { method: "GET", path: rawPath, protocol: "HTTP/1.1", sourceIp: "203.0.113.9", userAgent: "vitest" },
    requestId: "r", routeKey: "$default", stage: "$default", time: "02/Nov/2026:03:02:10 +0000", timeEpoch: 1,
  },
  isBase64Encoded: false,
});

function handlerFor(w: World, log: CommitLog, aws: Aws, extra: Partial<LambdaOptions> = {}, lines: string[] = []) {
  return createLambdaHandler({
    env: { STAGE: "staging", DISCORD_API_URL: "http://127.0.0.1:1/discord", MODQUEUE_DISCORD_COMPONENTS: "false", AWS_LAMBDA_FUNCTION_VERSION: "7" },
    aws,
    log,
    migrationsDir: MIGRATIONS_DIR,
    snapshots: { state: w.state, objects: w.objects },
    logError: (m) => void lines.push(`ERR ${m}`),
    logLine: (m) => void lines.push(m),
    now: () => w.clock.ms,
    sleep: async () => {},
    ...extra,
  });
}

const settled = async (p: Promise<unknown>): Promise<boolean> => {
  let done = false;
  void p.then(() => (done = true), () => (done = true));
  for (let i = 0; i < 20; i++) await new Promise<void>((r) => setImmediate(r));
  return done;
};

async function snapshotted(): Promise<World> {
  const w = await world();
  await churn(w.replica, 15);
  await writeSnapshot(w.replica, w.deps);
  await churn(w.replica, 9, 2); // a tail after the snapshot
  return w;
}

describe("the handler boots from the snapshot (RP2)", () => {
  it("[LDB-RP2] nothing is served before the snapshot is verified and the tail is replayed: a request waits for the tail read, then sees the head", async () => {
    const w = await snapshotted();
    let release!: () => void;
    const latch = new Promise<void>((r) => (release = r));
    let tailReads = 0;
    const gated: CommitLog = {
      head: () => w.log.head(),
      read: async (a, b) => {
        tailReads++;
        await latch;
        return w.log.read(a, b);
      },
      append: (h, e) => w.log.append(h, e),
      get: (s) => w.log.get(s),
    };
    let booted: Promise<unknown> | undefined;
    const lines: string[] = [];
    const handler = handlerFor(w, gated, fakeAws(), { boot: (l) => (booted = bootReplica(l, { ...FAST, snapshots: { state: w.state, objects: w.objects }, logLine: (m) => void lines.push(m) })) }, lines);
    const res = handler(get("/v1/meta"));
    expect(await settled(res)).toBe(false); // the tail read is still pending: no answer, and no boot report either
    expect(await settled(booted!)).toBe(false);
    expect(tailReads).toBeGreaterThan(0);
    expect(lines.filter((l) => l.startsWith("akldb-boot"))).toEqual([]);
    release();
    const out = (await res) as { statusCode: number };
    expect(out.statusCode).toBe(200);
    const r = (await booted) as Awaited<ReturnType<typeof bootReplica>>;
    expect(r.seq).toBe(w.log.length);
    expect(lines.find((l) => l.startsWith("akldb-boot"))).toMatch(/path=pointer .*seq=\d+/);
    expect(digestOf(r)).toBe(digestOf(await replayFrom0(w.log)));
  });

  it("[LDB-RP2] the default boot uses the pointer's snapshot, and a damaged one falls back loudly while the handler still serves", async () => {
    const w = await snapshotted();
    const lines: string[] = [];
    const ok = handlerFor(w, w.log, fakeAws(), {}, lines);
    await ok.ready();
    expect(lines.find((l) => l.startsWith("akldb-boot: path="))).toMatch(/^akldb-boot: path=pointer /);
    expect(((await ok(get("/v1/meta"))) as { statusCode: number }).statusCode).toBe(200);

    const pointer = (await w.state.pointer())!;
    w.objects.peek(pointer.key)!.bytes[100]! ^= 0xff;
    const lines2: string[] = [];
    const h = handlerFor(w, w.log, fakeAws(), {}, lines2);
    expect(((await h(get("/v1/meta"))) as { statusCode: number }).statusCode).toBe(200);
    expect(lines2.filter((l) => l.startsWith("akldb-alarm: boot: fallback: pointer unusable"))).toHaveLength(1);
    expect(lines2.find((l) => l.startsWith("akldb-boot: path="))).toMatch(/^akldb-boot: path=replay /);
  });
});

describe("the init warm-up (RP8)", () => {
  it("[LDB-RP8] boot is followed by exactly one read-only GET /v1/meta through the app: it appends nothing, reads no SSM and skips the origin check", async () => {
    const w = await snapshotted();
    const aws = fakeAws();
    const before = { length: w.log.length, appends: w.log.counts.appends, heads: w.log.counts.heads };
    const lines: string[] = [];
    const handler = handlerFor(w, w.log, aws, {}, lines);
    await handler.ready();
    expect(w.log.length).toBe(before.length);
    expect(w.log.counts.appends).toBe(before.appends);
    // boot reads the head twice (the tail prefetch, then the final strong read); the warm-up's request snapshot adds one more
    expect(w.log.counts.heads - before.heads).toBe(3);
    expect(aws.params).toBe(0);
    expect(lines.filter((l) => l.startsWith("ERR"))).toEqual([]);
    const warm = (await handler({ akldb: "warm", child: true })) as { warmup: string; seq: number };
    expect(warm.warmup).toBe("ok");
    expect(warm.seq).toBe(w.log.length);
    expect(w.log.length).toBe(before.length);
  });

  it("[LDB-RP8] a failing warm-up is logged and does not stop the handler from serving", async () => {
    const w = await snapshotted();
    let heads = 0;
    const flaky: CommitLog = {
      head: async () => {
        if (++heads === 3) throw new Error("injected: the warm-up's head read fails");
        return w.log.head();
      },
      read: (a, b) => w.log.read(a, b),
      append: (h, e) => w.log.append(h, e),
      get: (s) => w.log.get(s),
    };
    const lines: string[] = [];
    const handler = handlerFor(w, flaky, fakeAws(), {}, lines);
    await handler.ready();
    expect(lines.some((l) => /^ERR warm-up failed \(serving anyway\)/.test(l))).toBe(true);
    expect(((await handler(get("/v1/meta"))) as { statusCode: number }).statusCode).toBe(200);
    expect(((await handler({ akldb: "warm", child: true })) as { warmup: string }).warmup).toBe("failed");
  });
});

describe("the tick runs the snapshot jobs", () => {
  it("[LDB-RP1] a tick writes the rolling snapshot once the head moved, then not again until 50 units or an hour; the next container boots from it", async () => {
    const w = await world();
    await churn(w.replica, 12);
    const lines: string[] = [];
    const handler = handlerFor(w, w.log, fakeAws(), {}, lines);
    const t1 = (await handler({ akldb: "tick", time: "2026-11-02T00:05:00Z" })) as { snapshot: { rolling: { status: string }; nightly: string } };
    expect(t1.snapshot.rolling.status).toBe("written");
    expect(t1.snapshot.nightly).toBe("not due"); // 00:05 UTC: before the daily hour
    const pointer = (await w.state.pointer())!;
    expect(pointer.seq).toBe(w.log.length);
    const t2 = (await handler({ akldb: "tick", time: "2026-11-02T00:10:00Z" })) as { snapshot: { rolling: string } };
    expect(t2.snapshot.rolling).toBe("not due");
    // a new container boots from it and replays nothing
    await churn(w.replica, 3, 3);
    const lines2: string[] = [];
    const fresh = handlerFor(w, w.log, fakeAws(), {}, lines2);
    await fresh.ready();
    expect(lines2.find((l) => l.startsWith("akldb-boot: path="))).toMatch(/path=pointer .*replayed=\d+/);
  });

  it("[LDB-RP4] with no JOBS_FUNCTION the first tick after 03:00 UTC runs the nightly work inline: daily snapshot, retention, proof", async () => {
    const w = await world();
    let lines: string[] = [];
    await churn(w.replica, 6);
    w.clock.ms = Date.parse("2026-11-02T03:10:00Z");
    const handler = handlerFor(w, w.log, fakeAws(), {}, (lines = []));
    const t = (await handler({ akldb: "tick", time: "2026-11-02T03:10:00Z" })) as { snapshot: { nightly: string } };
    expect(t.snapshot.nightly).toBe("inline");
    expect((await w.state.dailies()).map((d) => d.day)).toEqual(["2026-11-02"]);
    expect(lines.length).toBeGreaterThan(0);
    expect(lines.filter((l) => l.startsWith("akldb-proof: ok seq="))).toHaveLength(1);
    const again = (await handler({ akldb: "tick", time: "2026-11-02T03:15:00Z" })) as { snapshot: { nightly: string } };
    expect(again.snapshot.nightly).toBe("not due"); // today's daily exists
  });

  it("[LDB-RP10] with JOBS_FUNCTION the tick only starts the nightly job (an async invocation of that function) and does none of its work", async () => {
    const w = await world();
    let lines: string[] = [];
    await churn(w.replica, 6);
    w.clock.ms = Date.parse("2026-11-02T03:10:00Z");
    const aws = fakeAws();
    const env = { STAGE: "staging", DISCORD_API_URL: "http://127.0.0.1:1/discord", MODQUEUE_DISCORD_COMPONENTS: "false", JOBS_FUNCTION: "akldb-staging-jobs" };
    const handler = handlerFor(w, w.log, aws, { env }, (lines = []));
    const t = (await handler({ akldb: "tick", time: "2026-11-02T03:10:00Z" })) as { snapshot: { nightly: string } };
    expect(t.snapshot.nightly).toBe("started");
    expect(aws.async).toEqual([{ fn: "akldb-staging-jobs", payload: { akldb: "nightly" } }]);
    expect(await w.state.dailies()).toEqual([]); // the tick did not write the daily snapshot, retention or the proof
    expect(lines.some((l) => l.startsWith("akldb-proof"))).toBe(false);
    // the next tick (the job has not finished) starts it again; the claim, not the tick, keeps it single
    await handler({ akldb: "tick", time: "2026-11-02T03:15:00Z" });
    expect(aws.async).toHaveLength(2);
    const first = (await handler({ akldb: "nightly" })) as { nightly: { status: string; daily: { status: string }; proof: { seq: number } } };
    expect(first.nightly.status).toBe("ran");
    expect(first.nightly.daily.status).toBe("written");
    expect(first.nightly.proof.seq).toBe(w.log.length);
    const second = (await handler({ akldb: "nightly" })) as { nightly: { status: string } };
    expect(second.nightly.status).toBe("busy");
    await handler({ akldb: "tick", time: "2026-11-02T03:20:00Z" });
    expect(aws.async).toHaveLength(2); // today's daily exists: nothing more is started
  });

  it("[LDB-RP10] [LDB-RP9] a nightly job that cannot be started fails the tick with one alarm line, after the rolling snapshot ran", async () => {
    const w = await world();
    let lines: string[] = [];
    await churn(w.replica, 6);
    w.clock.ms = Date.parse("2026-11-02T03:10:00Z");
    const aws = fakeAws();
    aws.failAsync = true;
    const env = { STAGE: "staging", DISCORD_API_URL: "http://127.0.0.1:1/discord", MODQUEUE_DISCORD_COMPONENTS: "false", JOBS_FUNCTION: "akldb-staging-jobs" };
    const handler = handlerFor(w, w.log, aws, { env }, (lines = []));
    await expect(handler({ akldb: "tick", time: "2026-11-02T03:10:00Z" })).rejects.toThrow(/Lambda Invoke \(Event\): 500/);
    expect(lines.filter((l) => l.startsWith("akldb-alarm: "))).toEqual([expect.stringMatching(/^akldb-alarm: nightly: could not start the nightly job on akldb-staging-jobs: /)]);
    expect((await w.state.pointer())?.seq).toBe(w.log.length);
  });

  it("[LDB-RP1] a failed snapshot upload fails the tick (the Errors alarm) with one alarm line, leaves the pointer alone, and the next tick retries", async () => {
    const w = await world();
    let lines: string[] = [];
    await churn(w.replica, 6);
    const handler = handlerFor(w, w.log, fakeAws(), {}, (lines = []));
    w.objects.failPut.add("snap/");
    await expect(handler({ akldb: "tick", time: "2026-11-02T00:05:00Z" })).rejects.toThrow(/injected PUT failure/);
    expect(lines.filter((l) => l.startsWith("akldb-alarm: "))).toHaveLength(1);
    expect(await w.state.pointer()).toBeNull();
    w.objects.failPut.clear();
    const t = (await handler({ akldb: "tick", time: "2026-11-02T00:10:00Z" })) as { snapshot: { rolling: { status: string } } };
    expect(t.snapshot.rolling.status).toBe("written");
  });
});
