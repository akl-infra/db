// The Worker's bindings and vars, as declared in wrangler.toml. Every key
// here must have a row in README.md's secrets/bindings table (LDB-G4).
export interface Bindings {
  DB: D1Database;
  DUMPS: R2Bucket;
  IMPORT_SOURCE_URL: string;
  IMPORT_MAX_WRITES_PER_TICK: string;
  IMPORT_UA: string;
  DISCORD_API_URL: string; // e.g. https://discord.com/api -- src/auth/discord.ts (09 §3 T1)
  WEBHOOK_MAX_POSTS: string; // X1 (12 §2.1): the global POST bound per drain() call
  STREAM_MAX_MS: string; // X1 (12 §2.2): the SSE stream's wall-clock bound; "0" -> 503 stream_unavailable
  STREAM_POLL_MS: string; // X1 (12 §2.2): the SSE stream's feed-poll interval
}
