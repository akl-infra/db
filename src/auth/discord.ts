// The user lane (09 §2.2): a Discord access token, verified with Discord,
// cached by hash. `resolveBearer` is the whole cache dance; `resolveActor`
// (09 §2.1) widens at 10 C1 into a two-lane dispatcher -- `Authorization`
// present -> this lane; else `X-Akl-Client` present -> the client lane
// (`./client.ts`); both -> 400; neither -> 401. `fetchImpl` is injected
// (`FetchImpl`, `core/fetch.ts`) -- tests fake Discord with a plain
// function, never the network.
import type { HonoRequest } from "hono";
import type { Bindings } from "../env";
import { badRequest, identityUnavailable, tokenInvalid, unauthorized } from "../core/errors";
import type { FetchImpl } from "../core/fetch";
import type { Clock } from "../core/time";
import type { Actor } from "./actor";
import { type ClientDeps, verifyClientRequest } from "./client";
import { roleOf } from "./roles";

export interface AuthDeps extends ClientDeps {
  fetchImpl: FetchImpl;
  now: Clock;
}

const CACHE_OK_SECONDS = 300;
const CACHE_FAIL_SECONDS = 60;
const DISCORD_TIMEOUT_MS = 5000;
const USER_AGENT = "akl-db/1.0";

interface AuthCacheRow {
  user_id: string | null;
  name: string | null;
  app_id: string | null;
  ok: number;
  expires_at: string;
}

// saltorbit/aklgg#352: `username` is Discord's stable, unique handle --
// the only field stored as an author's name. `global_name` (a changeable
// display name/nickname) is deliberately never read or kept here.
interface DiscordUser {
  id: string;
  username: string;
}

// 20-spark.md S3s (decision 14): `GET /oauth2/@me`'s body -- "the same
// user object plus the application the token was issued to" (saltorbit). Its
// `user` key is present only when the token's grant includes the
// `identify` scope; every other scope shape (an application-only token,
// or one with narrower scopes) answers 200 with `application` alone.
interface OAuth2Me {
  application: { id: string };
  user?: DiscordUser;
}

