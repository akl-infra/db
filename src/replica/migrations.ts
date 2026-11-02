// Migrations travel as log entries (SH10): each pending `migrations/*.sql`
// file, in filename order, is appended through the same conditional append as
// a unit, so every replica replays it. The files stay plain D1 SQL.
import fs from "node:fs";
import path from "node:path";
import type { Replica } from "./replica";

/** `YYYY-MM-DD HH:MM:SS` UTC, the shape CURRENT_TIMESTAMP (and so wrangler's d1_migrations) uses. */
export function sqlTimestamp(d: Date): string {
  return d.toISOString().slice(0, 19).replace("T", " ");
}

export interface MigrationFile {
  name: string;
  sql: string;
}

export function readMigrationFiles(dir: string): MigrationFile[] {
  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith(".sql"))
    .sort()
    .map((name) => ({ name, sql: fs.readFileSync(path.join(dir, name), "utf8") }));
}

/** Append every migration the log does not have yet. Returns the names this call applied. */
export async function applyMigrations(replica: Replica, dir: string, now: () => Date = () => new Date()): Promise<string[]> {
  const applied: string[] = [];
  await replica.catchUp();
  for (const m of readMigrationFiles(dir)) {
    if ((await replica.applyMigration({ name: m.name, sql: m.sql, at: sqlTimestamp(now()) })) === "applied") applied.push(m.name);
  }
  return applied;
}
