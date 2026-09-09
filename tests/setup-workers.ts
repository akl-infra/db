// Applies migrations/0001_init.sql (read by vitest.config.ts into the
// TEST_MIGRATIONS binding) before any "workers"-project test runs. Setup
// files run outside per-test-file storage isolation and may run more than
// once; applyD1Migrations() only applies migrations not already recorded in
// d1_migrations, so calling it here unconditionally is safe.
import { applyD1Migrations } from "cloudflare:test";
import { env } from "cloudflare:workers";
import type { D1Migration } from "@cloudflare/vitest-pool-workers";

const e = env as unknown as { DB: D1Database; TEST_MIGRATIONS: D1Migration[] };

await applyD1Migrations(e.DB, e.TEST_MIGRATIONS);
