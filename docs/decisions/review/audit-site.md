# Site integration + stats pipeline: architecture audit

Branch `ldb-arch-review` (= `pipeline-313` state), 2026-09-12. Read-only. Paths are repo-relative.
Requirements weighed in this order: correctness of a site publish, simplicity, latency, cost
(`design/HARD-REQUIREMENTS.md` R4/R5; `db/` stays client-neutral).

**Verdict up front: replace, not keep.** Two complete stats pipelines exist on this branch and a
third half-path (`db_site_write`) is dead. Production akl.gg still runs the GitHub-Actions/D1
shape; the trial `db` alias runs the R2 pointer shape; both have full compute, plan, doorbell and
storage stacks. Finish the pointer shape as a *replacement* (one publisher, colocated with the bot,
no GitHub and no D1 in the stats path) and delete the rest. Section G has the ranked list.

## A. Data flow today, both shapes

```
                 cmini API (clemenpine.com/layoutapi/v3)
                    |  import cron */5, <=500 writes/tick        (db/wrangler.toml:16,20)
                    v
   +------------ layoutdb  akl-db Worker + D1, public /v1 only -------------+
   |  events/seq, /v1/meta ETag 10s, /v1/changes feed, nightly dump -> R2   |
   +----------------------+------------------------+-----------------------+
     ^ PUT/POST If-Match   |                        |  GET /v1/meta 30s doorbell
     | (user bearer)       | change feed ~2s        v
   akl.gg Pages Function   v                   stats service (Fly aklgg-stats-preview,
   functions/api/db/*   spark bot (Fly)        shared-cpu-2x, vol /work)   [TRIAL PATH]
   dbproxy.mjs           computes in wasm,       plan(make_plan) -> fast_sync_patch.run
     |  + repository_dispatch                    -> o/<overlay>/* + _manifest -> CAS pointer
     |    db_site_write (NO CONSUMER)                  |  bearer -> data-writer Worker
     v                                                 v
   browser: promoted row from OWN wasm          R2 aklgg-data-preview: lines/H/current.json
   (state/db.ts:548-568)                        (15s), b/<base>/ (1y), o/<overlay>/ (1y)
                                                       ^ base = laptop-built web/data via
                                                       | publish_base.py (no CI)
                                                       v
                                                SPA pointer mode: pointer no-store at boot,
                                                re-read every 20 min (refreshPolling.ts:47)

   [PRODUCTION PATH, main, DB_BASE_URL unset everywhere]  -- reads cmini, NOT layoutdb
   cmini /v3/meta <-- meta-watch Worker cron */2 (wrangler.toml:28) --compare--> akl.gg
                      /api/stat-patches/cursor/state ; not covered -> workflow_dispatch
                      live-sync.yml (index.js:188-194)
   live-sync.yml: poll(scrape, make_plan, caps 10 layouts/96KiB else need-build -> build.yml)
        -> compute matrix 13 corpora x 25 min -> finalize -> D1 cb-magic:
           stat_patches, layout_patches, layout_authors, stat_patch_atoms, cmini_sync_log,
           sync_markers (live_patch_sync.py:40-63, 722-766)
   build.yml nightly 02:00 + every push to main: scrape, build_mana2 incremental, npm build,
        wrangler pages deploy aklgg, compact_stat_patches.py (build.yml:300-304, 397-464)
   full-rebuild.yml Sunday 03:00: 13-way matrix --full (full-rebuild.yml:24-27,108-114)
   SPA: static web/data + /api/stat-patches/* (D1, 15 s cache, [[path]].js:69), spliced by
        patchRefresh every 20 min or on visibility (>=60 s floor, patchRefresh.ts:42,98)
```

Per hop, and what happens to an edit made 10 s ago:

