import path from "node:path";
import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

// Two projects (07-implementation-phase1.md S1/S2):
//  - "workers": runs inside workerd (miniflare D1 + R2, migrations applied
//    by tests/setup-workers.ts); everything that touches the Worker, D1 or
//    the import pipeline.
//  - "node": plain vitest; formats, tools (boundary/noconst/invariants/
//    ciwiring), core, and the live upstream diff.
export default defineConfig(async () => {
  const migrationsPath = path.join(import.meta.dirname, "migrations");
  const migrations = await readD1Migrations(migrationsPath);

  return {
    test: {
      projects: [
        {
          plugins: [
            cloudflareTest({
              wrangler: { configPath: "./wrangler.toml" },
              miniflare: {
                // Test-only binding: tests/setup-workers.ts applies these
                // via applyD1Migrations() before any workers test runs.
                bindings: { TEST_MIGRATIONS: migrations },
              },
            }),
          ],
          test: {
            name: "workers",
            include: [
              "tests/api/**/*.test.ts",
              "tests/import/**/*.test.ts",
              "tests/events/**/*.test.ts",
              "tests/rehost.test.ts",
            ],
            setupFiles: ["./tests/setup-workers.ts"],
          },
        },
        {
          test: {
            name: "node",
            include: [
              "tests/tools/**/*.test.ts",
              "tests/core/**/*.test.ts",
              "tests/formats/**/*.test.ts",
              "tests/upstream-diff.test.ts",
            ],
          },
        },
      ],
    },
  };
});
