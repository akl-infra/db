# 21 — several formats per layout, the webhook lease, spark/1 cleanup

Status: plan written 2026-09-11; reviewed the same day by an Opus agent (Fable is out of credits until 2026-09-12), who edited it in place. §7 lists every change the review made and why; the lead accepted all of it, including the two lead's calls it changed (format removal left for later, scoped If-Match tokens). No code yet, except D1, which is on its own branch.

Source: xsznix's review in saltorbit's test server, #general, 2026-09-11 11:28–16:14Z, and saltorbit's decisions the same day. The blast-radius survey behind §3 was run against `pipeline-313` @ 79ea7a13e.

## 1. Decisions

saltorbit's, 2026-09-11, except where a row says "lead's call". A lead's call is flippable; say so and it changes.

| # | decision |
|---|---|
| D1 | **Webhook delivery takes a lease.** A drain claims a hook before it POSTs and commits on the lease, never on the cursor. This fixes the race xsznix reported ("your webhook seq CAS is racy"): overlapping drains interleaved POSTs and lost failure counts. Built separately on branch `ldb-webhook-lease`; not part of the slices below. |
| D2 | **~~spark/1 keys become a list of positions~~ — deferred.** Revised 2026-09-11: mana2 refuses repeated letters (`core/load_layout.go:297`, both our pinned copy and upstream `main`: "Duplicate keys are not allowed. If you need them, implement them through magic"), and every stats path looks keys up by letter. spark keeps its one-letter-once `keys` map; neon keeps its stand-in `у`. The keys change happens when mana2 supports repeats (#322 tracks akl.gg's side). |
| D3 | **A layout name holds several formats.** Each format under a name has its own payload, rev, created/modified timestamps and history. Name, owner, likes and deletion stay per layout. The formats are independent: no format has to be convertible to any other. |
| D4 | **No default format.** Every read that returns a payload and every write that changes one names its format. A request without one is `400 format_required`. Layout-level writes (rename, transfer, delete, restore, like) concern no format and take none. The feed, webhooks and the SSE stream carry no payloads and take no format parameter; every event says which format it concerns, or `null` for a layout-level event. |
| D5 | **The cmini export is deleted entirely.** `?as=cmini/1`, the `adapter:cmini` alias and `toCmini` go. The cmini *import* (`fromCmini`, the upstream sync) stays. |
| D6 | **akl.gg's editor stays as is.** Repeated letters on akl.gg are #322, blocked on mana2 (D2). |
| D7 | **Out of scope:** Fossil-style content-addressed revisions and WASM format modules ("overkill"; "idc about wasm"). |
| D8 | **No data migration.** layoutdb is wiped and rebuilt from cmini and akl.gg after the schema change (standing rule: layoutdb is disposable). |
| D9 | **Docs move with the code.** Each slice updates the docs it touches (§5). A spark/1 spec page and a worked example of adding a second format (layouts.wiki), with diagrams, are part of this work. |
| D10 | **spark/1 drops its free-form `x` field.** It existed so the cmini import could round-trip exactly (`x.cmini` held `tag`, `blame`, `combos` and `link`, which spark has nowhere to put) and as a place for other clients' extras. D5 removes the round trip and D3 gives other clients their own formats. Cost: the combos on crescent and finch are not carried (spark has no combos idiom); `link` is already never rendered (18 C3), and nothing reads `tag` or `blame`. |
| D11 | **LDB-F6 (a published format never changes) is suspended until layoutdb's first outside adopter.** spark/1 is edited in place this round (D5, D10). The F6 test gets an explicit frozen list (empty until that day) instead of comparing against `origin/main`. Today it compares against `origin/main`, which has no `db/formats/`, so it already skips. |
| D12 | **Lead's call: the legacy machinery goes.** After the D8 wipe no row is stored as `cmini/1` or `akl/1`, every imported row carries the `upstream` the importer wrote, and the importer never writes magic (LDB-I10). So all of this is dead code: `LEGACY_STORED`, `storedAsSpark`, the `akl/1` alias (and the package's `./akl/1`, `./cmini/1` subpaths); the whole record migration (`core/migrate.ts`, `POST /v1/admin/migrate/tick`, `scripts/migrate_records_to_spark.py`, the `migrated` event kind, the bot's `applyMigrated`); the legacy upstream fallback (`core/follows.ts`, `legacyUpstreamMap`, `upstreamOf`'s `import_map` fallback, the `magic_only` marker); and the M1 strip route (`import/strip.ts`, `POST /v1/admin/import/strip-cmini-magic`, `admin.magic_stripped`). An alias is an implicit default in disguise (D4). The within-lineage chain (`up`/`down`, `format_behind`, P13 `written_as`) stays for a future spark/2: its rows read up the chain and a write stores the latest major (LDB-P13), so no batch migration is needed. If one ever is, it is rebuilt per lineage then; today's `migrate.ts` assumes a single stored lineage. Every client already writes `spark/1` (checked: `web/src/data/db.ts:178,207`, the bot's `add`, `mirror!`, `cycle!`, `angle!`, `unangle!`). *Extended in review: the upstream fallback, the strip route and the rest of `migrate.ts` die for the same reason.* |
| D13 | **Write requirements (saltorbit, 2026-09-11).** Versions are **per part**: the layout's own fields (name, owner, deletion) are one part, and each format is its own part (his pick over one version per layout).<br>**E1.** Every edit names the version of the part it changes (payload write or patch, adding a format, rename, transfer, delete, restore). If that part changed since, through any client, the edit fails with `409 stale` and the current version, and nothing is written.<br>**E2.** Of two edits to the same part based on the same version, exactly one succeeds.<br>**E3.** An edit based on its part's current version succeeds, unless it fails on its own merits (permission, validation, a taken name), even when another part of the same layout is written in between. This is what the server-side retry in §2.2 guarantees; it stays (lead's call: kept over a serial writer or per-layout Durable Objects, since it is built and its logic reviewed sound).<br>**E4.** Creating a layout needs no version; it fails only if the name is taken.<br>**L1.** A like needs no version. It succeeds if the layout is live and that user hasn't liked it; a repeat like fails with `409 already_liked` and changes nothing (his pick; today it is a silent no-op).<br>**L2.** An unlike succeeds if that user has liked it; otherwise `409 not_liked` (lead's call, mirroring L1).<br>**L3.** Likes never change any version, so a like never fails an edit and an edit never fails a like.<br>**L4.** `like_count` always equals the number of distinct users in `likes` for the layout. |

## 2. The model

### 2.1 Tables

The layout is the identity: id, name, owner, likes, deletion, and its link to cmini. Each format a layout has is a row of its own, keyed by the format's **lineage** (`spark`, later `lw`), so a future spark/2 migrates the same row forward instead of adding a second one.

```
layouts         id PK, name (unique among live), owner,
                n             -- internal write counter: +1 on every rev-bumping write, any scope
                layout_rev    -- +1 on every layout-level write
                created_at, modified_at, deleted, like_count,
                upstream_source, upstream_id, upstream_state    -- cmini follow state (§2.2)

layout_formats  layout_id, lineage            PK (layout_id, lineage)
                format        -- full id, e.g. 'spark/1'
                rev           -- this format's own rev, from 1
                created_at, modified_at
                payload_json, has_magic
                source_client, source_version  -- the latest write to this format

layout_revs     layout_id, n                  PK (layout_id, n)   -- the concurrency guard, as today (LDB-P2)
                lineage       -- NULL for a layout-level write
                rev           -- layout_rev when lineage IS NULL, else that format's rev
                event_seq, format, payload_json   -- format/payload NULL for a layout-level write
                UNIQUE (layout_id, lineage, rev)  -- a format's own history

events          seq PK, at, kind, layout_id, name, owner,
                format        -- NULL for a layout-level event
                rev           -- layout_rev when format IS NULL, else that format's rev
                actor, via, admin, detail_json, before_json, after_json,
                source_client, source_version
```

`n` never leaves the Worker. It is today's `rev` doing the job it really does: every write to a layout, whatever its scope, commits at the next `n`, so `layout_revs`' PK serializes all writes to one layout exactly as today. That keeps the checks that ride on that guard today race-free: owner, deletion, and the importer's follow state. Clients never see `n`; they see `layout_rev` and each format's `rev`, and If-Match compares only the one their write concerns (§2.2).

`authors`, `admins`, `clients`, `webhooks` and the shapes of `likes`, `import_state` and `import_map` are unchanged. The schema lands as one migration that drops and recreates `layouts`, `layout_formats`, `layout_revs` and `events`, empties `likes`, `import_map` and `import_state` (their rows point at ids that no longer exist), and resets every webhook cursor to 0 (D8). It is numbered after D1's migration, which merges first (F4).

### 2.2 Scopes and revs

Every rev-bumping write has one **scope**: the layout (name, owner, deletion) or one format. Its event names the format, or `null` for the layout. A write that changes both appends one event per scope in one batch, each with its own `layout_revs` row.

| a write that… | scope | bumps | If-Match | events |
|---|---|---|---|---|
| creates a layout with its first format | both | `layout_rev` → 1, that format's `rev` → 1 | none (as today) | `created` (`null`), then `format_added` (the format) |
| adds a format to an existing layout | the format | its `rev` → 1 | `If-None-Match: *` | `format_added` |
| replaces or patches a format's payload (fingermap, board, magic) | the format | its `rev` | `"<lineage>:<rev>"`, e.g. `"spark:7"` | `updated`, `fingermap`, … |
| renames, transfers, deletes | the layout | `layout_rev` | `"layout:<layout_rev>"` (transfer: presence only, as today) | `renamed`, `transferred`, `deleted` |
| restores | the layout | `layout_rev` | none (as today) | `restored` |
| likes, unlikes | none (informational, as today) | — | — | `liked`, `unliked` (`null`) |
| cmini import: create | both | as a create | `expectN` | `imported` (`null`), then `imported` (`spark/1`) |
| cmini import: update | the layout (name, owner, created_at), `spark`, or both | as the equivalent user writes | `expectN` | one `imported` per scope changed |
| cmini import: upstream delete | the layout | `layout_rev` | `expectN` | `upstream_deleted` (`null`) |

The rules:

- **Independence.** A write to one format never changes another format's row. A layout-level write changes no format row.
- **One write, one If-Match.** A user PATCH that mixes a layout-level field (`name`) with a format edit is refused (`400 mixed_patch`). Only the importer writes both scopes at once, and it is guarded by `n`, not by If-Match.
- **Races.** A write reads `n`, checks its If-Match against its own scope, and commits at `n + 1`. If another write to the same layout took `n + 1` first, the PK refuses the whole batch. The loser re-reads. If its own scope's rev still matches its If-Match (the winner was another scope), it re-runs its owner and deletion checks and retries, up to 3 times; otherwise it answers `409 stale`. So two writers on one format: one lands, the other gets `stale`. Writers on different scopes both land, and a transfer or delete that lands first is caught by the retry's own checks. System writers pass `expectN` (LDB-P14's `expectRev`, renamed) and never retry: any write since their read aborts theirs, and the next tick re-evaluates.
- **Follow state is layout-level.** The importer owns a following layout's name, owner, deletion and spark payload together, so `upstream_*` lives on `layouts`. A user write forks it (`following` → `forked`) iff it is layout-level or to lineage `spark`. A write to any other lineage never touches it. `nextUpstream` takes the write's scope.
- **Event `after`** holds, without payload, what the write changed: the `layouts` row for a layout-level event; the format's row for a format event, plus the layout's `upstream` when that write forked it. Folding a layout's events in seq order, with payloads from `layout_revs`, rebuilds every row (MF-3).
- **Timestamps.** `layouts.modified_at` moves only with layout-level writes; a format's with that format's writes. A list's `sort=modified_at` and `since=` use `max(layouts.modified_at, F.modified_at)` for the requested `format=F`: the last time anything an F reader sees changed.
- **Ownership stays per layout (D3).** Only the owner or an admin writes any of a layout's formats, adding one included, exactly as today.

### 2.3 Wire shape

Every payload-bearing response has the same shape. `format` names the payload that came back; `formats` lists every stored format the layout has, so a client can see what else exists without a second request.

```json
{
  "id": "01J…", "name": "graphite", "owner": "1234…",
  "layout_rev": 3, "created_at": "…", "modified_at": "…", "deleted": false, "like_count": 12,
  "upstream": { "source": "cmini", "id": "…", "state": "following" },
  "formats": {
    "spark/1": { "rev": 7, "created_at": "…", "modified_at": "…", "has_magic": true,  "source": { "client": "…", "version": "…" } },
    "lw/1":    { "rev": 2, "created_at": "…", "modified_at": "…", "has_magic": false, "source": { "client": "…", "version": null } }
  },
  "format": "spark/1",
  "payload": { "keys": { … }, "board": { … }, "magic": { … } }
}
```

The bare `rev` field is gone, on purpose: every client has to choose `layout_rev` or `formats[f].rev`, so nothing silently keeps the old meaning. For the same reason, If-Match values and write ETags are **scoped tokens**: `"layout:3"`, `"spark:7"`. A bare number is `400 bad_request` (param `If-Match`), and so is a token for the wrong scope, such as `"spark:7"` on a rename or a delete. Without this, a client that sent `layout_rev` to a format write would pass whenever the two numbers happened to agree. A write's response carries its scope's token as its `ETag`. `*` still means "overwrite on purpose", within the write's own scope. Single-layout GETs carry no ETag (as today); the list routes keep their seq-based one. `WIRE_VERSION` bumps (LDB-R1) so no cached 304 serves the old shape.

A GET reads the `layouts` row and the format row in one statement, so the two revs it returns are one snapshot. The bot's monotonic guard depends on this (LDB-B65, §4).

`409 stale` carries `scope`, that scope's current `rev`, and the current record: the layout-level fields and `formats` always, plus `format` and `payload` when the scope is a format.

### 2.4 Routes

| route | change |
|---|---|
| `GET /v1/layouts?format=F` | `format` required. Rows are the live layouts that have F stored or can derive it (§2.5), each with the §2.3 fields minus `payload` (plus `payload` under `full=1`). `has_magic=` filters on F. Replaces both today's `?as=` and today's `?format=` (which filtered the one stored column). |
| `GET /v1/layouts/:ref?format=F` | `format` required. Without one: `400 format_required`. A layout with no F that can't derive it: `404 format_absent`. Both bodies carry the layout-level fields and `formats`, so a client (the bot's feed, notably) learns what exists without a second request. |
| `GET /v1/layouts/:ref/history` | all events for the layout, each naming its format. `?format=F` is an optional filter; absent means all, not a default. |
| `GET /v1/layouts/:ref/rev/:n?format=F` | `format` required; `:n` is that format's rev. |
| `POST /v1/layouts` | body `{name, format, payload}`, unchanged; appends `created` then `format_added` (§2.2). |
| `PUT /v1/layouts/:ref` | body `{format, payload}`. `If-Match: "<lineage>:<rev>"` replaces that format; `If-None-Match: *` adds it to the layout (`409 format_exists` if it has it already). |
| `PATCH /v1/layouts/:ref` | either `{format, fingermap \| board \| magic}` (If-Match: that format's token) or `{name}` (If-Match: `"layout:<n>"`); both at once is `400 mixed_patch`. |
| `DELETE /v1/layouts/:ref` | deletes the layout (If-Match: `"layout:<n>"`); otherwise unchanged. |
| `POST /v1/layouts/:ref/transfer` | layout-level; If-Match `"layout:<n>"` or `*`, presence-checked only, as today. |
| `POST /v1/layouts/:ref/restore`, `PUT \| DELETE /v1/layouts/:ref/like`, `GET /v1/layouts/:ref/likes` | layout-level, no If-Match, unchanged. |
| `GET /v1/changes`, `/v1/changes/stream`, webhooks, `/admin/changelog` | events gain `format`; no payloads; no format parameter. |
| `GET /v1/formats` | drops the `cmini/1` and `akl/1` alias rows (D5, D12). |
| `GET /v1/dump/*` | the dump carries `layouts`, `layout_formats`, `layout_revs`, and reads `meta` before any table (§3 F2). `latest.<fmt>.json` per stored format already exists (LDB-D6); it lists the layouts that have that format. |

New error codes, added to `core/errors.ts` with the rest: `format_required` (400), `format_absent` (404), `format_exists` (409), `mixed_patch` (400). A write naming an output format stays `400 format_not_writable`; an unregistered id stays `400 unknown_format`.

**Not in this round:** removing one format from a layout. No client needs it, and it can be added later without breaking anything (`DELETE /v1/layouts/:ref/formats/:lineage`, a `format_removed` kind, a rule that a live layout keeps at least one format).

### 2.5 Output formats

`mana2/1` stays an output format: never stored, derived on read. `GET …?format=mana2/1` derives it from the one stored lineage with a registered translation to it (spark today). The response says so (`"derived_from": "spark/1"`) and its `formats` map lists the stored formats only. A layout without that lineage gets `404 format_absent`. Asking for mana2 is explicit, so this doesn't contradict D4.

Two rules keep hidden choices out of derivation:

- **Each output format is reachable from exactly one stored lineage** (MF-10, a registry test). A second stored lineage that wants an edge to mana2/1 has to come with a way to name the source (a `from=` parameter), designed at that point.
- **Stored formats are never derived.** `?format=spark/1` returns the layout's own spark row (translated within its lineage, LDB-F18) or `404 format_absent`. A `lw/1 → spark/1` edge, if someone writes one, is a package function clients call themselves; layoutdb never serves it. So "has spark/1" always means someone wrote spark/1.

### 2.6 Who reads what

| client | reads | writes |
|---|---|---|
| spark bot | `spark/1` only. Follows the feed, applying layout-level and `spark` events; from other formats' events it keeps only the format names (`format_added`) | `spark/1` |
| akl.gg (SPA + `functions/`) | `spark/1` | `spark/1` |
| stats service, `sync_cmini_data.py` | `spark/1`; a layout with no spark row is skipped and counted in the build log | — |
| magic-rules builders (`build_magic_rules.py`, `stats_service/rules.py`, `fetch_d1_rules.py`) | `spark/1` with `has_magic=1` | — |
| cmini importer (in the Worker) | upstream cmini | the layout's own fields and lineage `spark` only |
| layouts.wiki (future) | `lw/1`, and `spark/1` if it wants | `lw/1` |

A lookup of a layout that exists but has no spark row must say so, not "not found" (R1: bot lookups are always correct). The bot caches every live layout's layout-level fields and format names, spark or not, so it answers "`<name>` has no spark/1 format (it has lw/1)" from memory (LDB-B3: a read verb makes no request).

The stats service's pointer `db_seq` keeps its meaning: every event at or below it is reflected. An event for another format changes no spark input, so it is reflected trivially.

## 3. Slices

Each slice runs in its own worktree on a branch cut from `ldb-formats`, built by a Sonnet agent from a self-contained brief, and reviewed by the lead before it merges back. One agent edits at a time (subagent-worktree lesson). Docs and invariants ride in the same slice as the code (D9).

**Nothing deploys before F4.** No slice pushes to `main` or opens a PR from `layout-db-pr`: db.yml's `pr-deploy` job deploys prod `akl-db` from that branch's PRs. The live Worker, bot and stats service keep running the old wire until F4 replaces all three together. Until then an F-branch Worker runs only locally (`wrangler dev`) or in tests.

**Syncing the live bot and trial site (saltorbit, 2026-09-11):** keep the bot and `db.cmini-web.pages.dev` synced with this branch so testing continues, but only at natural pause points, and not when a sync would be painful. F1 alone was not synced: its `x` removal makes every stored payload unwritable, so syncing it meant a full wipe and re-import, and F2 + F3 need one anyway (D8). The first sync is therefore F4.

### F1 — spark/1 cleanup (format package, and the dead code it strands)

- D5: delete `toCmini`, the `adapter:cmini` alias and the `cmini/1` read path (`registry.ts` ALIASES/translate, `adapters/cmini/translate.ts`, `adapters/cmini/edits.ts`, `cminiBoardWord` if only `toCmini` uses it), and the `held` bookkeeping for it in `db/src/import/diff.ts`.
- D10: drop `x` from `spark/1/schema.json`, `validateX`, `fromCmini`'s `x.cmini` writes and the bot's `x.cmini.link` reads (`bot/src/commands/shared.ts:133,162`).
- D12: delete `LEGACY_STORED`, `storedAsSpark`, the `akl/1` alias, the package's `./akl/1`, `./cmini/1` and their `schema.json` export subpaths, `core/migrate.ts` and its admin route, `core/follows.ts`, `legacyUpstreamMap`, `upstreamOf`'s fallback, `import/strip.ts` and its admin route, `scripts/migrate_records_to_spark.py`. Every caller moves in the same slice: `import/apply.ts`, `import/diff.ts` (`d1Ours`), `core/write.ts`, `routes/admin.ts`, and the bot's `@akl/layout-formats/akl/1` imports (→ `spark/1`). Find them with `rg -a`, which doesn't skip files as binary: `bot/src/cache/provenance.ts` is one plain grep skips. Bot typecheck is F1's gate too.
- D11: `frozen.test.ts` reads an explicit frozen list (empty), and says so in its output.
- Regenerate the spark/1 and mana2/1 fixtures that carry `x`; delete `x.test.ts`, the `toCmini` round-trip tests, the `registry-aliases` rows for the removed aliases, and the tests of the deleted modules.
- New spark/1 spec page (§5).

### F2 — several formats per layout (the Worker)

Schema (§2.1); core (`records.ts`, `events.ts`, `write.ts`, `ifmatch.ts`, `etag.ts`, `upstream.ts`, `errors.ts`); routes (§2.4, including `changelog.ts`, `webhooks.ts`, `stream.ts`); `registry.translate` taking the stored row of the lineage the request named, plus derivation for output formats (§2.5); the import (`apply.ts`, `diff.ts`, `difftick.ts` write and compare the layout's own fields and lineage `spark` only, one event per scope, guarded by `expectN`); dump, restore and the drill (LDB-D5's byte-equality holds across the new tables; `buildDump` reads `meta` first and the tables after it, not in one `Promise.all`, so every table is at or past `meta.seq`); `WIRE_VERSION`. Tests register a test-only second stored lineage (`db/tests/formats/stub-lineage.ts` already has the pattern), so every multi-format path runs without a real second format.

### F3 — clients

Split into three sub-slices, in this order, each against the F2 Worker running locally:
- **F3a bot:** `client/types.ts` wire types, `client/http.ts`, `cache/boot.ts` (folds `layouts` + `layout_formats`; §6 Q5), `cache/feed.ts` (detail GETs use `?format=spark/1`; events for other lineages skip the GET and only update the layout's format names; a `404 format_absent` is folded as a layout without spark, never a failed GET, or the drain would stall forever), `cache/store.ts` (LDB-B65 restated), the stats memo keyed by `(id, spark rev, corpus)`, the provenance memo keyed by `(id, spark rev, name, publish)`, every write verb's scoped If-Match, the "has no spark/1 format" answer, and deleting `applyMigrated` (LDB-B49).
- **F3b site:** `web/src/data/db.ts` (every GET names `format=spark/1`, including `get` and `listOwned`), `web/src/state/db.ts` (rebase, `expectedRev`), `Draft.origin.rev` = the spark rev, scoped If-Match tokens, `functions/_lib/magicdb.mjs`, `functions/api/db/**` pass-through.
- **F3c scripts:** `sync_cmini_data.py`, `stats_service/dbclient.py` + `rules.py`, `build_magic_rules.py`, `fetch_d1_rules.py`, `migrate_magic_rules_to_db.py`, `scripts/e2e/bot_db_site.mjs`.

### F4 — rebuild and prove it live

D1's branch merges into `ldb-formats` first, so one deploy carries both. Prod akl.gg is fenced from layoutdb; F4 starts by confirming its Pages env has no `DB_BASE_URL`, so the wire change can't reach it. Then, in order: stop the bot (an old bot against the new wire would stall its drain on `400 format_required` while still answering from a stale cache, breaking R1); apply the migration to prod `akl-db` and deploy the Worker; wipe; re-import from cmini; reset magic from akl.gg's published `magic_rules.json` (the 2026-09-11 cutover step); deploy and start the new bot; restart the stats service. Then:
- the spark-tester e2e harness, 46/46 or better, plus new scenarios for a layout with a second (test) format and a layout with no spark row;
- `scripts/e2e/bot_db_site.mjs --dry-run` re-recorded;
- the trial site (`db.cmini-web.pages.dev`) publishing a draft and reading it back.

## 4. Invariants

Ids assigned by the F2 slice (2026-09-11), the next free number in `db/INVARIANTS.md` at the time (MF-8 excluded -- it's the bot's own job, F3a, and belongs in `bot/INVARIANTS.md` when that slice lands): MF-1=LDB-P16, MF-2=LDB-P17, MF-3=LDB-P18, MF-4=LDB-G11, MF-5=LDB-P19, MF-6=LDB-P20, MF-7=LDB-F25, MF-9=LDB-F23 (already existed, F1), MF-10=LDB-F26, MF-11=LDB-P21, MF-12=LDB-I18, MF-13=LDB-D7. "The write model" below is one `fast-check` model shared by MF-1, 2, 3, 5 and 12 (one shared test, `db/tests/events/fold.test.ts`'s `[LDB-P16] [LDB-P17] [LDB-P18] [LDB-P19] [LDB-I18]`-tagged case): random sequences of every write kind in §2.2 (user and import, both scopes, over spark and the test-only second lineage), including concurrent pairs. MF-6 turned out to need its own dedicated race tests instead (concurrency requires real interleaving, not a single-threaded random-sequence model), so it is NOT part of the shared write model despite the original plan grouping it there.

| id | invariant | enforced by |
|---|---|---|
| MF-1 = LDB-P16 | **Format independence.** A write to format A never changes format B's payload, rev, created_at or modified_at; a layout-level write changes no format row. | the write model: every row outside the write's scope is byte-equal before and after each step |
| MF-2 = LDB-P17 | **Rev partition.** Every rev-bumping event has exactly one scope: `format` NULL bumps `layout_rev` by 1, otherwise it bumps that format's `rev` by 1. A write that changes both scopes (a create, an import) appends one event per scope. Per layout, `layout_revs.n` is gapless from 1; per `(layout, lineage)`, `rev` is gapless from 1; per layout, `layout_rev` equals its count of layout-level events. | the write model |
| MF-3 = LDB-P18 | **Replay equivalence.** Folding a layout's events in seq order, with payloads from `layout_revs`, reproduces its `layouts` row and every `layout_formats` row exactly. | the write model (`foldLayout`, `foldRecord`'s several-format successor); also exercised end to end by the dump/restore round trip (`tests/rehost.test.ts`) |
| MF-4 = LDB-G11 | **Explicit format.** Every route that returns or changes a payload answers `400 format_required` without one; no route has a default. | a generated matrix over the three `?format=`-bearing GET routes (list, detail, `/rev/:n`) × {format missing, stored and present, stored but absent on this layout, output (mana2/1), unregistered}, each with its expected status and code (`tests/api/format-required-matrix.test.ts`) |
| MF-5 = LDB-P19 | **At least one format.** Every layout has at least one `layout_formats` row: creation takes one and nothing removes one this round (§2.4). | the write model's per-step check |
| MF-6 = LDB-P20 | **Concurrency per scope, serialization per layout.** Two writers on one format with the same If-Match: exactly one lands, the other gets `409 stale` with that format's current rev. Writers on different scopes of one layout both land. A format write racing a transfer or delete that lands first is refused by the new owner/deletion state, never landing on a tombstone or for a former owner. | dedicated race tests (`db/tests/events/races.test.ts`), including a forced PK collision to exercise the retry path -- NOT part of the shared write model (see note above) |
| MF-7 = LDB-F25 | **Derived formats are never stored.** A `?format=mana2/1` read never writes, and its response names `derived_from`. A read of a stored format is never derived. | `tests/api/mf7-derived-formats.test.ts`: byte-identical row counts/fields across every polled table before/after a derived read, on detail, list and `full=1` |
| MF-8 | **The bot only reads spark.** Every layoutdb GET the bot issues names `format=spark/1`. An event for another lineage changes nothing in the bot's cache except that layout's format names. A layout with no spark row answers "has no spark/1 format", never "not found", and its `404 format_absent` never stalls the drain. | bot test over a feed with mixed-lineage events and spark-less layouts; a matrix row per lookup verb (F3a, not this slice) |
| MF-9 = LDB-F23 | **fromCmini is exact where spark has a place.** For every cmini layout, the multiset of (char, row, col, finger) equals spark/1's `keys` entries, cmini's board word maps to spark's `board` by the fixed table, and the fields dropped are exactly `tag`, `blame`, `combos`, `link`. | property test over `upstream-100` with a test-local projection (replaces the `toCmini` round trip deleted by D5) -- landed with F1, before this slice |
| MF-10 = LDB-F26 | **Unambiguous derivation.** Each `role: "output"` format is reachable from exactly one `role: "stored"` lineage. | `tests/formats/mf10-derivation.test.ts`: a registry test over `list()`/`reachingLineages()`/`outputSourceLineage()`; a deliberately-ambiguous test-only pair of stored lineages both claiming the same output edge proves it's caught, not silently resolved. The read-time half (a layout missing its one reaching lineage answers `format_absent`) is `tests/api/held.test.ts` |
| MF-11 = LDB-P21 | **Scoped If-Match.** A write accepts only its own scope's token (or `*`); a bare number or another scope's token is `400 bad_request`, before any read. Every write response's `ETag` is its scope's token. | a generated matrix: every write route × {absent, bare number, own scope, other scope, wrong scope, `*`} (`tests/api/ifmatch.test.ts`) |
| MF-12 = LDB-I18 | **Follow scope.** A user write forks a following layout iff it is layout-level or to lineage `spark`; a write to another lineage never changes `upstream`; the importer never writes a forked layout. | the write model (restates LDB-I14 and LDB-P11), plus `tests/core/upstream.test.ts`'s pure `nextUpstream(prior, via, touches)` matrix |
| MF-13 = LDB-D7 | **Dump floor.** Every table in a dump is at or past the dump's `meta.seq`, so booting from the dump and draining the feed from `meta.seq` equals the live state (LDB-B10 with two tables). | `tests/api/mf13-dump-floor.test.ts`: a `readHead()` spy lands a write strictly between `meta`'s read and the table pages' own reads, then folds the dump's own events/revs and checks the result against both the dump's own rows and live state |
| LDB-F10 | retired (D10). | — |
| LDB-F6 | suspended: the frozen list is empty (D11). | `frozen.test.ts` |
| LDB-F16 | restated: several stored lineages; a write stores the lineage its `format` names, never another. | existing tests, updated |
| LDB-F20, F21, P12, B49 | retired (D5, D12: no aliases, no legacy rows, no migration). | — |
| LDB-P2 | restated: `layout_revs`' PK on `(layout_id, n)` is still the one concurrency guard; If-Match compares the write's own scope (MF-6, MF-11). | existing tests, updated |
| LDB-P14 | restated: `expectRev` becomes `expectN`; any write to the layout since the system writer's read aborts it. | existing tests, updated |
| LDB-B65 | restated: the bot folds a snapshot only if both its `layout_rev` and its spark `rev` are ≥ the cached ones; a tombstone guard is on `layout_rev`. Sound because each GET is one snapshot (§2.3) and both revs only grow, so any two snapshots are ordered in both. | existing property test, extended to two revs |

## 5. Docs

| doc | what changes |
|---|---|
| `design/layout-db/architecture.md` (the `/layoutdb/` page) | §1 no longer says "every record is stored in one format"; §2 shows a layout with several formats (new figure); §3 the formats table drops `cmini/1` export, `akl/1` and `x`; §4 read/write walk-throughs name the format; §5 invariants; new section **"Adding a second format: layouts.wiki"** (below). |
| new `design/layout-db/22-spark-spec.md` (renders to `/layoutdb/`) | the spark/1 spec xsznix asked for: every field, its rules, what it can't express (repeated letters, per D2), how it lowers to mana2, with one worked example layout. |
| `design/layout-db/03-api.md`, `db/README.md` (Formats, If-Match), `db/INTEGRATION.md`, `db/docs/adoption.md` (§3 Read, §4 Stay current, §5 Write, §7 For format authors, §9 endpoint table) | the §2.3 wire shape and scoped tokens, §2.4 routes and error codes, the two revs, `format_required`. |
| `design/layout-db/01-format.md`, `20-spark.md`, `db/formats/spark/1/README.md`, `db/formats/adapters/cmini/README.md` | a dated note at the top pointing here for D5, D10, D12 (these are design history, not rewritten). The READMEs are current docs and are rewritten. |
| `bot/README.md`, `bot/INVARIANTS.md`, `db/INVARIANTS.md`, `design/INVARIANTS.md` | the slices' invariants. |

### The layouts.wiki section (architecture.md)

A worked example, not a promise: what it takes to add `lw/1` as a second stored format, written so xsznix could follow it. Three inline SVG figures, matching the page's existing six:

1. **One layout, two formats.** The `layouts` row with its two `layout_formats` rows (spark, lw), each with its own rev and history, and the events log interleaving layout-level and per-format events.
2. **Who reads and writes what.** The bot and akl.gg on spark; layouts.wiki on lw (and spark if it wants); the importer on spark only; mana2 derived from spark on read; keymaxx IR as layouts.wiki's own lowering, outside layoutdb.
3. **A write, end to end.** layouts.wiki PUTs `lw/1` with `If-Match: "lw:2"` → validate with the `lw/1` module → one `layout_revs` row + one event naming `lw/1` → the feed and webhooks → the bot sees an event for a lineage it doesn't read and ignores it.

Then the steps, as a checklist:
- write an `lw/1` module under `db/formats/lw/1/` exporting the whole `FormatModule` contract (`db/formats/registry.ts`): `id`, `owner`, `description`, `schema` (a JSON Schema object, served at `/v1/formats/lw/1/schema.json`), `role: "stored"`, `validate`, `to` and `from` (both required, `{}` is fine), and `hasMagic` (required; `() => false` if lw has no magic). `edits` is optional: without it every PATCH verb on lw answers `unsupported_for_format`. `up`/`down` are only for `lw/2` and later;
- register it: add it to `REGISTRY` in `db/formats/registry.ts` and the package's `exports`, bump `@akl/layout-formats`, deploy the Worker. It's a code change reviewed like any other, not a runtime plugin (D7);
- payloads are JSON, stored `canonical()`: object keys sorted, arrays kept in order. A format must not give meaning to key order. An opaque non-JSON payload needs `payload_json` widened to a bytes column first;
- no `to`/`from` edges are required (D3). An edge to another stored lineage (say `lw/1 → spark/1`) is a package function for clients; layoutdb never serves it (§2.5). An edge to mana2/1 is refused while spark already reaches it (MF-10);
- the format's own versioning: `lw/2` ships `up`/`down` to `lw/1` (LDB-F18), so clients pinned to `lw/1` keep working. Once `lw/1` has an outside user it goes on LDB-F6's frozen list;
- a client credential for layouts.wiki (`POST /v1/admin/clients`); it writes a layout's formats only as that layout's owner, like every client;
- nothing in the bot, akl.gg or the stats service changes.

## 6. Questions for the reviewer — answered

1. **Key `layout_formats` by lineage rather than full id?** Yes. spark/1 and spark/2 of one layout are one format at two ages; D3's "each format" means each lineage. The wire's `formats` map is still keyed by the stored full id, and If-Match tokens by lineage.
2. **`upstream_*` on the spark row or on `layouts`?** On `layouts` (§2.2). The importer writes the layout's name, owner and deletion as well as spark's payload, and a user rename must fork today's follow state or the next tick would rename it back. The fork rule names both scopes it covers (layout-level, lineage `spark`), so a write to another lineage still never forks (MF-12).
3. **Does any reader want "any format has magic"?** No. Every `has_magic` reader (the magic-rules builders, the bot) reads spark only, so it stays per format and the list filter applies to the requested `format`.
4. **Hidden defaults in §2.4?** Three found and closed: derivation's source when two stored lineages reach one output (MF-10); `DELETE` without `?format=` meaning "delete the layout" (format removal left this round, and scoped tokens would catch a format token there anyway); and `/history`'s `?format=`, which is a filter with "absent = all", not a default. List and dump have none: list requires `format`, and each dump file names its format.
5. **What does the bot's boot need beyond reading two tables?** Four things. (a) Keep spark-less live layouts: their name, owner, `layout_rev` and format names, so lookups answer "has no spark/1 format" and the name reads as taken. (b) Seed LDB-B65's guard with both revs. (c) A dump floor: every table at or past `meta.seq` (MF-13; today's `buildDump` reads `meta` concurrently with the tables, so F2 sequences it). (d) Nothing about cross-table snapshots: the two tables may be read at different moments, because the feed replays from `meta.seq` and the two-rev guard only moves forward.

## 7. Review changes (2026-09-11)

What the review changed, and why. Rows marked **lead's call** changed a lead's call and can be flipped back.

| where | change | why |
|---|---|---|
| D12 (**lead's call**) | also deletes the legacy upstream fallback, the M1 strip route and all of `migrate.ts` | dead after D8 for the same reason; the fallback walks `events WHERE rev IS NOT NULL`, which the rev split breaks anyway; `migrate.ts` assumes one stored lineage |
| §2.1 | kept `layout_revs` with PK `(layout_id, n)` as the one per-layout guard, instead of `format_revs` keyed per format | with the guard per format, a format write no longer collided with a transfer or delete: a former owner's edit or an edit to a tombstone could land, and the importer's layout-level write could re-set a follow state a user's spark write had just forked. `n` restores today's serialization while clients still see two revs |
| §2.1 | `upstream_*` moved to `layouts`; `likes`, `import_map`, `import_state` emptied by the migration; migration numbered after D1's | Q2; stale rows would point at wiped ids |
| §2.2 | a create (and an import touching both scopes) is two events in one batch | the table had `created` bumping both revs while MF-2 said every event bumps exactly one |
| §2.2 | the cross-scope retry rule, the fork rule, what `after` holds, which `modified_at` list sorts use, owner-only format writes | none were stated; each is needed for MF-3, MF-6 or `since=` correctness |
| §2.2, §2.4, MF-5 | format removal left for later (**lead's call**) | no client needs it; it brought a resurrection race, an overloaded `DELETE` and a last-format rule |
| §2.3 | scoped If-Match tokens and write ETags (`"spark:7"`, `"layout:3"`); `upstream` and per-format `source` in the wire shape; one-statement snapshot reads; the `stale` body | a bare number sent to the wrong scope passed whenever the numbers agreed (R4); the shape had dropped two fields; LDB-B65 needs snapshots |
| §2.4 | restore and likes take no If-Match (as today); transfer is presence-only (as today); new error codes listed; `404 format_absent` carries the layout-level fields | the route table said "If-Match is `layout_rev`" for all of them, which changed today's behavior by accident; the bot's feed must fold a spark-less layout without a second request |
| §2.5 | derivation from exactly one stored lineage (MF-10); stored formats never derived | two stored lineages reaching mana2 would be a hidden default; §5's `lw/1 → spark/1` suggestion would have served derived spark to the bot |
| §3 | "nothing deploys before F4" stated, with the `pr-deploy` trap; F4 stops the bot first and checks prod akl.gg is fenced | an old bot against the new wire stalls its drain and serves a stale cache (R1) |
| §3 F1 | callers of the deleted code (Worker and bot) move in F1; package subpaths go; `rg -a` | deleting `akl/1` breaks the bot's typecheck otherwise |
| §3 F2/F3 | dump reads `meta` first; the bot folds `404 format_absent` instead of stalling; the provenance memo is keyed on the spark rev; `web/src/data/db.ts`'s `get`/`listOwned` named | each would have been a bug found only in F4 |
| §4 | MF-6 says `409 stale` (it said `412`, which layoutdb doesn't use); MF-2, 5, 8, 9 tightened; MF-10..13 added; LDB-F16, F20, F21, P12, P14, B49 restated or retired | the covenant: each new rule in §2 now maps to an enforced row |
| §5 | the checklist names the real `FormatModule` fields, registration as a code change, `canonical()`'s key order, owner-only writes | "schema or validator" was wrong: both are required, and so are `to`, `from`, `hasMagic` |
