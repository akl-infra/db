// [LDB-INF20..INF29] The Lambda entry (src/platform/lambda.ts): every handler boots against a fake runtime event,
// SSM is read once per container, the origin-verify header is enforced, post-response work is awaited, EMF metrics.
import { beforeEach, describe, expect, it, vi } from "vitest";

const writeSnapshot = vi.fn(async () => ({ seq: 7, written: false }));
vi.mock("../../src/store/ddb/catalog", () => ({ createCatalog: () => ({ writeSnapshot }) }));
vi.mock("../../src/store/ddb", () => ({ createDdbStore: () => ({ fake: "store" }) }));
vi.mock("../../src/dump/write", () => ({ readDumpState: async () => ({ at: new Date(Date.now() - 3600_000).toISOString(), seq: 1, key: "k" }) }));
vi.mock("../../src/index", () => ({ default: { fetch: async () => new Response("unused"), scheduled: async () => {} } }));

import { createHandlers, type LambdaDeps, type WritableLike } from "../../src/platform/lambda";
import { bucketFor, emfLine, s3Blobs, type UrlEvent } from "../../src/platform/lambda-support";

const SECRET = "s".repeat(40);
const ENV = {
  AKLDB_STAGE: "staging",
  AKLDB_TABLE_MAIN: "akldb-staging-main",
  AKLDB_TABLE_EPHEMERAL: "akldb-staging-ephemeral",
  AKLDB_BUCKET_DATA: "d",
  AKLDB_BUCKET_DUMPS: "u",
  AKLDB_BUCKET_SNAPSHOT: "s",
  AKLDB_SSM_PREFIX: "/akldb/staging",
  MIRROR_MODE: "off",
};

function setup(over: Partial<LambdaDeps["env"]> = {}, params: Record<string, string> = { "origin-verify": SECRET }) {
  const ssmCalls: string[] = [];
  const lines: string[] = [];
  const errors: unknown[][] = [];
  const invoked: unknown[] = [];
  const worker = {
    fetch: vi.fn(async (_req: Request, env: Record<string, unknown>, ctx: { waitUntil(p: Promise<unknown>): void }) => {
      expect(env.PLATFORM).toBeTypeOf("function");
      expect(env.DB).toEqual({ fake: "store" });
      ctx.waitUntil(new Promise((r) => setTimeout(r, 5)).then(() => lines.push("waitUntil done")));
      const h = new Headers({ "content-type": "application/json", etag: '"x"' });
      h.append("set-cookie", "a=1");
      h.append("set-cookie", "b=2");
      return new Response('{"ok":true}', { status: 201, headers: h });
    }),
    scheduled: vi.fn(async () => {}),
  };
  const deps: LambdaDeps = {
    env: { ...ENV, ...over },
    doc: {} as never,
    s3: { send: vi.fn() } as never,
    ssm: {
      send: vi.fn(async (cmd: { input: { Name: string } }) => {
        ssmCalls.push(cmd.input.Name);
        const key = cmd.input.Name.replace("/akldb/staging/", "");
        if (key in params) return { Parameter: { Value: params[key] } };
        throw Object.assign(new Error("nf"), { name: "ParameterNotFound" });
      }),
    } as never,
    lambda: { send: vi.fn(async (c: unknown) => void invoked.push(c)) } as never,
    worker: worker as never,
    fetch: vi.fn() as never,
    streamify: (h) => h,
    httpResponseStream: {
      from(s, meta) {
        (s as unknown as { meta: unknown }).meta = meta;
        return s;
      },
    },
    log: { error: (...a) => errors.push(a), log: (l) => lines.push(l) },
  };
  return { deps, handlers: createHandlers(deps), ssmCalls, lines, errors, invoked, worker };
}

function stream() {
  const chunks: string[] = [];
  let ended = false;
  const s: WritableLike & { chunks: string[]; meta?: { statusCode: number; headers: Record<string, string>; cookies?: string[] }; ended(): boolean } = {
    chunks,
    write: (c) => void chunks.push(typeof c === "string" ? c : Buffer.from(c).toString()),
    end: () => void (ended = true),
    ended: () => ended,
  };
  return s;
}

