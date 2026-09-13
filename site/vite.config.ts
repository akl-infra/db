// db/site's Vite config -- builds src/ into dist/, served by the Worker's
// [assets] block (wrangler.toml). solid-js 2.0.0-rc.1 + @solidjs/vite-plugin
// (same pin as the root app, design/akldb-site/01-plan.md S9).
import { defineConfig } from "vite";
import solid from "@solidjs/vite-plugin";

export default defineConfig({
  plugins: [solid()],
  build: {
    outDir: "dist",
    emptyOutDir: true,
    rollupOptions: {
      output: {
        // The generated docs content (scripts/build-docs.mjs's render of
        // db/docs/adoption.md) legitimately quotes akl-db's real hostname
        // dozens of times -- that guide's whole job is to name the real
        // production endpoint. Isolating it into its own named chunk lets
        // SITE-7 (tests/tools/no-hostname-leak.test.ts) scan every OTHER
        // chunk for that hostname literal -- proving the actual
        // application code (session/proxy/api layers) never hardcodes it
        // outside `DB_BASE_URL` -- without that proof being unwinnable
        // just because the Docs page renders its own source material.
        manualChunks(id) {
          if (id.includes("/src/generated/docs.html")) return "docs-content";
        },
      },
    },
  },
  server: {
    port: 5183,
    proxy: {
      // Local `vite dev` alone can't run the Worker's Hono routes -- point
      // /auth and /api at `wrangler dev` (README.md's two-terminal dev flow)
      // when both are running side by side.
      "/auth": "http://127.0.0.1:8788",
      "/api": "http://127.0.0.1:8788",
    },
  },
});
