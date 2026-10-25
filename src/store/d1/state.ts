// D1 implementation of `StateStore` (src/store/port.ts): the `import_state`
// key/value rows. Implemented with the freeze (not left to agent A) because
// agents B and D read and write it too; the statements are today's, from
// core/clients.ts (suspend state) and dump/write.ts (dump state).
import type { StateStore } from "../port";

export function d1StateStore(db: D1Database): StateStore {
  return {
    async get(key) {
      const row = await db.prepare("SELECT value FROM import_state WHERE key = ?").bind(key).first<{ value: string }>();
      return row?.value ?? null;
    },
    async getMany(keys) {
      const out = new Map<string, string>();
      if (keys.length === 0) return out;
      const { results } = await db
        .prepare(`SELECT key, value FROM import_state WHERE key IN (${keys.map(() => "?").join(",")})`)
        .bind(...keys)
        .all<{ key: string; value: string }>();
      for (const r of results) out.set(r.key, r.value);
      return out;
    },
    async put(key, value) {
      await db
        .prepare("INSERT INTO import_state (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
        .bind(key, value)
        .run();
    },
    async delete(key) {
      await db.prepare("DELETE FROM import_state WHERE key = ?").bind(key).run();
    },
  };
}
