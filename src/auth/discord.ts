// The user lane (09 §2.2): a Discord access token, verified with Discord,
// cached by hash. `resolveBearer` is the whole cache dance; `resolveActor`
// (09 §2.1) widens at 10 C1 into a two-lane dispatcher -- `Authorization`
// present -> this lane; else `X-Akl-Client` present -> the client lane
// (`./client.ts`); both -> 400; neither -> 401. `fetchImpl` is injected
// exactly as the import's is (`FetchImpl` from `import/upstream.ts`,
// reused) -- tests fake Discord with a plain function, never the network.
import type { HonoRequest } from "hono";
import type { Bindings } from "../env";
import { badRequest, identityUnavailable, tokenInvalid, unauthorized } from "../core/errors";
import type { Clock } from "../core/time";
import type { FetchImpl } from "../import/upstream";
import type { Actor } from "./actor";
import { type ClientDeps, verifyClientRequest } from "./client";

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
  ok: number;
  expires_at: string;
}

interface DiscordUser {
  id: string;
  username: string;
  global_name: string | null;
}

async function sha256Hex(input: string): Promise<string> {
  const bytes = new TextEncoder().encode(input);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function addSeconds(iso: string, seconds: number): string {
  return new Date(new Date(iso).getTime() + seconds * 1000).toISOString();
}

// One read per authenticated request (09 §2.2 step 3) -- never cached, so a
// promotion/demotion takes effect on the actor's very next request.
async function isAdmin(db: Bindings["DB"], userId: string): Promise<boolean> {
  const row = await db.prepare("SELECT 1 FROM admins WHERE user_id = ? LIMIT 1").bind(userId).first();
  return row !== null;
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
//  2. otherwise call Discord's /users/@me and cache the answer:
//     200 -> ok=1 for 5 min, plus an authors upsert in the same batch;
//     401 -> ok=0 for 60 s (name/user_id NULL);
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
    .prepare("SELECT user_id, name, ok, expires_at FROM auth_cache WHERE token_hash = ?")
    .bind(hash)
    .first<AuthCacheRow>();

  if (cached !== null && cached.expires_at > at) {
    if (cached.ok === 0) throw tokenInvalid();
    const admin = await isAdmin(db, cached.user_id!);
    return { user_id: cached.user_id!, name: cached.name!, via: "discord", admin };
  }

  let res: Response;
  try {
    res = await fetchImpl(`${discordApiUrl}/users/@me`, {
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
        `INSERT INTO auth_cache (token_hash, user_id, name, ok, expires_at) VALUES (?, NULL, NULL, 0, ?)
         ON CONFLICT(token_hash) DO UPDATE SET user_id = NULL, name = NULL, ok = 0, expires_at = excluded.expires_at`,
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

  let user: DiscordUser;
  try {
    const body = (await res.json()) as Partial<DiscordUser>;
    if (typeof body.id !== "string" || typeof body.username !== "string") {
      throw new Error("malformed /users/@me body");
    }
    user = { id: body.id, username: body.username, global_name: body.global_name ?? null };
  } catch {
    throw identityUnavailable();
  }

  const name = user.global_name ?? user.username;

  await db.batch([
    db
      .prepare(
        `INSERT INTO auth_cache (token_hash, user_id, name, ok, expires_at) VALUES (?, ?, ?, 1, ?)
         ON CONFLICT(token_hash) DO UPDATE SET user_id = excluded.user_id, name = excluded.name, ok = 1, expires_at = excluded.expires_at`,
      )
      .bind(hash, user.id, name, addSeconds(at, CACHE_OK_SECONDS)),
    db
      .prepare(
        `INSERT INTO authors (user_id, name, first_seen_at, last_seen_at) VALUES (?, ?, ?, ?)
         ON CONFLICT(user_id) DO UPDATE SET name = excluded.name, last_seen_at = excluded.last_seen_at`,
      )
      .bind(user.id, name, at, at),
  ]);

  const admin = await isAdmin(db, user.id);
  return { user_id: user.id, name, via: "discord", admin };
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
