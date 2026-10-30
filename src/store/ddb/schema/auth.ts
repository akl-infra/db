// Lane I's slice of the item model (src/store/ddb/contracts.ts `LaneSchema`,
// design/p2-p5-briefs.md): rows of these tables <-> their DynamoDB items.
//
//   authors          AUTHORS/<user_id>
//   authors_head     META/AUTHORS           version, modified_at, count
//   discord_users    DUSERS/<id>            id, username, global_name, updated_at
//   discord_users_head META/DISCORD_USERS   version
//   admins           ADMINS/<user_id>       + META/ADMINS.count (derived)
//   bans             BANS/<user_id>
//   clients          CLIENTS/<id>
//   nonces           N#<client>/<nonce>     ephemeral, ttl = at + 900 s
//   auth_cache       AC#<token_hash>/AC     ephemeral, ttl = expires_at
//   ratelimit        RL#<key>/<window>      ephemeral, one item per window
//   idempotency      IDEM#<scope>/<key>     ephemeral, ttl = at + 25 h
//
// `META/ADMINS.count` follows the admins rows: a harness that inserts admins
// in several calls must ADD to it, not Put it whole (`adminsCountItem`).
// An idempotency body over SPILL_BYTES is stored gzip-compressed as
// `response_gz` by the store; `toItems` refuses one (none exists in a
// production export) and `fromItems` needs `inlineIdempotencyBodies` first.
import type { D1Row, D1TableName, Item, LaneSchema, RowsByTable } from "../contracts";
import {
  ADMINS_HEAD_KEY,
  adminKey,
  authCacheKey,
  authorKey,
  AUTHORS_HEAD_KEY,
  DISCORD_USERS_HEAD_KEY,
  DISCORD_USERS_PK,
  discordUserKey,
  banKey,
  clientKey,
  epochSeconds,
  idempotencyKey,
  IDEMPOTENCY_TTL_SECONDS,
  NONCE_TTL_SECONDS,
  nonceKey,
  rateLimitKey,
  RATELIMIT_TTL_SECONDS,
  ttlFor,
} from "../keys-auth";
import { byteLength, SPILL_BYTES } from "../payload";

const AUTHOR_COLUMNS = ["user_id", "name", "first_seen_at", "last_seen_at", "name_source"] as const;
const DISCORD_USER_COLUMNS = ["id", "username", "global_name", "updated_at"] as const;
const ADMIN_COLUMNS = ["user_id", "added_by", "added_at", "note"] as const;
const BAN_COLUMNS = ["user_id", "by", "at", "reason"] as const;
const CLIENT_COLUMNS = ["id", "name", "pubkey", "owner_user_id", "caps", "discord_app_id", "status", "created_at", "revoked_at"] as const;
const AUTH_CACHE_COLUMNS = ["token_hash", "user_id", "name", "app_id", "ok", "expires_at"] as const;
const IDEMPOTENCY_COLUMNS = ["scope", "key", "method", "path", "request_hash", "status", "at"] as const;

function pick(row: D1Row, cols: readonly string[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const c of cols) out[c] = row[c] === undefined ? null : row[c];
  return out;
}

function withTtl(item: Item, ttl: number | null): Item {
  return ttl === null ? item : { ...item, ttl };
}

export const authorItem = (row: D1Row): Item => ({ ...authorKey(row.user_id as string), ...pick(row, AUTHOR_COLUMNS) });
export const adminItem = (row: D1Row): Item => ({ ...adminKey(row.user_id as string), ...pick(row, ADMIN_COLUMNS) });
export const banItem = (row: D1Row): Item => ({ ...banKey(row.user_id as string), ...pick(row, BAN_COLUMNS) });
export const clientItem = (row: D1Row): Item => ({ ...clientKey(row.id as string), ...pick(row, CLIENT_COLUMNS) });

export function nonceItem(row: D1Row): Item {
  const at = row.at as string;
  const t = epochSeconds(at);
  return withTtl({ ...nonceKey(row.client_id as string, row.nonce as string), client_id: row.client_id, nonce: row.nonce, at }, ttlFor(t === null ? null : t + NONCE_TTL_SECONDS));
}

