// GET /v1/changes/stream (12 §2.2, §3 X1): the feed, framed as SSE. Same
// `TransformStream` + `c.executionCtx.waitUntil(pump)` shape as
// `routes/layouts.ts`'s `handleFullDump` (12 §0.2) -- a poll loop instead
// of a keyset walk.
import { Hono } from "hono";
import type { Bindings } from "../env";
import { canonical } from "../core/canonical";
import { badRequest, streamUnavailable } from "../core/errors";
import { feed } from "../core/events";
import { parseKinds, parseSince } from "./changes";

// Deliberately NOT a wrangler var (12 §0.2 names only WEBHOOK_MAX_POSTS,
// STREAM_MAX_MS, STREAM_POLL_MS): the heartbeat cadence is not something an
// operator needs to tune. `TEST_STREAM_HEARTBEAT_MS` is a test-only escape
// hatch, same shape/spirit as `TEST_CLOCK` (src/routes/write.ts) -- without
// it, `tests/api/stream.test.ts` could only observe a real ping by waiting
// 25 real seconds, which no fast test suite should do. Absent in production.
const DEFAULT_HEARTBEAT_MS = 25_000;
function resolveHeartbeatMs(env: Bindings): number {
  const test = (env as unknown as { TEST_STREAM_HEARTBEAT_MS?: number }).TEST_STREAM_HEARTBEAT_MS;
  return test ?? DEFAULT_HEARTBEAT_MS;
}

function realSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function parseLastEventId(raw: string | undefined): number | undefined {
  if (raw === undefined) return undefined;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 0) throw badRequest(`invalid 'Last-Event-ID' (expected a non-negative integer seq)`, "Last-Event-ID");
  return n;
}

export const streamRoute = new Hono<{ Bindings: Bindings }>();

streamRoute.get("/v1/changes/stream", async (c) => {
  const maxMs = Number(c.env.STREAM_MAX_MS);
  if (maxMs === 0) throw streamUnavailable(); // the Free-plan setting (12 §2.3 Q1)
  const pollMs = Number(c.env.STREAM_POLL_MS);
  const heartbeatMs = resolveHeartbeatMs(c.env);

  // `Last-Event-ID` beats `since` -- what `EventSource` sends on reconnect
  // (12 §2.2).
  const lastEventId = parseLastEventId(c.req.header("Last-Event-ID") ?? undefined);
  const since = lastEventId ?? parseSince(c.req.query("since"));
  const kinds = parseKinds(c.req.query("kinds"));
  const db = c.env.DB;

  const encoder = new TextEncoder();
  const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>();
  const writer = writable.getWriter();

  const startedAt = Date.now();
  const pump = (async () => {
    let cursor = since;
    try {
      let lastFrameAt = Date.now();
      for (;;) {
        if (Date.now() - startedAt >= maxMs) {
          await writer.write(encoder.encode(`event: close\ndata: ${canonical({ next: cursor })}\n\n`));
          break;
        }
        const { items, next } = await feed(db, cursor, 100, kinds);
        if (items.length > 0) {
          for (const item of items) {
            await writer.write(encoder.encode(`id: ${item.seq}\nevent: ${item.kind}\ndata: ${canonical(item)}\n\n`));
          }
          cursor = next;
          lastFrameAt = Date.now();
          continue; // more may already be waiting -- don't sleep before checking again
        }
        if (Date.now() - lastFrameAt >= heartbeatMs) {
          await writer.write(encoder.encode(": ping\n\n"));
          lastFrameAt = Date.now();
        }
        await realSleep(pollMs);
      }
    } catch (e) {
      console.error("changes stream failed", e); // never surfaced to the client -- the stream is already open
    } finally {
      await writer.close();
    }
  })();
  c.executionCtx.waitUntil(pump); // keep the isolate alive for the poll loop even if the client stops reading

  return new Response(readable, {
    headers: { "Content-Type": "text/event-stream; charset=utf-8", "Cache-Control": "no-store" },
  });
});
