/// <reference types="vite/client" />
// The shim variant of the test harness: akldb's own store/d1 code and SQL on
// node:sqlite through the D1 shim, a replica and an in-memory commit log
// (src/store/shim, src/replica). `tests/harness` resolves here in the `shim`
// vitest project (an alias in vitest.config.ts); the exports match
// tests/harness/index.ts, so no test file changes. The replica comes from
// setup-shim.ts (one per test file, migrated through the log).
import fs from "node:fs";
import path from "node:path";
import { inject } from "vitest";
import { parse as parseToml } from "smol-toml";
import app from "../../src/index";
import { createNodePlatform, loopbackOnlyFetch, memoryBlobs, r2Binding, lruResponseCache } from "../../src/platform/node";
import type { Bindings } from "../../src/env";
import { createShimD1 } from "../../src/store/shim/d1";
import { createD1Store } from "../../src/store/d1";
import type { Store } from "../../src/store/port";
import { d1TestStore } from "./d1";
import { STATE_KEY, type ShimFileState } from "./setup-shim";
import type { TestStore } from "./port";

export type { Row, TableName, TestStore, Where } from "./port";

const state = (globalThis as Record<string, unknown>)[STATE_KEY] as ShimFileState | undefined;
if (state === undefined) throw new Error("tests/harness/shim.ts imported outside the `shim` vitest project (tests/harness/setup-shim.ts did not run)");

const ROOT = path.resolve(import.meta.dirname, "..", "..");
const wrangler = parseToml(fs.readFileSync(path.join(ROOT, "wrangler.toml"), "utf8")) as { vars?: Record<string, string> };

/** Not request-scoped: every statement catches up first, the strongest reading a test can ask of the shim. */
const db = createShimD1(state.replica);
const blobs = memoryBlobs();
const cache = lruResponseCache();
// A request gets its own request-scoped shim (SH7) -- unless a test swapped `env.DB` for a spy or a flaky wrapper, as
// Workers would honour: then the request runs on the swapped binding.
const platform = createNodePlatform({
  replica: state.replica,
  blobs,
  cache,
  fetch: loopbackOnlyFetch,
  d1: (e) => (e.DB === db ? createShimD1(state.replica, { requestScoped: true }) : e.DB),
});

// `caches.default` for the tests that read the edge cache directly (tests/api/cache-retain.test.ts).
(globalThis as unknown as { caches: { default: unknown } }).caches = { default: cache };

/** The Worker's bindings: wrangler.toml [vars], the workers project's test overrides, `DB` = the shim D1, `DUMPS` = memory blobs, and `PLATFORM`. Tests set TEST_CLOCK etc. on it. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const env: Bindings & Record<string, any> = {
  ...wrangler.vars,
  STREAM_MAX_MS: "500",
  STREAM_POLL_MS: "20",
  IMPORT_ENABLED: "on",
  TEST_REHOST_DUMP_URL: process.env.REHOST_DUMP_URL ?? "",
  // The migration files as the workers project's TEST_MIGRATIONS has them (the migration tests re-run their statements).
  TEST_MIGRATIONS: inject("TEST_MIGRATIONS" as never),
  // workerd refuses `new Function`; pool-workers hands tests this binding instead. Node has no such rule.
  __VITEST_POOL_WORKERS_UNSAFE_EVAL: { newFunction: (body: string) => new Function(body) },
  DB: db,
  // R2's list() too (tests/api/cutover.test.ts counts the dump objects); the memory store knows its keys.
  DUMPS: Object.assign(r2Binding(blobs), {
    async list(opts: { prefix?: string } = {}) {
      const keys = [...blobs.objects.keys()].filter((k) => opts.prefix === undefined || k.startsWith(opts.prefix)).sort();
      return { objects: keys.map((key) => ({ key, size: blobs.objects.get(key)!.bytes.byteLength })), truncated: false, delimitedPrefixes: [] };
    },
  }),
  PLATFORM: platform,
} as unknown as Bindings & Record<string, any>;
(globalThis as Record<string, unknown>).__aklShimEnv = env;

/** Extras for tests/shim/**: the replica, its log and the platform. */
export const shimHarness = { replica: state.replica, log: state.log, platform, blobs, cache, db };

interface Ctx {
  waitUntil(p: Promise<unknown>): void;
  passThroughOnException(): void;
}
const ctxTasks = new WeakMap<object, Promise<unknown>[]>();

export function createExecutionContext(): ExecutionContext {
  const tasks: Promise<unknown>[] = [];
  const ctx: Ctx = {
    waitUntil(p) {
      tasks.push(p);
    },
    passThroughOnException() {},
  };
  ctxTasks.set(ctx, tasks);
  return ctx as unknown as ExecutionContext;
}

/** Await every task handed to this context, and to the platform's own `background`. */
export async function waitOnExecutionContext(ctx: ExecutionContext): Promise<void> {
  const tasks = ctxTasks.get(ctx as object) ?? [];
  while (tasks.length > 0) await Promise.allSettled(tasks.splice(0));
  await platform.drain();
}

export function createScheduledController(options?: { scheduledTime?: Date | number; cron?: string }): ScheduledController {
  const t = options?.scheduledTime;
  return { scheduledTime: t === undefined ? Date.now() : t instanceof Date ? t.getTime() : t, cron: options?.cron ?? "", noRetry() {} } as ScheduledController;
}

export const SELF = {
  async fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
    const ctx = createExecutionContext();
    const req = input instanceof Request && init === undefined ? input : new Request(input, init);
    return app.fetch(req, env, ctx);
  },
};

/** Seed and inspect rows (D1-shaped), over the same shim: tests/harness/d1.ts works unchanged because the shim IS a D1Database. */
export const testStore: TestStore = d1TestStore(db);

/** The storage port under test, for tests that call core functions directly. */
export const store: Store = createD1Store(db);
