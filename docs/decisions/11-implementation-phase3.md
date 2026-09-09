# Implementation — phase 3, akl.gg cuts over

Status: plan, round 2 (2026-09-09; round-1 draft reviewed against
`scripts/sync_cmini_data.py`, `workers/meta-watch`, the workflows, the
magic-rules functions and the phase-1/2 `db/` code; rewritten as closed
briefs). Part of `00-plan.md` (§5 phase 3) and `06-akl-integration.md`.
Every slice is a change to the **site** (`scripts/`, `workers/meta-watch`,
`functions/`, `web/src`, `.github/`), never to `db/`, except the two
fixture exports `db/` makes for the site's tests (W1, W4). Prerequisites:
phase 1 deployed (the production DB mirrors cmini; `08 §1`) and phase 2's
write verbs on the **preview** DB (`09` T7). **Every step that flips
production is marked ⚠ and is saltorbit's** (`08 §1`; the standing "no prod
changes by agents" rule): everything below is built and proved against the
preview DB first.

## 0. The seams (measured on the branch, 2026-09-09)

| seam | today (verified) | after |
|---|---|---|
| **layout source** | `scripts/sync_cmini_data.py`: `DEFAULT_BASE_URL = https://clemenpine.com/layoutapi/v3`; `fetch_meta_token` stores the **whole** `/meta` response canonically as `sync_state.api_meta` (the quiet-tick gate); `fetch_list` → entries needing a string `id` (+ optional `modified_at`, `like_count`, `created_at`); `?full=1` when ≥ 50 % of ids need fetching, joined **by `name`** (`batch_join_details`: the upstream batch has no `id`); per-id `GET /layouts/{id}` otherwise (404 with `tolerate_404` = deleted this tick); `fetch_authors` → `{name: id}`; `normalize_detail` keeps exactly `name user board free keys` (user via `parse_snowflake`, numeric strings accepted) and `render_layout_bytes` writes `layouts/<id>.json` with `indent=1`; `extract_likes` sorts; `compute_digest` = sha256 over `<id>:<hash>` lines + `likes.json` + `authors.json` bytes. **The data root, `layouts.json`, `sync_hashes.json`, every D1 patch table and the frontend are keyed by cmini's id = the lowercase name.** | `--source db`: a `DbSource` adapter (W1) that speaks `/v1/meta`, `/v1/layouts` (list + `?full=1&as=cmini/1`), `/v1/layouts/{name}?as=cmini/1`, `/v1/authors`, and presents them in the shapes the existing functions consume — with **`id = name.lower()`** (the ULID is not used by the pipeline in phase 3; a DB-side rename is delete + create in the data root, exactly as a cmini rename is today). Output files byte-identical (LDB-S1) |
| **change detection** | `workers/meta-watch/src/index.js`: `fetchJson(env.CMINI_META_URL)` then `isCovered(cursor, live)` (`covered.js`: canonical-JSON equality of the site's stored `api_meta` with the live meta) → dispatch `live-sync.yml`. `wrangler.toml` `[vars] CMINI_META_URL`; deploys **by hand** (`npx wrangler deploy` from that directory, `DEPLOY.md`) | `CMINI_META_URL = <DB>/v1/meta` — no code change; the DB's `revision` moves on likes (`03 D7`) as cmini's does. One ⚠ manual deploy |
| **the scrape in CI** | `.github/actions/cmini-scrape/action.yml` runs `python3 scripts/sync_cmini_data.py ${{ inputs.args }}` (restore/save of `build/cmini-live` around it); called from `live-sync.yml` (poll, compute, finalize), `build.yml` (`args: --refetch-all` on schedule), `full-rebuild.yml` (a bare `python3 scripts/sync_cmini_data.py`, no action) | the action gains a `source-url` input threaded from `vars.DB_BASE_URL`; `full-rebuild.yml`'s bare call goes through the action (W2) |
| **magic rules** | canonical in D1 `cb-magic.magic_rules {layout_id, author_discord_id, rules_json, updated_at}` written by `functions/api/magic-rules/[id].js` `onRequestPut` (session cookie → `layout_authors` ownership check or `ADMIN_DISCORD_IDS` → `validateRuleSet` → CAS upsert + `magic_rules_log` row → `repository_dispatch magic_rules_submit` → `magic-rules-sync.yml`); read by `index.js` (all rows), `scripts/build_magic_rules.py --merge-d1 [--remote]` (seed `data/magic_rules.json` ⊕ D1 → `web/data/magic_rules.json`, 83 sets on 2026-09-09), `fetch_d1_rules.py`, `live_patch_sync.py`, `fast_sync_patch.py`, `compact_stat_patches.py`, `backup_magic_rules.py`, `check_magic_freshness.py`, `seed_local_d1.py` | rules live in the record (`payload.magic`, `akl/1`, the same authoring shape); after W5's migration the sync writes `magic_rules.json`'s content from `?as=akl/1` records; the PUT route and `magic-rules-sync.yml` retire at W6; the read scripts keep working off `web/data/magic_rules.json` (unchanged shape) |
| **ownership** | D1 `layout_authors` (`build_layout_authors.py` from `layouts.json` + `build/cmini-live/authors.json`; `sync_prod_authors.py` diffs it into prod; `live_patch_sync.py --finalize` upserts rows) — read by the magic-rules PUT and `functions/admin/*`; the frontend reads `web/data/layout_authors.json` | **unchanged in phase 3**: `authors.json` from `/v1/authors` has cmini's shape, so `build_layout_authors.py` needs no edit; the D1 table keeps being written until the magic-rules PUT is deleted (W6 step 3 + one release), then dropped — a follow-up, not a slice (round 1's W5 retirement is cut) |
| **dates** | `data/layout-dates.json` (committed) read by `build_web.py:run` → `layout_meta_and_keys(…, layout_dates)` → `created`/`modified` on `layouts.json` rows; rolled forward by `sync_cmini_data.py --update-dates` from the list's `created_at`/`modified_at` | **unchanged in phase 3**: the DB's list rows carry `created_at`/`modified_at`, so `--update-dates` keeps working; the "import the file into the DB" step is **cut** from W6 (only needed when the file retires, `06 Q1` — phase 5) |
| **writes** | none: the site cannot write to cmini; the approved UX (`design/cmini-write/06-holistic-proposal.md`, 2026-09-01) and the round-1 proxy plan (`05-implementation-plan.md §4.1–4.2`) target `clemenpine.com/v1` with `If-Match: "<modified_at>"` | `functions/api/db/*` (W3) targeting the DB with **`If-Match: "<rev>"`** (`03 §1`; the emulation branch is gone), then the publish UX (W4) |
| **the site's own identity** | `functions/auth/discord/callback.js`: code → `oauth2/token` → `/users/@me` → HMAC session cookie `{discord_id, name}`; the access token is **discarded** (line ~82) | W3 keeps it (encrypted, D1 `discord_tokens`) — `05-implementation-plan.md §4.1` as written, migration renumbered `0008` (the site's migrations are at `0007_usage_events`) |
| **stale shape** | the approved UX prints "whirl changed in cmini since you started — 2 h ago, via the bot" from a 409 | the DB's `409 stale { rev, record, last_write: { seq, at, actor, via, kind, admin } }` (`09 §2.1`) — `last_write.at` and `last_write.via` are the two fields the footer reads; `via` → words: `discord` = "on akl.gg", `client:<id>` = "via the bot", `import:cmini` = "from cmini" (**copy, gated**) |

