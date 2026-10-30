// The Worker's bindings and vars, as declared in wrangler.toml. Every key
// here must have a row in README.md's secrets/bindings table (LDB-G4).
export interface Bindings {
  DB: D1Database;
  DUMPS: R2Bucket;
  // Long-poll hold budget, hold-seconds per UTC day (src/core/longpoll.ts; design/aws-port.md §3). Unset => no budget (every hold granted).
  HOLD_BUDGET_SECONDS?: string;
  // Deploy-time default of the `jobs.enabled` runtime flag (src/core/flags.ts): "off" makes every scheduled tick a no-op. Unset => on.
  JOBS_ENABLED?: string;
  // The AWS `prod` stage's base URL; the Worker forwards every request there while import_state['cutover.mode'] is 'proxy' (src/core/cutover.ts).
  CUTOVER_PROXY_URL?: string;
  // "on" arms the cutover and jobs flags (src/core/cutover.ts): only then are cutover.mode and jobs.enabled read from the store. Unset
  // (production D1 until the cutover is staged) reads neither, so no request or tick pays a query for them.
  CUTOVER_ARMED?: string;
  DISCORD_API_URL: string; // e.g. https://discord.com/api -- src/auth/discord.ts (09 §3 T1)
  // Mod-queue Discord notify (LDB-MD12, src/core/modqueue.ts): a Discord
  // incoming-webhook URL. Unset or empty => the whole feature is a no-op
  // (no fetch, no `notified_at` write) -- never set locally, `wrangler
  // secret put MODQUEUE_DISCORD_WEBHOOK` in production.
  MODQUEUE_DISCORD_WEBHOOK?: string;
  // Opt in only after the webhook is owned by an application that supports
  // Components V2 interactions. Defaults to legacy text messages.
  MODQUEUE_DISCORD_COMPONENTS?: string;
  // Dedicated akldb application adapter; all features remain off unless the
  // matching explicit gate is enabled and the required configuration exists.
  MODQUEUE_DISCORD_BOT_TOKEN?: string;
  MODQUEUE_DISCORD_APPLICATION_ID?: string;
  MODQUEUE_DISCORD_PUBLIC_KEY?: string;
  MODQUEUE_DISCORD_GUILD_ID?: string;
  MODQUEUE_DISCORD_CHANNEL_ID?: string;
  MODQUEUE_DISCORD_CARDS?: string;
  MODQUEUE_DISCORD_ACTIONS?: string;
  // Rejection-only submitter DMs (LDB-MD18): delivery is opt-in at the
  // Worker level and requires both this explicit true flag and the bot token.
  // The token is a secret and must never be set in wrangler vars.
  MODQUEUE_DISCORD_DMS?: string;
}
