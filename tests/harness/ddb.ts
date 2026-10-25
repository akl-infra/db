/// <reference types="vite/client" />
// The DynamoDB variant of the test harness (design/aws-port.md §4.3; lane L).
// `tests/harness` resolves here in the `ddb` vitest project (a project-level
// alias in vitest.config.ts); the exports match tests/harness/index.ts, so no
// test file changes. Tables come from setup-ddb.ts (one pair per test file).
//
// Layering of the document client the store sees, outermost first:
//   withCallCounter( withFaults( raw ) )
// so `ddbHarness.calls` counts what the store sent, including injected
// faults, and `ddbHarness.faults` is what TestStore.faults (lane N) drives.
// LAB_FAULT_RATE=0.2 (and LAB_FAULT_SEED) turn on random conflicts/throttles.
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { parse as parseToml } from "smol-toml";
import app from "../../src/index";
import { createNodeLabPlatform, memoryBlobs } from "../../src/platform/node-lab";
import type { Bindings } from "../../src/env";
import { createDdbStore } from "../../src/store/ddb";
import { createDocClient } from "../../src/store/ddb/client";
import type { DdbContext } from "../../src/store/ddb/contracts";
import { withCallCounter, type CountingDoc } from "../../src/store/ddb/counting";
import { withFaults, type FaultControl, type FaultyDoc } from "../../src/store/ddb/faults";
import type { Store } from "../../src/store/port";
import { STATE_KEY, type DdbFileState } from "./setup-ddb";
import type { TestStore } from "./port";

export type { Row, TableName, TestStore, Where } from "./port";

const state = (globalThis as Record<string, unknown>)[STATE_KEY] as DdbFileState | undefined;
if (state === undefined) throw new Error("tests/harness/ddb.ts imported outside the `ddb` vitest project (tests/harness/setup-ddb.ts did not run)");

const ROOT = path.resolve(import.meta.dirname, "..", "..");
const wrangler = parseToml(fs.readFileSync(path.join(ROOT, "wrangler.toml"), "utf8")) as { vars?: Record<string, string> };

const raw = createDocClient({ endpoint: state.endpoint, region: "us-east-2" });
const faultRate = Number(process.env.LAB_FAULT_RATE ?? 0);
const faultSeed = Number(process.env.LAB_FAULT_SEED ?? 1) ^ parseInt(createHash("sha1").update(state.file).digest("hex").slice(0, 8), 16);
const faulty: FaultyDoc = withFaults(raw, { rate: faultRate, seed: faultSeed, tables: state.tables });
const counted: CountingDoc = withCallCounter(faulty);
const blobs = memoryBlobs();

const ctxBase: Omit<DdbContext, "catalog"> = { doc: counted, tables: state.tables, blobs };

/** The storage port under test, for tests that call core functions directly. */
export const store: Store = createDdbStore(ctxBase);

const platform = createNodeLabPlatform({ store, blobs });

/** Extras for tests/ddb/** and lane N's TestStore: the wrapped client, tables, fault hooks and the call counter. */
export const ddbHarness = {
  raw,
  doc: counted as CountingDoc,
  tables: state.tables,
  blobs,
  store,
  faults: counted as unknown as FaultControl,
  calls: counted.calls,
  /** The context a DDB area factory takes (catalog excluded: createDdbStore builds it). */
  ctxBase,
};

/** The Worker's bindings: wrangler.toml [vars], the vitest config's test overrides, `DB` = the DynamoDB Store, and `PLATFORM`. Tests set TEST_CLOCK, TEST_RATE_LIMITS and TEST_LONGPOLL_SLEEP on it. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const env: Bindings & Record<string, any> = {
  ...wrangler.vars,
  STREAM_MAX_MS: "500",
  STREAM_POLL_MS: "20",
  IMPORT_ENABLED: "on",
  TEST_REHOST_DUMP_URL: process.env.REHOST_DUMP_URL ?? "",
  DB: store as unknown as D1Database,
  PLATFORM: platform,
  // workerd refuses `new Function`; pool-workers hands tests this binding instead. Node has no such rule.
  __VITEST_POOL_WORKERS_UNSAFE_EVAL: { newFunction: (body: string) => new Function(body) },
} as unknown as Bindings & Record<string, any>;

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
    const res = await app.fetch(req, env, ctx);
    return res;
  },
};

// Lane N's DynamoDB TestStore (tests/harness/ddb-store.ts) exports
// `ddbTestStore(h: typeof ddbHarness): TestStore`. Until it exists this is a stub.
const nModules = import.meta.glob<{ ddbTestStore?: (h: typeof ddbHarness) => TestStore }>("./ddb-store.ts", { eager: true });
const makeTestStore = Object.values(nModules)[0]?.ddbTestStore;

const unmerged = (): never => {
  throw new Error("testStore: lane N's tests/harness/ddb-store.ts (ddbTestStore) is not merged yet");
};
export const testStore: TestStore =
  makeTestStore !== undefined
    ? makeTestStore(ddbHarness)
    : {
        rows: unmerged,
        row: unmerged,
        count: unmerged,
        insert: unmerged,
        patch: unmerged,
        remove: unmerged,
        faults: { failWrites: unmerged, clear: unmerged },
      };