export function authCacheItem(row: D1Row): Item {
  const t = epochSeconds(row.expires_at as string);
  return withTtl({ ...authCacheKey(row.token_hash as string), ...pick(row, AUTH_CACHE_COLUMNS) }, ttlFor(t));
}

export function rateLimitItem(row: D1Row): Item {
  const ws = row.window_start as number;
  // Key and window live only in pk/sk (fromItems derives them), so the writers that ADD to a window -- hitWindow, lane G's destructive budget -- and this codec agree byte for byte.
  return {
    ...rateLimitKey(row.key as string, ws),
    n: row.n,
    ttl: ttlFor(ws + RATELIMIT_TTL_SECONDS),
  };
}

/** The idempotency item; `gz` (the compressed body) replaces `response_body` for a big one. */
export function idempotencyItem(row: D1Row, gz?: Uint8Array): Item {
  const t = epochSeconds(row.at as string);
  const base: Item = { ...idempotencyKey(row.scope as string, row.key as string), ...pick(row, IDEMPOTENCY_COLUMNS) };
  if (gz !== undefined) base.response_gz = gz;
  else base.response_body = row.response_body;
  return withTtl(base, ttlFor(t === null ? null : t + IDEMPOTENCY_TTL_SECONDS));
}

export function adminsCountItem(count: number): Item {
  return { ...ADMINS_HEAD_KEY, count };
}

export async function gzipText(text: string): Promise<Uint8Array> {
  const cs = new CompressionStream("gzip");
  const w = cs.writable.getWriter();
  void w.write(new TextEncoder().encode(text));
  void w.close();
  return new Uint8Array(await new Response(cs.readable).arrayBuffer());
}

export async function gunzipText(bytes: Uint8Array): Promise<string> {
  const ds = new DecompressionStream("gzip");
  const w = ds.writable.getWriter();
  void w.write(bytes);
  void w.close();
  return await new Response(ds.readable).text();
}

/** Puts compressed idempotency bodies back inline (the `inlinePayloads` of this lane). Returns new items. */
export async function inlineIdempotencyBodies(items: readonly Item[]): Promise<Item[]> {
  const out: Item[] = [];
  for (const it of items) {
    if (typeof it.pk === "string" && it.pk.startsWith("IDEM#") && it.response_gz !== undefined) {
      const { response_gz, ...rest } = it;
      out.push({ ...rest, response_body: await gunzipText(response_gz as Uint8Array) });
    } else out.push(it);
  }
  return out;
}

function toItems(rows: RowsByTable): { main: Item[]; ephemeral: Item[] } {
  const main: Item[] = [];
  const ephemeral: Item[] = [];
  for (const r of rows.authors ?? []) main.push(authorItem(r));
  for (const r of rows.authors_head ?? []) {
    main.push({ ...AUTHORS_HEAD_KEY, version: r.version, modified_at: r.modified_at ?? null, count: r.count ?? 0 });
  }
  for (const r of rows.discord_users ?? []) main.push({ ...discordUserKey(r.id as string), ...pick(r, DISCORD_USER_COLUMNS) });
  for (const r of rows.discord_users_head ?? []) main.push({ ...DISCORD_USERS_HEAD_KEY, version: r.version });
  if (rows.admins !== undefined) {
    for (const r of rows.admins) main.push(adminItem(r));
    main.push(adminsCountItem(rows.admins.length));
  }
  for (const r of rows.bans ?? []) main.push(banItem(r));
  for (const r of rows.clients ?? []) main.push(clientItem(r));
  for (const r of rows.nonces ?? []) ephemeral.push(nonceItem(r));
  for (const r of rows.auth_cache ?? []) ephemeral.push(authCacheItem(r));
  for (const r of rows.ratelimit ?? []) ephemeral.push(rateLimitItem(r));
  for (const r of rows.idempotency ?? []) {
    if (byteLength(r.response_body as string) > SPILL_BYTES) {
      throw new Error(`idempotency ${String(r.scope)}/${String(r.key)}: body over ${SPILL_BYTES} bytes (the codec holds bodies inline; none exists in a production export)`);
    }
    ephemeral.push(idempotencyItem(r));
  }
  return { main, ephemeral };
}

