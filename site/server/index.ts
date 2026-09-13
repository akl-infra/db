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
// outside /v1/ is proxied" for the /api half.
app.notFound((c) => c.json({ error: "not_found" }, 404));

export default app;
