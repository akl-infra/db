// Shared Worker bindings type (wrangler.toml's [vars] + secrets, §7 of the
// plan). Every var/secret read anywhere in server/ is named here AND has a
// README.md row -- SITE-8 checks both directions.
export interface Env {
  DB_BASE_URL: string;
  SITE_NAME: string;
  // Secrets -- unset in a deploy where saltorbit hasn't done §7 of the plan yet.
  // Every reader of these two must degrade cleanly (sign-in hidden / "not
  // configured"), exactly like functions/auth/discord/login.js's guard.
  DISCORD_CLIENT_ID?: string;
  DISCORD_CLIENT_SECRET?: string;
  SESSION_SECRET?: string;
}

export const BUILD_VERSION = "1.0";
export const CLIENT_VERSION_HEADER = `akldb-site/${BUILD_VERSION}`;
