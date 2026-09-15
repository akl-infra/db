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
                // Test-only bindings: tests/setup-workers.ts applies
                // TEST_MIGRATIONS via applyD1Migrations() before any workers
                // test runs. TEST_REHOST_DUMP_URL threads the real
                // `REHOST_DUMP_URL` env var (set only by db.yml's daily job,
                // 07 §7) from this outer Node process into the miniflare
                // Worker -- `process.env` inside the workerd realm itself
                // does not see the host shell's environment, so this is the
                // one place tests/rehost.test.ts (S7) can read it from.
                // (T2's write-route tests set a THIRD test-only property,
                // `TEST_CLOCK`, directly on the live `env` object at runtime
                // instead of declaring it here -- see src/routes/write.ts's
                // `resolveNow()`.)
                bindings: {
                  TEST_MIGRATIONS: migrations,
                  TEST_REHOST_DUMP_URL: process.env.REHOST_DUMP_URL ?? "",
                  // X1 (12 §2.2): overrides wrangler.toml's production
                  // STREAM_MAX_MS/STREAM_POLL_MS (300000/2000) so
                  // tests/api/stream.test.ts's bound/reconnect cases run in
                  // well under a second of real wall time instead of
                  // minutes -- the route reads these the same way in both
                  // cases, only the numbers differ.
                  STREAM_MAX_MS: "500",
                  STREAM_POLL_MS: "20",
                  // LDB-I27: overrides wrangler.toml's production
                  // IMPORT_ENABLED ("off" since 2026-09-15 -- cmini's own
                  // upstream is down) back to "on" for this whole suite, the
                  // same reasoning STREAM_MAX_MS/STREAM_POLL_MS above give --
                  // the import/diff test suite (tests/import/**, LDB-I1..I27)
                  // exercises real tick/diff behavior against FakeUpstream
                  // and expects it to run by default; only the
                  // "[LDB-I27] IMPORT_ENABLED kill switch" describes
                  // themselves override this back to "off" per test, the
                  // same pattern the LDB-I23 IMPORT_DELETES describe uses.
                  IMPORT_ENABLED: "on",
                },
              },
            }),
          ],
          test: {
            name: "workers",
            include: [
              "tests/api/**/*.test.ts",
              "tests/auth/**/*.test.ts",
              "tests/import/**/*.test.ts",
              "tests/events/**/*.test.ts",
              "tests/rehost.test.ts",
            ],
            // diff-unit.test.ts (S8) is offline/pure -- it belongs in the
            // "node" project below (import/diff.ts's own header explains
            // why: it can't share the workers project's extensionless
            // module resolution assumptions either way, and doesn't need
            // miniflare D1/R2 at all).
            exclude: ["tests/import/diff-unit.test.ts"],
            setupFiles: ["./tests/setup-workers.ts"],
            // GitHub's runners are ~3x slower than the laptop this default
            // (5s) was fine on -- run 34361785870 red-only on
            // tests/api/list.test.ts's [LDB-R4] sort=like_count limit=1 and
            // tests/api/ratelimit.test.ts's [LDB-R6] every non-GET route,
            // both "Test timed out in 5000ms", nothing actually wrong.
            testTimeout: 30000,
            hookTimeout: 30000,
          },
        },
        {
          test: {
            name: "node",
            include: [
              "tests/tools/**/*.test.ts",
              "tests/core/**/*.test.ts",
              "tests/formats/**/*.test.ts",
              "tests/import/diff-unit.test.ts",
              "tests/upstream-diff.test.ts",
              "tests/drill/**/*.test.ts",
              // [LDB-V4..V6] the route-table contract: pure over `CASES`
              // (static import), `adoption.md` (fs) and `db-responses/`
              // fixtures (static import) -- no D1/miniflare needed, so it
              // belongs here alongside docs-site.test.ts, not "workers".
              "tests/contract/**/*.test.ts",
            ],
          },
        },
      ],
    },
  };
});
