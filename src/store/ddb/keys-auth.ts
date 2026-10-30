// Lane I's key builders (design/aws-port.md §2.3), inside its own pk
// prefixes: AUTHORS, ADMINS, BANS, CLIENTS, IDEM#, and the ephemeral N#, AC#,
// RL#. (HOLD# and `RL#holds` belong to lane G; `RL#client:...#destructive`
// is written by G's commitWrite on the shape `rateLimitKey` builds.)
import type { Key } from "./keys";

/** A nonce only has to outlive the 900 s signature skew window. */
export const NONCE_TTL_SECONDS = 900;
/** Idempotency rows expire for the code at 24 h; TTL only collects them an hour later. */
export const IDEMPOTENCY_TTL_SECONDS = 25 * 60 * 60;
/** A rate-limit window item is garbage two hours after its window began. */
export const RATELIMIT_TTL_SECONDS = 2 * 60 * 60;

export const AUTHORS_PK = "AUTHORS";
export const ADMINS_PK = "ADMINS";
export const BANS_PK = "BANS";
export const CLIENTS_PK = "CLIENTS";

/** `META/AUTHORS`: `version`, `modified_at`, `count` (authors_head and its three triggers, R4). */
export const AUTHORS_HEAD_KEY: Key = { pk: "META", sk: "AUTHORS" };
/** `META/ADMINS`: `count` (the `> 2` guard of removeAdmin, R4). */
export const ADMINS_HEAD_KEY: Key = { pk: "META", sk: "ADMINS" };

/** `DUSERS/<discord id>`: one `discord_users` row (migrations/0036), all four columns flat. */
export const DISCORD_USERS_PK = "DUSERS";
/** `META/DISCORD_USERS`: `version` (`discord_users_head` and its two triggers, migrations/0036); bumped in the same transaction as the row. */
export const DISCORD_USERS_HEAD_KEY: Key = { pk: "META", sk: "DISCORD_USERS" };
export const discordUserKey = (id: string): Key => ({ pk: DISCORD_USERS_PK, sk: id });

export const authorKey = (userId: string): Key => ({ pk: AUTHORS_PK, sk: userId });
export const adminKey = (userId: string): Key => ({ pk: ADMINS_PK, sk: userId });
export const banKey = (userId: string): Key => ({ pk: BANS_PK, sk: userId });
export const clientKey = (id: string): Key => ({ pk: CLIENTS_PK, sk: id });

// Ephemeral table.
export const nonceKey = (clientId: string, nonce: string): Key => ({ pk: `N#${clientId}`, sk: nonce });
export const authCacheKey = (tokenHash: string): Key => ({ pk: `AC#${tokenHash}`, sk: "AC" });
/** The partition of one rate-limit key; its items are one per window. */
export const rateLimitPk = (key: string): string => `RL#${key}`;
/** `sk` is the window start, unpadded (lane G's budget increments use the same shape). */
export const rateLimitKey = (key: string, windowStart: number): Key => ({ pk: rateLimitPk(key), sk: String(windowStart) });
export const idempotencyKey = (scope: string, key: string): Key => ({ pk: `IDEM#${scope}`, sk: key });

/** Epoch seconds of an ISO timestamp, or null if it does not parse. */
export function epochSeconds(iso: string): number | null {
  const ms = Date.parse(iso);
  return Number.isNaN(ms) ? null : Math.floor(ms / 1000);
}

/** The `ttl` attribute: the true expiry epoch, or null if the timestamp does not parse. TTL only collects; readers compare it themselves. */
export function ttlFor(logicalSeconds: number | null): number | null {
  return logicalSeconds;
}