async function sha256Hex(input: string): Promise<string> {
  const bytes = new TextEncoder().encode(input);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function addSeconds(iso: string, seconds: number): string {
  return new Date(new Date(iso).getTime() + seconds * 1000).toISOString();
}

// Nightly (`0 3 * * *`, wired into src/index.ts's `scheduled()`): drop
// expired cache rows. Housekeeping, not a security boundary -- a token is
// never stored, so an expired row holds nothing sensitive.
export async function pruneAuthCache(db: Bindings["DB"], now: Clock): Promise<void> {
  await db.prepare("DELETE FROM auth_cache WHERE expires_at < ?").bind(now()).run();
}

// The §2.2 cache dance, step by step:
//  1. hash the token, look up auth_cache; a live row answers with no
//     Discord call at all (success or cached-401 alike).
//     20-spark.md S3s: a cached FAILURE (ok=0) is trusted regardless of
//     `app_id` -- Discord never hands one back on a 401, so a failure row
//     never carries it, cached-before-or-after-0005 alike. A cached
//     SUCCESS row with `app_id IS NULL` (written before 0005 -- the
//     column didn't exist) is treated as a MISS: this service can't yet
//     answer `Actor.source_client` from it, so it re-verifies with
//     Discord and re-caches with `app_id` this time, same cost as a cold
//     cache.
//  2. otherwise call Discord's `GET /oauth2/@me` (saltorbit, 2026-09-10: "the
//     same user object plus the application the token was issued to", at
//     the same cost as `/users/@me`) and cache the answer:
//     200 with a `user` key -> ok=1 for 5 min, `app_id` from
//       `application.id`, plus an authors upsert in the same batch;
//     200 with NO `user` key (the grant lacks the `identify` scope) ->
//       treated exactly like a 401: ok=0 for 60s, `token_invalid` (with a
//       message naming the missing scope);
//     401 -> ok=0 for 60 s (name/user_id/app_id NULL);
//     anything else (429/5xx/malformed/network/timeout) -> 503, nothing
//     cached, Discord's Retry-After copied through when it sent one.
export async function resolveBearer(
  db: Bindings["DB"],
  now: Clock,
  token: string,
  fetchImpl: FetchImpl,
  discordApiUrl: string,
): Promise<Actor> {
  const at = now();
  const hash = await sha256Hex(token);

  const cached = await db
    .prepare("SELECT user_id, name, app_id, ok, expires_at FROM auth_cache WHERE token_hash = ?")
    .bind(hash)
    .first<AuthCacheRow>();

  if (cached !== null && cached.expires_at > at) {
    if (cached.ok === 0) throw tokenInvalid();
    if (cached.app_id !== null) {
      const roles = await roleOf(db, cached.user_id!);
      return { user_id: cached.user_id!, name: cached.name!, via: "discord", ...roles, source_client: `discord-app:${cached.app_id}` };
    }
    // else: LDB-A2 amended -- fall through to a fresh Discord call, same
    // as a cold/expired cache row.
  }

  let res: Response;
  try {
    res = await fetchImpl(`${discordApiUrl}/oauth2/@me`, {
      headers: { Authorization: `Bearer ${token}`, "User-Agent": USER_AGENT },
      signal: AbortSignal.timeout(DISCORD_TIMEOUT_MS),
    });
  } catch {
    // network error, thrown fetch, or the timeout's own abort -- all the
    // same "we could not ask Discord" outcome, never cached.
    throw identityUnavailable();
  }

  if (res.status === 401) {
    await db
      .prepare(
        `INSERT INTO auth_cache (token_hash, user_id, name, app_id, ok, expires_at) VALUES (?, NULL, NULL, NULL, 0, ?)
         ON CONFLICT(token_hash) DO UPDATE SET user_id = NULL, name = NULL, app_id = NULL, ok = 0, expires_at = excluded.expires_at`,
      )
      .bind(hash, addSeconds(at, CACHE_FAIL_SECONDS))
      .run();
    throw tokenInvalid();
  }

  if (res.status !== 200) {
    // 429, 5xx, or anything else Discord might answer with that isn't a
    // clean 200/401 -- identity_unavailable, Retry-After passed through.
    throw identityUnavailable(res.headers.get("Retry-After") ?? undefined);
  }

  let body: Partial<OAuth2Me>;
  try {
    const parsed = (await res.json()) as Partial<OAuth2Me>;
    if (typeof parsed.application?.id !== "string") {
      throw new Error("malformed /oauth2/@me body");
    }
    body = parsed;
  } catch {
    throw identityUnavailable();
  }
  const appId = body.application!.id;

  if (body.user === undefined) {
    // 20-spark.md S3s: authenticates, but the grant never included
    // `identify` -- cached as a failure exactly like a real 401 (no
    // `app_id`: this failure is never resolved to a known application on
    // a later cache hit, same as a plain invalid token).
    await db
      .prepare(
        `INSERT INTO auth_cache (token_hash, user_id, name, app_id, ok, expires_at) VALUES (?, NULL, NULL, NULL, 0, ?)
         ON CONFLICT(token_hash) DO UPDATE SET user_id = NULL, name = NULL, app_id = NULL, ok = 0, expires_at = excluded.expires_at`,
      )
      .bind(hash, addSeconds(at, CACHE_FAIL_SECONDS))
      .run();
    throw tokenInvalid("the token is valid but was not granted the 'identify' scope");
  }

  const rawUser = body.user;
  if (typeof rawUser.id !== "string" || typeof rawUser.username !== "string") {
    throw identityUnavailable();
  }
  const user: DiscordUser = { id: rawUser.id, username: rawUser.username };

  const name = user.username;

  await db.batch([
    db
      .prepare(
        `INSERT INTO auth_cache (token_hash, user_id, name, app_id, ok, expires_at) VALUES (?, ?, ?, ?, 1, ?)
         ON CONFLICT(token_hash) DO UPDATE SET user_id = excluded.user_id, name = excluded.name, app_id = excluded.app_id, ok = 1, expires_at = excluded.expires_at`,
      )
      .bind(hash, user.id, name, appId, addSeconds(at, CACHE_OK_SECONDS)),
    db
      .prepare(
        // LDB-I17 (historical -- the cmini importer this row's `name_source`
        // vocabulary predates is gone): the user lane always sets its own
        // name and marks it `name_source = 'user'`. §4.3 (LDB-MD4): an `admin`
        // override is STICKIER than that -- this WHERE guard is what keeps
        // an admin-set name from being overwritten by the very next
        // sign-in. `last_seen_at` still needs to move on every sign-in
        // regardless (bookkeeping, LDB-R11), so the second statement below
        // moves it on exactly the rows this one's WHERE clause skipped.
        `INSERT INTO authors (user_id, name, first_seen_at, last_seen_at, name_source) VALUES (?, ?, ?, ?, 'user')
         ON CONFLICT(user_id) DO UPDATE SET name = excluded.name, name_source = 'user', last_seen_at = excluded.last_seen_at
         WHERE authors.name_source <> 'admin'`,
      )
      .bind(user.id, name, at, at),
    db
      .prepare("UPDATE authors SET last_seen_at = ? WHERE user_id = ? AND name_source = 'admin'")
      .bind(at, user.id),
  ]);

  const roles = await roleOf(db, user.id);
  return { user_id: user.id, name, via: "discord", ...roles, source_client: `discord-app:${appId}` };
}

// The two-lane dispatcher (09 §2.1; 10 C1 §1 D9: on any route, not just
// writes -- so `GET /v1/me` on the client lane answers `via: client:<id>`
// too). `Authorization` present -> resolveBearer; else `X-Akl-Client`
// present -> the client lane; both -> 400 (one lane per request); neither
// -> 401 with the same `WWW-Authenticate` hint either lane's own failure
// would carry.
export async function resolveActor(env: Bindings, req: HonoRequest, deps: AuthDeps): Promise<Actor> {
  const header = req.header("Authorization");
  const clientId = req.header("X-Akl-Client");

  if (header !== undefined && clientId !== undefined) {
    throw badRequest("use one lane per request", "Authorization");
  }

  if (header !== undefined) {
    const match = /^Bearer\s+(.+)$/.exec(header);
    if (match === null) throw unauthorized();
    return resolveBearer(env.DB, deps.now, match[1]!, deps.fetchImpl, env.DISCORD_API_URL);
  }

  if (clientId !== undefined) {
    // Read ONCE through Hono's cache (see requireActorOnWrites's comment) so
    // a route handler's later `c.req.json()` still sees the same bytes.
    const bodyBytes = new Uint8Array(await req.arrayBuffer());
    return verifyClientRequest(env.DB, deps.now, req.raw, bodyBytes, deps);
  }

  throw unauthorized();
}
