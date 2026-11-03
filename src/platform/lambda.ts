// The Lambda host for design A (handoff/akldb-on-aws-build-plan.md phase C): the Hono app over API Gateway HTTP API
// events (payload 2.0, buffered; hono/aws-lambda), on a node:sqlite replica of the DynamoDB commit log. One
// function, one handler, four kinds of event:
//   an API Gateway event      -> the origin-secret check (AX2), then the app
//   {"akldb":"tick"}          -> the Worker's scheduled() dispatch (src/index.ts), every five minutes
//   {"akldb":"warm","k":N}    -> keep-warm fan-out: N-1 concurrent child invocations of the live alias, each held
//                                about 150 ms, so N containers stay warm (AX6); answers carry a container id
//   {"akldb":"migrate"}       -> apply pending migrations through the log (deploy-aws.sh, before the alias moves)
//   {"akldb":"seed",...}      -> SHADOW ONLY (STAGE=shadow, else refused): load production's latest public dump (phase D)
//   {"akldb":"shadow-status"} -> SHADOW ONLY: the follower's row (cursor, last check) and the fake Discord's call count
//   AKLDB_AWAIT_IMAGE=1 (prod): while the log is EMPTY, migrate, tick and nightly answer {"awaiting":"image"} and do nothing:
//                                the cutover's image (src/replica/image.ts, LDB-CV10) must be the log's first entry, and it
//                                carries D1's own d1_migrations, so no migration may reach an empty prod log before it
//   {"akldb":"nightly"}       -> the daily snapshot, log retention and the nightly proof (src/replica/jobs.ts). The tick
//                                starts it when it is due: an async self-invocation of the function named by JOBS_FUNCTION
//                                (a separate function with a 600 s timeout), or inline when JOBS_FUNCTION is unset
// No AWS SDK: aws4fetch signs the DynamoDB, S3, SSM and Lambda calls. The environment is set by infra/akldb.yaml:
// STAGE, LOG_TABLE, DATA_BUCKET, SSM_PREFIX, DISCORD_API_URL, MODQUEUE_DISCORD_COMPONENTS.
import { logByLevel } from "../replica/alarm";
import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import zlib from "node:zlib";
import path from "node:path";
import { Hono } from "hono";
import { handle } from "hono/aws-lambda";
import type { Bindings } from "../env";
import worker, { app as workerApp, discordFollowUp } from "../index";
import { bootReplica } from "../replica/boot";
import { raise } from "../replica/alarm";
import { nightlyDue, runNightlyJobs, runRollingJob, type SnapshotJobDeps } from "../replica/jobs";
import type { CommitLog, ExpirableLog } from "../replica/log";
import { applyMigrations, readMigrationFiles } from "../replica/migrations";
import type { ObjectStore } from "../replica/objects";
import type { SnapshotPolicy, SnapshotState } from "../replica/snapshot";
import { sleep as realSleep } from "../replica/timers";
import type { Replica } from "../replica/replica";
import { buildDump } from "../dump/write";
import { followFeed } from "../replica/shadow/follower";
import { applyShadowMigrations, defaultShadowMigrationsDir } from "../replica/shadow/schema";
import { SeedRefused, seedShadow, type SeedRequest } from "../replica/shadow/seed";
import { createUpstream, UPSTREAM_BASE, type UpstreamFetch } from "../replica/shadow/upstream";
import { readFollowerState } from "../replica/shadow/follower";
import { createShimD1 } from "../store/shim/d1";
import { createFakeDiscord, FAKE_DISCORD_BASE, type FakeDiscord } from "./fake-discord";
import { installEgressGuard } from "./shadow-egress";
import type { Aws } from "./lambda-aws";
import { createNodePlatform, lruResponseCache, r2Binding } from "./node";
import type { PlatformConfig } from "./port";

/** Every answer from this stack carries `X-Akldb-Backend: aws`: the cutover's proof that api.akldb.org, once its DNS record has moved, is answered by AWS (LDB-CV13). */
export const BACKEND_HEADER = "x-akldb-backend";
export const BACKEND_VALUE = "aws";

/**
 * Lambda's response payload is 6 MB (6,291,556 bytes) INCLUDING the base64 expansion of a binary body, and over it API Gateway answers
 * its own opaque 413/500. Anything bigger than this is refused by us first, with a clear 500 and one alarm line (LDB-CV19).
 */
