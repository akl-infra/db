// POST/PUT/DELETE/restore/transfer on /v1/layouts (09 §3 T2). Glue only:
// parse the request, call one `core/write.ts` pipeline function, `c.json`
// the result -- no D1 statement here (LDB-W1, tests/tools/
// routes-noprepare.test.ts).
import { Hono } from "hono";
import type { ActorVariables } from "../auth/actor";
import type { Bindings } from "../env";
import { badRequest } from "../core/errors";
import { parseIfMatch } from "../core/ifmatch";
import { toWire } from "../core/records";
import { systemClock, type Clock } from "../core/time";
import { createLayout, deleteLayout, patchLayout, replaceLayout, restoreLayout, transferLayout } from "../core/write";
import { parseCreateBody, parsePatchBody, parseReplaceBody, parseTransferBody } from "./schemas";

// Test-only escape hatch, same shape as `TEST_ROUTES`/`TEST_MIGRATIONS`
// (vitest.config.ts, src/index.ts): pool-workers runs the Worker in the
// SAME isolate as the test file, so a test can set this directly on the
// shared `env` object (from `cloudflare:test`) before a `SELF.fetch` call
// to pin "now" for a write -- restore's 30-day boundary needs this; nothing
// else under phase 2 does. Absent in production; `Bindings` itself stays
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

export const writeRoute = new Hono<{ Bindings: Bindings; Variables: ActorVariables }>();

writeRoute.post("/v1/layouts", async (c) => {
  const body = parseCreateBody(await readJson(c.req));
  const { record } = await createLayout(c.env, resolveNow(c.env), c.get("actor"), body);
  return c.json(toWire(record), 201, { ETag: `"${record.rev}"` });
});

writeRoute.put("/v1/layouts/:ref", async (c) => {
  const ifMatch = parseIfMatch(c.req.header("If-Match") ?? null);
  const body = parseReplaceBody(await readJson(c.req));
  const { record } = await replaceLayout(c.env, resolveNow(c.env), c.get("actor"), c.req.param("ref"), body, ifMatch);
  return c.json(toWire(record), 200, { ETag: `"${record.rev}"` });
});

writeRoute.patch("/v1/layouts/:ref", async (c) => {
  const ifMatch = parseIfMatch(c.req.header("If-Match") ?? null);
  const body = parsePatchBody(await readJson(c.req.raw));
  const { record } = await patchLayout(c.env, resolveNow(c.env), c.get("actor"), c.req.param("ref"), body, ifMatch);
  return c.json(toWire(record), 200, { ETag: `"${record.rev}"` });
});

writeRoute.delete("/v1/layouts/:ref", async (c) => {
  const ifMatch = parseIfMatch(c.req.header("If-Match") ?? null);
  const { record } = await deleteLayout(c.env, resolveNow(c.env), c.get("actor"), c.req.param("ref"), ifMatch);
  return c.json(toWire(record), 200, { ETag: `"${record.rev}"` });
});

writeRoute.post("/v1/layouts/:ref/restore", async (c) => {
  const { record } = await restoreLayout(c.env, resolveNow(c.env), c.get("actor"), c.req.param("ref"));
  return c.json(toWire(record), 200, { ETag: `"${record.rev}"` });
});

writeRoute.post("/v1/layouts/:ref/transfer", async (c) => {
  const body = parseTransferBody(await readJson(c.req));
  const { record } = await transferLayout(c.env, resolveNow(c.env), c.get("actor"), c.req.param("ref"), body);
  return c.json(toWire(record), 200, { ETag: `"${record.rev}"` });
});
