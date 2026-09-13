# `akl-db`

Updated 2026-09-11 (20-spark.md).

The layout-db service (`design/layout-db/`): a Cloudflare Worker with its
own D1 database and R2 bucket, mirroring cmini's layouts -- read-only in
phase 1, now also accepting direct writes. Deployable independently of the
rest of this repo -- see `00-plan.md` §7 for why nothing here imports from
`../web`, `../scripts` or `../functions`, and nothing outside imports `db/`
(enforced by `tests/tools/boundary.test.ts`, LDB-G5).

Full design: `design/layout-db/00-plan.md` (why) and
`design/layout-db/07-implementation-phase1.md` (what phase 1 shipped, slice
by slice; `design/layout-db/20-spark.md` is the current plan + ledger).
Invariants: `INVARIANTS.md` (this directory). **Building a client (a bot, a
site, a script, or an agent)?** Start at `db/docs/adoption.md` -- the
primary, code-checked adoption guide: lanes, registration, reads, staying
current, writes, limits, format authoring, and the full endpoint table.
`INTEGRATION.md` (this directory) is the older integration note, kept for
its design-doc cross-references and the generated error-code appendix.
Both docs, plus the rest of `design/layout-db/*.md`, are rendered onto the
site as the `/layoutdb/` hub (`design/layout-db/build_site.mjs`, `LDB-G9`).

## API versioning

The HTTP API's own version (distinct from a stored format's own major,
below): `design/layout-db/25-api-versioning.md` is the audit + policy
(`/v1` additive-only, `X-AKLDB-API` header + `GET /v1/meta`'s `api` block,
the `tests/contract/` golden, `CHANGELOG-API.md`). `db/CHANGELOG-API.md`
is the dated changelog; `db/INTEGRATION.md`'s "Versioning" section is the
client-facing summary.

## Formats

**A layout can hold several formats at once** (`design/layout-db/
21-formats.md`, F2, 2026-09-11): `layout_formats` has one row per (layout,
lineage), each with its own rev/timestamps/`has_magic`/payload,
independent of every other format the same layout has and of the layout's
own name/owner/deletion (`layouts.layout_rev`) -- two disjoint write
scopes per layout, each with its own `If-Match` token (below). `spark/1` is
the one **stored** format today (`akl/1` renamed at the same payload shape,
byte for byte -- `design/layout-db/20-spark.md` decision 1): every write
naming it ends up in `layout_formats` under lineage `spark`. `mana2/1` is
an **output-only, derived** shape -- never stored, produced from whichever
ONE stored lineage is registered to reach it (`spark/1` today) on every
read that asks for it explicitly (`?format=mana2/1`); a write naming it is
`400 format_not_writable`. Each output format is reachable from exactly
one stored lineage (`MF-10`) -- a second stored lineage wanting the same
output edge needs an explicit way to say so, not designed yet. cmini is an
**import source**, not a stored format lineage -- the importer converts
each upstream detail to spark on arrival, touching the layout's own
fields and lineage `spark` only. There is no `akl/1` alias, no `?as=`
query parameter at all any more (`design/layout-db/21-formats.md` D4/D5/D12):
`?format=` is the one name everywhere, and it is **required** on every
route that returns a payload -- there is no default, `400
format_required` without one. `spark/1` also lost its free-form `x` field
in the F1 slice (D10) -- see `design/layout-db/22-spark-spec.md` for the
current spec. `GET /v1/formats` is the live registry (`role`,
`can_translate_to`, and an `aliases` field kept for wire compatibility but
always `[]` now that there are none).

**New error codes** (`src/core/errors.ts`, `db/INTEGRATION.md`'s
generated appendix): `format_required` (400, no `?format=`/`format`),
`format_absent` (404, this layout has no such format and can't derive it
-- distinct from `unknown_format`, the id itself unregistered), `format_exists`
(409, `PUT … If-None-Match: *` naming a lineage the layout already has),
`mixed_patch` (400, a PATCH body naming both `name` and a format edit --
each write has exactly one scope).

**The chain.** A format lineage can grow a second (and later) major without
breaking older clients: `up`/`down` convert one major to the next/previous
(down is held or lossless), a write in an older major is chained up to the
latest automatically (`detail.written_as` on the event), and a blind
overwrite that would lose newer content is refused with `409
format_behind` instead of silently discarding it. With only `spark/1`
registered today the mechanism is exercised by a test-only stub lineage --
see `db/formats/registry.ts` and `db/docs/adoption.md` §7/§8.

