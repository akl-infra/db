// akldb.org's Worker (design/akldb-site/01-plan.md §3, S1: one Worker with
// static assets, Hono serves /auth/* + /api/*; everything else falls
// through to the Vite build under [assets] via wrangler.toml's
// `run_worker_first`/SPA fallback).
import { Hono } from "hono";
import type { Env } from "./env.ts";
import { discordRoutes } from "./discord.ts";
import { proxyRoutes } from "./proxy.ts";

const app = new Hono<{ Bindings: Env }>();

app.route("/", discordRoutes);
app.route("/", proxyRoutes);

// Any other /auth/* or /api/* the routes above didn't match (both are in
// wrangler.toml's `run_worker_first`, so they always reach this Worker
// rather than falling through to the SPA index.html) -- SITE-4's "no path
// outside /v1/ is proxied" for the /api half. Every OTHER path -- the SPA's
// own routes (/, /l/:ref, /changes, /admin, ...) and every built asset --
// falls through to the `[assets]` binding, which applies wrangler.toml's
// own `not_found_handling = "single-page-application"` fallback itself
// (found necessary during W1b's Chrome QA: local `wrangler dev` was
// invoking this Worker for every path rather than only the ones
// `run_worker_first` lists, so the Worker has to hand off explicitly
// rather than assume the platform already tried assets first). `ASSETS` is
// undefined in every unit test's plain `Env` object (`tests/server/*.test.ts`
// never sets it) -- those keep getting the old bare JSON 404 unchanged.
app.notFound((c) => {
  const path = new URL(c.req.url).pathname;
  if (path.startsWith("/auth/") || path.startsWith("/api/") || !c.env.ASSETS) {
    return c.json({ error: "not_found" }, 404);
  }
  return c.env.ASSETS.fetch(c.req.raw);
});

export default app;
