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

**Writes require `If-Match` (LDB-P2, saltorbit's rule, 2026-09-09):** no client
may write to an existing record without naming the version it saw. `PUT
/v1/layouts/{ref}`, `PATCH /v1/layouts/{ref}`, `DELETE /v1/layouts/{ref}`
and `POST /v1/layouts/{ref}/transfer` all refuse a request with no
`If-Match` header -- `400 if_match_required` (`src/core/errors.ts`),
checked before any read or mutation. A client's "overwrite" is never a
blind write: it must re-read the record first and send the `rev` it was
shown (`If-Match: "<rev>"`); `If-Match: *` still means "overwrite whatever
is there", but the client must say so explicitly -- absent is refused, not
treated as `*`. `POST /v1/layouts` (creation), likes, `restore` and the
`import:cmini` path are unaffected -- there is no prior version to name.
Design: `design/layout-db/09-implementation-phase2.md` §2.1 (the error
vocabulary), §2.3 (`If-Match` mechanics).

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
| `WEBHOOK_MAX_POSTS` | var | `src/core/webhooks.ts` (X1) | `wrangler.toml`'s `[vars]`; default `25` -- the global POST bound per `drain()` call (the after-write nudge and every `*/5` tick's own drain alike) |
| `STREAM_MAX_MS` | var | `src/routes/stream.ts` (X1) | `wrangler.toml`'s `[vars]`; default `300000` (5 min) -- the SSE stream's wall-clock bound; `"0"` (the Free-plan setting) makes the route answer `503 stream_unavailable` instead |
| `STREAM_POLL_MS` | var | `src/routes/stream.ts` (X1) | `wrangler.toml`'s `[vars]`; default `2000` -- the stream's feed-poll interval; tests override both stream vars via `vitest.config.ts`'s miniflare `bindings` (`500`/`20`) so the bound/reconnect cases run in well under a second |
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

## Webhooks

`POST /v1/webhooks { url, secret, kinds?, owner_filter? }` registers a
subscription (up to `WEBHOOKS_PER_USER` = 5 per user); `GET /v1/webhooks`
lists the caller's own (an admin with `?all=1` sees every row, every
owner); `DELETE /v1/webhooks/{id}` removes one (own, or any as admin --
otherwise `404`, never `403`, so ids are not enumerable). Every field but
`secret` comes back on every route; `secret` is never returned, never
placed on an event, and never in a dump (`Dump.webhooks: []`) -- it is
stored verbatim in D1 because delivery needs the actual HMAC key, not a
hash of it (`design/layout-db/12-implementation-phase5.md` §2.1's ledger
of that decision). A rehosted service starts with zero subscriptions;
owners re-register (the feed, which the dump carries in full, is the
actual recovery path either way).

Each subscription is a cursor into the one event log, not a per-attempt
queue: delivery is "advance the cursor by POSTing what lies past it",
at-least-once and in order per hook. Every event past the cursor is
POSTed as its `canonical()` JSON, in `seq` order, with:

```
Content-Type: application/json
User-Agent: akl-db-webhooks/1.0
X-Akl-Webhook-Id: <id>
X-Akl-Seq: <seq>
X-Akl-Timestamp: <unix seconds>
X-Akl-Signature: v1=<hex hmac-sha256(secret, `${timestamp}.${body}`)>
```

**Receiver contract:** verify `hex(hmac_sha256(secret, X-Akl-Timestamp +
"." + raw_body)) == X-Akl-Signature`'s hex half (strip the `v1=` prefix
first) and reject anything more than 300s old. A receiver MAY see one
`seq` twice -- the after-write nudge and every `*/5` tick's own retry drain
are safe to overlap, and a receiver that accepted a POST but timed out before
answering looks identical to a dropped one from here -- so treat any `seq`
at or below the highest one already applied as a no-op; a `seq` never
arrives lower than one already seen from the same hook. A non-2xx answer
(or a timeout past 10s) stops that hook's batch there and schedules a
retry (backing off 1 min / 10 min / 1 h); three consecutive failed drains
mark the subscription `failing` (still retried hourly, still visible via
`GET /v1/webhooks`); a streak failing for more than 7 days marks it
`disabled` (no further attempts). A gap in `seq` on a `disabled` hook (or
any hook you suspect missed something) means poll `/v1/changes?since=` to
fill it -- the feed is the ground truth a subscription is only ever a
shortcut around (LDB-P3).

## Stream