## 1. Slices — PRs in order

Order: **W1 → W2 → W3 → W4 → W5 → W6 ⚠**. W1–W5 prove themselves against
the preview DB (`akl-db-preview`); W6 is the production flip. Every site
invariant below gets an `I-nnn` at landing (next free after `I-219`) with
its enforcing test tagged, registered in `design/INVARIANTS.md`; the
`LDB-S*` names here are the cross-references `06 §8` uses.

### W1 — `sync_cmini_data.py --source db`

**Lands:** `scripts/sync_cmini_data.py` (`--source {cmini,db}`, default
`cmini` until W6; `--base-url` keeps its meaning per source; `DEFAULT_DB_URL
= ''` — no default, the flag is required with `--source db`), a `DbSource`
class beside the existing module functions, `scripts/tests/
test_sync_db_source.py`, `scripts/tests/fixtures/db-responses/` (exported by
`db/`, below), and a `db/` fixture-export test.

`DbSource(base_url)` — one method per upstream function it replaces; each
returns the **same shape** the existing code consumes, so `run_full`/
`run_ids` change only in which callable they hold:

| existing | `DbSource` method | request | mapping |
|---|---|---|---|
| `fetch_meta_token` | `meta_token()` | `GET /v1/meta` | the whole body canonicalised (`json.dumps(sort_keys=True)`) — what `sync_state.api_meta` and meta-watch's `isCovered` compare; `None` on any failure (gate disengages, never fails) |
| `fetch_list` | `list()` | `GET /v1/layouts?limit=1000&cursor=…` until `next_cursor` is null (`sort=name`) | entry = `{ id: name.lower(), name, modified_at, like_count, created_at, has_magic }` — `id` **derived**; a case-insensitive duplicate cannot occur (`layouts_name_live`), asserted anyway (`sys.exit` on a repeat, like `fetch_list`'s dedupe) |
| `fetch_batch_details` | `full()` | `GET /v1/layouts?full=1&as=cmini/1` (streamed; read whole) | `items[]` → the list of `cminiDetail` objects (`07 §5.1`: `name user board tag? blame? created_at modified_at likes keys free? magic? combos? link?`); a `held: true` item (impossible for `cmini/1` today — every registered format translates to it; asserted) is dropped with a stderr line |
| `batch_join_details` | unchanged | — | joins by `name` exactly as today (names are unique; the DB items also carry `id`, unused) |
| `fetch_detail` | `detail(id)` | `GET /v1/layouts/{id}?as=cmini/1` (`id` = the lowercase name; the DB's name lookup is NOCASE) | `normalize_detail(id, body)` + `extract_likes(id, body)` unchanged (`user` is the DB's `owner` string → `parse_snowflake`); `404 not_found` → `NotFoundError` (a tombstone by name 404s — deletion this tick, `tolerate_404` semantics unchanged) |
| `fetch_authors` | `authors()` | `GET /v1/authors` | cmini's `{name: user_id}` shape already; ids parse as today |
| `fetch_with_retry` | reused | — | UA `cmini-web-sync/1.0` as today; `If-None-Match` is **not** used here (the meta gate is the quiet path; a full run wants fresh bodies) |

`run_full` picks `src = DbSource(args.base_url) if args.source == 'db' else CminiSource(args.base_url)`
where `CminiSource` is a thin class over the existing functions (no
behaviour change for `cmini` — the refactor is one indirection). `--ids`
(`run_ids`) goes through the same source. `--update-dates` works unchanged
(the DB list carries `created_at`/`modified_at`).

**The fixture the test needs is the DB's own output, not a Python
re-implementation of the projection.** `db/tests/api/list.test.ts` (S6)
gains an `it` guarded by `BOT_FIXTURE_WRITE`/`SITE_FIXTURE_WRITE=1` that
seeds `upstream-100` and writes `scripts/tests/fixtures/db-responses/
{meta.json, layouts-list.json, layouts-full-cmini1.json, authors.json,
detail/<name>.json × 100}` from the real routes (committed; regenerated only
when the API contract changes, which `db/`'s conformance sweep documents).
A second `db/` test, `tests/api/site-fixture.test.ts` (**LDB-S1a**),
asserts the committed files equal the live routes' bodies under
`canonical` — so a drift between `db/` and the site's fixture is a red
`db.yml`, not a stale test. (Reading fixture files across the boundary is
allowed — `00 §7(a)` "tests use fixtures"; `db/tests/tools/boundary.test.ts`
scans imports, not `fs` reads.)

| file | asserts | invariant |
|---|---|---|
| `scripts/tests/test_sync_db_source.py` | serves `db-responses/` from a `http.server` thread with the DB's paths (`/v1/meta`, `/v1/layouts?…`, `/v1/layouts/<name>?as=cmini/1`, `/v1/authors`); serves the same 100 layouts in **cmini's** shapes from `db/tests/fixtures/upstream-100/{list,full,authors}.json` on a second port; runs `main(['--source','cmini','--base-url',A,'--out',outA])` and `main(['--source','db','--base-url',B,'--out',outB])`; asserts **byte-equality** of every file under `layouts/`, of `likes.json`, `authors.json`, `sync_digest.txt`; `sync_state.json` equal except `api_meta` and `synced_at`; a second `db` run → `/meta unchanged -- nothing to do` after exactly one request (the fake counts); with `sync_state` deleted and 60 of 100 files removed → `?full=1` used (request log); with 10 removed → per-id; a tombstone (a name the list omits and the detail 404s) → pruned, bounded by `--max-prune-frac`; `--ids graphite --source db` writes one file byte-equal to the cmini run's | **LDB-S1** |
| `scripts/tests/test_sync_cmini_data.py` (existing) | unchanged and green — the `CminiSource` indirection changes no cmini-path behaviour | — |
| `db/tests/api/site-fixture.test.ts` | the committed `db-responses/` equal the live routes (`canonical`); every file the Python test reads exists | **LDB-S1a** |

**DoD:** green; `python3 scripts/sync_cmini_data.py --source db --base-url
https://akl-db-preview.<account>.workers.dev --out /tmp/db-root` then the
same from cmini into `/tmp/cmini-root`: `diff -r` of `layouts/`,
`likes.json`, `authors.json` empty **for every record still following
upstream** (the preview has phase-2 test writes; list them with
`/v1/changes?kinds=created,updated,…&since=0` and exclude).

### W2 — CI and meta-watch driven by `DB_BASE_URL`

**Lands:** `.github/actions/cmini-scrape/action.yml` input `source-url`
(default `''`): when non-empty the run step is `python3 scripts/
sync_cmini_data.py --source db --base-url "${{ inputs.source-url }}"
${{ inputs.args }}`, else today's line; every `uses: ./.github/actions/
cmini-scrape` passes `source-url: ${{ vars.DB_BASE_URL }}` (live-sync ×3,
build ×1); `full-rebuild.yml`'s bare `python3 scripts/sync_cmini_data.py`
becomes the action (with the same `source-url`); `workers/meta-watch/
wrangler.toml` comment updated (no var change — the value is set at W6);
`web/tests/tools/ciwiring.test.mjs` extended.

Why a repo **variable**: `vars.DB_BASE_URL` empty ⇒ cmini (today);
`= <preview DB>` ⇒ a preview deploy from the DB end to end (`build.yml`
`workflow_dispatch` from a feature branch deploys to `<alias>.cmini-web.
pages.dev`, `DEPLOY.md`); `= <prod DB>` ⇒ W6. One knob, one rollback
(`DEPLOY.md` gets the line).

| file | asserts | invariant |
|---|---|---|
| `web/tests/tools/ciwiring.test.mjs` (extended) | every job that scrapes (grep `cmini-scrape` across `live-sync.yml`, `build.yml`, `full-rebuild.yml`) passes `source-url: ${{ vars.DB_BASE_URL }}`; no workflow invokes `sync_cmini_data.py` outside the action; the action's run line branches on `source-url` and still forwards `args` | **LDB-S5** (I-135 family: the source is threaded to every scrape, none left on the old default) |
| `web/tests/backend/metawatch.test.js` (existing) | unchanged: `isCovered` over the shared fixture; add one case with a DB-shaped meta body (`seq`, `revision`, `formats`) on both sides → covered, and with `seq` moved → not | — |

**DoD:** `vars.DB_BASE_URL` set to the **preview** DB on a feature branch's
`workflow_dispatch` of `build.yml` → the preview alias serves a
`sync_hashes.json` whose `layout_hashes` equal production's for every
following record (a `node` one-liner in the PR description); then the
variable is **cleared** (production stays on cmini until W6).

### W3 — the write proxy (`functions/api/db/*`)

**Lands:** `migrations/0008_discord_tokens.sql` (`05-impl §4.1`'s table,
renumbered), `functions/_lib/tokens.mjs` (`encryptTokens`/`decryptTokens`
AES-GCM under `TOKEN_KEY`, `saveTokens`, `loadAccessToken` with the
`< 3600 s` refresh, `refresh` (Discord `grant_type=refresh_token`; 400/401
→ delete row → `null`), `deleteTokens` — as `05-impl §4.1` specifies, no
change), `functions/_lib/dbproxy.mjs`, the routes, `functions/auth/discord/
callback.js` (+`saveTokens` after `/users/@me`, guarded on `env.TOKEN_KEY`),
`functions/auth/logout.js` (+`deleteTokens`), `.dev.vars.example`
(`TOKEN_KEY`, `DB_BASE_URL`), `web/tests/backend/db-lib-tokens.test.js`,
`web/tests/backend/db-proxy.test.js`.

`dbproxy.mjs` — `proxy(context, { method, path, body?, passIfMatch = true })`:

1. `getSessionFromRequest` → none → `401 { error: "unauthorized", message: "not signed in" }`.
2. `loadAccessToken(env, session.discord_id)` → null → `401 { error: "reauth", message: "Sign in again to publish" }` (**copy**; the string is a stand-in under `web/src/copy/` once the UI prints it).
3. `fetch(env.DB_BASE_URL + path, { method, headers: { Authorization: \`Bearer ${tok}\`, 'Content-Type': 'application/json', ...(passIfMatch && request.headers.get('If-Match') ? { 'If-Match': … } : {}), 'User-Agent': 'akl.gg-proxy/1.0' }, body })`.
4. DB answers `401 token_invalid` → `refresh` once → retry once → still 401 → `401 reauth`.
5. Pass through **status, JSON body, `ETag`, `Retry-After`** unchanged; never `Set-Cookie`, never the bearer, never `WWW-Authenticate` (the browser must not see the DB's auth scheme).
6. After a 2xx on a **layout** write (not likes): `context.waitUntil(dispatchLiveSync(env, layoutName))` — `repository_dispatch` type `db_site_write`, payload `{ layout_id: name.toLowerCase(), action }` (the site's pipeline id), using `triggerFastSync`'s pattern from `functions/api/magic-rules/[id].js` (env `GITHUB_DISPATCH_TOKEN` absent = silent no-op); and one `cmini_sync_log` row `source: 'site'` (`0008` adds the column if `0005` lacks it — check at landing).

Routes (Pages Functions file routing):

```
GET    /api/db/me                          → GET    /v1/me
POST   /api/db/layouts                     → POST   /v1/layouts
PUT    /api/db/layouts/[ref]               → PUT    /v1/layouts/{ref}          If-Match passed
PATCH  /api/db/layouts/[ref]               → PATCH  /v1/layouts/{ref}          If-Match passed
DELETE /api/db/layouts/[ref]               → DELETE /v1/layouts/{ref}          If-Match passed
POST   /api/db/layouts/[ref]/restore       → POST   /v1/layouts/{ref}/restore
POST   /api/db/layouts/[ref]/transfer      → POST   /v1/layouts/{ref}/transfer
PUT    /api/db/layouts/[ref]/like          → PUT    /v1/layouts/{ref}/like     (no dispatch)
DELETE /api/db/layouts/[ref]/like          → DELETE /v1/layouts/{ref}/like     (no dispatch)
```

`[ref]` is forwarded verbatim (the DB resolves ULID-first, `03 §1`; the
site sends the ULID it stored at fork time — `Draft.origin.id`, W4 — and
the lowercase name only for records it has never edited). Env on the Pages
project: `DB_BASE_URL` Preview = the preview DB (set now), Production = the
production DB (⚠ W6), `TOKEN_KEY` both.

| file | asserts | invariant |
|---|---|---|
| `web/tests/backend/db-lib-tokens.test.js` (vitest, the `magic-lib-*.test.js` pattern, mocked `fetch` + an in-memory D1 stub) | encrypt/decrypt round trip; a different key fails to decrypt; `loadAccessToken` refreshes when `< 3600 s` remain and not otherwise; refresh 400 deletes the row and returns null; the ciphertext never contains the token bytes | I-W7a (tokens at rest are ciphertext) |
| `web/tests/backend/db-proxy.test.js` | matrix over route × {no session → 401, session without tokens → 401 reauth, DB 200/201, DB 401 then 200 after refresh, DB 401 twice → reauth, DB 409 `stale` (body passed through **byte-equal**, `ETag` absent), DB 429 (`Retry-After` passed)}; **no response ever contains the bearer, `Set-Cookie`, or `WWW-Authenticate`** (every header and body scanned for the token string); `If-Match` forwarded iff present and only on PUT/PATCH/DELETE; a 2xx layout write dispatches once with `layout_id = name.toLowerCase()`, a like never dispatches; a `GITHUB_DISPATCH_TOKEN`-less env dispatches nothing and still answers 2xx | **LDB-S2** (`I-W7`: the bearer never reaches the browser), **LDB-S6** (the proxy is a pass-through: status and body equal the DB's) |

**DoD:** green; on the preview deploy, signed in as saltorbit: `GET /api/db/me`
→ `{ user_id, name, via: "discord", admin: true }`; `PUT /api/db/layouts/
<a test record>` with a wrong `If-Match` → 409 with `last_write`.

### W4 — the publish UX

**Lands:** the approved round (`design/cmini-write/06-holistic-proposal.md`
§2, mockups `07-holistic-mockups.html`) with `06 §3`'s changes, under
`web/src/{core,data,state,ui,copy,app}` per `ARCHITECTURE.md`; behavior
catalog entries first (`design/behaviors/*.json`, `TESTING.md`); copy
strings as stand-ins under `web/src/copy/publish.ts` (new leaf module),
**every one flagged `// COPY: sign-off pending` and listed in the PR** —
saltorbit signs off before the preview shows them to anyone but him.

What changes against the approved text (the retargeting, `06 §3`):

| approved (06-holistic) | built here | why |
|---|---|---|
| `functions/api/cmini/*`, `If-Match: "<modified_at>"`, emulation fallback | `functions/api/db/*` (W3), `If-Match: "<rev>"`, no fallback | `03 §1`: the DB honours `If-Match` on `rev` |
| `Draft.origin = {id, modified_at}` | `Draft.origin = { id: <ULID>, name, rev }` (schema 3 → 4 in `core/drafts.ts` with a migration; the `#241` new-storage-field checklist: sample matrix, golden-v2 re-record, v2-dispatch allowlist) | the DB's concurrency token is `rev` |
| body = `{name, board, keys, free, link, magic: lower(ruleSet)}` | body = `{ name, format: "akl/1", payload: toAkl1(draft) }` where `toAkl1` (new `core/akl1.ts`) = `keys` map from the draft's `KeyCell[]` (after `normalizeLayoutColumns`), `free: []`, `board: { kind, stagger, cmini }` from `#261`'s per-side geometry (`kind: 'rowstag'` ⇒ `stagger: [0, 0.25, 0.75]`, `cmini` = the draft's native board word when it has one), `magic` = the workbench `ruleSet` **verbatim** (it *is* `02-schema.md`'s shape = `akl/1.magic`, minus `except` which the DB's collision `hint` may ask for — see the 400 handling), no `link` | `06 §3`, `01 §2`; I-W2 becomes LDB-S3 |
| Link verb | gone | `00 §6` |
| Rename / Fingermap inline edits via PUT | `PATCH /api/db/layouts/{id} { name }` / `{ fingermap }` | `03 §3` |
| Delete → re-POST on Undo | `DELETE` (tombstone) → the 8 s Undo pill calls `POST …/restore` (id stable) | `03 §3`, `09` T2 |
| Overwrite = PUT without `If-Match` | same (`If-Match` omitted; a lost race still 409s — retry once, then show the footer) | `09 §2.3` |
| "the site treats id as stable" | the **DB** id is stable; the **catalog** id (`layouts.json`) is the lowercase name and changes on rename after the next sync — the promoted card carries `_dbId` (the ULID) and `id = name.toLowerCase()`; a rename updates both, and the overlay row is re-keyed | `§0` seam 1 |
| "whirl changed in cmini since you started — 2 h ago, via the bot" | from `409 stale.last_write.{at, via}` (`§0` last row); Rebase = the existing reconcile over `record` (the 409 carries the current record with payload — no second GET) | `09 §2.1` |
| name availability "against the local catalog first, the API's 409 second" | same; the 409's `holder.owner === me` → the "whirl is yours, update it instead" hint | `09 §6.5` |
| magic collision | new: `400 magic_collision { inputs, from, hint }` (`01 §3`) → the sheet shows the DB's `message` verbatim and, when `hint` names an `except`, offers *Apply fix and publish* which adds the `except` entry to the draft's ruleSet and retries once (**copy**) | `01 §3` |
| the workbench's own publish, its scrim, the "Layout edits must go through the !cmini Discord bot" warning, the sync pill | retired (`06-holistic §2.3`, decision 2) | — |
| `_provenance: 'site-publish'` overlay row + tripwire vs the pipeline patch | as approved (`06-holistic §3.5`); the wasm row is `cminiCellToFields(cell)` — the same composition the pipeline's patch row went through, so the tripwire fires only on real drift | `06-holistic §3.5`, I-W6 |
| feature flag | the surfaces render iff `GET /api/db/me` answered 200 at boot (`state/identity`); Production answers 404 until W3's routes deploy and `DB_BASE_URL` is set, so nothing shows on prod before W6 step 5 | `06-holistic §5` |

Invariants (registered as `I-nnn` at landing; `06-holistic §4`'s numbers
retargeted):

| id | invariant | enforced by |
|---|---|---|
| I-W1 | no `/api/db/*` write without a user verb (Publish/Update/Rename/Fingermap/Delete/Undo/Give to/Like) in the same dispatch trail | recorder-v2 replay: every proxy request is preceded by one of those actions (`web/tests/ui/…`) |
| **LDB-S3** (I-W2) | `toAkl1(draft)` is a pure function of the draft; `fromAkl1(toAkl1(d))` equals `d` on keys/board/magic for every draft in the sample matrix; `toAkl1(d)` **validates against `db/formats/akl/1/schema.json`** (read as a fixture file) for every sample | `web/tests/core/akl1.test.ts` (property, fast-check over the draft matrix) |
| I-W3 | `draftDestination(draft, me, authors)` is `update` iff `authors[rootId].author_discord_id === me` and the root is a catalog layout; else `new` | matrix test over lineage shapes |
| I-W4 | every non-2xx leaves the draft byte-identical; delete → `draftFromRecord(record)` re-publishes an identical body | round-trip property test |
| **LDB-S2** (I-W5) | a PUT/PATCH/DELETE carries `If-Match: "<origin.rev>"` unless the action is `overwrite`; the browser never sees a Discord token (W3) | proxy unit test + UI spec for the 409 footer |
| I-W6 | after promotion the card's numbers equal the wasm row; after the patch lands they equal the patch row; a difference above display precision renders the tripwire | vitest with a fixture patch |
| I-W7 | the bearer never reaches the browser | W3's proxy test |

**DoD:** the catalog entries are `active` with tagged tests; Playwright
specs for the sheet's states (`06-holistic §2.2`: signed out / name taken /
yours-update-instead / conflict / sent / API error / magic collision) green
against fixtures; on the **preview** deploy saltorbit publishes a draft, sees
it promote, edits it in the bench, updates with the conflict path
exercised once (a `!spark`-less manual `PUT` through `curl` in between),
deletes, undoes. The copy list in the PR is signed off before the preview
URL is shared.

### W5 — magic migration into the records

**Lands:** `scripts/migrate_magic_rules_to_db.py` (+ `scripts/tests/
test_migrate_magic_rules.py`), `scripts/verify_magic_migration.py` (the
LDB-S4 check, kept as a test fixture), `web/tests/backend/magic-migration-
verify.test.js`.

Source of truth for the migration: **`web/data/magic_rules.json` as the
nightly builds it** (`build_magic_rules.py --merge-d1 --remote` = the
committed seed ⊕ live D1, D1 winning — exactly what the site serves).
Seed-only entries carry `updated`/`notes` metadata keys (`data/
magic_rules.json`) that the workbench's D1 rows do not: the script strips
every key outside `{magic_keys, chiral_keys, adaptive_swaps}` before the
PUT (`validateRuleSet`'s own schema; `akl/1`'s `magic` has
`additionalProperties: false`).

Per layout id (= lowercase name) in that file:

1. `GET <DB>/v1/layouts/{id}?as=akl/1` → `rec` (404 → logged `missing`, skipped — the layout is not in the DB; the verification lists it).
2. `payload = rec.payload` with `payload.magic = rules` (replacing whatever the import lifted from cmini's flat rows — the site's rules are what the site has been serving; for the ~15 upstream layouts with cmini-side magic this **forks the record from cmini** (`06 §2`, D9: the write's `via` is not `import:cmini`) — **saltorbit question 2**).
3. `PUT <DB>/v1/layouts/{rec.id}` `{ format: "akl/1", payload }` with `If-Match: "<rec.rev>"`, through the **client lane** with a personal `act-as-owner-only` key registered for saltorbit (`10` C1 — `X-Akl-Actor` = saltorbit's id, an admin, so `admin: true` is logged on every record he does not own; the fallback when C1 is not deployed yet: the site proxy with saltorbit's session cookie, `AKL_SESSION_COOKIE` env). `400 magic_collision` with a `hint` → apply the hint (`except` entry) and retry **once**; a second 400 → logged `collision`, skipped, listed. `409 stale` → re-GET and retry once.
4. Write `migrate-report.json` `{ migrated: [...], missing: [...], collision: [...], skipped_identical: [...] }` (identical = `lower(rec.payload.magic)` already equals the compiled rows — a re-run is idempotent: zero PUTs).

`verify_magic_migration.py` (**LDB-S4**): for every id in
`web/data/magic_rules.json`: `served = magicRulesFlatCompile(ruleSet,
keys)` — the site's compile, run via `node -e` against
`web/src/core/rules.ts` (a 10-line `scripts/tools/compile_rules.mjs`
shim; the Python shells out) — and `db = GET …?as=cmini/1`.`magic` (the
DB's `lower()`); assert `set((r.inputs, r.output) for r in served) ==
set((r.inputs, r.output) for r in db)` (tags excluded: the DB adds
`chiral`/`default:<c>` the site never had). Exit 1 on any difference or
any `missing`/`collision` row in the report. The vitest twin
`magic-migration-verify.test.js` runs the same comparison over the
committed `db-responses/` fixture extended with 5 migrated records (the
upstream-100 set has `opal`, `auditor`, `opal-dario`, `whirl` — real magic)
so the invariant has a test that runs on every PR, not only the one-shot.

After the migration the sync's `?as=cmini/1` reads carry `magic` = the
lowering, so `layouts/<id>.json`'s **content hash changes** for every
migrated layout (the cmini shape now has a `magic` list it lacked) —
**except** `normalize_detail` strips everything but `name user board free
keys`, so the files are unchanged and `sync_digest.txt` is stable.
`magic_rules.json` keeps being built from the seed ⊕ D1 until W6 step 3
switches `build_magic_rules.py`'s source to the sync's `?as=akl/1`
records — **not in this slice**: W5 is the data move; the readers move at
W6 with the PUT route's retirement, one release, so a rollback of W6 needs
no data undo (the D1 rows are still there).

| file | asserts | invariant |
|---|---|---|
| `scripts/tests/test_migrate_magic_rules.py` | against a fake DB (`http.server`): a seed-only rule set is stripped of `updated`/`notes`; the PUT body is `akl/1` with `magic` verbatim; `If-Match` = the GET's `rev`; a 400 with `hint` → one retry with the `except` applied, the report lists it under `migrated` with `hint_applied: true`; a second 400 → `collision`; 404 → `missing`; identical → no PUT; the run is idempotent (second run: zero PUTs); the report shape | **LDB-S4** (script half) |
| `web/tests/backend/magic-migration-verify.test.js` | the served-vs-DB set equality over the fixture; a mutated row is named | **LDB-S4** |

**DoD:** against the **preview** DB with production's `web/data/magic_rules.json`
(the last nightly's artifact, fetched from `https://akl.gg/data/magic_rules.json`):
`migrate-report.json` has zero `collision`, `missing` ≤ the seed-only ids
with no live layout (listed by name in the PR), and `verify_magic_migration.py`
exits 0.

### W6 — ⚠ the flip (saltorbit runs every step)

Each step has a rollback line; each is one knob.

1. **`vars.DB_BASE_URL` → the production DB.** The next scheduled `build.yml` (`--refetch-all`) and every live-sync tick scrape the DB. Rollback: clear the variable. Check: the deployed `sync_hashes.json` after the build equals the previous deploy's for every record following upstream (LDB-S1 in production; a `node` one-liner over the two files, kept in `DEPLOY.md`).
2. **meta-watch:** `CMINI_META_URL = https://<DB>/v1/meta` in `workers/meta-watch/wrangler.toml`, `npx wrangler deploy` from that directory (**manual**, `DEPLOY.md`). Rollback: revert + deploy. Check: the Worker's log shows a quiet tick (`isCovered` true) once the first post-flip live-sync run settled the cursor.
3. **W5's migration against production** (`scripts/migrate_magic_rules_to_db.py --base-url <prod DB>`; report attached to the flip's issue), then `verify_magic_migration.py` exit 0; then the PR that (a) points `build_magic_rules.py` at the sync's `?as=akl/1` records for `magic_rules.json` (`DbSource.full(as='akl/1')` → `{id: payload.magic}`; the seed file becomes local-dev-only), (b) turns `functions/api/magic-rules/[id].js`'s PUT into `410 { error: "gone", message: "rules are published with the layout now" }` (**copy**) and its GET into a read of the built `magic_rules.json`'s D1 overlay no longer (the overlay is the sync), (c) disables `magic-rules-sync.yml` (`on: workflow_dispatch` only) and `magic-rules-backup.yml` (the DB's dump is the backup), (d) drops `fetch_d1_rules.py`'s D1 read behind `--source db` (one release later: delete). Rollback for (a)–(d): revert the PR; D1 still holds the rows.
4. **Pages Production `DB_BASE_URL`** → the production DB (the proxy goes live); the publish UX renders (its flag is `/api/db/me` answering 200). Rollback: unset the env var — the flag hides every surface.
5. `layout_authors` D1 + `build_layout_authors.py` + `sync_prod_authors.py` + `live_patch_sync.py`'s upsert: **untouched** (the frontend's owner gate reads `layout_authors.json`; `functions/admin/*` reads the table). Retiring them is a follow-up once the magic-rules PUT is deleted.
6. The cmini import keeps running in the DB (`00 §6.6` is still open); the `cmini-backup` branch keeps committing the scraped set (now a backup of our own DB).

## 2. Invariants added (site; registered in `design/INVARIANTS.md` at landing)

| id | invariant | enforced by |
|---|---|---|
| LDB-S1 | `sync_cmini_data.py --source db` produces a data root byte-identical to the cmini source's for every record following upstream (`layouts/*`, `likes.json`, `authors.json`, `sync_digest.txt`) | `scripts/tests/test_sync_db_source.py` |
| LDB-S1a | the site's committed DB-response fixture equals the DB's live routes | `db/tests/api/site-fixture.test.ts` |
| LDB-S2 | every site write carries `If-Match: "<rev>"` unless the action is `overwrite`; no proxy response carries the bearer, `Set-Cookie`, or `WWW-Authenticate` | `web/tests/backend/db-proxy.test.js`, the UI 409 spec |
| LDB-S3 | the publish body is `toAkl1(draft)`; `fromAkl1(toAkl1(d)) == d`; the body validates against the frozen `akl/1` schema | `web/tests/core/akl1.test.ts` |
| LDB-S4 | after the magic migration no layout's served rules differ (set of `(inputs, output)`) from the static `magic_rules.json`'s compile; the migration is idempotent | `scripts/tests/test_migrate_magic_rules.py`, `web/tests/backend/magic-migration-verify.test.js`, the one-shot `verify_magic_migration.py` |
| LDB-S5 | every CI scrape passes `source-url: ${{ vars.DB_BASE_URL }}`; no workflow calls `sync_cmini_data.py` outside the action | `web/tests/tools/ciwiring.test.mjs` |
| LDB-S6 | the proxy is a pass-through: status, JSON body, `ETag`, `Retry-After` equal the DB's | `db-proxy.test.js` |
| I-W1, I-W3, I-W4, I-W6 | as `06-holistic §4`, retargeted (W4 table) | W4's tests |

## 3. Decisions taken in this round (ledger; flip any of them)

1. **The pipeline id stays the lowercase name** (`DbSource` derives it); the ULID enters the site only as `Draft.origin.id` / the promoted card's `_dbId`. A DB rename is delete + create for the data root, as a cmini rename is today. (Alternative: re-key the whole pipeline by ULID — every D1 patch table, `sync_hashes`, the frontend's id space; phase 5 at the earliest, if ever.)
2. **Dates: nothing changes** — `--update-dates` reads the DB list's `created_at`; the "import `layout-dates.json` into the DB" step is cut (round 1's W6 step 4 and Q1). `06 Q1`'s diff is still worth doing before the file is retired; not a phase-3 item.
3. **Ownership retirement is cut from phase 3** — `authors.json`'s shape is unchanged so nothing needs to move; the D1 table falls with the magic-rules PUT.
4. **The site has its own `core/akl1.ts`** (`toAkl1`/`fromAkl1`) rather than importing `db/formats` — LDB-G5 forbids the path import and `@akl/layout-formats` does not exist yet (`06 §5`); the schema file is read as a **test fixture** to prove the two agree (LDB-S3's third clause). A draft is not a format (`06 §5`, F-12), so `toAkl1` stays site code even after the package exists; the package's `validate` then replaces the schema-file test.
5. **The fixture for LDB-S1 is exported by `db/`'s own code** and frozen by a `db/` test (LDB-S1a) — never a Python re-implementation of `cminiDetail`.
6. **The magic migration authenticates through the client lane** (a personal `act-as-owner-only` key, `10` C1) — the one "CLI write" `02 §2.2` set aside a design for is a *personal script by an admin*, which `02 §3.1` explicitly allows; not a personal token. Fallback: the proxy + session cookie.
7. **`build_magic_rules.py` switches source at W6, not W5** — data first, readers second, so W6's rollback needs no data undo.
8. **The proxy dispatches `db_site_write`** (not `cmini_site_write`) and logs `source: 'site'` — the approved plan's names, renamed for the target.
9. **The magic-collision 400 gets a one-click fix in the sheet** (apply `hint`, retry once) — the DB refuses silently-resolved collisions (D4) and the site's data has exactly one such case (`bunya`, `01 §3`), which the migration handles the same way.

## 4. Cut from the round-1 draft (and why)

- **W5's `layout_authors` retirement and `build_layout_authors.py` rewrite** — `authors.json` keeps its shape; nothing to rewrite (§3.3).
- **W6 step 4, the dates import, and `scripts/import_layout_dates.py`** — `build_web.py` keeps reading the committed file (§3.2).
- **`fetch_d1_rules.py`'s "no-op shim for one release"** — it is behind `--source db` at W6 (c) and deleted a release later; no shim.
- **"`sync_cmini_data.py` gets `id` from the DB list"** — the DB's `id` is a ULID; the pipeline's id is the lowercase name (§3.1).
- **`If-Match` emulation in the proxy** (`05-impl §3.4`'s fallback) — the DB honours it.
- **A Python fixture DB re-implementing the projection** — §3.5.

## 5. Questions only saltorbit can answer

1. **The flips** — W6 steps 1–4 are yours; the PR descriptions carry the exact commands.
2. **Migrating a layout's site rules forks it from cmini** (W5 step 2): for the ~15 cmini-authored magic layouts (opal, auditor, …) whose rules the site's D1 also holds, the PUT stops the record following upstream. Acceptable, or migrate only records with no cmini-side `magic`?
3. **Copy** (all stand-ins, flagged in W4's PR): the conflict footer's `via` words ("on akl.gg" / "via the bot" / "from cmini"), *Sign in again to publish*, the magic-collision *Apply fix and publish*, the 410 message on the retired rules PUT, the `--- STATS ---` family in `10 §9`.
4. **`06 Q1`** (is `layout-dates.json` richer than upstream's `created_at`?) — deferred to phase 5 by §3.2; say so if you want it answered now.

## 6. What can start when

- **Now:** W1 (needs only phase 1's read routes and the `db/` fixture export — `db/tests/api/list.test.ts` exists), W2 (pure CI wiring; provable with the preview DB as `vars.DB_BASE_URL` on a feature-branch dispatch), W3's token storage and `GET /api/db/me` (`/v1/me` is `09` T1).
- **When `09` T1 + T2 are on the branch and T7 (preview) is deployed:** W3's write routes, W4.
- **When `10` C1 is on the preview DB:** W5 (or W5 via the proxy fallback once W3 is on preview).
- **Blocked on saltorbit:** W6 entirely; §5.