| hop | trigger / frequency | latency | failure mode | edit 10 s old |
|---|---|---|---|---|
| cmini -> layoutdb import | cron */5, 500-write cap (`db/wrangler.toml:16,20`) | <=5 min | a forked record never re-imports (D9, `15-transition.md` §1) | not yet in layoutdb |
| site publish -> layoutdb | user action, `PUT` with `If-Match` (`state/db.ts:625,641`) | ~200 ms | 409 rebased locally, 5xx keeps the draft (`state/publish.ts:125-131`) | in layoutdb, event N |
| layoutdb -> bot | change feed + per-command `/v1/meta` check (`bot/src/cache/fresh.ts`) | ~2 s, <=1 command | bot refuses when layoutdb is unreachable | seen, computed in wasm |
| layoutdb -> stats service | ETag doorbell every 30 s (`doorbell.py:17-42`, `__main__.py:96`) | 30 s + scrape 14 s + compute 3.5 s to 522 s/layout (`02-handoff.md:49,239`) | batch >10 keeps `db_seq` stale for up to an hour; a restart loses in-memory batch patches (`02-handoff.md:51`) | planned next tick |
| stats service -> R2 | per tick, files then manifest then CAS (`publish.py:391-401`) | seconds | 412 -> re-read/re-merge; overlays never GC'd (`data-writer/src/index.js:14`) | published 2 to 60 min later |
| R2 -> browser | pointer no-store at boot; 20-min poll | <=15 s new load; <=20 min open tab | reload before the pointer moves shows the previous version (`02-handoff.md:330`) | invisible to others |
| **prod:** cmini -> meta-watch -> live-sync | */2 cron, then a GitHub run | 5 to 10 min for <=10 layouts; else a 9-min build.yml (`live-sync.yml:255-259`) | zombie queued runs, stall issue after 2 failures (`stall.js:61-81`) | invisible for >=5 min |
| **prod:** layoutdb -> site static data | **none.** Prod scrapes cmini (`cmini-scrape/action.yml:78-83`, `build.yml:289-292` on `vars.DB_BASE_URL`, unset per `02-handoff.md:21`); layoutdb never writes back to cmini (`15-transition.md` "No write-back") | never | a site publish is visible only as the publishing tab's promoted row; `publishedRows` drops any owned id with no catalog row (`ui/table/Body.tsx:143`) | **lost from the catalog on reload** |

The last row is the headline correctness finding: on production wiring, the publish UX writes to
a store the site's read path never consults. It is hidden today only because the publish surfaces
key off `/api/db/me` answering 200 (`11-implementation-phase3.md` W6 step 4), and prod has no
`DB_BASE_URL`. The flip must move `vars.DB_BASE_URL`, the Pages prod env and the site's stats
source in one motion, or R4's "what the site shows as published matches layoutdb" fails.

## B. The stats service (pipeline-313)

**What.** `scripts/stats_service/` on Fly (`stats/fly.toml:7-51`; image = Go 1.26 build of
mana2bridge + mana2 CLI + Python 3.12 + `data/` corpora, `stats/Dockerfile:14-42`). A tick:
conditional `GET /v1/meta`; `sync_cmini_data.py --source db` into its volume; strip `_dbId`/`_rev`
before hashing (`parity.py:44-66`); `live_patch_sync.make_plan` against a fake of the site's URLs
over `b/<base>` ⊕ `o/<overlay>` (`publish.py:107-210`); compute the changed layouts with the very
same `fast_sync_patch.run` live-sync uses (`publish.py:546-561` vs `live_patch_sync.py:508-521`);
render overlay files byte-identical to the D1 route's JSON (`overlay.py:1-39`); upload; CAS the
pointer. `db_seq` on the pointer means "every layoutdb event <= seq is reflected"; a partial batch
keeps the old seq (`publish.py:373-378`). Rules are desired state via one `rules_sig`
(`rules.py:1-46`). Tombstones are swept (I-318), identity refreshed once per DB (I-356).

**Cell model.** One cell = corpus × board × space, `mana2/<corpus>.<board>.<space>.json`
(`build_mana2.py:13,164-166`); 108 cells per plain layout, 78 per magic layout
(`fast_sync_patch.py:239-245`). Base tree: 553 files, 1.97 GB (`01-plan.md:527`).

**Who reads.** The trial SPA (pointer mode, `core/dataorigin.ts:84-187`, `data/origin.ts:87-136`).
The bot is *designed* to read the same pointer with exact provenance (B6, `01-plan.md:1011-1037`)
but today boots from akl.gg's static `/data/` harvest, 65 MB sequentially, plus
`magic_rules.json`, and a 530 from akl.gg at boot is fatal (`bot/src/engine/site.ts:71-95`,
`02-handoff.md:32`). So the bot's bulk still depends on the GitHub build of the *site*.

**Edit-to-visible.** Bot: ~2 s (own compute). Site, trial: 30 s doorbell + 14 s scrape + compute
+ upload, measured 74 to 245 s per write in the e2e run (`02-handoff.md:206`), then <=15 s for a
new load, <=20 min for an open tab. Site, prod: never (A, last row) for layoutdb edits; 5 to 10 min
for cmini edits.

