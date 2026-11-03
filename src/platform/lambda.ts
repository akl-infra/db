// The Lambda host for design A (handoff/akldb-on-aws-build-plan.md phase C): the Hono app over API Gateway HTTP API
// events (payload 2.0, buffered; hono/aws-lambda), on a node:sqlite replica of the DynamoDB commit log. One
// function, one handler, four kinds of event:
//   an API Gateway event      -> the origin-secret check (AX2), then the app
//   {"akldb":"tick"}          -> the Worker's scheduled() dispatch (src/index.ts), every five minutes
//   {"akldb":"warm","k":N}    -> keep-warm fan-out: N-1 concurrent child invocations of the live alias, each held
//                                about 150 ms, so N containers stay warm (AX6); answers carry a container id
//   {"akldb":"migrate"}       -> apply pending migrations through the log (deploy-aws.sh, before the alias moves)
// No AWS SDK: aws4fetch signs the DynamoDB, S3, SSM and Lambda calls. The environment is set by infra/akldb.yaml:
// STAGE, LOG_TABLE, DATA_BUCKET, SSM_PREFIX, DISCORD_API_URL, MODQUEUE_DISCORD_COMPONENTS.
import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import path from "node:path";
import { Hono } from "hono";
import { handle } from "hono/aws-lambda";
import type { Bindings } from "../env";
import worker, { app as workerApp } from "../index";
import { bootReplica } from "../replica/boot";
import { runSnapshotJobs } from "../replica/jobs";
import type { CommitLog, ExpirableLog } from "../replica/log";
import { applyMigrations } from "../replica/migrations";
import type { ObjectStore } from "../replica/objects";
import type { SnapshotPolicy, SnapshotState } from "../replica/snapshot";
import { sleep as realSleep } from "../replica/timers";
import type { Replica } from "../replica/replica";
import { createShimD1 } from "../store/shim/d1";
import type { Aws } from "./lambda-aws";
import { createNodePlatform, lruResponseCache, r2Binding } from "./node";
import type { PlatformConfig } from "./port";

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
  snapshots?: { state: SnapshotState; objects: ObjectStore; policy?: SnapshotPolicy };
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
  /** Test hook: where the boot/snapshot report lines go. Default console.error. */
  logLine?: (message: string) => void;
}

type SchedulerEvent = { akldb: "tick"; time?: string } | { akldb: "warm"; k?: number; child?: boolean } | { akldb: "migrate" };

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
};

export function createLambdaHandler(opts: LambdaOptions): LambdaHandler {
  const { aws, log, env } = opts;
  const logLine = opts.logLine ?? ((m: string) => console.error(m));
  const boot = opts.boot ?? ((l: CommitLog) => bootReplica(l, { ...(opts.snapshots !== undefined ? { snapshots: opts.snapshots } : {}), logLine }));
  const sleep = opts.sleep ?? realSleep;
  const now = opts.now ?? Date.now;
  const containerId = opts.containerId ?? randomUUID();
  const logError = opts.logError ?? ((m: string) => console.error(m));
  const ttl = opts.paramsTtlMs ?? PARAMS_TTL_MS;

  // ---- the replica: boot starts when the handler is created (module load in the real entry), after the consts below ----
  let booting!: Promise<Replica>;
  let current: Replica | undefined;
  let warmed: "ok" | "failed" | "pending" = "pending";
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
  const platform = createNodePlatform({
    d1: (e) => e.DB,
    blobs: aws.dumps,
    cache: lruResponseCache(),
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
      ...config,
      DISCORD_API_URL: env.DISCORD_API_URL ?? "https://discord.com/api",
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
    try {
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

  /** A halted replica must fail the invocation, not just the request: the Errors alarm is the page. */
  function assertAlive(): void {
    if (current?.dead != null) throw current.dead;
  }

  // ---- HTTP ----
  const front = new Hono();
  front.use("*", async (c, next) => {
    const got = c.req.header(ORIGIN_HEADER);
    // No header: refuse without even reading SSM. A wrong one: refuse before the replica is touched.
    if (got === undefined || !safeEqual(got, (await getParams()).secret)) {
      return c.text("forbidden", 403, { "cache-control": "no-store" });
    }
    await next();
  });
  front.all("*", async (c) => {
    const replica = await getReplica();
    return workerApp.fetch(c.req.raw, await buildEnv(replica), execCtx);
  });
  const serve = handle(front);

  async function http(event: HttpEvent, context: unknown): Promise<unknown> {
    const result = await serve(event as never, context as never);
    await settle();
    assertAlive();
    return result;
  }

  // ---- scheduler events ----
  async function tick(event: { time?: string }): Promise<unknown> {
    const replica = await getReplica();
    const parsed = event.time === undefined ? NaN : Date.parse(event.time);
    const at = tickTime(Number.isNaN(parsed) ? now() : parsed);
    const controller = { scheduledTime: at, cron: "*/5 * * * *", noRetry() {} } as unknown as ScheduledController;
    await worker.scheduled(controller, await buildEnv(replica), execCtx);
    await settle();
    assertAlive();
    // The snapshot jobs (rolling snapshot, daily snapshot, retention, nightly proof) run here and nowhere else, after the
    // Worker's own jobs, off every request path. A failure is thrown: the Errors alarm is the page.
    const snapshot = opts.snapshots === undefined ? undefined : await runSnapshotJobs(replica, { ...opts.snapshots, log: log as CommitLog & Partial<ExpirableLog>, logLine, now });
    assertAlive();
    return { ok: true, tick: new Date(at).toISOString(), seq: replica.seq, ...(snapshot !== undefined ? { snapshot } : {}) };
  }

  async function warm(event: { k?: number; child?: boolean }): Promise<unknown> {
    const k = Math.min(Math.max(Math.trunc(event.k ?? 1), 1), MAX_WARM);
    const kids = event.child === true ? [] : Array.from({ length: k - 1 }, () => aws.invokeLive({ akldb: "warm", child: true }));
    // Boot the replica too: a warm container that still had to boot would be warm in name only.
    const [replica, settled] = await Promise.all([getReplica(), Promise.allSettled(kids), sleep(WARM_HOLD_MS)]);
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
    const applied = await applyMigrations(replica, opts.migrationsDir, () => new Date(now()));
    assertAlive();
    return { ok: true, applied, seq: replica.seq };
  }

  booting = start();

  const handler = async (event: unknown, context?: unknown): Promise<unknown> => {
    if (isHttpEvent(event)) return http(event, context);
    if (isSchedulerEvent(event)) {
      switch (event.akldb) {
        case "tick":
          return tick(event);
        case "warm":
          return warm(event);
        case "migrate":
          return migrate();
      }
    }
    throw new Error(`unrecognized event: ${JSON.stringify(event)?.slice(0, 200)}`);
  };
  return Object.assign(handler, { ready: () => booting.then(() => undefined, () => undefined) });
}

/** The migrations directory inside the deployed zip (`migrations/` beside the bundle), unless MIGRATIONS_DIR says otherwise. */
export function defaultMigrationsDir(env: Record<string, string | undefined>): string {
  return env.MIGRATIONS_DIR ?? path.join(env.LAMBDA_TASK_ROOT ?? process.cwd(), "migrations");
}
