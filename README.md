# `akl-db`

The layout-db service (`design/layout-db/`): a Cloudflare Worker with its
own D1 database and R2 bucket, mirroring cmini's layouts read-only in
phase 1. Deployable independently of the rest of this repo -- see
`00-plan.md` §7 for why nothing here imports from `../web`, `../scripts` or
`../functions`, and nothing outside imports `db/` (enforced by
`tests/tools/boundary.test.ts`, LDB-G5).

Full design: `design/layout-db/00-plan.md` (why) and
`design/layout-db/07-implementation-phase1.md` (what phase 1 ships, slice
by slice). Invariants: `INVARIANTS.md` (this directory).

## Run locally

```bash
cd db && npm ci
npm run migrate                     # wrangler d1 migrations apply akl-db --local
npm run import -- --once --fixture  # S5: a 100-layout snapshot, offline
npm run dev                         # wrangler dev; GET http://localhost:8787/v1/meta
npm test                            # both vitest projects (workers + node)
npm run typecheck
```

`deploy`, `rehost` and `diff-upstream` are placeholders until their slice
lands (S7-S8); each prints which slice to look for. `profile-upstream`
(prints the `07 §0.1` measured table), `pick-fixtures` (regenerates
`tests/fixtures/upstream-100/` -- run once, its output is frozen) and
`goldens -- --write` (writes `db/formats/*/*/fixtures/` and their derived
goldens -- also run once per new fixture, never to regenerate one that
already merged) are real (S2). `import` is real (S5, see below).

### `npm run import -- --once [--fixture]`

Drives exactly one cmini import tick (`src/import/cmini.ts`'s `tick()`)
against the LOCAL D1 (`npm run migrate` first). `scripts/import.mjs` starts
`wrangler dev --test-scheduled` and hits its `/__scheduled?cron=*/5+*+*+*+*`
endpoint -- the same mechanism 07 §8 documents by hand
(`wrangler dev --test-scheduled` + `curl
"http://localhost:8787/__scheduled?cron=*/5+*+*+*+*"`), just scripted.

- **`--fixture`**: serves `tests/fixtures/upstream-100/{list,full,authors}.json`
  from a tiny in-process HTTP server and points the dev Worker's
  `IMPORT_SOURCE_URL` at it for this run only (`wrangler dev --var`,
  wrangler.toml itself is untouched) -- fully offline, safe to run
  repeatedly. A fresh local D1 ends up with `layout_count: 100`,
  `author_count: 32` (authors.json has 48 name entries but only 32 distinct
  user ids -- some users have more than one recorded name; `authors`'s
  PRIMARY KEY is `user_id`, so 32 is the correct row count); running it
  again reports a fast, event-count-unchanged ("quiet") tick.
- without `--fixture`: hits the real upstream
  (`IMPORT_SOURCE_URL` from `wrangler.toml`, `https://clemenpine.com/
  layoutapi/v3` by default) -- a real tick against production data.

Ports default to 8787 (wrangler dev) and 8788 (the fixture server);
override with `IMPORT_SCRIPT_WRANGLER_PORT`/`IMPORT_SCRIPT_FIXTURE_PORT` if
those are taken.

## Secrets and bindings

| name | kind | where it's read | how to regenerate |
|---|---|---|---|
| `DB` | D1 binding | `src/index.ts` (and everywhere under `src/core`, `src/import`) | `wrangler d1 create akl-db`; paste the id into `wrangler.toml`'s `[[d1_databases]]` |
| `DUMPS` | R2 binding | `src/dump/write.ts` (S7) | `wrangler r2 bucket create akl-db-dumps` |
| `IMPORT_SOURCE_URL` | var | `src/import/upstream.ts` (S5) | `wrangler.toml`'s `[vars]`; defaults to `https://clemenpine.com/layoutapi/v3` |
| `IMPORT_MAX_WRITES_PER_TICK` | var | `src/import/apply.ts` (S5) | `wrangler.toml`'s `[vars]`; default `500` |
| `IMPORT_UA` | var | `src/import/upstream.ts` (S5) | `wrangler.toml`'s `[vars]`; every upstream request must send it (0.1: the default UA is 403'd) |
| `DISCORD_API_URL` | var | `src/auth/discord.ts` (T1) | `wrangler.toml`'s `[vars]`; default `https://discord.com/api`; tests inject `fetchImpl` directly and never resolve this URL |
| `CLOUDFLARE_DB_TOKEN` | repo secret (CI) | `.github/workflows/db.yml`'s `deploy` job (S7) | a Cloudflare API token with Workers Scripts + D1 + R2 edit, separate from the site's Pages token |
| `CLOUDFLARE_ACCOUNT_ID` | repo secret (CI) | `.github/workflows/db.yml`'s `deploy` job (S7) | same account as Pages (`cminibrowser`) |

## Rehost procedure

Not yet implemented (S7). Will be: `npm run rehost -- --dump <file|url>`,
which applies migrations then restores the nightly dump's full event log
into a fresh D1 -- see `07-implementation-phase1.md` §7.