**Is it a third piece of infrastructure? Yes, and it duplicates the other two.**

| function | prod (D1) | trial (R2) |
|---|---|---|
| doorbell | meta-watch Worker, */2 (`meta-watch/wrangler.toml:28`) | own ETag loop, 30 s |
| plan | `make_plan` in a GitHub job | same function in-process |
| compute | `fast_sync_patch.run` in 13 runner jobs | same function, one machine |
| store | 6 D1 tables + Functions routes | overlay files rendering those routes' bytes |
| base | nightly `build.yml` + Sunday `--full` | `publish_base.py` from a laptop build |

They also disagree on source (cmini vs layoutdb), and a content-hash planner cannot tell older from
newer, so running both writers would recompute layouts back to the older side (`01-plan.md` §6 F4).

**Could clients or the DB compute instead?**
- *DB Worker:* no. mana2 is two native Go binaries shelling over multi-MB corpus parses
  (`fast_sync_patch.py:113-165`), far past Workers CPU limits, and it would make layoutdb compute
  stats, which the owner ruled out (ecosystem page: "computes no stats").
- *Browser:* the swap engine does ~90 ms per recompute per cell, single-threaded; fine for the
  publishing tab's own row (already done, `state/db.ts:552-562`), not for 4,200 × 108.
- *Bot in-process:* it already runs the engine as wasm, median 121 ms, p95 200 ms per cell
  (`03-b6-plan.md:917-919`). 108 cells ≈ 10 s of wasm per layout, versus 0.5 s for the Go CLI
  on a laptop and 3.5 to 522 s on Fly `shared-cpu-2x` (`02-handoff.md:49,239`). Publishing is
  background work, so R2 is not at stake, but the native path is the right compute.

Conclusion: a publisher is needed as long as the site stays a static-bulk SPA (R5), but it should
be *the* publisher and it should live next to the bot: same Fly app, second process group, same
image lineage, driven by the change feed the bot already consumes instead of a second doorbell.

## C. The site write path

**Sign-in.** Discord OAuth `identify` (`functions/auth/discord/login.js:62-86`); HMAC-signed,
unencrypted `cmini_session` cookie, `HttpOnly; SameSite=Lax`, **no `Secure`** (`session.mjs:88`);
access + refresh tokens AES-GCM in D1 `discord_tokens` (`tokens.mjs:87-98`, `migrations/0008`).

**Client neutrality holds.** The proxy sends only `Authorization: Bearer <user's Discord token>`
and a UA (`dbproxy.mjs:54-70`); no client-signature headers exist under `functions/`. Ownership is
layoutdb's own 403 (`magic-rules/[id].js:215-221`). The Ed25519 client lane is used only by the bot
and one-shot scripts (`scripts/akl_client_signing.py`). Good.

**Proxy.** Routes are thin wrappers (`api/db/me.js`, `layouts/index.js:31-40`,
`layouts/[id].js:44-74`, `like.js`, `restore.js`, `transfer.js`). Headers in: `If-Match` only
(`dbproxy.mjs:60`); out: `Content-Type`, `ETag`, `Retry-After` allowlist (`:74-82`). 401
`token_invalid` -> one refresh and retry (`:125-131`); fetch throw -> 503 (`:67-68`); **409, 412,
429 and 5xx pass through byte for byte** (`:133`). Gaps: no upstream timeout, no body-size cap
(handoff has 4 MiB, `handoff/index.js:24`), and `dispatchAfterWrite` fires a GitHub
`repository_dispatch db_site_write` per write that **nothing consumes** (`dbproxy.mjs:143-201`;
grep of `.github`, `workers`, `scripts` is empty) using `GITHUB_DISPATCH_TOKEN`, stored as plain
text in Pages env (`02-handoff.md:89`).

**Publish flow.** Bench footer or card -> one modal target (`state/publish.ts:182-197`) ->
`publishDraft` (POST) or `updateDraft` (`state/db.ts:575-580,622-645`). Update is read-then-write:
`GET` the live record, refuse an unusable body, synthesize a local 409 on rev mismatch, else `PUT`
with `If-Match: "spark:<rev>"` (`:628-642`). R4 holds. On 2xx the record is *promoted*: a row with
the DB's id/name/rev but **the draft's own wasm stats and keys** (`promoteRecord`, `:548-568`),
inserted where the catalog lacks it (`state/list-actions.ts:190-223`); a real pipeline row later
wins and a tripwire diffs the two. 409 -> replay the step log onto the 409's record, no overwrite
verb (`:394-419,449-515`). 5xx -> error on the sheet, draft kept (`state/publish.ts:125-131`).