**`upstream` is transitional.** Every record carries `upstream: {source:
"cmini", id, state: "following" | "forked"} | null`, folded from import and
write events (`core/upstream.ts`'s `nextUpstream`) -- it answers exactly one
question, "does the importer still own this record's keys and board", for
exactly as long as the one-time cmini import keeps running. Nothing outside
the importer, the daily upstream diff, and the one-time record migration
reads it for any decision; it is retired along with the import
(`20-spark.md` decision 16, §6b). Don't build client behavior on it.

**Every edit records its source.** `Write.source: {client, version}` is
required on every write and folded onto the record and its events: `client`
is proven (`client:<id>` on the client lane, `discord-app:<app id>` on the
user lane, `system:cmini-import`/`system:migration` for system writers) --
never a header or body field a caller controls; `version` is whatever the
caller sends as `X-Client-Version`. History predating this (`0005_spark.sql`)
reads `source: {client: "legacy:<via>", version: null}`.

**Writes require a SCOPED `If-Match` (LDB-P2/MF-11, restated by
21-formats.md for several formats per layout):** no client may write to an
existing scope without naming the version it saw, and the token must name
the write's OWN scope -- `"layout:<layout_rev>"` for a layout-level write
(rename, delete, transfer), `"<lineage>:<rev>"` (e.g. `"spark:7"`) for a
format write. `PUT /v1/layouts/{ref}`, `PATCH /v1/layouts/{ref}`, `DELETE
/v1/layouts/{ref}` and `POST /v1/layouts/{ref}/transfer` all refuse a
request with no `If-Match` header -- `400 if_match_required`
(`src/core/errors.ts`), checked before any read or mutation. A bare
unscoped number, or the WRONG scope's token, is `400 bad_request` (MF-11) --
also checked before any read. A client's "overwrite" is never a blind
write: it must re-read the record first and send the scope's OWN current
rev; `If-Match: *` still means "overwrite whatever is there, any scope",
but the client must say so explicitly -- absent is refused, not treated as
`*`. Two writers on DIFFERENT scopes of one layout never race each other
and both land (MF-6); only same-scope writers race. `POST /v1/layouts`
(creation), likes, `restore` and the `import:cmini` path are unaffected --
there is no prior version to name. Design: `design/layout-db/
09-implementation-phase2.md` §2.1 (the error vocabulary), §2.3 (`If-Match`
mechanics), `design/layout-db/21-formats.md` §2.2/§2.3 (the scoped rewrite).

## Dead columns

`layouts.like_adjust` (added by `migrations/0014_moderation.sql`) is a dead
column since `migrations/0015_drop_like_adjust.sql` (H24, saltorbit
2026-09-13): the admin like-count override it backed was removed entirely
("mods should not be able to override the like count" / "likes should
always be tied to the users who liked it, not be just an opaque number you
can set") -- `like_count` is once again exactly `COUNT(DISTINCT user_id)
FROM likes` and no code reads or writes `like_adjust` any more. It stays
physically on the table, `NOT NULL DEFAULT 0`, rather than being dropped --
D1's migration tooling can't reliably drop a SQLite column in place, and
this DB is disposable (wiped + re-imported at cutover, `design/layout-db/
review/` conventions), so a harmless dead column is the simpler, safer
path over a full `layouts` table recreation.

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
| `IMPORT_DELETES` | var | `src/import/cmini.ts` (`importDeletesEnabled`, LDB-I23) | `wrangler.toml`'s `[vars]`; default `"on"`; `"off"` is the hostile-upstream kill switch -- the importer never tombstones anything while set |
| `DISCORD_API_URL` | var | `src/auth/discord.ts` (T1) | `wrangler.toml`'s `[vars]`; default `https://discord.com/api`; tests inject `fetchImpl` directly and never resolve this URL |
| `CLOUDFLARE_DB_TOKEN` | repo secret (CI) | `.github/workflows/db.yml`'s `deploy` job (S7) | a Cloudflare API token with Workers Scripts + D1 + R2 edit, separate from the site's Pages token |
| `CLOUDFLARE_DB_ACCOUNT_ID` | repo secret (CI) | `.github/workflows/db.yml`'s `deploy` job (S7) | the NEW community account's id (00 §1) -- NOT the site's `CLOUDFLARE_ACCOUNT_ID` |
| `DB_BASE_URL` | repo/org variable (CI) | `.github/workflows/db.yml`'s `daily` job (S7) | the deployed service's own origin, e.g. `https://akl-db.<account>.workers.dev`; set once the service is deployed |
| `TEST_ROUTES` | test-only miniflare binding | `src/index.ts`'s throwaway `/v1/__test/write` route | set unconditionally in `vitest.config.ts`; never present outside tests |
| `TEST_MIGRATIONS` | test-only miniflare binding | `tests/setup-workers.ts` | built from `migrations/` by `vitest.config.ts` at test-run time; never present outside tests |
| `TEST_REHOST_DUMP_URL` | test-only miniflare binding | `tests/rehost.test.ts` (S7) | threads the real `REHOST_DUMP_URL` env var (set only by db.yml's `daily` job) into the miniflare Worker; empty string locally, so `npm test` always runs the local (cron-driven) half of the rehost drill |

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
| the import tick (`cminiTick`) | `pruneAuthCache`, `pruneRateLimits`, `pruneNonces`, `writeDump` (the nightly dump, below) | `diffTick` (the diff cron, below) |

Each of the (up to five) jobs one invocation can run is caught and logged
independently (`src/index.ts`'s `runJob`) -- one job throwing (an upstream
outage during the import tick, say) never stops the others queued after it
in the same invocation from running. `tests/import/tick.test.ts`'s
`[isolation]` case and its `[matrix]`/`[property]` cases (every 5-minute
slot of a day, and a property over any two slots 5 minutes apart) are this
dispatch's own regression suite.

**Dump/diff catch-up (LDB-D8).** hour=3/hour=4 are the PREFERRED slots for
the dump/diff, but neither is exclusive to them any more: on every OTHER
invocation, `scheduled()` reads `import_state`'s own record for each
(`dump.last_at`, `cmini.last_diff`) and runs the job anyway if it is
missing or its `at` is more than 24h before this tick -- a cron dispatch
Cloudflare drops for the one slot that matters no longer skips a whole day
silently; the very next successful tick (at most 5 minutes later) catches
up instead. Under normal operation this never double-runs within 24h: a
successful hour=3/hour=4 run leaves the record fresh, so the immediately
following ticks' own catch-up checks are false. The diff is checked (and,
if due, run) BEFORE the dump on every invocation, so a tick where both
catch up at once has the dump's own snapshot already reflect the diff's
fresh state rather than being one write behind it. `GET /v1/meta.health`
(below) surfaces both records' staleness for monitoring.

## Rogue trusted client

A client registered `act-as-user` (§1.1 of `docs/adoption.md`) can assert
*any* Discord user's identity -- that trust is the client's to keep, and
the layer below assumes it's kept. saltorbit, 2026-09-13: "do we have recourse
if [a trusted client] crashes out and abuses their trusted powers to wipe
everything?" Two layers of recourse exist; work through them in order.

**0. Automatic backstop, before you do anything.** Every registered
client's DESTRUCTIVE writes (delete, rename, transfer, a format
replacement via `PUT`/`PATCH` on an EXISTING record, clearing an approved
link -- never a create, a like, or a format ADD) are counted against a
rolling 1-hour budget, `max(200, 5% of the live catalog)`
(`src/core/destructive-budget.ts`). A client that blows through it is
auto-suspended (`clients.status = 'suspended'`, distinct from `revoked`):
every further request from it -- reads included -- gets `403
client_suspended` from the moment it trips, and the trip itself is a
public, `admin`-kind event (`admin.client_suspended`, actor
`system:budget-guard`) on `GET /admin/changelog`. This bounds a rogue
client's worst case to a small slice of the catalog per hour instead of
the whole thing in the ~10 minutes `CLIENT_LIMIT` (`src/auth/
ratelimit.ts`, 5000 writes/10min) would otherwise allow -- but it is a
backstop, not a substitute for the steps below: it does nothing about
damage already done before it tripped, and a client causing damage slowly
enough (or spread across many hours) never trips it at all.

**1. Detect.** `GET /v1/meta`'s `health.clients.suspended` lists anyone
currently auto-suspended (`{id, name, at, reason}`) -- check this first,
it costs nothing. Otherwise, the existing revocation story
(`docs/adoption.md` §1.1/§2.1) still applies: every write is permanently
attributed to its client id on `GET /admin/changes`/`GET
/admin/changelog`, so a client behaving badly is one query away
(`?actor=` or eyeballing `source.client` on the feed).

**2. Suspend or revoke.** If it's not already auto-suspended,
`POST /v1/admin/clients/{id}/suspend` (admin lane, optional `{reason}`)
stops it immediately without losing the registration -- prefer this over
`DELETE /v1/admin/clients/{id}` (revoke) whenever you expect to want it
back: revoke is **terminal** (an admin can never move a revoked client to
`suspended` or `active` again; re-onboarding needs a fresh registration,
a new key). Either way, `clients.status` is read fresh on every request
(LDB-A9/LDB-A11) -- no cache window.

**3. Dry-run the damage.** `POST /v1/admin/clients/{id}/revert
{"since": "<ISO timestamp>", "dry_run": true}` walks every destructive
write that client made at/after `since` and reports, per event, what it
WOULD do: `reverted` (safe to undo), `skipped_no_op` (already back to
that state), or `skipped_newer_write_by_other` (someone else's later,
legitimate edit sits on top of it -- never touched). Nothing is written.
Read the plan before acting on it.

**4. Revert.** The same call with `dry_run: false` (or omitted) actually
undoes it: a tombstone restored, a rename/transfer undone, a format
payload rolled back to its prior `layout_revs` row **as a new revision**
(history is never rewritten -- every payload that ever existed stays
findable at its own rev), a cleared link restored. Bounded per call (a
`next` cursor -- keep calling with it until `next` is `null`); idempotent
(running it again reverts nothing new, so it's safe to retry or to run
opportunistically); every reverted write is its own event, attributed to
`system:revert` and naming the admin and the original event's `seq`, so
the revert itself is on the public changelog too.

**5. Last resort: restore from backup.** If the damage predates your
`since` window, or predates the client's own registration somehow, or
`revert` can't reach it (an OTHER actor's later write blocked it, and
that write itself needs undoing by hand) -- the nightly R2 dump
(`GET /v1/dump/latest.json`, "Rehost procedure" below) is the full event
log and every table, gzipped, off the account. `tests/rehost.test.ts` runs
this exact restore path daily against the real deployed dump, so it is
never a cold, untested path when you actually need it.

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

