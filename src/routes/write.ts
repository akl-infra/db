// POST/PUT/PATCH/DELETE/restore/transfer on /v1/layouts (21-formats.md
// §2.4). Glue only: parse the request, call one `core/write.ts` pipeline
// function, `c.json` the result -- no D1 statement here (LDB-W1).
import { Hono } from "hono";
import type { ActorVariables } from "../auth/actor";
import type { Bindings } from "../env";
import { badRequest } from "../core/errors";
import { parseIfMatch, parseIfNoneMatch } from "../core/ifmatch";
import { fullWire } from "../core/records";
import { systemClock, type Clock } from "../core/time";
import { classifyPatch, createLayout, deleteLayout, patchFormat, putFormat, renameLayout, restoreLayout, transferLayout } from "../core/write";
import { parseCreateBody, parsePatchBody, parseReplaceBody, parseRestoreBody, parseTransferBody } from "./schemas";

// Test-only escape hatch: pool-workers runs the Worker in the SAME isolate
// as the test file, so a test can set this directly on the shared `env`
// object before a `SELF.fetch` call to pin "now" for a write. Absent in
// production.
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

// restore's body is OPTIONAL (20-spark.md §1 decision 9): an empty request
// body reads as `{}` rather than a JSON-parse `bad_request`.
async function readOptionalJson(req: { text(): Promise<string> }): Promise<unknown> {
  const text = await req.text();
  if (text.trim() === "") return {};
  try {
    return JSON.parse(text);
  } catch {
    throw badRequest("request body must be valid JSON", "/");
  }
}

export const writeRoute = new Hono<{ Bindings: Bindings; Variables: ActorVariables }>();

writeRoute.post("/v1/layouts", async (c) => {
  const body = parseCreateBody(await readJson(c.req));
  const { layout, formats, format, lineage, payload } = await createLayout(c.env, resolveNow(c.env), c.get("actor"), body, c.get("sourceVersion"));
  const f = formats.get(lineage)!;
  return c.json(fullWire(layout, formats, { format, payload }), 201, { ETag: `"${lineage}:${f.rev}"` });
});

writeRoute.put("/v1/layouts/:ref", async (c) => {
  const ifMatch = parseIfMatch(c.req.header("If-Match") ?? null);
  const ifNoneMatch = parseIfNoneMatch(c.req.header("If-None-Match") ?? null);
  const body = parseReplaceBody(await readJson(c.req));
  const { layout, formats, format, lineage, payload } = await putFormat(c.env, resolveNow(c.env), c.get("actor"), c.req.param("ref"), body, ifMatch, ifNoneMatch, c.get("sourceVersion"));
  const f = formats.get(lineage)!;
  return c.json(fullWire(layout, formats, { format, payload }), 200, { ETag: `"${lineage}:${f.rev}"` });
});

writeRoute.patch("/v1/layouts/:ref", async (c) => {
  const ifMatch = parseIfMatch(c.req.header("If-Match") ?? null);
  // `c.req`, not `c.req.raw`: the client lane hashes the body via
  // `c.req.arrayBuffer()`, which Hono caches on `c.req`.
  const body = parsePatchBody(await readJson(c.req));
  const classified = classifyPatch(body);
  const now = resolveNow(c.env);
  const actor = c.get("actor");
  const ref = c.req.param("ref");
  const version = c.get("sourceVersion");

  if (classified.kind === "rename") {
    const { layout, formats } = await renameLayout(c.env, now, actor, ref, classified.name, ifMatch, version);
    return c.json(fullWire(layout, formats), 200, { ETag: `"layout:${layout.layout_rev}"` });
  }
  const { layout, formats, format, lineage, payload } = await patchFormat(c.env, now, actor, ref, classified.format, classified.edits, ifMatch, version);
  const f = formats.get(lineage)!;
  return c.json(fullWire(layout, formats, { format, payload }), 200, { ETag: `"${lineage}:${f.rev}"` });
});

writeRoute.delete("/v1/layouts/:ref", async (c) => {
  const ifMatch = parseIfMatch(c.req.header("If-Match") ?? null);
  const { layout, formats } = await deleteLayout(c.env, resolveNow(c.env), c.get("actor"), c.req.param("ref"), ifMatch, c.get("sourceVersion"));
  return c.json(fullWire(layout, formats), 200, { ETag: `"layout:${layout.layout_rev}"` });
});

writeRoute.post("/v1/layouts/:ref/restore", async (c) => {
  const body = parseRestoreBody(await readOptionalJson(c.req));
  const { layout, formats } = await restoreLayout(c.env, resolveNow(c.env), c.get("actor"), c.req.param("ref"), body, c.get("sourceVersion"));
  return c.json(fullWire(layout, formats), 200, { ETag: `"layout:${layout.layout_rev}"` });
});

writeRoute.post("/v1/layouts/:ref/transfer", async (c) => {
  const ifMatch = parseIfMatch(c.req.header("If-Match") ?? null);
  const body = parseTransferBody(await readJson(c.req));
  const { layout, formats } = await transferLayout(c.env, resolveNow(c.env), c.get("actor"), c.req.param("ref"), body, ifMatch, c.get("sourceVersion"));
  return c.json(fullWire(layout, formats), 200, { ETag: `"layout:${layout.layout_rev}"` });
});
