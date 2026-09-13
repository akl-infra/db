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
  // wrangler.toml's `[assets]` binding -- `index.ts`'s `notFound` fallback
  // (a local `wrangler dev` quirk found during W1b's own Chrome QA: local
  // dev invoked this Worker for EVERY path, including ones `run_worker_
  // first` lists as assets-first, so relying on the platform to serve
  // static assets without the Worker's help isn't safe locally). Optional:
  // absent in every `tests/server/*.test.ts` call (`app.request(path, {},
  // env)` passes a bare `Env` with no `ASSETS`), which is exactly when the
  // fallback below must still answer its OLD plain 404 instead of throwing.
  ASSETS?: Fetcher;
}

export const BUILD_VERSION = "1.0";
export const CLIENT_VERSION_HEADER = `akldb-site/${BUILD_VERSION}`;
