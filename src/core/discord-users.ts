// Discord names for WPM typists (docs/decisions/28-wpm-records.md,
// LDB-WPM18..LDB-WPM20). Every read and write of `discord_users` goes
// through `store.discordUsers` (store/d1/discord-users.ts); this file is the
// rules around it: validating a client-sent name, asking Discord for one
// with the akldb bot, and the admin backfill.
import { badRequest } from "./errors";
import type { DiscordProofAccess } from "./modqueue-proof";
import type { Clock } from "./time";
import { toStore, type StoreArg } from "../store/arg";

const MAX_USER_NAME_UNITS = 64;
const DELETED_USERNAME = /^deleted_user_[0-9a-f]+$/i;
export const NAME_FRESH_MS = 7 * 24 * 60 * 60 * 1000;
export const LOOKUP_TIMEOUT_MS = 3000;
export const REFRESH_DEFAULT_LIMIT = 50;
export const REFRESH_MAX_LIMIT = 50;
const REFRESH_CONCURRENCY = 5;

export interface DiscordLookup {
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

export interface DiscordUserNames { username: string; globalName: string | null }

function clip(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const v = value.trim();
  return v === "" ? null : v.slice(0, MAX_USER_NAME_UNITS);
}

// Asks Discord for a user with the akldb bot (`GET /users/{id}`). NEVER
// throws: a missing token, a timeout, a network error, a non-2xx answer or
// an unusable body is a logged warning and null (no secrets in the log).
export async function lookupDiscordUser(env: DiscordProofAccess, id: string, lookup: DiscordLookup = {}): Promise<DiscordUserNames | null> {
  if (!env.MODQUEUE_DISCORD_BOT_TOKEN) {
    console.warn("discord user lookup: the akldb bot token is not configured");
    return null;
  }
  const fetchImpl = lookup.fetchImpl ?? fetch;
  try {
    const signal = AbortSignal.timeout(lookup.timeoutMs ?? LOOKUP_TIMEOUT_MS);
    const response = await fetchImpl(`${env.DISCORD_API_URL.replace(/\/$/, "")}/v10/users/${id}`, {
      method: "GET", headers: { Authorization: `Bot ${env.MODQUEUE_DISCORD_BOT_TOKEN}`, "User-Agent": "akl-db/1.0" },
      redirect: "manual", signal,
    });
    if (!response.ok) {
      console.warn(`discord user lookup: Discord answered ${response.status}`);
      return null;
    }
    const body = (await response.json()) as Record<string, unknown> | null;
    const username = clip(body?.username);
    if (username === null) {
      console.warn("discord user lookup: the answer has no username");
      return null;
    }
    const globalName = clip(body?.global_name);
    // Discord's placeholder for a deleted account must never replace a real
    // name: treated as no answer, so a stored row stays as it was.
    if (DELETED_USERNAME.test(username) || globalName === "Deleted User") {
      console.warn("discord user lookup: the account is deleted");
      return null;
    }
    return { username, globalName };
  } catch (err) {
    console.warn(`discord user lookup failed (${err instanceof Error ? err.name : "error"})`);
    return null;
  }
}

// [LDB-WPM18] After a typist's own submit: look their name up with the bot
// unless a name is stored and fresh (looked up less than 7 days ago). Never
// throws, so it can run unawaited behind the response.
export async function ensureUserName(dbArg: StoreArg, now: Clock, env: DiscordProofAccess, userId: string, lookup?: DiscordLookup): Promise<void> {
  try {
    const known = await toStore(dbArg).discordUsers.get(userId);
    if (known !== null && Date.parse(now()) - Date.parse(known.updated_at) < NAME_FRESH_MS) return;
    await resolveAndStore(dbArg, now, env, userId, lookup);
  } catch (err) {
    console.warn(`discord user name refresh failed (${err instanceof Error ? err.name : "error"})`);
  }
}

// Resolves one user with the bot and stores the names. True when stored.
// Never throws (see `lookupDiscordUser`; a failed write is a warning too).
export async function resolveAndStore(dbArg: StoreArg, now: Clock, env: DiscordProofAccess, id: string, lookup?: DiscordLookup): Promise<boolean> {
  return storeResolved(dbArg, now, id, await lookupDiscordUser(env, id, lookup));
}

// The second half of `resolveAndStore`, for a caller that started the lookup
// earlier and ran it alongside other work.
export async function storeResolved(dbArg: StoreArg, now: Clock, id: string, names: DiscordUserNames | null): Promise<boolean> {
  if (names === null) return false;
  try {
    await toStore(dbArg).discordUsers.upsert({ id, username: names.username, globalName: names.globalName, at: now() });
    return true;
  } catch (err) {
    console.warn(`discord user save failed (${err instanceof Error ? err.name : "error"})`);
    return false;
  }
}

export interface RefreshResult { resolved: number; failed: number; remaining: number }

// [LDB-WPM20] POST /v1/admin/discord-users/refresh: resolves up to `limit`
// WPM typists that have no usable name. Idempotent: it only ever touches
// what is still missing, so a re-run continues where the last stopped (an id
// Discord cannot resolve stays missing and is counted in `remaining`).
export async function refreshMissingNames(dbArg: StoreArg, now: Clock, env: DiscordProofAccess, rawLimit: unknown, lookup?: DiscordLookup): Promise<RefreshResult> {
  const store = toStore(dbArg);
  let limit = REFRESH_DEFAULT_LIMIT;
  if (rawLimit !== undefined) {
    if (typeof rawLimit !== "number" || !Number.isInteger(rawLimit) || rawLimit < 1 || rawLimit > REFRESH_MAX_LIMIT) {
      throw badRequest(`'limit' must be an integer between 1 and ${REFRESH_MAX_LIMIT}`, "limit");
    }
    limit = rawLimit;
  }
  const { ids } = await store.discordUsers.missingWpmUsers(limit);
  let resolved = 0;
  for (let i = 0; i < ids.length; i += REFRESH_CONCURRENCY) {
    const results = await Promise.all(ids.slice(i, i + REFRESH_CONCURRENCY).map((id) => resolveAndStore(store, now, env, id, lookup)));
    resolved += results.filter(Boolean).length;
  }
  const remaining = ids.length === 0 ? 0 : (await store.discordUsers.missingWpmUsers(1)).total;
  return { resolved, failed: ids.length - resolved, remaining };
}
