// Real timers for the commit protocol, captured when this module loads. A test
// that freezes the clock (`vi.useFakeTimers()`, as tests/api/dump.test.ts and
// tests/rehost.test.ts do) replaces the global setTimeout/setImmediate later;
// the replica's backoff and the memory log's simulated latency must keep
// running on real time, or a retried unit never resumes (found by the 20%
// fault run: both files hung idle).
const realSetTimeout = globalThis.setTimeout;
const realSetImmediate = globalThis.setImmediate;

/** Resolve after `ms` milliseconds of real time. */
export function sleep(ms: number): Promise<void> {
  return new Promise<void>((resolve) => realSetTimeout(resolve, ms));
}

/** Resolve on the next turn of the real event loop. */
export function nextTurn(): Promise<void> {
  return new Promise<void>((resolve) => realSetImmediate(resolve));
}