**Read-your-writes.** Membership of PUBLISHED comes from `listOwned` at boot and on visibility
(60 s throttle, `state/ownedReconcile.ts:21,43`); row content from static ⊕ overlay ⊕ promoted.
An owned id with no catalog row is counted but not rendered (`Body.tsx:143`). The site never
polls layoutdb for content, and never reads the DB's record back except id/name/rev. That is
acceptable under R5 *only if* the stats pipeline is the DB's follower; on prod it is not (A).

## D. Duplication and seams

| fact | copy A | copy B (and C) | reconciled by | drift |
|---|---|---|---|---|
| magic rules | D1 `cb-magic.magic_rules` (`[id].js:131-195`) | layoutdb `payload.magic` (`magicdb.mjs:231-294`); C: `web/data/magic_rules.json` (nightly) | `dbMode(env)` branch (`magicdb.mjs:68-70`); build `--source db` (`build_magic_rules.py:365-386`, `build.yml:289-292`) | `/api/stat-patches/rules/all` still serves D1 rows in DB mode (`[[path]].js:187-205`); overlay index capped at 40 records (`magicdb.mjs:50-51`); 5 stale rule sets for layouts cmini 404s (`02-handoff.md:80`) |
| stat cells | D1 `stat_patches`, `stat_patch_atoms` | R2 `o/<overlay>/mana2/*.json`; C: static `web/data/mana2` | nightly compaction (`compact_stat_patches.py:111-173`) vs overlay fold | two writers from two sources (B) |
| layout meta/keys | D1 `layout_patches` (`[[path]].js:96-118`) | `web/data/layouts.json`; C: overlay `layouts.json` | patch wins, null = tombstone | double-apply hazard (`app/patchSplice.ts:15-22`) |
| ownership | D1 `layout_authors` (`sync_prod_authors.py`, `live_patch_sync.py:557-571`) | `web/data/layout_authors.json` (`build_layout_authors.py`); C: layoutdb `owner` | diff-write into D1 per build; C never reconciled | three copies; `functions/admin/*` reads the table |
| dates | `data/layout-dates.json`, committed, rolled by `--update-dates` (`sync_cmini_data.py:1047-1082`) | layoutdb `created_at`/`modified_at`; C: promoted `publishedAt` | shelf prefers promoted > reconcile > build row (`core/publishedShelf.ts:142`) | three clocks; the dirty `data/layout-dates.json` in the main checkout is this file moving |
| likes | cmini `likes.json` -> `layouts.json.likes` (`build_web.py:465`) | layoutdb `like_count` + inline likes (`sync_cmini_data.py:129-137`) | none | site like toggle wired but unused (`state/db.ts:736-738`) |
| identity `_dbId`/`_rev` | DB-sourced scrape -> `layouts.json` (`build_web.py:175,481-483`) | overlay rows (I-356) | base from cmini has none -> owned layouts look unpublished -> POST -> duplicate-name 409 (`02-handoff.md:279-282`) | live in the trial |
| change signal | meta-watch vs `/v3/meta` | stats doorbell vs `/v1/meta`; C: bot change feed | none | three followers, three cadences |

## E. CI and ops cost

Runner-minutes per day, estimated from `design/ci-cleanup/01-notes.md` timings:

| source | schedule | min/day |
|---|---|---|
| push to main: gate (11 jobs) + build-deploy with data work | ~10 pushes | 270 to 330 |
| build.yml nightly (`0 2 * * *`) | 1 | 9 |
| live-sync poll ticks | ~40 | 40 |
| live-sync compute + finalize | 15 jobs per upstream delta | 15 × n |
| magic-rules-sync | **13 jobs per rules submit** (`magic-rules-sync.yml:62-69`) | 13 × submits |
| full-rebuild Sunday | 1/wk, ~230 aggregate | 33 |
| db.yml, backup, test.yml | daily/weekly | ~7 |

