// POST/PUT/DELETE/restore/transfer on /v1/layouts (09 §3 T2). Glue only:
// parse the request, call one `core/write.ts` pipeline function, `c.json`
// the result -- no D1 statement here (LDB-W1, tests/tools/
// routes-noprepare.test.ts).
import { Hono } from "hono";
import type { ActorVariables } from "../auth/actor";
import type { Bindings } from "../env";
import { ApiError, badRequest, type ErrBody } from "../core/errors";
import { parseIfMatch } from "../core/ifmatch";
import { toWire } from "../core/records";
import { systemClock, type Clock } from "../core/time";
import { createLayout, deleteLayout, patchLayout, replaceLayout, restoreLayout, transferLayout } from "../core/write";
import { parseCreateBody, parsePatchBody, parseReplaceBody, parseRestoreBody, parseTransferBody } from "./schemas";
import { ALIASES } from "../../formats/registry.ts";

// Test-only escape hatch, same shape as `TEST_ROUTES`/`TEST_MIGRATIONS`
// (vitest.config.ts, src/index.ts): pool-workers runs the Worker in the
// SAME isolate as the test file, so a test can set this directly on the
// shared `env` object (from `cloudflare:test`) before a `SELF.fetch` call
// to pin "now" for a write. Absent in production; `Bindings` itself stays
// clean (LDB-G4 -- every real binding has a README row, this isn't one).
function resolveNow(env: Bindings): Clock {
  return (env as unknown as { TEST_CLOCK?: Clock }).TEST_CLOCK ?? systemClock;
}

async function readJson(req: { json(): Promise<unknown> }): Promise<unknown> {
  try {
    return await req.json();
  } catch {
    throw badRequest("request body must be valid JSON", "/");
  }
}

// restore's body is OPTIONAL (20-spark.md §1 decision 9): the deployed
// site/bot send no body at all, which must stay valid -- an empty request
// body reads as `{}` rather than a JSON-parse `bad_request`, but anything
// present that ISN'T valid JSON still is one.
async function readOptionalJson(req: { text(): Promise<string> }): Promise<unknown> {
  const text = await req.text();
  if (text.trim() === "") return {};
  try {
    return JSON.parse(text);
  } catch {
    throw badRequest("request body must be valid JSON", "/");
  }
}

// 20-spark.md S2 §1.12 (refined, §8 R-H3/R-L3): the wire `format` field is
// the record's NATIVE format everywhere -- the relabel to an alias is the
// one exception, and it follows the REQUEST: a write response (POST/PUT)
// whose body named `akl/1` carries `format: "akl/1"` even though the
// record is stored `spark/1`. Only `akl/1` (`ALIASES[...].relabel`) ever
// triggers this; `cmini/1` writes are refused before a response body
// exists at all.
function relabelWrite(wire: Record<string, unknown>, requestedFormat: string): Record<string, unknown> {
  return ALIASES[requestedFormat]?.relabel ? { ...wire, format: requestedFormat } : wire;
}

// Same rule for a `409 stale` body's embedded `record` (the winner's
// current state) -- the CALLER'S request named `akl/1`, so the record it
// is shown, byte-identical either way, is labelled the same way a success
// response would have been.
function relabelStaleError(e: unknown, requestedFormat: string): never {
  if (e instanceof ApiError && e.body.error === "stale" && ALIASES[requestedFormat]?.relabel) {
    const body = e.body as ErrBody & { record: Record<string, unknown> };
    throw new ApiError(e.status, { ...body, record: { ...body.record, format: requestedFormat } }, e.headers);
  }
  throw e;
}

export const writeRoute = new Hono<{ Bindings: Bindings; Variables: ActorVariables }>();

writeRoute.post("/v1/layouts", async (c) => {
  const body = parseCreateBody(await readJson(c.req));
  const { record } = await createLayout(c.env, resolveNow(c.env), c.get("actor"), body, c.get("sourceVersion"));
  return c.json(relabelWrite(toWire(record), body.format), 201, { ETag: `"${record.rev}"` });
});

writeRoute.put("/v1/layouts/:ref", async (c) => {
  const ifMatch = parseIfMatch(c.req.header("If-Match") ?? null);
  const body = parseReplaceBody(await readJson(c.req));
  try {
    const { record } = await replaceLayout(c.env, resolveNow(c.env), c.get("actor"), c.req.param("ref"), body, ifMatch, c.get("sourceVersion"));
    return c.json(relabelWrite(toWire(record), body.format), 200, { ETag: `"${record.rev}"` });
  } catch (e) {
    relabelStaleError(e, body.format);
  }
});

writeRoute.patch("/v1/layouts/:ref", async (c) => {
  const ifMatch = parseIfMatch(c.req.header("If-Match") ?? null);
  // `c.req`, not `c.req.raw`: `auth/actor.ts`'s own comment on this exact
  // rule -- the client lane hashes the body via `c.req.arrayBuffer()`,
  // which Hono caches on `c.req`; reading the raw Request's stream here
  // (this route's own bug until the PATCH client-lane test below caught
  // it) leaves nothing for that cache to reuse and a second read throws.
  const body = parsePatchBody(await readJson(c.req));
  const { record } = await patchLayout(c.env, resolveNow(c.env), c.get("actor"), c.req.param("ref"), body, ifMatch, c.get("sourceVersion"));
  return c.json(toWire(record), 200, { ETag: `"${record.rev}"` });
});

writeRoute.delete("/v1/layouts/:ref", async (c) => {
  const ifMatch = parseIfMatch(c.req.header("If-Match") ?? null);
  const { record } = await deleteLayout(c.env, resolveNow(c.env), c.get("actor"), c.req.param("ref"), ifMatch, c.get("sourceVersion"));
  return c.json(toWire(record), 200, { ETag: `"${record.rev}"` });
});

writeRoute.post("/v1/layouts/:ref/restore", async (c) => {
  const body = parseRestoreBody(await readOptionalJson(c.req));
  const { record } = await restoreLayout(c.env, resolveNow(c.env), c.get("actor"), c.req.param("ref"), body, c.get("sourceVersion"));
  return c.json(toWire(record), 200, { ETag: `"${record.rev}"` });
});

writeRoute.post("/v1/layouts/:ref/transfer", async (c) => {
  const ifMatch = parseIfMatch(c.req.header("If-Match") ?? null);
  const body = parseTransferBody(await readJson(c.req));
  const { record } = await transferLayout(c.env, resolveNow(c.env), c.get("actor"), c.req.param("ref"), body, ifMatch, c.get("sourceVersion"));
  return c.json(toWire(record), 200, { ETag: `"${record.rev}"` });
});
