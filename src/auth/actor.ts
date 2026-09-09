// The actor and the write gate (09 §2.1). `Actor` is what every
// authorization rule in phase 2 reads (`actor.user_id`, `actor.admin`);
// `requireActorOnWrites` is the one middleware that makes every non-GET
// route under /v1/* 401 an anonymous request -- registered before any
// route in src/index.ts, so no write route can be reached without it.
import type { MiddlewareHandler } from "hono";
import type { Bindings } from "../env";
import { type AuthDeps, resolveActor } from "./discord";

// `via` widens to the client lane (10 C1): `"discord"` from a Discord
// bearer token, `` `client:${id}` `` from an Ed25519-signed request an
// admin-registered client made on that user's behalf (02 §3).
export interface Actor {
  user_id: string;
  name: string;
  via: "discord" | `client:${string}`;
  admin: boolean;
}

export type ActorVariables = { actor: Actor };

// Exported so `auth/ratelimit.ts`'s `rateLimitWrites` (mounted right after
// this middleware, 09 §2.5) skips the exact same methods -- two independent
// copies of this set could quietly drift.
export const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

export function requireActorOnWrites(
  deps: AuthDeps,
): MiddlewareHandler<{ Bindings: Bindings; Variables: ActorVariables }> {
  return async (c, next) => {
    if (SAFE_METHODS.has(c.req.method)) {
      await next();
      return;
    }
    // `c.req`, not `c.req.raw`: the client lane (10 C1) hashes the body via
    // `c.req.arrayBuffer()`, which Hono caches on `c.req` -- reading the raw
    // Request's own stream here would leave nothing for that cache to reuse.
    const actor = await resolveActor(c.env, c.req, deps);
    c.set("actor", actor);
    await next();
  };
}