**What a rehost DOES restore (LDB-D9):** `clients` -- registered bot
pubkeys, caps and status. Unlike the now-deleted `webhooks` table
(LEDGER.md L4), nothing on this table is a secret (10 C1 §4), so there is
no reason for a rehost to lose every registered bot key and need the
admin bootstrap redone; it is dumped and restored like any other table.

**What a rehost does NOT restore:** `auth_cache` (never dumped -- it holds
only token hashes with a <=5-minute lifetime; a rehost starts with a cold
cache, so the next authenticated request just re-verifies with Discord),
`nonces` (never dumped -- the client-lane replay guard, <=300s lifetime by
construction, so a rehost simply starts with no history of recent
requests), and `ratelimit` (rate-limit windows; starting empty only ever
makes a request succeed sooner, never later). All three tables are wiped
by `restoreSql`'s own `DELETE FROM` pass and never re-populated -- this is
intentional, not a gap. `dump.last_at` (LDB-D8, the dump's own scheduling
bookkeeping) is likewise excluded from `import_state`'s dumped rows
specifically -- a restored database starts eligible for an immediate
catch-up dump instead of carrying a stale ex-deployment's memory of
"already dumped".

**The daily proof** (`.github/workflows/db.yml`'s `daily` job, 04:00 UTC):
fetches the real `latest.json` from the deployed service and uploads it as
a 30-day-retention CI artifact (LDB-C6 -- a free, off-Cloudflare copy, so a
lost/corrupted D1 + R2 account still has a rehostable dump sitting in
Actions), runs `tests/rehost.test.ts` against it (restores the dump into
the job's own throwaway D1 and re-runs the whole conformance suite against
the restored copy), and separately runs the upstream diff (S8). Both fail
the job loudly on any problem -- neither is allowed to skip silently.

## Weekly backup in GitHub (db-backup.yml)

`.github/workflows/db-backup.yml` (saltorbit, 2026-09-13: "at least weekly backups
in github") runs Sundays 06:00 UTC and on demand: it fetches
`/v1/dump/latest.json` + the dump from https://api.akldb.org, verifies the
sha256, and stores both as assets of a GitHub Release tagged
`akldb-backup-<UTC date>` in this repo -- kept indefinitely, outside
Cloudflare and outside the git history. Restore from one the same way as
from an R2 dump (below). The daily 30-day artifact (LDB-C6) stays as the
finer-grained copy.

## Point-in-time restore with D1 Time Travel

Cloudflare's D1 Time Travel gives 30 days of point-in-time restore on the
Workers Paid plan, free, with no separate backup job -- it is a second,
finer-grained safety net alongside the dump/restore above (RPO minutes
instead of up to 24h, at the cost of restoring the WHOLE database to one
instant, not individual tables or rows).

```bash
# Find restorable bookmarks (also printed by db.yml's pr-deploy job before
# every deploy, as a rollback bookmark):
npx wrangler d1 time-travel info akl-db

# Restore to a specific bookmark or timestamp (`--timestamp` accepts an ISO
# 8601 instant or a Unix epoch second):
npx wrangler d1 time-travel restore akl-db --bookmark=<bookmark>
npx wrangler d1 time-travel restore akl-db --timestamp=2026-09-12T03:00:00Z
```

**Caveat:** Time Travel restores the ENTIRE database to that instant --
there is no way to restore just `layouts` or just one row. A restore
also does not touch anything outside D1 (R2 dumps, the deployed Worker
code, Fly/spark's own cell store) -- coordinate those separately if the
restore point predates a schema migration or a code deploy that assumed
one. Prefer this for "something is subtly wrong and I need last Tuesday
back" over "I need one layout's history," which `GET /v1/changes` (the
event log) already answers without touching D1's storage layer at all.

## Fresh-D1 restore rehearsal

A rehearsed checklist for "we lost the D1 database entirely, rebuild it
from a dump" -- run this for real at least once (recorded: **not yet run**;
whoever runs it first, log the date and minutes here) so the numbered
procedure above is proven, not just written down. Do NOT run this against
`akl-db`/prod -- a scratch D1 only.

1. `npx wrangler d1 create akl-db-rehearsal` (or reuse a previous scratch
   database). `rehost.mjs` always targets `akl-db` (or, with `--env
   preview`, `akl-db-preview`) -- it has no "restore into an arbitrary
   name" flag -- so a genuine fresh-D1 rehearsal needs a scratch
   `[[d1_databases]]` entry (temporarily added to a throwaway copy of
   `wrangler.toml`, never committed) naming `akl-db-rehearsal`, or drive
   `wrangler d1` directly by database name/id as steps 2-5 below do (this
   is the CLI-only path -- no wrangler.toml binding required for `d1
   migrations apply`/`d1 execute` against a name you already have).
2. `npx wrangler d1 migrations apply akl-db-rehearsal --remote` -- every
   migration in `migrations/`, in order, against the empty database.
3. Fetch a real dump (`curl -O <service>/v1/dump/latest.json`, follow its
   `url`, gunzip it) and note its `meta.layout_count`/`meta.seq`.
4. Render the restore SQL through the SAME code `restoreSql`/`restoreInto`
   are tested through -- never a hand-written INSERT -- then apply it:
   ```bash
   node -e '
     import("./src/dump/restore.ts").then(({ restoreSql }) => {
       const dump = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
       require("fs").writeFileSync("restore.sql", restoreSql(dump).join(";\n") + ";\n");
     });
   ' <path-to-decompressed-dump.json>
   npx wrangler d1 execute akl-db-rehearsal --remote --file restore.sql
   ```
5. Verify: `npx wrangler d1 execute akl-db-rehearsal --remote --command
   "SELECT COUNT(*) FROM layouts WHERE deleted = 0"` equals the dump's
   `meta.layout_count`; `SELECT MAX(seq) FROM events` equals `meta.seq`.
6. Record how long steps 1-5 took (this is the rehost RTO estimate) and
   `npx wrangler d1 delete akl-db-rehearsal` to clean up.

## Verify the mirror

`npm run diff-upstream` (`scripts/diff-upstream.mjs`, logic in `src/import/
diff.ts`, LDB-P5) is the shrunk upstream diff (LEDGER.md L4): it compares
our `layout_count` to upstream's `/meta`, then draws a random sample (50 by
default, `DIFF_SAMPLE_SIZE` to override) of our own live, `following`
layouts and content-compares each against a fresh single-record upstream
fetch on the `spark/1` projection (likes sorted, magic excluded) -- never
the whole upstream corpus. A sampled name upstream no longer answers for is
reported `missing`; a genuine content mismatch is `contentDiffs`, with the
first differing JSON path. Exits 1 on any real difference (a count
mismatch, a missing sampled layout, or a content diff).

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