export const MAX_RESPONSE_BYTES = 5_900_000;
/** Bodies smaller than this are not worth compressing. */
export const GZIP_MIN_BYTES = 1024;
/** zlib level 4: about 4x faster than the default 6 for a few percent more bytes (JSON compresses to ~15% either way). */
export const GZIP_LEVEL = 4;

const COMPRESSIBLE = /^(application\/([a-z.+-]*\+)?json|text\/(?!event-stream)[a-z0-9.+-]+|application\/(javascript|xml)|image\/svg\+xml)\b/i;

/** True when the client's Accept-Encoding allows gzip (and does not set gzip;q=0). */
export function acceptsGzip(header: string | undefined): boolean {
  if (header === undefined) return false;
  for (const part of header.split(",")) {
    const [name, ...params] = part.trim().split(";");
    if (name!.trim().toLowerCase() !== "gzip" && name!.trim() !== "*") continue;
    const q = params.map((p) => p.trim()).find((p) => p.startsWith("q="));
    return q === undefined || Number(q.slice(2)) > 0;
  }
  return false;
}

/** The header Cloudflare's Transform Rule sets to the SSM secret. Requests without it never reach the app. */
export const ORIGIN_HEADER = "x-akldb-origin";

/** The origin secret's SSM name (under /akldb/<stage>/), required. */
export const ORIGIN_SECRET_PARAM = "origin-secret";

/** SSM name (under /akldb/<stage>/) -> PlatformConfig key. All SecureStrings, all optional: a missing one leaves the feature off. */
export const CONFIG_PARAMS: Record<string, keyof PlatformConfig> = {
  "discord-bot-token": "MODQUEUE_DISCORD_BOT_TOKEN",
  "discord-application-id": "MODQUEUE_DISCORD_APPLICATION_ID",
  "discord-public-key": "MODQUEUE_DISCORD_PUBLIC_KEY",
  "discord-webhook": "MODQUEUE_DISCORD_WEBHOOK",
  "discord-guild-id": "MODQUEUE_DISCORD_GUILD_ID",
  "discord-channel-id": "MODQUEUE_DISCORD_CHANNEL_ID",
  "discord-cards": "MODQUEUE_DISCORD_CARDS",
  "discord-actions": "MODQUEUE_DISCORD_ACTIONS",
  "discord-dms": "MODQUEUE_DISCORD_DMS",
};

/** How long a container trusts the parameters it read before it reads them again (a rotated secret takes effect within this). */
const PARAMS_TTL_MS = 5 * 60 * 1000;
/** How long a keep-warm invocation is held, so concurrent pings cannot share a container. */
export const WARM_HOLD_MS = 150;
/** The account's concurrency limit is 10; a keep-warm fan-out never asks for more than this. */
const MAX_WARM = 8;

export interface LambdaOptions {
  /** `STAGE`, `DISCORD_API_URL`, `MODQUEUE_DISCORD_COMPONENTS`, `AWS_LAMBDA_FUNCTION_VERSION` ... */
  env: Record<string, string | undefined>;
  aws: Aws;
  /** The commit log (DynamoDB in Lambda, memory in tests). */
  log: CommitLog;
  /** Directory of the migration .sql files (the zip carries `migrations/` next to the bundle). */
  migrationsDir: string;
  /**
   * Where snapshots live (the pointer items and the S3 objects). With it the default boot starts from the pointer's snapshot
   * (src/replica/boot.ts) and the tick runs the snapshot jobs (src/replica/jobs.ts); without it boot replays the log from 0.
   */
  snapshots?: { state: SnapshotState; objects: ObjectStore; policy?: SnapshotPolicy; zstdLevel?: number };
  /** Default: bootReplica over `snapshots`. */
  boot?: (log: CommitLog) => Promise<Replica>;
  /** Default: a new UUID per handler (that is, per container). */
  containerId?: string;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  /** Default: Date.now. Test hook for the parameter cache. */
  paramsTtlMs?: number;
  /** Test hook: console.error. */
  logError?: (message: string) => void;
  /** Test hook: where the boot/snapshot report lines go. Default `logByLevel`: alarms at ERROR, the rest at INFO. */
  logLine?: (message: string) => void;
  /** STAGE=shadow only (phase D). */
  shadow?: ShadowOptions;
}

export interface ShadowOptions {
  /** Default: a new in-process fake Discord. */
  fakeDiscord?: FakeDiscord;
  /** How the follower and the seed read production's public API. Default: the global fetch at call time, which the egress guard has replaced. */
  fetch?: UpstreamFetch;
  upstreamBase?: string;
  /** Default: `migrations-shadow/` beside the bundle. */
  migrationsDir?: string;
  /** Default true. Tests that already stub fetch turn it off. */
  installGuard?: boolean;
  /** Milliseconds of following per tick. Default 20 s. */
  followBudgetMs?: number;
}

