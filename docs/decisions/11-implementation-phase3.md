# Implementation — phase 3, akl.gg cuts over

Status: plan, round 1 (2026-09-09; site-side; needs a reviewer pass). Part
of `00-plan.md` (§5 phase 3) and `06-akl-integration.md`. Every slice here
is a change to the **site** (`scripts/`, `workers/meta-watch`, `functions/`,
`web/src`), not to `db/`; prerequisites are phase 1 deployed and phase 2's
write verbs on the preview DB (`09` T7). **Every step that flips production
is marked ⚠ and is saltorbit's to run** (`08 §1`; the standing "no prod"
rule): this doc builds and proves each against the preview DB first.

## 0. The seams (measured on the branch)

| seam | today | after |
|---|---|---|
| layout source | `scripts/sync_cmini_data.py` — `DEFAULT_BASE_URL = clemenpine.com/layoutapi/v3`; `/meta.revision` gate in `sync_state.json`; `/layouts`, `?full=1` join by name, per-id details; `/authors` | `--source db`: `<DB>/v1/meta` (`seq`/`revision`), `/v1/layouts?fields=…` list, `/v1/layouts?full=1&as=cmini/1`, `/v1/layouts/{id}?as=cmini/1`, `/v1/authors` — the extracted per-layout files keep the `cmini/1` shape, so content hashes, manifests, `web/sync_hashes.json`, live-sync's delta classes and everything downstream are untouched |
| change detection | `workers/meta-watch` — `CMINI_META_URL` var | `CMINI_META_URL = <DB>/v1/meta` (the Worker compares canonical JSON; `revision` field name is the same); later a webhook (phase 5) |
| magic rules | D1 `cb-magic.magic_rules` written by `functions/api/magic-rules/[id].js`; read by 12 scripts (`build_magic_rules.py`, `fetch_d1_rules.py`, `fast_sync_patch.py`, `live_patch_sync.py`, `build_mana2.py`, `compact_stat_patches.py`, …) via `--merge-d1` | rules live in the record (`payload.magic`, `akl/1`); the sync writes `magic_rules.json` from `?as=akl/1` records; `fetch_d1_rules.py`'s D1 read becomes a no-op shim for one release, then deleted |
| ownership | D1 `layout_authors` (`build_layout_authors.py`, `sync_prod_authors.py`, `live_patch_sync.py` finalize; read by `session.mjs` admin + the magic-rules PUT) | `record.owner` from the sync → `data/layout-authors.json` unchanged in shape; the D1 table stops being written, then dropped |
| dates | `data/layout-dates.json` (committed, git-mined) merged by `build_web.py` | one-time import into the DB as `created_at` for records older than cmini's own timestamps (`06 Q1`); afterwards `created_at`/`modified_at` from the record |
| writes | none (the site cannot write to cmini) | `functions/api/db/*` proxy (`06 §3`) → the publish UX |

## 1. Slices

Order: W1 → W2 → W3 → W4 → W5 → W6 ⚠. W1–W5 each prove themselves against
the preview DB in CI; W6 is the production flip.

### W1 — `sync_cmini_data.py --source db`

`scripts/sync_cmini_data.py` gains `--source {cmini,db}` (default `cmini`
until W6) and a `DbSource` client: meta gate on `/v1/meta.revision`, list
from `/v1/layouts?limit=1000&cursor=` (fields `id name owner modified_at
like_count has_magic`), details from `?full=1&as=cmini/1` when ≥ 50 % need
fetching (the entries DO carry `id` — no name join), per-id
`/v1/layouts/{id}?as=cmini/1` otherwise, authors from `/v1/authors`. Same
output files, same digest rule. `scripts/tests/test_sync_db_source.py`:
served from a fixture DB (the `upstream-100` snapshot behind a tiny local
HTTP shim) the data root is byte-identical to the one the cmini source
produces from the same 100 layouts (**LDB-S1**); the meta gate makes a
quiet tick one GET.

### W2 — meta-watch + live-sync against the DB

