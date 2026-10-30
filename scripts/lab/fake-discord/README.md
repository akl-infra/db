# Fake Discord (proving ground)

`node scripts/lab/fake-discord/server.mjs --port 18402 [--log record.ndjson] [--seed lab]`, or
`startFakeDiscord()` from `server.mjs`. Loopback only. Point akldb at it with
`DISCORD_API_URL=http://127.0.0.1:18402/api`. The route list and the `/__fake/*` control routes are in the
header of `server.mjs`.

A lab stage uses exactly one fake Discord. On akl.gg's `fake` stage that is akl.gg's `platform/fake-discord/`, not
this one. The contract akldb's bearer check needs from either: `GET {base}/oauth2/@me` with `Authorization: Bearer <token>`
answers 200 `{"application":{"id"},"user":{"id","username"},"scopes":["identify"]}`, 401 for an unknown or revoked
token, and anything else becomes `503 identity_unavailable` on akldb's side. To make a token this fake did not issue
work here, register it: `POST /__fake/tokens {token, user:{id,username}}`.

Caching caveat for akl.gg's suite: akldb caches a bearer success for 300 s and a failure for 60 s
(`src/auth/discord.ts`, production constants, not changed for the lab). A token revoked here keeps passing akldb's
check until its cached success expires, so a "revoked -> `token_invalid`" step must revoke a token akldb has not seen,
or wait more than 300 s after akldb last saw it.

The record (`GET /__fake/log`, or `--log`) is NDJSON: `seq`, `at`, `method`, `path`, `authKind` (never the credential),
`headers` minus auth/cookie, `body` (JSON, text, or the parts of a multipart), `status`, `injected`.
`at` is wall time; a differ should ignore it.