Roughly 370 to 440 min/day before per-edit fan-outs. The cost driver is not DB edits, it is that
**every push to main does a scrape, an incremental mana2 harvest, a 60-min Go reconciliation
test and a 2 GB Pages deploy** (`build.yml:131-136,300-313,397-402`), with no `timeout-minutes`
on `build-deploy` (`:78-82`) and a queueing concurrency group (`:33-43`). In pointer mode the code
deploy needs none of that (`npm run build:pointer`, `01-plan.md:789-790`).

D1 writes: live-sync ≈ 21 `rows_written` per changed layout per tick (13 stat rows + meta/author/
atoms/log/marker, `publish_stat_patch.py:156-170`, `live_patch_sync.py:634-708`); the historic
12,426-row authors wipe per build forced `sync_prod_authors.py`. The pointer path writes 0 D1
rows.

Hand deploys, not reproducible from a workflow: meta-watch (`workers/meta-watch/wrangler.toml:13-18,
36-37`), data-writer (`workers/data-writer/wrangler.toml:11-20`), the stats Fly app
(`stats/fly.toml:2-6`; recipe only in `02-handoff.md:227-231`), `cb-magic` migrations
(`design/DEPLOY.md:128-129`), the trial site (`02-handoff.md:357-364`, deploy from a copy outside
the repo). CI-reproducible: Pages prod, `akl-db` Worker + migrations, the bot. Footgun: `db.yml`
`pr-deploy` migrates and deploys **production** layoutdb on every push to the PR branch
(`db.yml:85-124`), decided by saltorbit, but any agent push is now a prod migration.

## F. Complexity inventory

Moving parts between layoutdb and a rendered site, marked keep / delete under the target shape:

