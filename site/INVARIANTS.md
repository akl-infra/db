# db/site/ invariant registry

The `SITE-*` invariants for akldb.org (`design/akldb-site/01-plan.md` §5,
W1a). This registry lives with the site's own code -- it is not swept by
`cd db && npm test` (`db/vitest.config.ts`'s projects only glob `db/tests/**`,
so `db/site/tests` needs its own runner: the CI `site` job, or
`cd db/site && npm test` by hand).

Every row here needs a test tagged `[SITE-*]` in its `test()`/`it()` title
under `db/site/tests/`; `tests/tools/invariants.test.ts` fails the build
when an id has no tagged test, or a tag names an id not in this table.

| id | invariant | enforced by |
|---|---|---|
| SITE-1 | A session cookie round-trips (`sealSession`/`openSession`) for any payload and any non-empty secret; a tampered ciphertext, a session sealed under a different secret, an expired session, and a malformed token all open to `null` -- never throw. | `tests/server/session.test.ts` |
| SITE-2 | The `/api/v1/*` proxy's header matrix: `Content-Type`/`If-Match`/`If-None-Match`/`Idempotency-Key`/`Accept` forward; `Authorization`/`X-Client-Version` are added only as the proxy itself decides; `Cookie`/every `X-Akl-*`/every `X-Forwarded-*` request header, and `Set-Cookie`/`WWW-Authenticate` response header, are never forwarded in either direction, authenticated or anonymous; an authenticated response always carries `Cache-Control: private, no-store` regardless of upstream; `?wait=` is stripped before the request reaches the DB. | `tests/server/proxy.test.ts` |
| SITE-3 | A non-safe `/api/v1/*` request, or `POST /auth/logout`, without `X-Requested-With: akldb`, or with a cross-site `Sec-Fetch-Site`, is `403 csrf` and never reaches the DB (never clears the cookie); a safe (GET) request needs neither header. | `tests/server/proxy.test.ts`, `tests/server/discord.test.ts` |
| SITE-4 | No path outside `/api/v1/*` is proxied to the DB -- `/api/<not-v1>` and any other unmatched path 404 without calling `fetch`. | `tests/server/proxy.test.ts` |
| SITE-5 | Every user-facing string of 3+ words lives in `src/copy.ts`, which itself carries the `// COPY: sign-off pending` marker; no `.tsx` file outside it hardcodes one. | `tests/tools/copy-scan.test.ts` |
| SITE-6 | The admin UI (`pages/Admin.tsx`) is unreachable without a fresh `/auth/me` answer saying `admin: true` (`canSeeAdmin`, never a cached flag); every `admin*` function in `src/api.ts` targets `/api/v1/admin/*`. | `tests/tools/admin-gate.test.ts` |
| SITE-7 | The built client bundle (`vite build`'s `dist/`) has no reference to akl-db's real hostname anywhere outside the isolated `docs-content` chunk (the rendered `db/docs/adoption.md`, whose whole job is to quote it) -- the application code (session/proxy/api/pages) only ever reaches the DB through `DB_BASE_URL` at the server edge. | `tests/tools/no-hostname-leak.test.ts` |
| SITE-8 | Every var/secret this Worker reads (`wrangler.toml`'s `[vars]`, plus `DISCORD_CLIENT_ID`/`DISCORD_CLIENT_SECRET`/`SESSION_SECRET`) has a `README.md` row, and every row names something actually read in `server/`. | `tests/tools/readme-vars.test.ts` |
| SITE-9 | Nothing under `db/site/src` or `db/site/server` resolves an import into `db/src/**`, `db/formats/**`, or `web/src/**` (no `@akl/core`) -- the site is a client of the public wire only, per `db/tests/tools/boundary.test.ts`'s `LDB-G5` extension. | `tests/tools/no-db-src-import.test.ts`, `db/tests/tools/boundary.test.ts` |
| SITE-10 | An upstream `401 token_invalid` on an authenticated proxied request clears the session cookie and answers `401 {error:"reauth"}` without ever retrying (no refresh token is kept); an anonymous `401` passes through unchanged. | `tests/server/proxy.test.ts` |
| SITE-11 | A rendered `link` is used only if it re-parses as `https:` client-side; the visible text is always the hostname, never the raw string (H17). | `tests/src/safelink.test.ts` |
| SITE-12 | The site never links out to akl.gg and never renders a layout as a board: the built bundle contains no `akl.gg` literal and no board component; a layout page shows the stored format as plain text (canonical JSON). | `tests/tools/no-hostname-leak.test.ts` |
