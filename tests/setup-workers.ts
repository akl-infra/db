// Applies migrations/0001_init.sql (read by vitest.config.ts into the
// TEST_MIGRATIONS binding) before any "workers"-project test runs. Setup
// files run outside per-test-file storage isolation and may run more than
// once; applyD1Migrations() only applies migrations not already recorded in
// d1_migrations, so calling it here unconditionally is safe.
import { applyD1Migrations } from "cloudflare:test";
import { env } from "cloudflare:workers";
import type { D1Migration } from "@cloudflare/vitest-pool-workers";
import { afterEach } from "vitest";

const e = env as unknown as { DB: D1Database; TEST_MIGRATIONS: D1Migration[] };

await applyD1Migrations(e.DB, e.TEST_MIGRATIONS);

// X1 (12 §2.1): `index.ts`'s webhook nudge fires a `drain()` via `ctx.
// executionCtx.waitUntil`, which `SELF.fetch` does not wait on before
// resolving. Several test files build their own local `SELF.fetch` wrapper
// (not `write-support.ts`'s `writeFetch`/`support.ts`'s
// `fireConformanceStep`, which already await this too, redundantly but
// harmlessly), so a per-helper fix can't be relied on to cover every write
// route this suite exercises -- a single project-wide `afterEach` does,
// regardless of which wrapper a test used or whether it wrote at all
// (`TEST_LAST_NUDGE` is simply absent when nothing did). Without this, a
// pending drain's own fetch call can survive past its test's fetch stub
// (torn down in a later `afterEach`/`afterAll`) and hit the real global
// fetch in this sandboxed runtime -- a request to nowhere that workerd
// eventually kills as "hung" (harmless to results, noisy in CI). Swallowed:
// a rejected drain is not any given test's problem to surface.
afterEach(async () => {
  const pending = (e as unknown as { TEST_LAST_NUDGE?: Promise<unknown> }).TEST_LAST_NUDGE;
  if (pending === undefined) return;
  try {
    await pending;
  } catch {
    // logged by the nudge's own caller in production; not this hook's job
  }
});