| part | today | verdict |
|---|---|---|
| layoutdb Worker + D1 + import cron + dump | load-bearing | keep |
| Pages proxy `functions/api/db/*`, Discord OAuth, `discord_tokens` | load-bearing (R4) | keep; add timeout, size cap, `Secure`, drop `dispatchAfterWrite` |
| publish UX, promote, rebase, ownedReconcile | load-bearing | keep; render owned-but-uncatalogued rows from the record |
| stats service (Fly) | load-bearing in trial | keep as **the** publisher; move next to the bot |
| data-writer Worker + R2 pointer/base/overlay contract | load-bearing in trial | keep (small, gives CAS without R2 tokens); add lifecycle + daily fold |
| SPA pointer mode (`core/dataorigin.ts`, `data/origin.ts`) | load-bearing in trial | keep; poll 60 s not 20 min |
| meta-watch Worker | prod only | **delete** after flip (cmini changes arrive via the import) |
| live-sync.yml + `live_patch_sync.py` compute/finalize + `publish_stat_patch.py` | prod only | **delete**; keep `make_plan` + `fast_sync_patch.run` as the service's library |
| D1 `stat_patches`, `stat_patch_ngrams` (dead since #214), `layout_patches`, `stat_patch_atoms`, `sync_markers`, `cmini_sync_log` + `/api/stat-patches/*` + `patchSplice` | prod only | **delete** |
| `compact_stat_patches.py`, `sync_prod_authors.py`, `build_layout_authors.py`, D1 `layout_authors` | prod | **delete** once the magic PUT is DB-only and admin pages read `/v1/authors` |
| magic-rules D1 write path, `magic_rules`, `magic_rules_log`, magic-rules-sync.yml (13 jobs/submit), magic-rules-backup.yml, `fetch_d1_rules.py` D1 branch | prod | **delete** (already parked behind `DB_BASE_URL`) |
| `data/layout-dates.json` + `--update-dates`, `build_layout_dates.py` | committed churn | **delete**; dates from the record |
| `cmini-backup` orphan branch commits | prod | **delete**; the nightly dump is the backup |
| `db_site_write` dispatch + `GITHUB_DISPATCH_TOKEN` in Pages env | dead | **delete**, rotate token |
| build.yml data work on push; nightly; full-rebuild | prod | reduce to: code deploy on push (pointer build, no data); `full-rebuild` only when H changes, publishing a base |
| bot's boot dependency on akl.gg `/data/` + `magic_rules.json` | prod | **replace** with the pointer (B6) so the bot no longer depends on the site's build |

Radical option considered and rejected: the site fetching layouts + stats straight from layoutdb.
It would put 2 GB of stats behind the DB, make layoutdb a stats store (ruled out), and serve
per-layout reads on a catalog that renders 4,200 rows at once. The pointer over R2 is the right
static snapshot; the only thing wrong with it is that it was built *beside* the old pipeline.

## G. Ranked risks, fixes, target shape

1. **A site publish is lost from the prod catalog.** Prod reads cmini; layoutdb never writes back;
   owned ids without a catalog row render nothing (`Body.tsx:143`, `cmini-scrape/action.yml:78-83`).
   Fix: flip `vars.DB_BASE_URL`, Pages prod `DB_BASE_URL` and the site's stats source together, and
   render owned-but-uncatalogued rows from the DB record with on-demand wasm stats.
2. **Two stats writers, two sources.** live-sync (cmini) and the service (layoutdb) would flap
   (`01-plan.md` §6 F4). Fix: the flip disables meta-watch and live-sync before the service
   publishes a production line; make it one commit plus one Worker delete.
3. **Compute latency on `shared-cpu-2x`**: 36 to 522 s per magic layout, batches of 10 up to an
   hour, `db_seq` frozen meanwhile (`02-handoff.md:49-50`); a restart loses the batch. Fix: a
   performance machine, persist per-layout patches to the volume as they finish, and find out why
   a magic layout parses 26 corpora (A3 TODO).
4. **Overlays never garbage-collected** and are rewritten whole each tick (`index.js:14`,
   `01-plan.md:979`). Fix: an R2 lifecycle rule on `o/` older than N days, and a daily fold of
   base ⊕ overlay into a new base by the service (no compute), which also retires the nightly build.
5. **20-minute pointer poll and reload-before-move** (`refreshPolling.ts:47`, `02-handoff.md:330`).
   Fix: poll the 15-s-cached pointer every 60 s, and after an own publish re-read until
   `db_seq` covers the write's event; the promoted row already bridges the gap.
6. **Identity loss in pointer mode** (base from a cmini scrape, no `_dbId`/`_rev`): publish of an
   owned layout tries POST and hits a duplicate-name 409 (`02-handoff.md:279-282`). Fix: publish
   bases only from DB-sourced builds; the service already refreshes identity once (I-356).
7. **Dead dispatch with a plaintext token** (`dbproxy.mjs:143-201`, `02-handoff.md:89`). Fix:
   delete `dispatchAfterWrite`, rotate `GITHUB_DISPATCH_TOKEN`, remove it from Pages env.
8. **`db.yml pr-deploy` migrates prod on every PR push** (`db.yml:85-124`). Fix: keep the bookmark
   step but gate the job on a GitHub Environment with required review, or on a label.
9. **Magic rules in three stores.** `/api/stat-patches/rules/all` serves D1 rows in DB mode
   (`[[path]].js:187-205`); each submit fans out 13 CI jobs; five rule sets exist for layouts cmini
   no longer has (`02-handoff.md:80`). Fix: rules live only in the record; the service's rules
   pass recomputes; delete the table, log, workflow and backup.
10. **Proxy and bot hardening.** No upstream timeout or body cap on `/api/db/*`; session cookie
    without `Secure` (`session.mjs:88`); bot crash-loops on an akl.gg 530 at boot
    (`02-handoff.md:32`) because its bulk comes from the site's static build. Fix: 4 MiB cap,
    10 s timeout, `Secure`, and B6 (bot reads the pointer; rules file optional at boot).

**Recommended target shape.** layoutdb unchanged, public API only. One publisher process in the
bot's Fly app, following the change feed the bot already has, computing with the Go CLI, writing
immutable base + overlay to R2 through the data-writer Worker and moving the pointer by CAS; it
folds overlay into a new base daily and publishes a fresh base itself when the line key H changes
(a GitHub `workflow_dispatch` full harvest only then). The site is pointer-mode only, polls the
pointer every 60 s, and its deploys are code-only (gate + pointer build + Pages). The bot reads the
same pointer with `db_seq` provenance and computes the remainder. cb-magic keeps only
`discord_tokens`, `handoff` and the analytics tables. Everything in F marked delete goes, which
removes two Workers, four workflows, six D1 tables, one Functions route family, one committed data
file and roughly 250 CI minutes a day. What breaks during the move: nothing on prod until the
flip, which must be one atomic change of three settings plus a Worker removal; after it, the
trial's measured 74 to 245 s publish-to-visible replaces prod's 5 to 10 min, and site publishes
stop being lost.
