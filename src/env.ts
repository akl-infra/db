// The Worker's bindings and vars, as declared in wrangler.toml. Every key
// here must have a row in README.md's secrets/bindings table (LDB-G4).
export interface Bindings {
  DB: D1Database;
  DUMPS: R2Bucket;
  IMPORT_SOURCE_URL: string;
  IMPORT_MAX_WRITES_PER_TICK: string;
  IMPORT_UA: string;
  // LDB-I23: "on" | "off", default "on" -- a kill switch for a hostile or
  // broken upstream. "off" makes the importer never tombstone anything,
  // regardless of the listing (src/import/cmini.ts's `importDeletesEnabled`).
  IMPORT_DELETES: string;
  // LDB-I27: "on" | "off", default "on" -- a kill switch for a hostile or
  // vanished upstream. "off" skips the cmini import tick and the upstream
  // diff tick entirely, before any fetch (src/import/cmini.ts's
  // `importEnabled`); the nightly dump and prunes are unaffected. Currently
  // "off" in wrangler.toml (2026-09-15: cmini's own API was taken down).
  IMPORT_ENABLED: string;
  DISCORD_API_URL: string; // e.g. https://discord.com/api -- src/auth/discord.ts (09 §3 T1)
}
