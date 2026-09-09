// Shared helpers for the T2 write-route suites (09 §3 T2). Not a
// `*.test.ts` file itself -- same reasoning as tests/api/support.ts: only
// `tests/api/**/*.test.ts` is picked up by vitest.config.ts's `include`.
import { SELF } from "cloudflare:test";
import { vi } from "vitest";
import type { Clock } from "../../src/core/time";
import { FakeDiscord } from "../auth/fake-discord";

// migrations/0001_init.sql's bootstrap admin row.
export const BOOTSTRAP_ADMIN = "184412255822020608";

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

export async function writeFetch(
  path: string,
  method: string,
  headers: Record<string, string> = {},
  body?: unknown,
): Promise<Response> {
  return SELF.fetch(`https://example.com${path}`, {
    method,
    headers: body === undefined ? headers : { "Content-Type": "application/json", ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}
