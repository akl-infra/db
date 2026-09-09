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

`diff-upstream` is real (S8, see "Verify the mirror" below). `profile-upstream`
(prints the `07 §0.1` measured table), `pick-fixtures` (regenerates
`tests/fixtures/upstream-100/` -- run once, its output is frozen) and
`goldens -- --write` (writes `db/formats/*/*/fixtures/` and their derived
goldens -- also run once per new fixture, never to regenerate one that
already merged) are real (S2). `import` is real (S5, see below). `deploy`
and `rehost` are real (S7, see "Rehost procedure" below); `deploy` is
normally run by CI (`.github/workflows/db.yml`'s `deploy` job), not by hand.

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
| `DB` | D1 binding | `src/index.ts` (and everywhere under `src/core`, `src/import`, `src/dump`, `src/auth`) | `wrangler d1 create akl-db`; paste the id into `wrangler.toml`'s `[[d1_databases]]` |
| `DUMPS` | R2 binding | `src/dump/write.ts`, `src/routes/dump.ts` (S7) | `wrangler r2 bucket create akl-db-dumps`; the 90-day lifecycle rule on `dump-*` is set by hand in the R2 bucket's dashboard/API (`monthly/` is exempt -- no prefix match) |
| `IMPORT_SOURCE_URL` | var | `src/import/upstream.ts` (S5) | `wrangler.toml`'s `[vars]`; defaults to `https://clemenpine.com/layoutapi/v3` |
| `IMPORT_MAX_WRITES_PER_TICK` | var | `src/import/apply.ts` (S5) | `wrangler.toml`'s `[vars]`; default `500` |
| `IMPORT_UA` | var | `src/import/upstream.ts` (S5) | `wrangler.toml`'s `[vars]`; every upstream request must send it (0.1: the default UA is 403'd) |
| `DISCORD_API_URL` | var | `src/auth/discord.ts` (T1) | `wrangler.toml`'s `[vars]`; default `https://discord.com/api`; tests inject `fetchImpl` directly and never resolve this URL |
| `CLOUDFLARE_DB_TOKEN` | repo secret (CI) | `.github/workflows/db.yml`'s `deploy` job (S7) | a Cloudflare API token with Workers Scripts + D1 + R2 edit, separate from the site's Pages token |
| `CLOUDFLARE_DB_ACCOUNT_ID` | repo secret (CI) | `.github/workflows/db.yml`'s `deploy` job (S7) | the NEW community account's id (00 §1) -- NOT the site's `CLOUDFLARE_ACCOUNT_ID` |
| `DB_BASE_URL` | repo/org variable (CI) | `.github/workflows/db.yml`'s `daily` job (S7) | the deployed service's own origin, e.g. `https://akl-db.<account>.workers.dev`; set once the service is deployed |
| `TEST_ROUTES` | test-only miniflare binding | `src/index.ts`'s throwaway `/v1/__test/write` route | set unconditionally in `vitest.config.ts`; never present outside tests |
| `TEST_MIGRATIONS` | test-only miniflare binding | `tests/setup-workers.ts` | built from `migrations/` by `vitest.config.ts` at test-run time; never present outside tests |
| `TEST_REHOST_DUMP_URL` | test-only miniflare binding | `tests/rehost.test.ts` (S7) | threads the real `REHOST_DUMP_URL` env var (set only by db.yml's `daily` job) into the miniflare Worker; empty string locally, so `npm test` always runs the local (cron-driven) half of the rehost drill |

## Preview environment

`[env.preview]` in `wrangler.toml` is a second, independent deployment of
this Worker (`09-implementation-phase2.md` §3 T7) that the site's phase-2
UX work (drafts, write verbs, `/v1/me`, likes, ...) writes against so that
production `akl-db` stays read-only-by-humans until phase 3. Wrangler
environments do not inherit `d1_databases`/`r2_buckets`/`vars`/`triggers`
from the top level, so `[env.preview]` redeclares every one of them under
the same binding names (`DB`, `DUMPS`) with preview-only resource names:

| resource | production | preview |
|---|---|---|
| Worker | `akl-db` -- `https://akl-db.<account>.workers.dev` | `akl-db-preview` -- `https://akl-db-preview.<account>.workers.dev` |
| D1 (binding `DB`) | `akl-db` (`53f596d5-9cb5-43b0-9026-17518d18052f`) | `akl-db-preview` (`d31147d4-ef1f-485e-bbed-c9f4a71f4d53`) |
| R2 (binding `DUMPS`) | `akl-db-dumps` | `akl-db-dumps-preview` |

Both resources were created by hand in the community (`akl`) Cloudflare
account on 2026-09-09 (`wrangler d1 create akl-db-preview`, `wrangler r2
bucket create akl-db-dumps-preview`); their ids/names live only in
`wrangler.toml`'s `[env.preview]` block, never as a code constant
(`tests/tools/wrangler-envs.test.ts`, LDB-C3, also asserts `[env.preview]`
mirrors the top level with only names/ids changed).

`.github/workflows/db.yml`'s `preview` job (`needs: test`, pushes to the
`worktree-layout-db` branch only) runs `wrangler d1 migrations apply
akl-db-preview --env preview --remote` then `wrangler deploy --env preview`
on every push -- so preview tracks that branch's `db/` automatically; there
is no separate manual deploy step for it.

