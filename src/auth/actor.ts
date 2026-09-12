// The actor and the write gate (09 §2.1). `Actor` is what every
// authorization rule in phase 2 reads (`actor.user_id`, `actor.admin`);
// `requireActorOnWrites` is the one middleware that makes every non-GET
// route under /v1/* 401 an anonymous request -- registered before any
// route in src/index.ts, so no write route can be reached without it.
import type { MiddlewareHandler } from "hono";
import type { Bindings } from "../env";
import { invalidClientVersion } from "../core/errors";
import { type AuthDeps, resolveActor } from "./discord";

// `via` widens to the client lane (10 C1): `"discord"` from a Discord
// bearer token, `` `client:${id}` `` from an Ed25519-signed request an
// admin-registered client made on that user's behalf (02 §3).
export interface Actor {
  user_id: string;
  name: string;
  via: "discord" | `client:${string}`;
  admin: boolean;
  // 20-spark.md S3s (decision 14, LDB-P15): PROVEN, never declared --
  // `` `discord-app:${app id}` `` on the user lane (the Discord OAuth2
  // application the bearer token was issued to, `auth/discord.ts`'s
  // `resolveBearer`, `GET /oauth2/@me`), `` `client:${client id}` `` on
  // the client lane (`auth/client.ts`'s `verifyClientRequest` -- the SAME
  // string `via` already carries there). Distinct from `via` (which stays
  // the literal `"discord"` on the user lane): this is what
  // `core/write.ts` folds onto every write's `source.client`.
  source_client: string;
  // LEDGER.md L4: the client-lane row's own `caps` string (e.g.
  // `"act-as-owner-only,feed:wait"`), verbatim -- undefined on the
  // Discord/bearer lane, which has no such row. `routes/changes.ts`'s
  // `wait=` gate reads this directly (`auth/client.ts`'s `hasCap`) rather
  // than re-querying `clients` a second time.
  client_caps?: string;
}

export type ActorVariables = { actor: Actor; sourceVersion: string | null };

// 20-spark.md S3s (LDB-P15): `X-Client-Version`, parsed ONCE here (not
// re-derived per write-pipeline call) and never allowed to influence
// `Actor`/`source_client` -- purely the client's own declared build
// string, stored as sent once validated. Absent header -> `null`;
// anything else that isn't <= 64 chars of `[A-Za-z0-9._+/:-]` (an empty
// string included) -> `400 invalid_client_version`.
const CLIENT_VERSION_RE = /^[A-Za-z0-9._+/:-]{1,64}$/;
export function parseClientVersion(raw: string | null): string | null {
  if (raw === null) return null;
  if (!CLIENT_VERSION_RE.test(raw)) throw invalidClientVersion(raw);
  return raw;
}

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
    const sourceVersion = parseClientVersion(c.req.header("X-Client-Version") ?? null);
    c.set("actor", actor);
    c.set("sourceVersion", sourceVersion);
    await next();
  };
}
