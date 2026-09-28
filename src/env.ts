// The Worker's bindings and vars, as declared in wrangler.toml. Every key
// here must have a row in README.md's secrets/bindings table (LDB-G4).
export interface Bindings {
  DB: D1Database;
  DUMPS: R2Bucket;
  DISCORD_API_URL: string; // e.g. https://discord.com/api -- src/auth/discord.ts (09 §3 T1)
  // Mod-queue Discord notify (LDB-MD12, src/core/modqueue.ts): a Discord
  // incoming-webhook URL. Unset or empty => the whole feature is a no-op
  // (no fetch, no `notified_at` write) -- never set locally, `wrangler
  // secret put MODQUEUE_DISCORD_WEBHOOK` in production.
  MODQUEUE_DISCORD_WEBHOOK?: string;
}
