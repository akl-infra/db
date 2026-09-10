// GET /v1/dump, /v1/dump/latest.json, /v1/dump/dump-*.json.gz,
// /v1/dump/monthly/dump-*.json.gz (07 §6 S7). These serve one immutable R2
// object per key -- cached by KEY, not by event head, so there's no
// `core/etag.ts` head-seq dance here: the R2 object's own `httpEtag` is
// passed straight through and `If-None-Match` needs no handling beyond what
// a normal HTTP cache already does with a strong ETag on an immutable URL.
import { Hono } from "hono";
import type { Bindings } from "../env";
import { notFound } from "../core/errors";

const DAILY_KEY_RE = /^dump-\d{4}-\d{2}-\d{2}\.json\.gz$/;
const MONTHLY_KEY_RE = /^dump-\d{4}-\d{2}\.json\.gz$/;
// LDB-D6: the per-major files `writeDump()` writes (`latest.<name>-<N>.json`
// and its `.sha256` sidecar, never gzipped). Anchored, lowercase lineage
// name, decimal major: nothing else in the bucket is reachable through it.
const PER_MAJOR_KEY_RE = /^latest\.[a-z][a-z0-9]*-[1-9]\d*\.json(\.sha256)?$/;

export const dumpRoute = new Hono<{ Bindings: Bindings }>();

// Static routes first so Hono's router never has to decide between a
// literal segment and `:key` -- `/v1/dump/latest.json` and
// `/v1/dump/monthly/:key` both live at a different path shape than
// `/v1/dump/:key` anyway, but registering the specific ones first keeps the
// file readable top-to-bottom in "most specific first" order.
dumpRoute.get("/v1/dump/latest.json", async (c) => {
  const obj = await c.env.DUMPS.get("latest.json");
  if (obj === null) throw notFound("no dump has been written yet", "latest.json");
  return new Response(obj.body, {
    headers: { "Content-Type": "application/json", ETag: obj.httpEtag },
  });
});

dumpRoute.get("/v1/dump/monthly/:key", async (c) => {
  const key = c.req.param("key");
  if (!MONTHLY_KEY_RE.test(key)) throw notFound(`no dump 'monthly/${key}'`, key);
  const r2Key = `monthly/${key}`;
  const obj = await c.env.DUMPS.get(r2Key);
  if (obj === null) throw notFound(`no dump '${r2Key}'`, key);
  return new Response(obj.body, { headers: { "Content-Type": "application/gzip", ETag: obj.httpEtag } });
});

dumpRoute.get("/v1/dump/:key", async (c) => {
  const key = c.req.param("key");
  const perMajor = PER_MAJOR_KEY_RE.test(key);
  if (!perMajor && !DAILY_KEY_RE.test(key)) throw notFound(`no dump '${key}'`, key);
  const obj = await c.env.DUMPS.get(key);
  if (obj === null) throw notFound(`no dump '${key}'`, key);
  const contentType = !perMajor ? "application/gzip" : key.endsWith(".sha256") ? "text/plain" : "application/json";
  return new Response(obj.body, { headers: { "Content-Type": contentType, ETag: obj.httpEtag } });
});

// GET /v1/dump -- always the latest, via a 302 (07 §6 S7: "no public bucket
// needed" -- the redirect target is this same Worker's own /v1/dump/<key>).
dumpRoute.get("/v1/dump", async (c) => {
  const obj = await c.env.DUMPS.get("latest.json");
  if (obj === null) throw notFound("no dump has been written yet");
  const latest = await obj.json<{ key: string }>();
  return c.redirect(`/v1/dump/${latest.key}`, 302);
});