A second copy of the same shrunk comparison above, run automatically every
day at 04:00 UTC by the Worker itself (`src/import/difftick.ts`'s
`diffTick`), against our OWN D1 -- no HTTP, in either direction (LDB-C4):
`d1Ours` (`src/import/difftick.ts`) draws its sample with one `ORDER BY
RANDOM() LIMIT n` query joined to each layout's `spark/1` row, plus one
chunked likes read -- never a full-corpus page. Every run -- success or
failure -- writes `import_state['cmini.last_diff']`; `GET /v1/meta`
exposes it as `last_diff: {at, ok} | null` (LDB-M1); the full summary
(`layout_count`/`sample_size`/`matched`/`missing`/`invalid_upstream`/
`content_diffs`, plus up to 10 samples of each kind of mismatch) is
admin-only, at `GET /v1/admin/health`.

`.github/workflows/db.yml`'s `daily` job also runs `tests/rehost.test.ts`
(the in-process rehost proof, above) alongside the live diff -- both fail
the job loudly on any problem, neither is allowed to skip silently.

**Staleness (LDB-M2).** `GET /v1/meta` also carries `health`:

```json
"health": {
  "dump":  { "last_at": "2026-09-12T03:00:00.000Z", "seq": 526, "age_s": 3600, "stale": false },
  "diff":  { "last_at": "2026-09-12T04:00:00.000Z", "age_s": 0, "stale": false }
}
```