const event = (over: Partial<UrlEvent> = {}, verify: string | null = SECRET): UrlEvent => ({
  rawPath: "/v1/meta",
  rawQueryString: "a=1",
  headers: { host: "x.lambda-url.us-east-2.on.aws", ...(verify === null ? {} : { "x-origin-verify": verify }) },
  requestContext: { http: { method: "GET" } },
  ...over,
});

beforeEach(() => writeSnapshot.mockClear());

describe("lambda entry", () => {
  it("[LDB-INF20] api streams the app's response with status, headers and cookies", async () => {
    const { handlers, worker } = setup();
    const s = stream();
    await handlers.api(event(), s);
    expect((s as unknown as { meta: unknown }).meta).toMatchObject({ statusCode: 201, cookies: ["a=1", "b=2"], headers: { etag: '"x"' } });
    expect(s.chunks.join("")).toBe('{"ok":true}');
    expect(s.ended()).toBe(true);
    const req = worker.fetch.mock.calls[0]![0];
    expect(req.url).toBe("https://x.lambda-url.us-east-2.on.aws/v1/meta?a=1");
  });

  it("[LDB-INF21] a request without the right X-Origin-Verify gets 403 and never reaches the app", async () => {
    const { handlers, worker } = setup();
    for (const bad of [null, "wrong", SECRET + "x"]) {
      const s = stream();
      await handlers.feed(event({}, bad), s);
      expect((s as unknown as { meta: { statusCode: number } }).meta.statusCode).toBe(403);
    }
    expect(worker.fetch).not.toHaveBeenCalled();
  });

  it("[LDB-INF22] SSM is read once per container, across invocations and handlers", async () => {
    const { handlers, ssmCalls } = setup({}, { "origin-verify": SECRET, "discord/bot-token": "t" });
    await handlers.api(event(), stream());
    await handlers.api(event(), stream());
    await handlers.feed(event(), stream());
    await handlers.jobs({ scheduledTime: "2026-10-25T00:00:00Z" });
    expect(ssmCalls.length).toBe(new Set(ssmCalls).size);
    expect(ssmCalls).toContain("/akldb/staging/origin-verify");
    expect(ssmCalls).toContain("/akldb/staging/discord/bot-token");
  });

  it("[LDB-INF23] Discord parameters map onto the platform config; missing ones stay unset", async () => {
    const { handlers, worker } = setup({}, { "origin-verify": SECRET, "discord/bot-token": "tok", "discord/modqueue-webhook": "https://w" });
    await handlers.api(event(), stream());
    const env = worker.fetch.mock.calls[0]![1] as Record<string, unknown>;
    expect(env.MODQUEUE_DISCORD_BOT_TOKEN).toBe("tok");
    expect(env.MODQUEUE_DISCORD_WEBHOOK).toBe("https://w");
    expect(env.MODQUEUE_DISCORD_PUBLIC_KEY).toBeUndefined();
    expect(env.DISCORD_API_URL).toBe("https://discord.com/api");
  });

  it("[LDB-INF24] post-response work (waitUntil) finishes before the invocation returns", async () => {
    const { handlers, lines } = setup();
    await handlers.api(event(), stream());
    expect(lines).toContain("waitUntil done");
  });

  it("[LDB-INF25] jobs runs the Worker's scheduled dispatch with the scheduler's time and emits snapshot and dump metrics", async () => {
    const { handlers, worker, lines } = setup();
    await handlers.jobs({ scheduledTime: "2026-10-25T03:00:00.000Z" });
    const ctl = (worker.scheduled.mock.calls as unknown as unknown[][])[0]![0] as { cron: string; scheduledTime: number };
    expect(ctl).toMatchObject({ cron: "*/5 * * * *", scheduledTime: Date.parse("2026-10-25T03:00:00.000Z") });
    expect(writeSnapshot).toHaveBeenCalledTimes(1);
    const emf = lines.filter((l) => l.startsWith("{")).map((l) => JSON.parse(l));
    expect(emf.find((m) => "ReplicaSnapshotAgeSeconds" in m)).toMatchObject({ Stage: "staging", ReplicaSnapshotAgeSeconds: 0 });
    expect(emf.find((m) => "DumpAgeSeconds" in m).DumpAgeSeconds).toBeGreaterThan(3500);
  });

  it("[LDB-INF26] a failing job still emits metrics (with a stale-snapshot sentinel) and then errors the invocation", async () => {
    const { handlers, lines } = setup();
    writeSnapshot.mockRejectedValueOnce(new Error("boom"));
    await expect(handlers.jobs({})).rejects.toThrow("boom");
    expect(lines.map((l) => (l.startsWith("{") ? JSON.parse(l) : {})).find((m) => "ReplicaSnapshotAgeSeconds" in m).ReplicaSnapshotAgeSeconds).toBe(86400);
  });

  it("[LDB-INF27] EVENTTX_EXHAUSTED log lines become the EventTxRetriesExhausted metric", async () => {
    const { handlers, deps, lines } = setup();
    deps.log.error("EVENTTX_EXHAUSTED x: gave up after 8 attempts");
    await handlers.api(event(), stream());
    const m = lines.filter((l) => l.startsWith("{")).map((l) => JSON.parse(l)).find((x) => "EventTxRetriesExhausted" in x);
    expect(m).toMatchObject({ Stage: "staging", EventTxRetriesExhausted: 1 });
    expect(m._aws.CloudWatchMetrics[0]).toMatchObject({ Namespace: "Akldb", Dimensions: [["Stage"]] });
  });

  it("[LDB-INF28] mirrorIngest is off outside apply mode, and 'not implemented' (not a crash) until lane Z lands", async () => {
    const off = setup({ MIRROR_MODE: "record" });
    expect((await off.handlers.mirrorIngest(event())).statusCode).toBe(503);
    const on = setup({ MIRROR_MODE: "apply", MIRROR_APPLY_FUNCTION: "akldb-prod-mirror-apply" }, { "tee-hmac": "h" });
    const r = await on.handlers.mirrorIngest(event({ body: "{}", requestContext: { http: { method: "POST" } } }));
    expect(r.statusCode).toBe(500);
    expect(r.body).toMatch(/not implemented/);
  });

  it("[LDB-INF29] mirrorIngest runs with only the data bucket configured (its real env)", async () => {
    const { handlers } = setup({ MIRROR_MODE: "apply", AKLDB_BUCKET_DUMPS: undefined, AKLDB_BUCKET_SNAPSHOT: undefined, AKLDB_TABLE_MAIN: undefined }, { "tee-hmac": "h" });
    expect((await handlers.mirrorIngest(event({ body: "{}" }))).body).toMatch(/not implemented/);
  });

  it("[LDB-INF29] mirrorApply mirrorApply skips outside apply mode and refuses clearly until lane Z lands", async () => {
    expect(await setup({ MIRROR_MODE: "record" }).handlers.mirrorApply()).toMatchObject({ skipped: expect.any(String) });
    await expect(setup({ MIRROR_MODE: "apply" }).handlers.mirrorApply()).rejects.toThrow(/not implemented/);
  });
});

describe("lambda support", () => {
  it("routes keys to buckets and maps a missing S3 key to null", async () => {
    const b = { data: "d", dumps: "u", snapshot: "s" };
    expect(bucketFor("payloads/abc", b)).toBe("d");
    expect(bucketFor("replica/snapshot.json.gz", b)).toBe("s");
    for (const k of ["latest.json", "dump-2026-10-25.json.gz", "monthly/dump-2026-10.json.gz"]) expect(bucketFor(k, b)).toBe("u");
    const blobs = s3Blobs({ send: async () => Promise.reject(Object.assign(new Error("x"), { name: "NoSuchKey" })) } as never, b);
    expect(await blobs.get("latest.json")).toBeNull();
  });

  it("emits well-formed EMF", () => {
    const m = JSON.parse(emfLine("prod", "DumpAgeSeconds", 5, "Seconds", 1));
    expect(m).toEqual({ _aws: { Timestamp: 1, CloudWatchMetrics: [{ Namespace: "Akldb", Dimensions: [["Stage"]], Metrics: [{ Name: "DumpAgeSeconds", Unit: "Seconds" }] }] }, Stage: "prod", DumpAgeSeconds: 5 });
  });
});