`workers/meta-watch/wrangler.toml` reads `CMINI_META_URL` from a var (it
already does); `live-sync.yml` and `build.yml` pass `--source db` when
`DB_BASE_URL` is set as a repo variable (`vars.DB_BASE_URL`), so the
preview DB can drive a preview deploy end to end. `ciwiring.test.mjs`
extended: the source flag is threaded to every job that scrapes (I-135
family).

### W3 — the write proxy

`functions/api/db/{me,layouts/[id]/…}.js` per `06 §3.2` (retargeted from
`design/cmini-write/05-implementation-plan.md` §4.1–4.2): Discord tokens
kept encrypted (`functions/_lib/tokens.mjs`, migration `0008_discord_tokens`
on `cb-magic`), proxy forwards the bearer, passes `If-Match` through, never
returns the token or `Set-Cookie`; after a 2xx layout write, dispatches
`live-sync.yml` for that id. `node --test` for `tokens.mjs` (round-trip,
refresh branches) and the proxy (401 → refresh → retry once; bearer never in
a response — I-W7). `DB_BASE_URL` env on the Pages project (Preview →
preview DB; Production → the real one at W6).

### W4 — the publish UX

`design/cmini-write/06-holistic-proposal.md` as approved, with `06 §3`'s
changes (no Link verb; `PATCH` for rename/fingermap; `DELETE` + `restore`
for the Undo pill; the body is `toAkl1(draft)`). Invariants I-W1–I-W6
(`06-holistic §4`) registered as site invariants with their tests; copy
strings as stand-ins under `web/src/copy/` flagged for sign-off. Ships on
the preview deploy only (feature-flagged on `/api/db/me` answering 200).

### W5 — magic migration + ownership retirement

`scripts/migrate_magic_rules_to_db.py`: for every `magic_rules` row, `PUT
/v1/layouts/{id}` as `akl/1` with `magic = rules_json` (admin actor,
`admin: true`, the `except` hint applied automatically — `01 §3`); a
verification pass asserts `lower(record.magic) == the static
magic_rules.json's lowering` for every row (**LDB-S4**). Against the preview
DB first (with the production `magic_rules` dump), then ⚠ against
production at W6. `build_layout_authors.py` reads owners from the synced
root; `live_patch_sync.py` stops writing `layout_authors`; the D1 table is
dropped one release later.

### W6 — ⚠ the flip (saltorbit runs it)

1. `vars.DB_BASE_URL` → the production DB; `CMINI_META_URL` on meta-watch →
   `<DB>/v1/meta` (wrangler deploy of the Worker — manual, `DEPLOY.md`).
2. `build.yml` scheduled run with `--source db`: the deployed
   `sync_hashes.json` must equal the previous one for every following
   record (LDB-S1 in production).
3. W5's migration against production; `functions/api/magic-rules/*`
   switched to read-through; `magic-rules-sync.yml` disabled.
4. `data/layout-dates.json` imported once (`scripts/import_layout_dates.py`
   → admin `PATCH` of `created_at`… — **needs an admin-only field on the
   record or a one-off migration on the DB side; open question 1**).
5. Publish UX flag on in Production.

Each step has a rollback line in `DEPLOY.md` (flip the var back; the
cmini import never stopped).

## 2. Invariants added (site)

LDB-S1–S4 from `06 §8`, registered in `design/INVARIANTS.md` as site
invariants (they live with the site, not `db/`), plus I-W1–I-W7 from the
approved UX.

## 3. Open questions

1. `created_at` backfill from `layout-dates.json`: the record's
   `created_at` is set at create; give admins a `PATCH {created_at}` (event
   `admin.redated`), or do a one-off SQL migration on the DB with the file
   as input? Proposal: the migration (once, auditable, no API surface).
2. How long does `fetch_d1_rules.py`'s shim live? Proposal: one release.
3. Does the site show `cmini/1`-native records (imported, never edited)
   and `akl/1` records identically? Yes — the sync reads everything
   `?as=cmini/1` until `06 §1` item 3 (later) switches it to `akl/1`.
