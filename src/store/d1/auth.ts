// D1 implementation of `AuthStore` (src/store/port.ts). Owner: P1 agent B
// (design/p1-briefs.md). The SQL is today's, moved verbatim from auth/*.ts
// and core/{ratelimit,idempotency}.ts.
import type { AuthCacheRow, AuthStore } from "../port";
import type { ClientRow } from "../../core/clients";
import type { IdempotencyRow } from "../../core/idempotency";

const CACHE_FAILURE_SQL = `INSERT INTO auth_cache (token_hash, user_id, name, app_id, ok, expires_at) VALUES (?, NULL, NULL, NULL, 0, ?)
         ON CONFLICT(token_hash) DO UPDATE SET user_id = NULL, name = NULL, app_id = NULL, ok = 0, expires_at = excluded.expires_at`;

// Mirrors the reservation status in core/idempotency.ts (PENDING_STATUS).
const PENDING_STATUS = 0;

export function d1AuthStore(db: D1Database): AuthStore {
  return {
    async client(id) {
      return await db
        .prepare("SELECT id, pubkey, owner_user_id, caps, status FROM clients WHERE id = ?")
        .bind(id)
        .first<Pick<ClientRow, "id" | "pubkey" | "owner_user_id" | "caps" | "status">>();
    },
    async insertNonce(clientId, nonce, at) {
      try {
        await db.prepare("INSERT INTO nonces (client_id, nonce, at) VALUES (?, ?, ?)").bind(clientId, nonce, at).run();
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        if (/UNIQUE constraint failed: nonces/.test(msg)) return false;
        throw e;
      }
      return true;
    },
    async pruneNonces(beforeIso) {
      await db.prepare("DELETE FROM nonces WHERE at < ?").bind(beforeIso).run();
    },
    async touchClientAuthor(userId, at, staleBefore) {
      const known = await db
        .prepare("SELECT name, last_seen_at FROM authors WHERE user_id = ?")
        .bind(userId)
        .first<{ name: string; last_seen_at: string | null }>();
      let name = known?.name;
      if (!known || known.last_seen_at === null || known.last_seen_at < staleBefore) {
        const authorRow = await db
          .prepare(
            `INSERT INTO authors (user_id, name, first_seen_at, last_seen_at, name_source) VALUES (?, ?, ?, ?, 'client')
         ON CONFLICT(user_id) DO UPDATE SET last_seen_at = excluded.last_seen_at
         WHERE authors.last_seen_at IS NULL OR authors.last_seen_at < ?
         RETURNING name`,
          )
          .bind(userId, userId, at, at, staleBefore)
          .first<{ name: string }>();
        name = authorRow?.name ?? name ?? (await db.prepare("SELECT name FROM authors WHERE user_id = ?").bind(userId).first<{ name: string }>())?.name;
      }
      return name ?? null;
    },
    async authCache(tokenHash) {
      return await db
        .prepare("SELECT user_id, name, app_id, ok, expires_at FROM auth_cache WHERE token_hash = ?")
        .bind(tokenHash)
        .first<AuthCacheRow>();
    },
    async cacheAuthFailure(tokenHash, expiresAt) {
      await db.prepare(CACHE_FAILURE_SQL).bind(tokenHash, expiresAt).run();
    },
    async cacheAuthSuccess(r) {
      await db.batch([
        db
          .prepare(
            `INSERT INTO auth_cache (token_hash, user_id, name, app_id, ok, expires_at) VALUES (?, ?, ?, ?, 1, ?)
         ON CONFLICT(token_hash) DO UPDATE SET user_id = excluded.user_id, name = excluded.name, app_id = excluded.app_id, ok = 1, expires_at = excluded.expires_at`,
          )
          .bind(r.tokenHash, r.userId, r.name, r.appId, r.expiresAt),
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
          .bind(r.userId, r.name, r.at, r.at),
        db.prepare("UPDATE authors SET last_seen_at = ? WHERE user_id = ? AND name_source = 'admin'").bind(r.at, r.userId),
      ]);
    },
    async pruneAuthCache(nowIso) {
      await db.prepare("DELETE FROM auth_cache WHERE expires_at < ?").bind(nowIso).run();
    },
    async rolesOf(userId) {
      const row = await db
        .prepare(
          `SELECT EXISTS(SELECT 1 FROM admins WHERE user_id = ?1) AS admin,
              EXISTS(SELECT 1 FROM bans WHERE user_id = ?1) AS banned`,
        )
        .bind(userId)
        .first<{ admin: number; banned: number }>();
      return { admin: row?.admin === 1, banned: row?.banned === 1 };
    },
    async authorName(userId) {
      const row = await db.prepare("SELECT name FROM authors WHERE user_id = ?").bind(userId).first<{ name: string }>();
      return row?.name ?? null;
    },
    async authors(order) {
      const sql = order === "name" ? "SELECT user_id, name FROM authors ORDER BY name" : "SELECT user_id, name FROM authors ORDER BY user_id";
      const { results } = await db.prepare(sql).all<{ user_id: string; name: string }>();
      return results;
    },
    async author(userId) {
      return await db.prepare("SELECT user_id, name FROM authors WHERE user_id = ?").bind(userId).first<{ user_id: string; name: string }>();
    },
    async hitWindow(key, windowStart) {
      const row = await db
        .prepare(
          `INSERT INTO ratelimit (key, window_start, n) VALUES (?1, ?2, 1)
       ON CONFLICT(key) DO UPDATE SET
         n = CASE WHEN window_start = excluded.window_start THEN n + 1 ELSE 1 END,
         window_start = excluded.window_start
       RETURNING n, window_start`,
        )
        .bind(key, windowStart)
        .first<{ n: number; window_start: number }>();
      if (row === null) throw new Error("ratelimit.take: upsert returned no row");
      return row;
    },
    async pruneRateLimits(beforeWindowStart) {
      await db.prepare("DELETE FROM ratelimit WHERE window_start < ?").bind(beforeWindowStart).run();
    },
    async getIdempotency(scope, key) {
      return await db.prepare("SELECT * FROM idempotency WHERE scope = ? AND key = ?").bind(scope, key).first<IdempotencyRow>();
    },
    async reserveIdempotency(row) {
      const result = await db
        .prepare(
          `INSERT INTO idempotency (scope, key, method, path, request_hash, status, response_body, at)
       VALUES (?, ?, ?, ?, ?, ${PENDING_STATUS}, '', ?)
       ON CONFLICT(scope, key) DO NOTHING`,
        )
        .bind(row.scope, row.key, row.method, row.path, row.request_hash, row.at)
        .run();
      return (result.meta.changes ?? 0) > 0;
    },
    async takeOverIdempotency(row) {
      const result = await db
        .prepare(
          `UPDATE idempotency SET method = ?, path = ?, request_hash = ?, status = ${PENDING_STATUS}, response_body = '', at = ?
       WHERE scope = ? AND key = ? AND at = ?`,
        )
        .bind(row.method, row.path, row.request_hash, row.at, row.scope, row.key, row.expectedAt)
        .run();
      return (result.meta.changes ?? 0) > 0;
    },
    async completeIdempotency(scope, key, status, responseBody, at) {
      await db
        .prepare("UPDATE idempotency SET status = ?, response_body = ?, at = ? WHERE scope = ? AND key = ?")
        .bind(status, responseBody, at, scope, key)
        .run();
    },
    async deleteIdempotency(scope, key) {
      await db.prepare("DELETE FROM idempotency WHERE scope = ? AND key = ?").bind(scope, key).run();
    },
    async pruneIdempotency(beforeIso) {
      await db.prepare("DELETE FROM idempotency WHERE at < ?").bind(beforeIso).run();
    },
  };
}