The site's Pages Preview environment points its `DB_BASE_URL` build
variable at `https://akl-db-preview.<account>.workers.dev` (a site PR, not
this directory) so phase-2 UX previews read and write the preview database
instead of production.

**Resetting the preview database:** the same rehost drill as production
(below), with `--env preview` so every wrangler call targets `akl-db-preview`
instead of `akl-db`:

```bash
npm run rehost -- --dump <file|url> --remote --env preview [--force]
```

## Rehost procedure

Every night (`0 3 * * *`) the Worker writes a complete snapshot -- every
table, the WHOLE event log (not a tail: a rehosted service must still be
able to answer `/v1/changes?since=0`) -- to R2 as `dump-YYYY-MM-DD.json.gz`,
with `latest.json` pointing at the newest one and a `monthly/dump-YYYY-MM.json.gz`
copy kept on the 1st of each month. `GET /v1/dump` always redirects to the
current one; nothing about this needs a public R2 bucket -- the Worker
streams the object itself.

**The numbered procedure** (04-governance.md §4's drill, as implemented):

1. Get a dump. Either download it yourself (`curl -O <service>/v1/dump/latest.json`,
   then follow its `url`), or hand `rehost.mjs` a URL directly -- it fetches
   and gunzips either a `.gz` or already-decompressed dump.
2. `npm run rehost -- --dump <file|url> --local` against a scratch local D1
   first if you want to sanity-check the dump before touching anything real
   (this is exactly what `tests/rehost.test.ts`'s local half does every
   test run, and what this slice's own DoD proof used).
3. `npm run rehost -- --dump <file|url> --remote [--force]` against the
   real `akl-db` -- needs `CLOUDFLARE_API_TOKEN`/`CLOUDFLARE_ACCOUNT_ID` in
   the environment (the same credentials `CLOUDFLARE_DB_TOKEN`/
   `CLOUDFLARE_DB_ACCOUNT_ID` name as repo secrets; export them locally
   under those exact wrangler-recognized names to run this by hand). The
   script refuses when `layouts` already has rows, unless you pass
   `--force` -- a rehost is meant to be a from-scratch recovery, not a
   silent overwrite of a live, healthy database.
4. `npm run deploy` (or push to `main` and let CI's `deploy` job do it) to
   point the Worker's code at the restored data, if this was a full
   from-scratch rehost (new account, lost database, etc.) rather than a
   drill against the existing one.
5. Confirm: `curl <service>/v1/meta` and compare `layout_count`/`seq`
   against what `latest.json` claimed before the restore.

**What a rehost does NOT restore:** `auth_cache` (never dumped -- it holds
only token hashes with a <=5-minute lifetime; a rehost starts with a cold
cache, so the next authenticated request just re-verifies with Discord) and
`ratelimit` (rate-limit windows; starting empty only ever makes a request
succeed sooner, never later). Both tables are wiped by `restoreSql`'s own
`DELETE FROM` pass and never re-populated -- this is intentional, not a gap.

**The daily proof** (`.github/workflows/db.yml`'s `daily` job, 04:00 UTC):
fetches the real `latest.json` from the deployed service, runs
`tests/rehost.test.ts` against it (restores the dump into the job's own
throwaway D1 and re-runs the whole conformance suite against the restored
copy), and separately runs the upstream diff (S8). Both fail the job loudly
on any problem -- neither is allowed to skip silently.

## Verify the mirror

`npm run diff-upstream` (`scripts/diff-upstream.mjs`, logic in `src/import/
diff.ts`, LDB-P5) is the D12 diff: it fetches every layout from upstream and
from `DB_BASE_URL`, matches by `name.toLowerCase()`, and compares each pair
on the `cmini/1` projection (`?as=cmini/1`, likes sorted both sides) --
printing the first differing JSON path for anything that disagrees, plus
`layout_count` and the `authors` map. Exits 1 on any difference.

```bash
npm run migrate                      # fresh local D1
npm run dev                          # in a second terminal: wrangler dev on :8787

# drive the import cron by hand against the real upstream until it's caught
# up (the write cap is 500/tick -- 07 §0.1's ~4200 layouts take ~9 ticks;
# `/v1/meta` converges when a tick reports `quiet: true`, i.e. two ticks in
# a row leave `layout_count` unchanged):
curl "http://localhost:8787/__scheduled?cron=*/5+*+*+*+*"   # repeat, waiting for each tick to finish
curl http://localhost:8787/v1/meta                          # check layout_count against upstream's own /meta

npm run diff-upstream                # DB_BASE_URL defaults to http://localhost:8787
```

Against the deployed service: `DB_BASE_URL=https://akl-db.<account>.workers.dev npm run diff-upstream`.
The daily job (`.github/workflows/db.yml`) runs the same comparison as
`tests/upstream-diff.test.ts` (`DB_BASE_URL` set to the live origin) --
real network, retries for 30 minutes on an unreachable service, then fails
(never skips); `tests/import/diff-unit.test.ts` runs the offline half
(the same comparison logic over the frozen `tests/fixtures/upstream-100/`
snapshot) on every PR.

### R2 lifecycle

`akl-db-dumps` has a lifecycle rule deleting objects under the `dump-`
prefix after 90 days (hand-configured once, `00 §1`/`08-infrastructure.md`
§1) -- this only ever touches the daily `dump-YYYY-MM-DD.json.gz` keys;
`monthly/dump-YYYY-MM.json.gz` doesn't match that prefix and is kept
indefinitely (the long-term archive), and `latest.json` is a single,
always-current object nothing ever expires.

### Clearing `cmini.stalled`

The import stalls itself (`import_state` key `cmini.stalled`, a JSON
`{at, reason}`) instead of applying a tick's deletes when a tick would
tombstone more than `max(5, 5%)` of live records, or when the upstream list
came back suspiciously short (07 §6 S5's collapse/prune guards, LDB-I3/I6)
-- a real upstream outage or bug should never silently mass-delete the
mirror. To clear it once you've confirmed the state is legitimate (not an
upstream bug):

```bash
npx wrangler d1 execute akl-db --remote --config wrangler.toml \
  --command "DELETE FROM import_state WHERE key = 'cmini.stalled'"
```

The next tick re-plans from scratch and applies its deletes normally; it
does not remember that it was ever stalled.

### Pausing the import

Set `import_state.cmini.paused = '1'`; every tick then returns immediately
(`src/import/cmini.ts`'s `tick()`, first check) without contacting upstream
or touching the database:

```bash
npx wrangler d1 execute akl-db --remote --config wrangler.toml \
  --command "INSERT INTO import_state (key, value) VALUES ('cmini.paused', '1')
             ON CONFLICT(key) DO UPDATE SET value = excluded.value"
```

Delete the row (or set it to anything other than the string `'1'`) to
resume -- there is no separate "resume" command.