`GET /v1/changes/stream?since=&kinds=` is the same feed as `/v1/changes`,
pushed as `text/event-stream` instead of polled: `id: <seq>`, `event:
<kind>`, `data: <canonical(event)>` per item, in order, exactly the items
`/v1/changes?since=<since>` would return. A `Last-Event-ID` request header
(what `EventSource` sends on reconnect) overrides `since`. A `: ping`
comment line appears after 25s with nothing new to send; the stream closes
with `event: close` + `data: {"next":<cursor>}` after `STREAM_MAX_MS` (5
minutes by default) -- reconnect with `Last-Event-ID: <cursor>` (or
`?since=<cursor>`) to continue with no gap or duplicate. No auth (same as
`/v1/changes`). Requires the Workers Paid plan (an open response holds the
isolate for the whole poll loop, `12 §0.1`/§2.2); a deployment on the Free
plan sets `STREAM_MAX_MS = "0"`, which makes every request to this route
answer `503 stream_unavailable` instead of opening a stream.

## Scheduled jobs

ONE cron trigger, `*/5 * * * *` (`wrangler.toml`'s `[triggers]`), drives
every scheduled job -- `src/index.ts`'s `scheduled()` reads `event
.scheduledTime` (UTC) to decide which of the four run on a given
invocation, not `event.cron` (there is only one cron string left to
route on). This replaced four separate cron triggers (`*/1`, `*/5`, `0 3`,
`0 4`) because Cloudflare's own dispatch has, at least once, simply
stopped firing for this Worker's registered triggers with no error
anywhere but a stale `/v1/meta` -- one trigger is one fewer thing that can
silently wedge, and `POST /v1/admin/import/tick` / `.../diff/tick` (below)
give an operator a manual way around it either way.

| every invocation | hour=3, minute=0 also | hour=4, minute=0 also |
|---|---|---|
| the import tick (`cminiTick`), then the webhook drain (`drainWebhooks`) -- tick first, so a subscription sees this SAME invocation's own import events without waiting a tick | `pruneAuthCache`, `pruneRateLimits`, `pruneNonces`, `writeDump` (the nightly dump, below) | `diffTick` (the diff cron, below) |

Each of the (up to six) jobs one invocation can run is caught and logged
independently (`src/index.ts`'s `runJob`) -- one job throwing (an upstream
outage during the import tick, say) never stops the others queued after it
in the same invocation from running. `tests/import/tick.test.ts`'s
`[isolation]` case and its `[matrix]`/`[property]` cases (every 5-minute
slot of a day, and a property over any two slots 5 minutes apart) are this
dispatch's own regression suite.

## Rehost procedure

Every night, at the `hour=3, minute=0` slot of the one `*/5 * * * *` cron
trigger, the Worker writes a complete snapshot -- every
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
cache, so the next authenticated request just re-verifies with Discord),
`ratelimit` (rate-limit windows; starting empty only ever makes a request
succeed sooner, never later), and `webhooks` (never dumped -- it holds
`secret` verbatim; a rehost has no subscriptions, and owners re-register
against the feed the dump already carries in full, see "Webhooks" above).
All three tables are wiped by `restoreSql`'s own `DELETE FROM` pass and
never re-populated -- this is intentional, not a gap.

**The daily proof** (`.github/workflows/db.yml`'s `daily` job, 04:00 UTC):
fetches the real `latest.json` from the deployed service, runs
`tests/rehost.test.ts` against it (restores the dump into the job's own
throwaway D1 and re-runs the whole conformance suite against the restored
copy), and separately runs the upstream diff (S8). Both fail the job loudly
on any problem -- neither is allowed to skip silently.

## Drill

The Fly restore drill (design/layout-db/12-implementation-phase5.md §3 X4
"the drill on Fly", LDB-D5) is a THIRD, independent proof that a rehost
works -- on top of `tests/rehost.test.ts`'s in-process CI proof (above) and
a human operator's own `npm run rehost` -- run daily, outside Cloudflare
entirely, as a scheduled Fly Machine (`db/drill/`). It:

1. fetches `$DB_BASE_URL/v1/dump/latest.json` then the dump it names, and
   verifies the fetched bytes' sha256 and byte count against what
   `latest.json` claims (`scripts/drill-fetch-dump.mjs`) -- a corrupt or
   truncated transfer never reaches the next step;
2. restores it into a LOCAL D1 (`wrangler d1 execute --local`) through the
   real restore code path, `restoreSql()` (`src/dump/restore.ts`) --
   the exact function `npm run rehost` and `tests/rehost.test.ts` both
   already use (`scripts/drill-restore.mjs`, a third caller, not a
   re-implementation) -- and checks the restored `layout_count`/`seq`
   against the dump's own `meta`;
3. serves that SAME local D1 with `wrangler dev --local --port 8790` and
   walks every layout id in the dump over real HTTP, comparing `GET /v1/
   layouts/:id` byte-for-byte (`canonical()`) against the dump's own
   record -- fields, likes, and payload -- plus `/v1/meta`'s
   `layout_count`/`seq` (`scripts/drill-verify.mjs`); and
4. signs and POSTs the assembled report to `POST /v1/admin/drill` on the
   client lane (`scripts/report-drill.mjs`, its own copy of the signer --
   the same duplication `bot/scripts/sign.mjs` uses, kept honest by
   `tests/drill/report-drill.test.ts` reproducing `tests/vectors/
   client-signing.json`), recorded as `import_state['drill.last']` and
   surfaced at `/v1/meta.last_drill` (`{at, ok}`) and `GET /v1/admin/
   health` (the full report, admin-only).

`db/drill/run.sh` orchestrates all four steps and is the container's
`ENTRYPOINT`; it exits non-zero on ANY failure -- a corrupted dump, a
restore mismatch, an HTTP mismatch, or the report POST itself failing --
even though a red (`ok: false`) report that DID post successfully still
means step 4 ran; see the script's own header for the exact distinction.
A Fly Machine run's own exit code is a second, redundant alarm alongside
`/v1/meta.last_drill` going stale (LDB-M1's meta-watch) -- belt and
suspenders, not either/or.

**Registering the drill's own client-lane key** (⚠ saltorbit, once, per target
DB): a drill needs its own Ed25519 keypair, registered as
`act-as-owner-only` so its `X-Akl-Actor` must equal its own
`owner_user_id` -- nobody else can act through it even if the private key
leaked from a different Fly app.

```bash
# From bot/ (bot/scripts/gen-key.mjs is the one keypair generator in the
# repo -- no need for the drill to carry its own copy):
node ../bot/scripts/gen-key.mjs
# prints CLIENT_PRIVATE_KEY=<pkcs8 b64url> and pubkey=<raw 32-byte b64url>

# Register it as an existing admin (saltorbit), act-as-owner-only, owner ==
# the same id you'll set DRILL_ACTOR to:
node ../bot/scripts/sign.mjs POST /v1/admin/clients --actor=<your-admin-discord-id> \
  --body='{"name":"fly-drill","pubkey":"<pubkey from above>","owner_user_id":"<DRILL_ACTOR>","caps":"act-as-owner-only"}'
# paste the printed -H/-d flags into curl against $DB_BASE_URL/v1/admin/clients
```

**Running it locally (Docker or bare):**

```bash
cd db
docker build -f drill/Dockerfile -t akl-db-drill .
docker run --rm \
  -e DB_BASE_URL=https://akl-db-preview.<account>.workers.dev \
  -e DRILL_CLIENT_ID=<client id from registration> \
  -e DRILL_PRIVATE_KEY=<CLIENT_PRIVATE_KEY from gen-key.mjs> \
  -e DRILL_ACTOR=<the same owner_user_id> \
  akl-db-drill

# or, without Docker (needs this checkout's own node_modules -- npm ci first):
DB_BASE_URL=... DRILL_CLIENT_ID=... DRILL_PRIVATE_KEY=... DRILL_ACTOR=... sh drill/run.sh
```

**Deploying the scheduled Fly Machine** (⚠ saltorbit -- `08 §2` item 2; never
run by an agent):

```bash
cd db
flyctl launch --no-deploy --config drill/fly.toml --dockerfile drill/Dockerfile
flyctl secrets set --config drill/fly.toml \
  DRILL_CLIENT_ID=... DRILL_PRIVATE_KEY=... DRILL_ACTOR=...
flyctl deploy --config drill/fly.toml --dockerfile drill/Dockerfile
flyctl machine run <image> --config drill/fly.toml --schedule daily --rm
```

Until the Fly drill has posted `ok: true` for seven days running AND the
site's meta-watch warns on a stale `last_diff`/`last_drill` (LDB-M1's site
half), `db.yml`'s own `daily` job (rehost + diff, above) stays as the
primary safety net -- X4b (a separate, dated PR) removes it once both
conditions hold.

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

### Diff cron (hour=4, minute=0 slot of the one `*/5 * * * *` trigger)

A second copy of the same D12 comparison above, run automatically every day
at 04:00 UTC by the Worker itself (`src/import/difftick.ts`'s `diffTick`),
against our OWN D1 -- no HTTP, in either direction (LDB-C4): `d1Ours`
(`src/import/difftick.ts`) reads `layouts`/`likes`/`authors`/`events`
directly, through the same `list()`/`translate()` functions the read routes
use, paged 500 records at a time. Every run -- success or failure -- writes
`import_state['cmini.last_diff']`; `GET /v1/meta` exposes it (and a drill
report, below) as `last_diff: {at, ok} | null` and `last_drill: {at, ok} |
null` (LDB-M1); the full summary (`upstream_count`/`corpus`/`authors`/up to
10 samples of each kind of mismatch) is admin-only, at `GET
/v1/admin/health` alongside the full drill record.

`POST /v1/admin/drill { ok: boolean, detail?: object <= 4 KB }` accepts and
stores a signed report of a rehost drill (a full restore-from-dump plus a
conformance-suite replay) -- admin-only, one `import_state['drill.last']`
row, no event (12 §6.4: ops state, not governance). **The drill itself
-- the Fly container that actually runs it against the deployed dump, and
the scheduled job that posts its result here -- is not part of this PR**
(`design/layout-db/12-implementation-phase5.md` §3 X4: "the Fly container
that performs it is saltorbit's own infrastructure, ⚠"); this service only
ever accepts and stores whatever report it's sent.

`.github/workflows/db.yml`'s `daily` job (the live upstream diff + the
rehost drill it already runs) is left in place until this cron -- and,
separately, the drill once it exists -- have both been green for 7
consecutive days; deleting it is a dated follow-up PR (X4b), never a test
with a date baked into it.

### Manual cron triggers

Cloudflare's cron dispatch has, at least once, simply stopped firing for
this Worker's registered triggers (zero scheduled invocations over 25
minutes observed on the deployed service, no error surfaced anywhere but a
stale `/v1/meta`) -- these three routes let an admin force a tick without
waiting it out. `wrangler dev --test-scheduled`'s `/__scheduled` endpoint
also ignores a `?time=` override, so there is no LOCAL way to drive the
`hour=3, minute=0` nightly slot either -- `POST /v1/admin/nightly/tick`
exists mainly for that: an operator who needs a fresh dump written (a
rehost drill, say) has no other way to force one short of waiting for a
real 03:00Z. All three call the EXACT SAME function(s) `scheduled()` calls
for the real cron (`tests/api/admin.test.ts` asserts this with a spy shared
across both call sites for each route), so there is no second
implementation of any tick to drift out of sync with the real one; all
three are admin-only, rate-limited the same as every other write here, and
append one `admin.*` event to the public feed (`admin.import_ticked` /
`admin.diff_ticked` / `admin.nightly_ticked`).

| route | body | 200 response | other statuses |
|---|---|---|---|
| `POST /v1/admin/import/tick` | none | `{ ran: true, ...tick()'s own TickStats }` (`quiet`/`applied`/`full_pass`/... -- `src/import/cmini.ts`'s `TickResult.stats`, unchanged) | `409 import_paused` if the import is paused (`POST .../resume` first); the usual admin `401`/`403`/`429`/`503` |
| `POST /v1/admin/diff/tick` | none | `{ ran: true, ...diffTick()'s own LastDiffRecord }` (`ok`/`corpus`/`samples`/... -- the same shape `import_state['cmini.last_diff']` stores) | the usual admin `401`/`403`/`429`/`503` (no "paused" state exists for the diff) |
| `POST /v1/admin/nightly/tick` | none | `{ ran: true, at, jobs: { "prune-auth-cache": "ok"\|"error", "prune-rate-limits": "ok"\|"error", "prune-nonces": "ok"\|"error", "write-dump": "ok"\|"error" }, dump: writeDump()'s own { key, latest } or null }` -- `src/core/nightly.ts`'s `runNightly`, the SAME job list `scheduled()`'s `hour=3, minute=0` branch runs, each job guarded (`core/jobs.ts`'s `runJob`) so one failing never skips the rest | the usual admin `401`/`403`/`429`/`503` (no "paused" state exists for this job set either) |

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