`stale` is `age_s > 48h` (twice the 24h catch-up threshold above, so a
genuinely stuck job reads unambiguously differently from one merely between
ticks); a record that has never run (`last_at: null`) is always
`stale: true`. Deliberately NOT folded into the route's ETag -- `age_s`
moves every second, and hashing it in would defeat the 304/edge-cache this
route exists for; a client relying on a cached body sees a slightly stale
`age_s`, bounded by the route's 10s `Cache-Control: max-age`.

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
| `POST /v1/admin/import/tick` | none | `{ ran: true, ...tick()'s own TickStats }` (`quiet`/`applied`/`full_pass`/... -- `src/import/cmini.ts`'s `TickResult.stats`, unchanged) | `409 import_paused` if the import is paused (`POST .../resume` first); `409 import_running` if another tick already holds the `cmini.running` lock (below); the usual admin `401`/`403`/`429`/`503` |
| `POST /v1/admin/diff/tick` | none | `{ ran: true, ...diffTick()'s own LastDiffRecord }` (`ok`/`corpus`/`samples`/... -- the same shape `import_state['cmini.last_diff']` stores) | the usual admin `401`/`403`/`429`/`503` (no "paused" state exists for the diff) |
| `POST /v1/admin/nightly/tick` | none | `{ ran: true, at, jobs: { "prune-auth-cache": "ok"\|"error", "prune-rate-limits": "ok"\|"error", "prune-nonces": "ok"\|"error", "write-dump": "ok"\|"error" }, dump: writeDump()'s own { key, latest } or null }` -- `src/core/nightly.ts`'s `runNightly`, the SAME job list `scheduled()`'s `hour=3, minute=0` branch runs, each job guarded (`core/jobs.ts`'s `runJob`) so one failing never skips the rest | the usual admin `401`/`403`/`429`/`503` (no "paused" state exists for this job set either) |

`POST /v1/admin/dump` is a fourth, narrower manual trigger: it calls
`dump/write.ts`'s `writeDump` directly (the exact same path the nightly
job's `write-dump` step and LDB-D8's own catch-up check use), needed
because the layoutdb cutover imports into a wiped DB and the bot/site
rebuild boot from the daily dump -- an operator can't wait for the next
`hour=3, minute=0` slot right after a wipe-and-reimport. Unlike the three
tick routes above, it appends no `admin.*` event (a dump write carries no
per-record content worth logging on the public feed).

| route | body | 200 response | other statuses |
|---|---|---|---|
| `POST /v1/admin/dump` | none | `{ seq, layout_count, written_at }` (`writeDump()`'s own `latest.json` fields, plus the clock value it was written at) | the usual admin `401`/`403`/`429`/`503` |
| `POST /v1/admin/magic-seed` | `{ ref, magic }` | `{ id, name, rev, has_magic, upstream }` -- the record's `magic` replaced through spark/1's `setMagic` + `validate()`, written as `system:magic-seed` via `seed:aklgg` (a one-time migration: never forks, sets `upstream.state` back to `following`; design/layout-db/23-geometry.md §10.1, 20-spark.md decision 14) | `400 bad_request`/`invalid_payload`/`magic_collision`, `404`, the usual admin `401`/`403`/`429`/`503` |

### Magic rules seed (one-time, M2)

`design/layout-db/17-magic-ownership.md` §4 M2: the one-time migration that
seeds every record's `magic` from akl.gg's own rule sets, the last time
akl.gg's copy is read as a source -- from then on akl.gg's rules editor
writes `PATCH /v1/layouts/{id} {magic}` directly (M3). **Prerequisite:
LDB-I12 (magic-only writes never fork a record from upstream, `18
-command-decisions.md` §2 item 1) must already be deployed** -- this script
writes through `PUT` (a whole-payload replace, not `PATCH`; see below for
why), and without LDB-I12 every migrated record would stop receiving
upstream's `!cmini` key edits the moment this script touched it.

**Historical since `spark/1` (2026-09):** this migration already ran; its
prerequisite is retired going forward. Decision 6 of
`design/layout-db/20-spark.md` retires LDB-I12's magic-only exemption, and
the `isMagicOnlyReplace` check and `detail.magic_only` event marker this
section's mechanics describe below were deleted in the same rewrite. A
magic-only write today forks like any other user edit and bumps
`modified_at`. **Further update (2026-09-11, `21-formats.md` D12, F1):**
`legacyFollows`/`core/follows.ts`, `isMagicOnlyReplace`, and the
`magic_only` event marker are deleted outright now, not just retired in
behavior, and LDB-I12's own registry row is gone from `INVARIANTS.md`
(retired, `legacyFollows` no longer exists to define even historically --
see that file's retirement log). Nothing in this section is meant to run
again -- it's kept for the record of what M2 did and why.

**What `scripts/migrate_magic_rules_to_db.py` does, per layout id** in
`web/data/magic_rules.json` (the nightly build's served rule sets, seed ⊕
D1):

1. `GET {base_url}/v1/layouts/{id}?as=akl/1` -- unauthenticated. A 404 is
   logged `missing` and skipped (the layout isn't in the DB).
2. The candidate `magic` is the rule set stripped to
   `{magic_keys, chiral_keys, adaptive_swaps}` (akl/1's schema has no room
   for the seed file's `updated`/`notes`). If the record's current
   `payload.magic` already equals the candidate byte-for-byte, it's
   `skipped_identical` -- no request sent.
3. Collision detection runs **locally**, zero network traffic, via the
   real akl/1 `validate()` (`db/formats/akl/1/index.ts`, through the
   `db/scripts/validate-akl1-payload.mjs` node shim) against
   `{...record.payload, magic: candidate}` -- the same function
   `core/write.ts`'s `validatePayload` runs server-side. A `magic_collision`
   with a hint (the scaffold-vs-idiom case) has the hint applied and is
   re-checked once; still colliding, or no hint at all, is `collision`.
   Any OTHER validation failure (observed once in production: a rule set
   naming a key the layout's CURRENT board doesn't have) is its own
   `invalid` bucket, never folded into `collision`.
4. **Live mode only** (`--dry-run` sends no write, ever): `PUT
   {base_url}/v1/layouts/{id}` `{format: "akl/1", payload}` `If-Match:
   "<rev>"`, client-lane signed. This is a whole-payload PUT rather than a
   `PATCH {magic}` because the script reads the record through `?as=akl/1`
   (so it can run ONE local `validate()` regardless of the record's
   underlying stored format) and writes that same translated shape back --
   but the payload it sends never touches anything except `magic`: keys/
   board/free/x are exactly what the `?as=akl/1` read already produced
   (identity for an `akl/1` record, `fromCmini`'s lossless translation for
   a `cmini/1` one). `core/write.ts`'s `replaceLayout` recognizes this shape
   (`isMagicOnlyReplace`: the new payload minus `magic` equals the record's
   own current content minus `magic`, translated to a common format first
   when the format changed) and marks the resulting event `magic_only` the
   same way a `PATCH {magic}` does -- this is "the migration's equivalent"
   LDB-I12's own registry row names. A `409 stale` re-GETs and retries the
   write once against the fresh record; any OTHER non-2xx response aborts
   the whole run loudly (a one-shot admin tool, not something that should
   paper over a local/server disagreement).

**What it logs**: one `{id}: {bucket}` line to stdout per layout, and
`migrate-report.json` (`--report` to change the path): `{migrated: [...],
missing: [...], collision: [...], invalid: [...], skipped_identical:
[...]}`. `--dry-run` marks every `migrated` entry `"dry_run": true` (a
preview, not a confirmation -- no write was actually sent).

**Verify**: `scripts/verify_magic_migration.py --base-url <same base-url>
--migrate-report migrate-report.json` -- for every id in
`magic_rules.json`, compares the site's OWN compiler output
(`magicRulesFlatCompile`, via a real node shim) against the DB's
`?as=mana2/1` lowered rows (`payload.magic.rules`) as a set of `(inputs,
output)` pairs -- moved off `?as=cmini/1` once `spark/1 -> mana2/1` never
held and the cmini adapter's alias was slated for removal (now gone
entirely, `21-formats.md` D5) -- and fails if `migrate-report.json` still
has any `missing`/`collision` entry. Exit 0 only when every layout matches
and the report has nothing unresolved.

**After LDB-I12 lands, this seed forks nothing**: every migrated record's
last write is `magic_only`, so `followsUpstream` reads straight through it
to whatever rev-bumping event came before -- a record that was following
`!cmini` (`via: import:cmini`) keeps following it, and the very next import
tick that sees upstream's keys change writes them through, carrying the
just-seeded `magic` forward untouched (`import/apply.ts`'s `akl/1` branch
of case 4, LDB-I11/I12).

**⚠ saltorbit, once, per target DB -- never run by an agent, never against a
remote from this checkout.** Register an ops client via `POST
/v1/admin/clients` (an existing admin registers it, `bot/scripts/gen-key.mjs`
mints the keypair): `act-as-owner-only` is NOT right here (this writes to
records owned by many different users) -- register it as a plain
admin-actor client instead (whatever `POST /v1/admin/clients` shape 10 C1
gives an unrestricted client; see `INTEGRATION.md`'s client-lane
section), then:

```bash
cd db
python3 ../scripts/migrate_magic_rules_to_db.py \
  --base-url "$DB_BASE_URL" \
  --actor <the ops Discord user id every migrated write is attributed to> \
  --client-id <the registered client id> \
  --private-key-env MIGRATION_PRIVATE_KEY
# reads web/data/magic_rules.json, writes ./migrate-report.json (repo root)

python3 ../scripts/verify_magic_migration.py \
  --base-url "$DB_BASE_URL" \
  --migrate-report ../migrate-report.json
```

Run `--dry-run` first (add the flag to the first command) and read its
report -- `collision`/`invalid`/`missing` entries need saltorbit's call before a
live run (17 §4 M2: "the 10 layouts whose rules the seed would fork" need a
decision first). The live run is idempotent: re-running it after a partial
or fully successful pass sends zero further writes for anything already
`skipped_identical`.

### R2 lifecycle

`akl-db-dumps` has a lifecycle rule deleting objects under the `dump-`
prefix after 90 days (hand-configured once, `00 §1`/`08-infrastructure.md`
§1) -- this only ever touches the daily `dump-YYYY-MM-DD.json.gz` keys;
`monthly/dump-YYYY-MM.json.gz` doesn't match that prefix and is kept
indefinitely (the long-term archive), and `latest.json` is a single,
always-current object nothing ever expires.

### Hostile or vanished upstream

saltorbit, 2026-09-13: "i am concerned about the cmini owner crashing out and
deleting their db when this goes live." The importer mirrors cmini every 5
minutes; these are the layers that keep a bad upstream (a hostile deletion
spree, an outage, a broken response shape) from mass-deleting our own
mirror, from what an admin sees, to the last-resort recovery.

**What stalls automatically** (`import_state` key `cmini.stalled`, a JSON
`{at, reason}`, instead of applying that tick's deletes):

- **LDB-I3, the per-tick bound**: more than `max(5, 5%)` of live records
  unlisted in ONE tick stalls that tick's deletes entirely (never partial).
- **LDB-I6, the collapse guard**: an upstream listing shorter than half the
  live record count -- including a genuinely EMPTY list, or upstream
  vanishing behind a non-2xx/malformed response (`import/upstream.ts`
  throws after 3 retries, which aborts the WHOLE tick before anything is
  written, no state change at all) -- stalls the whole tick, fetches
  included, not just deletes.
- **LDB-I22, the rolling 24h budget**: `max(20, 2%)` of live records may be
  tombstoned in ANY trailing 24h window (not just one tick) -- closes the
  "slow drip" the per-tick bound alone allows (5% every 5-minute tick, 288
  ticks/day, empties the whole corpus in a day). Same `cmini.stalled` key,
  same never-partial behavior. The two numbers were picked against the
  catalog's real churn: production's entire event history (45,257 events,
  2026-09-13) contains ZERO `upstream_deleted` events, ever -- `max(20,
  2%)` is generous next to that observed 0/day maximum while still capping
  a worst-case day at ~2% of the corpus instead of ~100%.

None of these are a "fix" -- they're a pause button. A real deletion is
still a tombstone either way (layout-level, formats untouched, restorable
by id at any time, LDB-P8) once it does apply.

**What an admin sees** -- `GET /v1/meta`'s `health.import` (LDB-M3):

```json
"import": {
  "stalled": { "since": "2026-09-13T12:00:00.000Z", "reason": "..." } ,
  "deletes_24h": 12,
  "deletes_budget_24h": 84,
  "deletes_planned": 5,
  "deletes_applied": 0,
  "deletes_disabled": false
}
```

`stalled` is `null` when nothing is stalled. `deletes_planned`/
`deletes_applied` are the LAST tick's own figures (0 applied while stalled
or while the kill switch is on, even if several were planned).
`deletes_disabled` mirrors the `IMPORT_DELETES` var below. The bot's
watchdog and the akldb.org admin console read this block; `stalled` is
folded into the ETag (a poller sees it move), `deletes_24h`/
`deletes_budget_24h` are not (continuously time-dependent, like
`health.dump/diff`'s own `age_s`).

**The three recovery calls** (`db/scripts/ops-call.sh`, admin lane):

```bash
# Lift a stall deliberately. NOT a fix: the very next tick re-plans from
# the SAME inputs and re-stalls immediately if the upstream is STILL bad.
sh db/scripts/ops-call.sh POST /v1/admin/import/unstall

# Bulk-restore upstream_deleted tombstones since a timestamp. dry_run
# first to see the candidate list; omit it to actually restore (bounded by
# `limit`, capped at 500 per call, safe to call again -- idempotent, and
# never touches a layout the OWNER deleted themselves).
sh db/scripts/ops-call.sh POST /v1/admin/import/restore-deleted '{"since":"2026-09-13T00:00:00Z","dry_run":true}'
sh db/scripts/ops-call.sh POST /v1/admin/import/restore-deleted '{"since":"2026-09-13T00:00:00Z"}'

# The kill switch: stop the importer from ever tombstoning anything,
# regardless of the listing, until you flip it back. A wrangler.toml edit
# + deploy (there is no runtime toggle route -- this is the "I don't trust
# upstream at all right now" lever, left outside the API on purpose).
# Edit wrangler.toml's [vars]: IMPORT_DELETES = "off", then:
npx wrangler deploy --config wrangler.toml
```

A cleared stall or a restored tombstone can also be done by hand (below),
but the admin routes are event-logged and preferred.

**Restore-from-backup, the last resort**: if the importer's own guards and
the recovery routes above aren't enough (the damage predates this guard
existing, or came from something else entirely), the daily R2 dump, the
30-day CI artifact, the weekly GitHub release, and D1 Time Travel are the
fallback layers -- see "Weekly backup in GitHub" and "Point-in-time
restore" below, in that order of preference (Time Travel restores the
WHOLE database to one instant; the others let you re-apply just what a
dump's `restoreSql` produces).

### Clearing `cmini.stalled` by hand

Prefer `POST /v1/admin/import/unstall` (above) -- it's event-logged. The
raw D1 statement, if you need it directly:

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

### The import lock

LDB-B4 (design/layout-db/review/audit-db.md B4): `tick()` takes
`import_state['cmini.running'] = {at, id}` (a CAS INSERT, or a CAS UPDATE
once the held value is >10 minutes old) before doing any real work, and
releases it in a `finally`. A `*/5` cron invocation that finds it already
held just logs `skipped_locked` and returns quietly (the next slot tries
again); `POST /v1/admin/import/tick` answers `409 import_running` instead.
If a Worker instance dies mid-tick (never runs its `finally`), the lock
self-heals after 10 minutes -- no manual clear is normally needed, but the
same `DELETE` used for `cmini.stalled` above works if you want it gone
sooner:

```bash
npx wrangler d1 execute akl-db --remote --config wrangler.toml \
  --command "DELETE FROM import_state WHERE key = 'cmini.running'"
```
