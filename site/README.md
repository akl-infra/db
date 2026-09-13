# akldb.org — the community layout database's own website

W1a (design/akldb-site/01-plan.md): a Cloudflare Worker (Hono, `server/`)
serving `/auth/*` + `/api/v1/*`, with everything else falling through to a
Vite/SolidJS static build (`src/` -> `dist/`). Its own `package.json`; no
workspace; nothing here imports `../src`, `../formats`, or `../../web`
(SITE-9, mirroring `db/tests/tools/boundary.test.ts`'s `LDB-G5`).

The browser never talks to `akl-db` directly — every read/write goes
through `/api/v1/*` on this Worker, which attaches the signed-in user's
bearer token server-side (`server/proxy.ts`). See `db/docs/adoption.md` for
the API this site is a client of.

## Vars and secrets

Every one of these is read somewhere in `server/` or `wrangler.toml`
(SITE-8 checks both directions: every reader has a row here, and every row
here is actually read).

| name | kind | where it's read | what it's for |
|---|---|---|---|
| `DB_BASE_URL` | var (`wrangler.toml`) | `server/proxy.ts`, `server/discord.ts` | the akl-db origin every proxied request and the OAuth callback's `/v1/me` check target |
| `SITE_NAME` | var (`wrangler.toml`) | reserved for `src/` branding; not yet read server-side | display name, in case akldb.org ever needs to tell itself apart from a preview deploy |
| `DISCORD_CLIENT_ID` | secret | `server/discord.ts` (`/auth/login`, `/auth/callback`), `server/discord.ts`'s `/auth/me` | the Discord OAuth application id. **Unset = sign-in degrades cleanly**: `/auth/login` and `/auth/callback` 404 (same guard as `functions/auth/discord/login.js`), `/auth/me` answers `{user:null, signin:false}` so the UI hides the sign-in button entirely |
| `DISCORD_CLIENT_SECRET` | secret | `server/discord.ts` (`/auth/callback`'s token exchange) | the Discord OAuth application secret |
| `SESSION_SECRET` | secret | `server/session.ts` (`sealSession`/`openSession`) | AES-256-GCM key material (SHA-256 of this string) for the `__Host-akldb_session` cookie. Unset = `/auth/callback` fails closed with a plain "not fully configured" page rather than sealing a forgeable session |

All three secrets and both custom domains (`akldb.org`, `www.akldb.org`)
are already live on the deployed Worker (2026-09-12) — see
`wrangler.toml`'s `[[routes]]`. `workers_dev = true` stays on alongside
them because the Discord application's redirect list still names
`https://akldb-site.akl-58a.workers.dev/auth/callback` as a second URI.

## Local dev

```bash
cp .dev.vars.example .dev.vars   # fill in real values, or leave sign-in unconfigured
npm ci
npm run build            # once, so dist/ exists for the Worker's [assets] block
npx wrangler dev          # terminal 1: server/ (Hono) + static assets, port 8788
npm run dev                # terminal 2: Vite, HMR for src/**, proxies /auth + /api to :8788 (vite.config.ts)
```

Visit the Vite dev server's own port for HMR, or `wrangler dev`'s port for
the whole Worker as it will actually run in production. `npm run build`
also runs `scripts/build-docs.mjs` (a `prebuild`/`predev` hook) — it reads
`../docs/adoption.md` and writes the gitignored `src/generated/docs.html.ts`
that `pages/Docs.tsx` renders; it fails loudly if that source file is
missing, never silently serving an empty Docs page.

## Deploy

CI (`.github/workflows/db.yml`'s `site` job) builds, tests and deploys on
every push to `ldb-arch-review` (the integration branch) using
`CLOUDFLARE_DB_TOKEN`/`CLOUDFLARE_DB_ACCOUNT_ID`. By hand, from `db/site/`:

```bash
CLOUDFLARE_ACCOUNT_ID=58a5eb82948e2134d8b7b242e9567ac4 npx wrangler deploy
```

## Testing

```bash
npm run typecheck && npm test && npm run build
```

`tests/server/` covers the session/proxy/CSRF invariants (`db/site/
INVARIANTS.md`'s SITE-1..3, SITE-10); `tests/src/` covers pure helpers
(the router, the `aklgg.ts` link builder); `tests/tools/` covers the
structural ones (copy scan, no-`db/src`-import scan, README completeness,
built-bundle hostname scan — SITE-5, SITE-7, SITE-8, SITE-9).

## Adding a page (for W1b)

1. Add a variant to `Route` in `src/router.ts` and its `parsePath`/`pathFor`
   cases.
2. Add the page component under `src/pages/`.
3. Wire it into the `<Show>` stack in `src/App.tsx` (routes are mutually
   exclusive, so each page is its own independent `<Show>`, not a `<Switch>`
   — see that file's own header comment for why).
4. Every user-facing string goes in `src/copy.ts` (SITE-5 fails the build
   otherwise) — it still carries the `// COPY: sign-off pending` marker
   until saltorbit signs off the page's copy.

## `src/api.ts`'s surface

Every route this site's Worker proxies has a typed function in `api.ts`.
Public/read routes (`listLayouts`, `getLayout`, `getLayoutHistory`,
`getLikes`, `getAuthors`, `getAuthor`, `getChanges`, `getMe`) are wired into
the W1a pages already. **Owner actions** (`likeLayout`, `unlikeLayout`,
`renameLayout`, `deleteLayout`, `restoreLayout`, `transferLayout`,
`getLink`, `submitLink`, `clearLink`) and **admin actions**
(`adminListBans`, `adminBanUser`, `adminUnbanUser`, `adminSetLikes`,
`adminSetAuthorName`, `adminLinkQueue`, `adminApproveLink`,
`adminRejectLink`, `adminListAdmins`, `adminAddAdmin`, `adminRemoveAdmin`,
`adminImportPause`/`Resume`/`Tick`, `adminHealth`) are typed and ready but
have **no UI** — that's W1b, per design/akldb-site/01-plan.md's slice split.
`src/pages/Admin.tsx` is a placeholder ("moderation lands in the next
slice") gated on `/auth/me`'s `admin: true`; replace its body with the real
tabs (Layouts/Authors/Bans/Link queue/Admins/Import) without touching the
admin-gate logic itself.
