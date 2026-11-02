// setupFiles of the `shim` vitest project: one fresh replica per test file, on
// a fresh in-memory commit log, with the migrations applied THROUGH the log
// (SH10), before the file's imports run. SHIM_FAULT_RATE=0.2 (and
// SHIM_FAULT_SEED) turn on injected conflicts, throttles and timeouts before
// and after the commit on every log call of the file's replica.
import path from "node:path";
import { afterAll, afterEach } from "vitest";
import { MemoryLog, type MemoryLogFaults } from "../../src/replica/log-memory";
import { applyMigrations } from "../../src/replica/migrations";
import { Replica } from "../../src/replica/replica";

export interface ShimFileState {
  log: MemoryLog;
  replica: Replica;
}

export const STATE_KEY = "__aklShimFileState";

/** Split a total fault rate evenly over the four kinds of failure. */
export function faultsFromRate(rate: number, seed: number, maxYields = 2): MemoryLogFaults {
  return { conflict: rate / 4, throttle: rate / 4, timeoutBefore: rate / 4, timeoutAfter: rate / 4, seed, maxYields };
}

const rate = Number(process.env.SHIM_FAULT_RATE ?? 0);
const seed = Number(process.env.SHIM_FAULT_SEED ?? 1);
const worker = (globalThis as unknown as { __vitest_worker__?: { filepath?: string } }).__vitest_worker__;
const fileHash = [...(worker?.filepath ?? "")].reduce((h, ch) => (Math.imul(h, 31) + ch.charCodeAt(0)) >>> 0, 7);

const log = new MemoryLog(rate > 0 ? faultsFromRate(rate, (seed ^ fileHash) >>> 0) : {});
const replica = new Replica(log, { sleep: async () => {}, backoffMs: 0 });
await applyMigrations(replica, path.resolve(import.meta.dirname, "..", "..", "migrations"));
(globalThis as Record<string, unknown>)[STATE_KEY] = { log, replica } satisfies ShimFileState;

// The same project-wide hook as tests/setup-workers.ts: a pending webhook nudge must not outlive its test.
afterEach(async () => {
  const env = (globalThis as unknown as { __aklShimEnv?: { TEST_LAST_NUDGE?: Promise<unknown> } }).__aklShimEnv;
  try {
    await env?.TEST_LAST_NUDGE;
  } catch {
    // not this hook's problem to surface
  }
});

afterAll(() => {
  replica.close();
});
