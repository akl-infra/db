// D1 implementation of `DiscordUserStore` (src/store/port.ts): the ONLY file
// that reads or writes `discord_users` (migrations/0036). The AWS port
// re-implements exactly this module. The name-resolution fragment that
// the WPM reads join in lives here too, so the precedence (authors.name,
// then global_name, then username) is defined once.
import type { DiscordUserStore } from "../port";

/** `LEFT JOIN` for a query that resolves a typist's name; alias `du`. */
export function discordUserJoin(userIdColumn: string): string {
  return `LEFT JOIN discord_users du ON du.id = ${userIdColumn}`;
}

/**
 * The resolved display name [LDB-WPM18]: `authors.name` when it is non-blank
 * and not the user id itself, else the Discord global name, else the
 * username, else NULL. `authorName` is the joined authors column.
 */
export function resolvedNameSql(authorName: string, userIdColumn: string): string {
  return `CASE WHEN ${authorName} IS NOT NULL AND TRIM(${authorName}) <> '' AND ${authorName} <> ${userIdColumn} THEN ${authorName}
       ELSE COALESCE(NULLIF(TRIM(du.global_name), ''), NULLIF(TRIM(du.username), '')) END`;
}

export function d1DiscordUserStore(db: D1Database): DiscordUserStore {
  return {
    async upsert(r) {
      // `updated_at` always moves (freshness); the head version moves via
      // the migration's trigger only when a name really changes.
      await db
        .prepare(`INSERT INTO discord_users (id, username, global_name, updated_at) VALUES (?1, ?2, ?3, ?4)
    ON CONFLICT (id) DO UPDATE SET username = excluded.username, global_name = excluded.global_name, updated_at = excluded.updated_at`)
        .bind(r.id, r.username, r.globalName, r.at)
        .run();
    },
    async get(id) {
      return db.prepare("SELECT id, username, global_name, updated_at FROM discord_users WHERE id = ?").bind(id).first();
    },
    async version() {
      const row = await db.prepare("SELECT version FROM discord_users_head WHERE id = 1").first<{ version: number }>();
      return row?.version ?? 0;
    },
    async missingWpmUsers(limit) {
      // Every typist with a pending, approved or rejected submission and no
      // usable name: no discord_users row, and authors.name missing, blank
      // or equal to the id.
      const where = `s.status IN ('pending', 'approved', 'rejected') AND du.id IS NULL
         AND (a.name IS NULL OR TRIM(a.name) = '' OR a.name = s.user_id)`;
      const from = `FROM wpm_submissions s
         LEFT JOIN authors a ON a.user_id = s.user_id
         LEFT JOIN discord_users du ON du.id = s.user_id`;
      const [ids, total] = await Promise.all([
        db.prepare(`SELECT DISTINCT s.user_id AS user_id ${from} WHERE ${where} ORDER BY s.user_id LIMIT ?`).bind(limit).all<{ user_id: string }>(),
        db.prepare(`SELECT COUNT(DISTINCT s.user_id) AS n ${from} WHERE ${where}`).first<{ n: number }>(),
      ]);
      return { ids: ids.results.map((r) => r.user_id), total: total?.n ?? 0 };
    },
  };
}