type SchedulerEvent =
  | { akldb: "tick"; time?: string }
  | { akldb: "warm"; k?: number; child?: boolean }
  | { akldb: "migrate" }
  | { akldb: "nightly" }
  | { akldb: "discord" }
  | ({ akldb: "seed" } & SeedRequest)
  | { akldb: "shadow-status" };

interface HttpEvent {
  version?: string;
  rawPath?: string;
  requestContext?: unknown;
  headers?: Record<string, string | undefined>;
}

const isHttpEvent = (e: unknown): e is HttpEvent => typeof e === "object" && e !== null && "requestContext" in e && !("akldb" in e);
const isSchedulerEvent = (e: unknown): e is SchedulerEvent => typeof e === "object" && e !== null && typeof (e as { akldb?: unknown }).akldb === "string";

/** Constant-time comparison; false for a missing value. Hashing first makes the lengths equal. */
export function safeEqual(got: string | undefined, want: string): boolean {
  if (got === undefined) return false;
  const a = createHash("sha256").update(got).digest();
  const b = createHash("sha256").update(want).digest();
  return timingSafeEqual(a, b);
}

/** Floor to the five-minute boundary: the Scheduler's rate(5 minutes) is not clock-aligned, and the nightly job keys on hour 3, minute 0. */
export function tickTime(ms: number): number {
  const step = 5 * 60 * 1000;
  return Math.floor(ms / step) * step;
}

export type LambdaHandler = ((event: unknown, context?: unknown) => Promise<unknown>) & {
  /** Resolves once the replica is booted and warmed (never rejects: a failed boot is retried by the first request). */
  ready(): Promise<void>;
  /** STAGE=shadow only: the fake Discord, and a function that puts the global fetch back (tests). */
  shadow?: { fakeDiscord: FakeDiscord; uninstallGuard(): void };
};

/** Methods shadow answers; any other would write. */
const SHADOW_READ_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);
/** Headers that make a request an authenticated one (a sign-in would write `authors`); shadow takes none. */
const SHADOW_CREDENTIAL_HEADERS = ["authorization", "x-akl-client"];

