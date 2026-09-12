// The `Idempotency-Key` middleware (L3, design/layout-db/review/
// PROPOSAL.md §2.1). Mounted on `/v1/*` right after `requireActorOnWrites`
// (so `c.get("actor")` is set) and BEFORE `rateLimitWrites` (src/index.ts)
// -- placement, not a per-route list, is what scopes this to every
// mutating /v1/layouts route (writes, likes, restore, transfer) with no
// route file ever importing it, and is what makes "rate limit charged once
// per key, not per replay" true for free: a genuine replay returns here,
// before `next()` ever reaches `rateLimitWrites` or a route handler, so
// neither the write-rate counter nor a second write is ever touched.
//
// The header is entirely optional -- absent, this middleware is a no-op
// (LDB-K5) -- and out of scope for anything outside `/v1/layouts*` (admin,
// webhooks): those routes aren't part of this slice (review/LEDGER.md L3).
import type { MiddlewareHandler } from "hono";
import type { ActorVariables } from "./actor";
import type { Bindings } from "../env";
import { badRequest, idempotencyMismatch } from "../core/errors";
import {
  getIdempotency,
  idempotencyScope,
  isExpired,
  isValidIdempotencyKey,
  requestHash,
  shouldStoreStatus,
  storeIdempotency,
} from "../core/idempotency";
import { systemClock, type Clock } from "../core/time";

// Same test-only escape hatch as `src/routes/write.ts`'s `resolveNow()`:
// pool-workers runs the Worker in the same isolate as the test file, so a
// test can pin "now" on the shared `env` object's `TEST_CLOCK` property
// before a `SELF.fetch` call to step across the 24h window without a real
// sleep.
function resolveNow(env: Bindings, fallback: Clock): Clock {
  return (env as unknown as { TEST_CLOCK?: Clock }).TEST_CLOCK ?? fallback;
}

function inScope(method: string, path: string): boolean {
  if (method === "GET" || method === "HEAD" || method === "OPTIONS") return false;
  return path.startsWith("/v1/layouts");
}

export function idempotencyKeys(defaultNow: Clock = systemClock): MiddlewareHandler<{ Bindings: Bindings; Variables: ActorVariables }> {
  return async (c, next) => {
    if (!inScope(c.req.method, c.req.path)) {
      await next();
      return;
    }
    const raw = c.req.header("Idempotency-Key") ?? null;
    if (raw === null) {
      await next();
      return;
    }
    if (!isValidIdempotencyKey(raw)) {
      throw badRequest("'Idempotency-Key' must be 1-128 printable ASCII characters", "Idempotency-Key");
    }

    const now = resolveNow(c.env, defaultNow);
    const actor = c.get("actor");
    const scope = idempotencyScope(actor);
    const method = c.req.method;
    const path = c.req.path;
    // `c.req`, not `c.req.raw`: same body-cache reasoning as
    // `requireActorOnWrites`/`routes/write.ts` -- Hono caches the parsed
    // body on first `c.req.arrayBuffer()`/`c.req.json()` call, so reading
    // it here (whether or not the client lane already did, for its own
    // signature) costs nothing extra and leaves the exact same bytes for
    // every downstream reader.
    const bodyBuf = await c.req.arrayBuffer();
    const hash = await requestHash(bodyBuf);

    const existing = await getIdempotency(c.env.DB, scope, raw);
    if (existing !== null && !isExpired(existing, now)) {
      if (existing.method === method && existing.path === path && existing.request_hash === hash) {
        // The replay: served straight from the stored row, no D1 write, no
        // route handler invoked at all -- `next()` never runs, so neither
        // `rateLimitWrites` nor the webhook nudge (both mounted after this
        // middleware in src/index.ts) see this request either.
        c.res = new Response(existing.response_body, {
          status: existing.status,
          headers: { "Content-Type": "application/json", "Idempotency-Replayed": "true" },
        });
        return;
      }
      // Same key, different method/path/body: refuse outright, write
      // nothing. Also short-circuits before `rateLimitWrites` -- a caller
      // that reuses a key by mistake doesn't spend a write attempt on the
      // refusal either, same posture as a genuine replay.
      throw idempotencyMismatch();
    }

    await next();

    const status = c.res.status;
    if (shouldStoreStatus(status)) {
      // Every route this middleware covers (`routes/write.ts`,
      // `routes/likes.ts`) answers via `c.json(...)` -- always JSON, so
      // storing (and later replaying) as `application/json` is exact.
      const body = await c.res.clone().text();
      await storeIdempotency(c.env.DB, {
        scope,
        key: raw,
        method,
        path,
        request_hash: hash,
        status,
        response_body: body,
        at: now(),
      });
    }
  };
}
