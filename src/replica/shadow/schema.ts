// The shadow-only schema (migrations-shadow/, never migrations/): applied through the commit log like any migration, under
// a `shadow-` name so it cannot collide with a main migration in d1_migrations.
import fs from "node:fs";
import path from "node:path";
import type { Replica } from "../replica";
import { sqlTimestamp } from "../migrations";

/** Applies every pending file of `dir`; returns the names it applied. */
export async function applyShadowMigrations(replica: Replica, dir: string, now: () => Date = () => new Date()): Promise<string[]> {
  const applied: string[] = [];
  await replica.catchUp();
  const files = fs.readdirSync(dir).filter((f) => f.endsWith(".sql")).sort();
  for (const f of files) {
    const name = `shadow-${f}`;
    const sql = fs.readFileSync(path.join(dir, f), "utf8");
    if ((await replica.applyMigration({ name, sql, at: sqlTimestamp(now()) })) === "applied") applied.push(name);
  }
  return applied;
}

/** `migrations-shadow/` beside the bundle in the zip (deploy-aws.sh ships it in the shadow stage only), unless SHADOW_MIGRATIONS_DIR says otherwise. */
export function defaultShadowMigrationsDir(env: Record<string, string | undefined>): string {
  return env.SHADOW_MIGRATIONS_DIR ?? path.join(env.LAMBDA_TASK_ROOT ?? process.cwd(), "migrations-shadow");
}
