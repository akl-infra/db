// The actor and the write gate (09 §2.1). `Actor` is what every
// authorization rule in phase 2 reads (`actor.user_id`, `actor.admin`);
// `requireActorOnWrites` is the one middleware that makes every non-GET
// route under /v1/* 401 an anonymous request -- registered before any
// route in src/index.ts, so no write route can be reached without it.
import type { MiddlewareHandler } from "hono";
import type { Bindings } from "../env";
import { type AuthDeps, resolveActor } from "./discord";

export interface Actor {
  user_id: string;
  name: string;
  via: "discord";
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
    const actor = await resolveActor(c.env, c.req.raw, deps);
    c.set("actor", actor);
    await next();
  };
}
