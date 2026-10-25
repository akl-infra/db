// D1 implementation of `AdminStore` (src/store/port.ts). Owner: P1 agent B
// (design/p1-briefs.md). The SQL is today's, moved verbatim from
// core/{admins,moderation,clients}.ts.
import type { AdminRow } from "../../core/admins";
import type { ClientRow } from "../../core/clients";
import type { BanRow } from "../../core/moderation";
import type { AdminStore } from "../port";

interface BanDbRow {
  user_id: string;
  by: string;
  at: string;
  reason: string | null;
  name: string | null;
}

export function d1AdminStore(db: D1Database): AdminStore {
  return {
    async isAdmin(userId) {
      const row = await db.prepare("SELECT 1 FROM admins WHERE user_id = ? LIMIT 1").bind(userId).first();
      return row !== null;
    },
    async listAdmins() {
      const { results } = await db
        .prepare("SELECT user_id, added_by, added_at, note FROM admins ORDER BY added_at ASC, user_id ASC")
        .all<AdminRow>();
      return results;
    },
    async getAdmin(userId) {
      return await db.prepare("SELECT user_id, added_by, added_at, note FROM admins WHERE user_id = ?").bind(userId).first<AdminRow>();
    },
    async insertAdmin(row) {
      await db
        .prepare("INSERT INTO admins (user_id, added_by, added_at, note) VALUES (?, ?, ?, ?)")
        .bind(row.user_id, row.added_by, row.added_at, row.note)
        .run();
    },
    async removeAdmin(userId) {
      const result = await db
        .prepare("DELETE FROM admins WHERE user_id = ? AND (SELECT COUNT(*) FROM admins) > 2")
        .bind(userId)
        .run();
      if (result.meta.changes !== 0) return { removed: true };
      const stillThere = await db.prepare("SELECT 1 FROM admins WHERE user_id = ?").bind(userId).first();
      if (stillThere === null) return { removed: false, exists: false, count: 0 };
      const countRow = await db.prepare("SELECT COUNT(*) AS n FROM admins").first<{ n: number }>();
      return { removed: false, exists: true, count: countRow?.n ?? 2 };
    },
    async listBans() {
      const { results } = await db
        .prepare(
          `SELECT b.user_id AS user_id, b.by AS by, b.at AS at, b.reason AS reason, a.name AS name
       FROM bans b LEFT JOIN authors a ON a.user_id = b.user_id
       ORDER BY b.at ASC, b.user_id ASC`,
        )
        .all<BanDbRow>();
      return results satisfies BanRow[];
    },
    async banExists(userId) {
      return (await db.prepare("SELECT 1 FROM bans WHERE user_id = ?").bind(userId).first()) !== null;
    },
    async upsertBan(row) {
      await db
        .prepare(
          `INSERT INTO bans (user_id, by, at, reason) VALUES (?, ?, ?, ?)
       ON CONFLICT(user_id) DO UPDATE SET by = excluded.by, at = excluded.at, reason = excluded.reason`,
        )
        .bind(row.user_id, row.by, row.at, row.reason)
        .run();
    },
    async deleteBan(userId) {
      const result = await db.prepare("DELETE FROM bans WHERE user_id = ?").bind(userId).run();
      return result.meta.changes !== 0;
    },
    async setAuthorNameByAdmin(userId, name, at) {
      await db.prepare("UPDATE authors SET name = ?, name_source = 'admin', last_seen_at = ? WHERE user_id = ?").bind(name, at, userId).run();
    },
    async insertClient(row) {
      await db
        .prepare(
          `INSERT INTO clients (id, name, pubkey, owner_user_id, caps, discord_app_id, status, created_at, revoked_at)
       VALUES (?, ?, ?, ?, ?, ?, 'active', ?, NULL)`,
        )
        .bind(row.id, row.name, row.pubkey, row.owner_user_id, row.caps, row.discord_app_id, row.created_at)
        .run();
    },
    async clientStatus(id) {
      const row = await db
        .prepare("SELECT status, revoked_at FROM clients WHERE id = ?")
        .bind(id)
        .first<{ status: ClientRow["status"]; revoked_at: string | null }>();
      return row;
    },
    async revokeClient(id, at) {
      await db.prepare("UPDATE clients SET status = 'revoked', revoked_at = ? WHERE id = ?").bind(at, id).run();
    },
    async listClients() {
      const { results } = await db
        .prepare(
          "SELECT id, name, pubkey, owner_user_id, caps, discord_app_id, status, created_at, revoked_at FROM clients ORDER BY created_at ASC, id ASC",
        )
        .all<ClientRow>();
      return results;
    },
    async suspendClient(id, stateKey, stateValue) {
      await db.batch([
        db.prepare("UPDATE clients SET status = 'suspended' WHERE id = ?").bind(id),
        db
          .prepare("INSERT INTO import_state (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
          .bind(stateKey, stateValue),
      ]);
    },
    async reactivateClient(id, stateKey, budgetKey) {
      await db.batch([
        db.prepare("UPDATE clients SET status = 'active' WHERE id = ?").bind(id),
        db.prepare("DELETE FROM import_state WHERE key = ?").bind(stateKey),
        // A clean slate: without this, a client reactivated mid-window would
        // re-trip on its very next destructive write (core/clients.ts).
        db.prepare("DELETE FROM ratelimit WHERE key = ?").bind(budgetKey),
      ]);
    },
    async suspendedClients() {
      const { results } = await db.prepare("SELECT id, name FROM clients WHERE status = 'suspended' ORDER BY id ASC").all<{ id: string; name: string }>();
      return results;
    },
  };
}
