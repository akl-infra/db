// Shared helpers for the T2 write-route suites (09 §3 T2). Not a
// `*.test.ts` file itself -- same reasoning as tests/api/support.ts: only
// `tests/api/**/*.test.ts` is picked up by vitest.config.ts's `include`.
import { SELF, env } from "cloudflare:test";
import { vi } from "vitest";
import type { Clock } from "../../src/core/time";
import { FakeDiscord } from "../auth/fake-discord";

// migrations/0001_init.sql's bootstrap admin row.
export const BOOTSTRAP_ADMIN = "184412255822020608";

// Genuinely cmini-shaped (bare-string `board`) -- still used to seed a
// REAL `cmini/1`-stored record directly via `appendWrite` (LDB-F21's own
// carry-forward tests need a real legacy shape to convert). 20-spark.md
// S2: `cmini/1` writes are refused through the real write routes now
// (LDB-F16), so a call site that used to POST/PUT this through HTTP uses
// `AKL_PAYLOAD`/`format: "akl/1"` instead -- never this constant, which
// would 400 `unknown_format`.
export const CMINI_PAYLOAD = { board: "ortho" as const, keys: {} };
export const AKL_PAYLOAD = { keys: {} };

let uniqueCounter = 0;
export function uniqueName(prefix: string): string {
  return `${prefix}-${uniqueCounter++}`;
}

// One FakeDiscord, one global fetch stub -- every actor a test needs is
// `register()`ed on it under its own token, then a request picks its actor
// via the Authorization header. Callers must `vi.unstubAllGlobals()` in
// `afterEach` (fake-discord.ts's own convention).
export function actorFixture(): FakeDiscord {
  const fake = new FakeDiscord();
  vi.stubGlobal("fetch", fake.fetchImpl);
  return fake;
}

export function register(fake: FakeDiscord, token: string, id: string): Record<string, string> {
  fake.setAnswer(token, { kind: "ok", id, username: `user-${id}`, global_name: null });
  return { Authorization: `Bearer ${token}` };
}

// `src/routes/write.ts`'s `resolveNow()`: a test-only escape hatch, same
// shape as `TEST_ROUTES`/`TEST_MIGRATIONS` (pool-workers runs the Worker in
// the SAME isolate as the test file, so mutating `env` here is visible to
// the very next `SELF.fetch`). Pins "now" for every write route in this
// test file -- needed wherever a write goes through HTTP (unlike a direct
// `appendWrite(db, fixedClock(...), ...)` call, which takes its clock as a
// plain argument and needs no such hatch).
export function pinTestClock(env: { TEST_CLOCK?: Clock }, clock: Clock): void {
  env.TEST_CLOCK = clock;
}

// X1 (12 §2.1): `index.ts`'s webhook nudge fires via `ctx.executionCtx.
// waitUntil`, which `SELF.fetch` does not wait on before resolving --
// awaited here, once, after every write this helper makes, so no test in
// this file's caller ever has to know the nudge exists, and its delivery
// attempt never outlives this call's own fetch stub (a dangling one hitting
// the REAL global fetch after a later `vi.unstubAllGlobals()` is what
// workerd's watchdog was killing as "hung"). Swallowed, not rethrown: a
// rejected drain is `waitUntil`'s own problem to log, not a reason to fail
// a test that has nothing to do with webhook delivery.
async function awaitPendingNudge(): Promise<void> {
  const pending = (env as unknown as { TEST_LAST_NUDGE?: Promise<unknown> }).TEST_LAST_NUDGE;
  if (pending === undefined) return;
  try {
    await pending;
  } catch {
    // logged by the nudge's own caller in production; not this helper's job
  }
}

export async function writeFetch(
  path: string,
  method: string,
  headers: Record<string, string> = {},
  body?: unknown,
): Promise<Response> {
  const res = await SELF.fetch(`https://example.com${path}`, {
    method,
    headers: body === undefined ? headers : { "Content-Type": "application/json", ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  await awaitPendingNudge();
  return res;
}