function tableOf(item: Item): D1TableName | null {
  const pk = item.pk as string;
  const sk = item.sk as string;
  if (pk === "AUTHORS") return "authors";
  if (pk === "META" && sk === "AUTHORS") return "authors_head";
  if (pk === DISCORD_USERS_PK) return "discord_users";
  if (pk === "META" && sk === "DISCORD_USERS") return "discord_users_head";
  if (pk === "ADMINS" || (pk === "META" && sk === "ADMINS")) return "admins";
  if (pk === "BANS") return "bans";
  if (pk === "CLIENTS") return "clients";
  if (pk.startsWith("N#")) return "nonces";
  if (pk.startsWith("AC#")) return "auth_cache";
  if (pk.startsWith("RL#") && pk !== "RL#holds") return "ratelimit";
  if (pk.startsWith("IDEM#")) return "idempotency";
  return null;
}

export const authSchema: LaneSchema = {
  lane: "I",
  tables: ["authors", "authors_head", "discord_users", "discord_users_head", "admins", "bans", "clients", "nonces", "auth_cache", "ratelimit", "idempotency"],
  toItems,
  tableOf,
  fromItems({ main, ephemeral }) {
    // A key's row is its newest window, as in D1 (one row per key); older windows are garbage awaiting TTL (`supersededWindows`).
    const newest = new Map<string, D1Row>();
    const out: RowsByTable = {
      authors: [], authors_head: [], discord_users: [], discord_users_head: [], admins: [], bans: [], clients: [], nonces: [], auth_cache: [], ratelimit: [], idempotency: [],
    };
    for (const it of main) {
      const pk = it.pk as string;
      const sk = it.sk as string;
      if (pk === "AUTHORS") out.authors!.push(pick(it, AUTHOR_COLUMNS));
      else if (pk === "META" && sk === "AUTHORS") out.authors_head!.push({ id: 1, version: it.version ?? 0, modified_at: it.modified_at ?? null, count: it.count ?? 0 });
      else if (pk === DISCORD_USERS_PK) out.discord_users!.push(pick(it, DISCORD_USER_COLUMNS));
      else if (pk === "META" && sk === "DISCORD_USERS") out.discord_users_head!.push({ id: 1, version: it.version ?? 0 });
      else if (pk === "ADMINS") out.admins!.push(pick(it, ADMIN_COLUMNS));
      else if (pk === "BANS") out.bans!.push(pick(it, BAN_COLUMNS));
      else if (pk === "CLIENTS") out.clients!.push(pick(it, CLIENT_COLUMNS));
    }
    for (const it of ephemeral) {
      const pk = it.pk as string;
      if (pk.startsWith("N#")) out.nonces!.push({ client_id: it.client_id, nonce: it.nonce, at: it.at });
      else if (pk.startsWith("AC#")) out.auth_cache!.push(pick(it, AUTH_CACHE_COLUMNS));
      else if (pk.startsWith("RL#") && pk !== "RL#holds") {
        const key = pk.slice(3);
        const window_start = Number(it.sk);
        const cur = newest.get(key);
        if (cur === undefined || (cur.window_start as number) < window_start) newest.set(key, { key, window_start, n: it.n });
      } else if (pk.startsWith("IDEM#")) {
        if (it.response_gz !== undefined) throw new Error(`${pk}/${String(it.sk)} has an unresolved response_gz (inlineIdempotencyBodies first)`);
        out.idempotency!.push({ ...pick(it, IDEMPOTENCY_COLUMNS), response_body: it.response_body });
      }
    }
    out.ratelimit!.push(...newest.values());
    return out;
  },
};

/** Rate-limit items that a newer window of the same key has superseded: not row state (D1 keeps one row per key), only garbage awaiting TTL. */
export function supersededWindows(items: readonly Item[]): Set<Item> {
  const newest = new Map<string, number>();
  const rl = items.filter((i) => (i.pk as string).startsWith("RL#") && i.pk !== "RL#holds");
  for (const i of rl) newest.set(i.pk as string, Math.max(newest.get(i.pk as string) ?? -Infinity, Number(i.sk)));
  return new Set(rl.filter((i) => Number(i.sk) < newest.get(i.pk as string)!));
}