export function createLambdaHandler(opts: LambdaOptions): LambdaHandler {
  const { aws, log, env } = opts;
  const logLine = opts.logLine ?? logByLevel;
  const boot = opts.boot ?? ((l: CommitLog) => bootReplica(l, { ...(opts.snapshots !== undefined ? { snapshots: opts.snapshots } : {}), logLine }));
  const sleep = opts.sleep ?? realSleep;
  const now = opts.now ?? Date.now;
  const containerId = opts.containerId ?? randomUUID();
  const logError = opts.logError ?? ((m: string) => console.error(m));
  const ttl = opts.paramsTtlMs ?? PARAMS_TTL_MS;

  // ---- STAGE=shadow (phase D, LDB-PV1): nothing leaves the stack, nothing writes except the feed follower ----
  const isShadow = env.STAGE === "shadow";
  const shadowOpts = opts.shadow ?? {};
  const fakeDiscord = isShadow ? (shadowOpts.fakeDiscord ?? createFakeDiscord()) : undefined;
  let uninstallGuard = (): void => {};
  if (isShadow) {
    if (shadowOpts.installGuard !== false) uninstallGuard = installEgressGuard({ fakeDiscord: fakeDiscord!, logLine });
    if (env.DISCORD_API_URL !== undefined && env.DISCORD_API_URL !== FAKE_DISCORD_BASE) raise(logLine, "shadow-egress", `DISCORD_API_URL is not the fake Discord; using ${FAKE_DISCORD_BASE}`);
  }

  // ---- the replica: boot starts when the handler is created (module load in the real entry), after the consts below ----
  let booting!: Promise<Replica>;
  let current: Replica | undefined;
  let warmed: "ok" | "failed" | "pending" | "skipped" = "pending";
  const start = (): Promise<Replica> => {
    // Boot, then one read-only warm-up request through the app: the route table, the first query's statements and the JIT are
    // paid here, in init, instead of by the first user. The warm-up never writes and never blocks serving on its own failure.
    const p = boot(log).then(async (r) => {
      await warmUp(r);
      return r;
    });
    p.catch(() => {}); // a failed boot is reported where it is awaited, not as an unhandled rejection
    return p;
  };

  /** The booted replica. A failed boot is retried once; a halted replica (SH8) is replaced by a fresh one. */
  async function getReplica(): Promise<Replica> {
    let r: Replica;
    try {
      r = await booting;
    } catch (e) {
      logError(`replica boot failed, retrying: ${e instanceof Error ? e.message : String(e)}`);
      booting = start();
      r = await booting;
    }
    if (r.dead !== null) {
      logError(`replica halted (${r.dead.message}); booting a fresh one`);
      r.close();
      booting = start();
      r = await booting;
    }
    current = r;
    return r;
  }

  // ---- SSM: the origin secret and the optional Discord settings, cached per container ----
  interface Params {
    at: number;
    secret: string;
    config: Partial<Record<keyof PlatformConfig, string>>;
  }
  let params: Params | undefined;
  let loading: Promise<Params> | undefined;

  async function load(): Promise<Params> {
    const names = [ORIGIN_SECRET_PARAM, ...Object.keys(CONFIG_PARAMS)];
    const values: Record<string, string> = {};
    for (let i = 0; i < names.length; i += 10) Object.assign(values, (await aws.getParameters(names.slice(i, i + 10))).values);
    const secret = values[ORIGIN_SECRET_PARAM];
    if (secret === undefined || secret === "") throw new Error(`SSM parameter ${ORIGIN_SECRET_PARAM} is not set`);
    const config: Params["config"] = {};
    for (const [name, key] of Object.entries(CONFIG_PARAMS)) {
      const v = values[name];
      if (v !== undefined && v !== "") config[key] = v;
    }
    return { at: now(), secret, config };
  }

  async function getParams(): Promise<Params> {
    if (params !== undefined && now() - params.at < ttl) return params;
    loading ??= load()
      .then((p) => (params = p))
      .catch((e: unknown) => {
        // A refresh that fails keeps the last good values; the first load has nothing to fall back on.
        if (params !== undefined) {
          logError(`SSM refresh failed, keeping the cached parameters: ${e instanceof Error ? e.message : String(e)}`);
          return params;
        }
        throw e;
      })
      .finally(() => {
        loading = undefined;
      });
    return loading;
  }

  // ---- the platform and the per-invocation env ----
  // [LDB-CV28] A Discord ACK must leave within 3 s, and this handler answers only after its background work: the work after
  // the ACK runs in the jobs function ({"akldb":"discord"}). Without one (tests, local) it stays in-process.
  const jobsFn = env.JOBS_FUNCTION;
  const platform = createNodePlatform({
    d1: (e) => e.DB,
    blobs: aws.dumps,
    cache: lruResponseCache(),
    ...(jobsFn !== undefined && jobsFn !== "" ? { handOff: (job: "discord") => aws.invokeAsync(jobsFn, { akldb: job }) } : {}),
  });
  const tasks: Promise<unknown>[] = [];
  const execCtx = {
    waitUntil(p: Promise<unknown>): void {
      tasks.push(p.catch((e: unknown) => logError(`waitUntil task failed: ${e instanceof Error ? e.message : String(e)}`)));
    },
    passThroughOnException(): void {},
  } as unknown as ExecutionContext;

  /** Everything handed to waitUntil/background has finished: Lambda freezes the container as soon as the handler returns. */
  async function settle(): Promise<void> {
    while (tasks.length > 0) await Promise.all(tasks.splice(0));
    await platform.drain();
  }

  async function buildEnv(replica: Replica): Promise<Bindings> {
    return bindings(replica, (await getParams()).config);
  }

  function bindings(replica: Replica, config: Params["config"]): Bindings {
    return {
      // shadow takes none of the Discord settings, whatever SSM holds: it has no bot, no webhook, no signing key
      ...(isShadow ? {} : config),
      DISCORD_API_URL: isShadow ? FAKE_DISCORD_BASE : (env.DISCORD_API_URL ?? "https://discord.com/api"),
      ...(env.MODQUEUE_DISCORD_COMPONENTS !== undefined ? { MODQUEUE_DISCORD_COMPONENTS: env.MODQUEUE_DISCORD_COMPONENTS } : {}),
      // One request-scoped snapshot per invocation (SH7): one strong HEAD read, then catch-up, before the first statement.
      DB: createShimD1(replica, { requestScoped: true }),
      DUMPS: r2Binding(aws.dumps),
      PLATFORM: platform,
    } as unknown as Bindings;
  }

  /**
   * The warm-up (RP8): `GET /v1/meta` straight through the app (no origin-secret check: it is not a network request, and it
   * needs no SSM read), read-only, so it appends nothing to the log. Failure is logged, never fatal.
   */
  async function warmUp(replica: Replica): Promise<void> {
    // A FIRST deploy boots on an empty log: the migrate invocation's own container runs this before migrations exist, and
    // GET /v1/meta would 500 ("no such table"). Skip until every migration the bundle ships is applied; migrate() and the
    // keep-warm handler run the warm-up again once it is (team-lead, 2026-11-03).
    try {
      const pending = await migrationsPending(replica);
      if (pending > 0) {
        warmed = "skipped";
        logLine(`akldb-boot: warm-up skipped: ${pending} migration(s) not applied yet (first deploy)`);
        return;
      }
      const res = await workerApp.fetch(new Request("http://akldb.internal/v1/meta"), bindings(replica, {}), execCtx);
      await res.arrayBuffer();
      if (!res.ok) throw new Error(`GET /v1/meta answered ${res.status}`);
      await settle();
      warmed = "ok";
    } catch (e) {
      warmed = "failed";
      logError(`warm-up failed (serving anyway): ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  let shippedMigrations: string[] | undefined;
  /** How many of the bundle's migrations the replica has not applied (0 = the schema is complete). */
  async function migrationsPending(replica: Replica): Promise<number> {
    shippedMigrations ??= readMigrationFiles(opts.migrationsDir).map((m) => m.name);
    // A local read at the replica's current seq (fresh: no head read; boot has just caught up). No d1_migrations table
    // yet means nothing is applied.
    let applied: Set<string>;
    try {
      const [out] = await replica.runUnit([{ sql: "SELECT name FROM d1_migrations", params: [] }], { fresh: true });
      applied = new Set(out!.rows.map((r) => String(r.name)));
    } catch (e) {
      if (!/no such table/.test(e instanceof Error ? e.message : String(e))) throw e;
      applied = new Set();
    }
    return shippedMigrations.filter((n) => !applied.has(n)).length;
  }

  /** A halted replica must fail the invocation, not just the request: the Errors alarm is the page. */
  function assertAlive(): void {
    if (current?.dead != null) throw current.dead;
  }

  // ---- HTTP ----
  const front = new Hono();
  front.use("*", async (c, next) => {
    await next();
    try {
      c.res.headers.set(BACKEND_HEADER, BACKEND_VALUE);
    } catch {
      c.res = new Response(c.res.body, c.res); // a Response with immutable headers (a fetch result): copy, then set
      c.res.headers.set(BACKEND_HEADER, BACKEND_VALUE);
    }
  });
  // gzip the answer when the client allows it (Cloudflare always asks its origin for gzip): a 4.9k-layout full=1 page is 17 MB of JSON and
  // would hit Lambda's 6 MB response limit raw. Hono turns a Content-Encoding response into a base64 body by itself. Dumps are already gzip
  // or served as stored, and streams are not buffered here.
  // Headers match what clients get from the Worker today (replay #2, 2026-11-03): Cloudflare compresses the Worker's answers itself and
  // then WEAKENS their ETag (W/"..."), and it adds no Vary. So a gzipped answer carries W/ + the same value (If-None-Match compares with
  // stripWeak, and If-Match takes scoped tokens, never an ETag), and no Vary: Cloudflare negotiates the encoding with each client itself.
  // A small answer goes out identity, and Cloudflare compresses and weakens it exactly as for the Worker.
  front.use("*", async (c, next) => {
    await next();
    const res = c.res;
    if (c.req.method === "HEAD" || res.status === 204 || res.status === 304 || res.body === null) return;
    if (c.req.path.startsWith("/v1/dump")) return;
    if (res.headers.has("content-encoding") || !COMPRESSIBLE.test(res.headers.get("content-type") ?? "")) return;
    if (!acceptsGzip(c.req.header("accept-encoding"))) return;
    const raw = new Uint8Array(await res.arrayBuffer());
    const headers = new Headers(res.headers);
    if (raw.byteLength < GZIP_MIN_BYTES) {
      c.res = new Response(raw, { status: res.status, statusText: res.statusText, headers });
      return;
    }
    headers.delete("content-length");
    headers.set("content-encoding", "gzip");
    c.res = new Response(zlib.gzipSync(raw, { level: GZIP_LEVEL }), { status: res.status, statusText: res.statusText, headers });
    // After the assignment: Hono's c.res setter copies the previous response's headers onto the new one, which would put the strong
    // ETag back.
    const etag = c.res.headers.get("etag");
    if (etag !== null && !etag.startsWith("W/")) c.res.headers.set("etag", `W/${etag}`);
  });
  front.use("*", async (c, next) => {
    const got = c.req.header(ORIGIN_HEADER);
    // No header: refuse without even reading SSM. A wrong one: refuse before the replica is touched.
    if (got === undefined || !safeEqual(got, (await getParams()).secret)) {
      return c.text("forbidden", 403, { "cache-control": "no-store" });
    }
    if (isShadow) {
      // LDB-PV1: shadow is read-only to the world. A write would diverge it from production; a credential would make the
      // sign-in lane write an author row (and ask Discord, faked or not). Refused before the replica is touched.
      if (!SHADOW_READ_METHODS.has(c.req.method)) return c.json({ error: "shadow_read_only", message: "the shadow stage serves reads only" }, 405, { "cache-control": "no-store", allow: "GET, HEAD, OPTIONS" });
      if (SHADOW_CREDENTIAL_HEADERS.some((h) => c.req.header(h) !== undefined)) return c.json({ error: "shadow_no_credentials", message: "the shadow stage takes no credentials" }, 403, { "cache-control": "no-store" });
    }
    await next();
  });
  front.all("*", async (c) => {
    const replica = await getReplica();
    return workerApp.fetch(c.req.raw, await buildEnv(replica), execCtx);
  });
  const serve = handle(front);

  async function http(event: HttpEvent, context: unknown): Promise<unknown> {
    const result = (await serve(event as never, context as never)) as { statusCode?: number; headers?: Record<string, string>; body?: string; isBase64Encoded?: boolean };
    await settle();
    assertAlive();
    // LDB-CV19: never let API Gateway answer for us. The payload limit counts the base64 text of a binary body.
    const bytes = Buffer.byteLength(result.body ?? "", "utf8");
    if (bytes > MAX_RESPONSE_BYTES) {
      const route = `${(event as { requestContext?: { http?: { method?: string } } }).requestContext?.http?.method ?? "GET"} ${event.rawPath ?? "?"}`;
      raise(logLine, "response-too-large", `route=${route} bytes=${bytes} limit=${MAX_RESPONSE_BYTES} encoded=${result.isBase64Encoded === true ? "base64" : "text"}`);
      return {
        statusCode: 500,
        headers: { "content-type": "application/json", "cache-control": "no-store", "x-akldb-backend": BACKEND_VALUE },
        body: JSON.stringify({ error: "response_too_large", message: "this answer does not fit one Lambda response; ask for a smaller page" }),
        isBase64Encoded: false,
      };
    }
    return result;
  }

  // ---- LDB-CV12: prod's log is empty until the cutover's image, and nothing may run against it before ----
  const awaitImage = env.AKLDB_AWAIT_IMAGE === "1";
  /** True (and one INFO line) while this stack awaits its image and the log is still empty. Catches up first: the image may have just landed. */
  async function awaitingImage(replica: Replica, what: string): Promise<boolean> {
    if (!awaitImage) return false;
    await replica.catchUp();
    if (replica.seq !== 0) return false;
    logLine(`akldb-migrate: ${what}: awaiting image (the log is empty and AKLDB_AWAIT_IMAGE=1); nothing was done`);
    return true;
  }

  // ---- scheduler events ----
  async function tick(event: { time?: string }): Promise<unknown> {
    const replica = await getReplica();
    if (await awaitingImage(replica, "tick")) return { ok: true, awaiting: "image", seq: 0 };
    const parsed = event.time === undefined ? NaN : Date.parse(event.time);
    const at = tickTime(Number.isNaN(parsed) ? now() : parsed);
    const controller = { scheduledTime: at, cron: "*/5 * * * *", noRetry() {} } as unknown as ScheduledController;
    let followed: unknown;
    if (isShadow) {
      // The Worker's own scheduled jobs append events (admin.nightly_ticked ...) and notify Discord: production's job.
      // Shadow's events table must stay production's, so its tick follows the public feed instead.
      followed = await shadowFollow(replica);
    } else {
      await worker.scheduled(controller, await buildEnv(replica), execCtx);
    }
    await settle();
    assertAlive();
    // The rolling snapshot runs here, after the Worker's own jobs, off every request path. The nightly work (daily snapshot,
    // retention, proof) does not: the tick only starts it, in its own invocation, because it can outlast the tick's timeout.
    let snapshot: Record<string, unknown> | undefined;
    if (opts.snapshots !== undefined) {
      const deps = jobDeps();
      let rolling: Awaited<ReturnType<typeof runRollingJob>> | undefined;
      let rollingError: unknown;
      try {
        rolling = await runRollingJob(replica, deps);
      } catch (e) {
        rollingError = e; // already alarmed; the nightly job is independent of it, so still start that, then fail the tick
      }
      let nightly: "not due" | "started" | "inline" = "not due";
      if (await nightlyDue(deps)) {
        const fn = env.JOBS_FUNCTION;
        if (fn !== undefined && fn !== "") {
          try {
            await aws.invokeAsync(fn, { akldb: "nightly" });
          } catch (e) {
            raise(logLine, "nightly", `could not start the nightly job on ${fn}: ${e instanceof Error ? e.message : String(e)}`);
            throw e;
          }
          nightly = "started";
        } else {
          await runNightly(replica); // no jobs function (tests, local): inline
          nightly = "inline";
        }
      }
      if (rollingError !== undefined) throw rollingError;
      snapshot = { rolling, nightly };
    }
    assertAlive();
    return { ok: true, tick: new Date(at).toISOString(), seq: replica.seq, ...(snapshot !== undefined ? { snapshot } : {}), ...(followed !== undefined ? { shadow: followed } : {}) };
  }

  // ---- shadow: schema, follower, seed, status ----
  const upstream = (): ReturnType<typeof createUpstream> =>
    createUpstream(shadowOpts.fetch ?? ((input, init) => globalThis.fetch(input, init)), shadowOpts.upstreamBase ?? UPSTREAM_BASE);
  const shadowDir = (): string => shadowOpts.migrationsDir ?? defaultShadowMigrationsDir(env);

  async function shadowFollow(replica: Replica): Promise<unknown> {
    await applyShadowMigrations(replica, shadowDir(), () => new Date(now()));
    const db = createShimD1(replica);
    const report = await followFeed({
      db,
      up: upstream(),
      buildDump: () => buildDump(bindings(replica, {}), () => new Date(now()).toISOString()),
      blobs: aws.dumps,
      logLine,
      now,
      ...(shadowOpts.followBudgetMs !== undefined ? { budgetMs: shadowOpts.followBudgetMs } : {}),
    });
    return { ...report, discordCalls: fakeDiscord!.total() };
  }

  async function seed(event: SeedRequest): Promise<unknown> {
    if (!isShadow) throw new SeedRefused(`the seed job runs only on the shadow stage (STAGE=${env.STAGE ?? "unset"})`);
    const replica = await getReplica();
    await applyShadowMigrations(replica, shadowDir(), () => new Date(now()));
    const report = await seedShadow({ db: createShimD1(replica), up: upstream(), blobs: aws.dumps, now, logLine }, { ...(event.dumpUrl !== undefined ? { dumpUrl: event.dumpUrl } : {}), ...(event.reset === true ? { reset: true } : {}) });
    assertAlive();
    return { ...report, replicaSeq: replica.seq };
  }

  async function shadowStatus(): Promise<unknown> {
    if (!isShadow) throw new SeedRefused(`shadow-status runs only on the shadow stage (STAGE=${env.STAGE ?? "unset"})`);
    const replica = await getReplica();
    const state = await readFollowerState(createShimD1(replica));
    return { ok: true, seq: replica.seq, follower: state, discordCalls: fakeDiscord!.total() };
  }

  function jobDeps(): SnapshotJobDeps {
    return { ...opts.snapshots!, log: log as SnapshotJobDeps["log"], logLine, now };
  }

  async function runNightly(replica: Replica): Promise<unknown> {
    if (opts.snapshots === undefined) return { ok: true, nightly: "disabled" };
    return runNightlyJobs(replica, jobDeps());
  }

  async function nightly(): Promise<unknown> {
    const replica = await getReplica();
    if (await awaitingImage(replica, "nightly")) return { ok: true, awaiting: "image", seq: 0 };
    const report = await runNightly(replica);
    assertAlive();
    return { ok: true, nightly: report, seq: replica.seq };
  }

  /** The work a Discord ACK left behind (handed off by the API function): the persisted actions, then the moderation DMs. */
  async function discord(): Promise<unknown> {
    const replica = await getReplica();
    if (await awaitingImage(replica, "discord")) return { ok: true, awaiting: "image", seq: 0 };
    const e = await buildEnv(replica);
    await discordFollowUp(platform(e, execCtx).store, e);
    await settle();
    assertAlive();
    return { ok: true, seq: replica.seq };
  }

  async function warm(event: { k?: number; child?: boolean }): Promise<unknown> {
    const k = Math.min(Math.max(Math.trunc(event.k ?? 1), 1), MAX_WARM);
    const kids = event.child === true ? [] : Array.from({ length: k - 1 }, () => aws.invokeLive({ akldb: "warm", child: true }));
    // Boot the replica too: a warm container that still had to boot would be warm in name only.
    const [replica, settled] = await Promise.all([getReplica(), Promise.allSettled(kids), sleep(WARM_HOLD_MS)]);
    // A container whose init warm-up was skipped (it booted before the first migrate) or failed retries it on its next
    // keep-warm ping, after catching up so it sees migrations another container applied.
    if (warmed !== "ok") {
      await replica.catchUp();
      await warmUp(replica);
    }
    const children = settled.map((s) => (s.status === "fulfilled" ? s.value : { error: s.reason instanceof Error ? s.reason.message : String(s.reason) }));
    for (const s of settled) if (s.status === "rejected") logError(`keep-warm child failed: ${s.reason instanceof Error ? s.reason.message : String(s.reason)}`);
    const ids = new Set<string>([containerId]);
    for (const c of children) {
      const id = (c as { container?: unknown } | null)?.container;
      if (typeof id === "string") ids.add(id);
    }
    return {
      ok: true,
      container: containerId,
      child: event.child === true,
      version: env.AWS_LAMBDA_FUNCTION_VERSION ?? null,
      seq: replica.seq,
      warmup: warmed,
      ...(event.child === true ? {} : { requested: k, containers: [...ids].sort(), children }),
    };
  }

  async function migrate(): Promise<unknown> {
    const replica = await getReplica();
    if (await awaitingImage(replica, "migrate")) return { ok: true, awaiting: "image", message: "awaiting image", applied: [], seq: 0 };
    const applied = await applyMigrations(replica, opts.migrationsDir, () => new Date(now()));
    if (isShadow) applied.push(...(await applyShadowMigrations(replica, shadowDir(), () => new Date(now()))));
    assertAlive();
    // The init warm-up was skipped (or failed) while the schema was incomplete: run it now, so the report is the
    // post-migrate state.
    if (warmed !== "ok") await warmUp(replica);
    return { ok: true, applied, seq: replica.seq, warmup: warmed };
  }

  booting = start();

  // The first invocation of a container logs one `akldb-cold:` line (not an alarm): how long the process had been up when it
  // arrived (init + module load, the REPORT line's Init Duration plus the runtime start) and how long that first invocation took
  // (it waits for the boot). The gate report's cold share and cold p95 (scripts/lab/shadow/gate.mjs) read these, because the
  // functions log at SystemLogLevel WARN and so write no REPORT lines.
  let coldLogged = false;
  const handler = async (event: unknown, context?: unknown): Promise<unknown> => {
    if (coldLogged) return dispatch(event, context);
    coldLogged = true;
    const arrived = now();
    const initMs = Math.round(process.uptime() * 1000);
    const kind = isHttpEvent(event) ? "http" : isSchedulerEvent(event) ? event.akldb : "other";
    try {
      return await dispatch(event, context);
    } finally {
      logLine(`akldb-cold: ${JSON.stringify({ first: kind, initMs, requestMs: now() - arrived })}`);
    }
  };
  const dispatch = async (event: unknown, context?: unknown): Promise<unknown> => {
    if (isHttpEvent(event)) return http(event, context);
    if (isSchedulerEvent(event)) {
      switch (event.akldb) {
        case "tick":
          return tick(event);
        case "warm":
          return warm(event);
        case "migrate":
          return migrate();
        case "nightly":
          return nightly();
        case "discord":
          return discord();
        case "seed":
          return seed(event);
        case "shadow-status":
          return shadowStatus();
      }
    }
    throw new Error(`unrecognized event: ${JSON.stringify(event)?.slice(0, 200)}`);
  };
  return Object.assign(handler, {
    ready: () => booting.then(() => undefined, () => undefined),
    ...(isShadow ? { shadow: { fakeDiscord: fakeDiscord!, uninstallGuard } } : {}),
  });
}

/** The migrations directory inside the deployed zip (`migrations/` beside the bundle), unless MIGRATIONS_DIR says otherwise. */
export function defaultMigrationsDir(env: Record<string, string | undefined>): string {
  return env.MIGRATIONS_DIR ?? path.join(env.LAMBDA_TASK_ROOT ?? process.cwd(), "migrations");
}
