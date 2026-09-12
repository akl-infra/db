// The Worker's bindings and vars, as declared in wrangler.toml. Every key
// here must have a row in README.md's secrets/bindings table (LDB-G4).
export interface Bindings {
  DB: D1Database;
  DUMPS: R2Bucket;
  IMPORT_SOURCE_URL: string;
  IMPORT_MAX_WRITES_PER_TICK: string;
  IMPORT_UA: string;
  DISCORD_API_URL: string; // e.g. https://discord.com/api -- src/auth/discord.ts (09 §3 T1)
}
