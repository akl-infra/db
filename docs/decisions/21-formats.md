# 21 — several formats per layout, the webhook lease, spark/1 cleanup

Status: plan written 2026-09-11; under review by an Opus agent (Fable is out of credits until 2026-09-12). No code yet, except D1, which is on its own branch.

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
| D12 | **Lead's call: the legacy-format machinery goes.** After the D8 wipe no row is stored as `cmini/1` or `akl/1`, so `LEGACY_STORED`, `storedAsSpark`, the `akl/1` alias, the S4 record migration (`migrate/tick`'s legacy half, `scripts/migrate_records_to_spark.py`) and the `migrated` event kind are dead code. An alias is an implicit default in disguise (D4). The within-lineage chain (`up`/`down`, `format_behind`, P13 `written_as`) stays for a future spark/2. Every client already writes `spark/1` (checked: `web/src/data/db.ts:178,207`, the bot's `add`, `mirror!`, `cycle!`, `angle!`, `unangle!`). |

## 2. The model

### 2.1 Tables

The layout is the identity: id, name, owner, likes, deletion. Each format a layout has is a row of its own, keyed by the format's **lineage** (`spark`, later `lw`), so a future spark/2 migrates the same row forward instead of adding a second one.

```
layouts         id PK, name (unique among live), owner, layout_rev,
                created_at, modified_at, deleted, like_count

layout_formats  layout_id, lineage            PK (layout_id, lineage)
                format        -- full id, e.g. 'spark/1'
                rev           -- this format's own rev, from 1
                created_at, modified_at
                payload_json, has_magic
                upstream_*    -- cmini follow state (the importer only ever touches lineage 'spark')
                source_client, source_version

format_revs     layout_id, lineage, rev       PK (layout_id, lineage, rev)   -- the concurrency guard (was LDB-P2's layout_revs PK)
                event_seq, format, payload_json

events          seq PK, at, kind, layout_id, name, owner,
                format        -- NULL for a layout-level event
                rev           -- layout_rev when format IS NULL, else that format's rev
                actor, via, admin, detail_json, before_json, after_json,
                source_client, source_version
```

`likes`, `authors`, `admins`, `clients`, `webhooks`, `import_state` and `import_map` are unchanged. The schema lands as one migration that drops and recreates `layouts`, `layout_revs` → `format_revs`, `layout_formats` and `events`, and resets every webhook cursor to 0 (D8). `clients`, `admins` and `webhooks` survive.

### 2.2 Two kinds of rev

| a write that… | bumps | If-Match carries | event `format` |
|---|---|---|---|
| creates a layout (with its first format) | `layout_rev` → 1 and that format's `rev` → 1 | `If-None-Match: *` | the format (kind `created`) |
| adds a format to an existing layout | that format's `rev` → 1 | `If-None-Match: *` (per format) | the format (`format_added`) |
| replaces or patches a format's payload (fingermap, board, magic) | that format's `rev` | that format's `rev` | the format (`updated`, `fingermap`, …) |
| removes a format | nothing else | that format's `rev` | the format (`format_removed`) |
| renames, transfers, deletes, restores | `layout_rev` | `layout_rev` | `null` |
| likes, unlikes | neither (informational, as today) | — | `null` |
| cmini import (create / update / upstream delete) | as the equivalent user write, lineage `spark` only | — | `spark/1` or `null` |

A write to one format never changes another format's payload, rev or timestamps. Removing a layout's last format is refused (`409 last_format`): delete the layout instead. A PATCH that mixes a layout-level field (`name`) with a format edit is refused (`400 mixed_patch`), since the two carry different revs.

### 2.3 Wire shape

Every payload-bearing response has the same shape. `format` names the payload that came back; `formats` lists everything the layout has, so a client can see what else exists without a second request.

```json
{
  "id": "01J…", "name": "graphite", "owner": "1234…",
  "layout_rev": 3, "created_at": "…", "modified_at": "…", "deleted": false, "like_count": 12,
  "formats": {
    "spark/1": { "rev": 7, "created_at": "…", "modified_at": "…", "has_magic": true },
    "lw/1":    { "rev": 2, "created_at": "…", "modified_at": "…", "has_magic": false }
  },
  "format": "spark/1",
  "payload": { "keys": { … }, "board": { … }, "magic": { … } }
}
```

The bare `rev` field is gone, on purpose: every client has to choose `layout_rev` or `formats[f].rev`, so nothing silently keeps the old meaning. `WIRE_VERSION` bumps (LDB-R1) so no cached 304 serves the old shape.

### 2.4 Routes

| route | change |
|---|---|
| `GET /v1/layouts?format=F` | `format` required. Rows are the layouts that have F (stored, or derivable per §2.5), each carrying F's payload metadata. `has_magic=` filters on F. Replaces both today's `?as=` and today's `?format=` (which filtered the one stored column). |
| `GET /v1/layouts/:ref?format=F` | `format` required. `400 format_required` otherwise, with the layout's `formats` in the error body so a client can see what to ask for. `404 format_absent` when the layout has no F and none can be derived. |
| `GET /v1/layouts/:ref/history` | all events for the layout, each naming its format; optional `?format=F` filter. |
| `GET /v1/layouts/:ref/rev/:n?format=F` | `format` required; revs are per format. |
| `POST /v1/layouts` | body `{name, format, payload}`; unchanged shape. |
| `PUT /v1/layouts/:ref` | body `{format, payload}`. `If-Match: <rev of that format>` replaces it; `If-None-Match: *` adds the format to the layout (`409` if it exists). |
| `PATCH /v1/layouts/:ref` | either `{format, fingermap | board | magic}` (If-Match: that format's rev) or `{name}` (If-Match: `layout_rev`). |
| `DELETE /v1/layouts/:ref?format=F` | removes one format (If-Match: its rev). Without `format`: deletes the layout (If-Match: `layout_rev`). |
| `POST /v1/layouts/:ref/restore`, `/transfer`, `PUT|DELETE /like` | layout-level, unchanged except If-Match is `layout_rev`. |
| `GET /v1/changes`, `/v1/changes/stream`, webhooks | events gain `format`; no payloads; no format parameter. |
| `GET /v1/formats` | drops the `cmini/1` and `akl/1` alias rows (D5, D12). |
| `GET /v1/dump/*` | the dump carries `layouts`, `layout_formats`, `format_revs`; `latest.<fmt>.json` per stored format already exists (LDB-D6). |

### 2.5 Output formats

`mana2/1` stays an output format: never stored, derived on read. `GET …?format=mana2/1` derives it from the layout's stored format that has a registered translation to mana2 (spark today). The response says so (`"derived_from": "spark/1"`) and its `formats` map is the stored formats only. A layout with no stored format that can reach mana2 gets `404 format_absent`. Asking for mana2 is explicit, so this doesn't contradict D4.

### 2.6 Who reads what

| client | reads | writes |
|---|---|---|
| spark bot | `spark/1` only; follows the feed and ignores events for other formats except layout-level ones | `spark/1` |
| akl.gg (SPA + `functions/`) | `spark/1` | `spark/1` |
| stats service, `sync_cmini_data.py` | `spark/1`; a layout with no spark row is skipped and counted in the build log | — |
| magic-rules builders (`build_magic_rules.py`, `stats_service/rules.py`, `fetch_d1_rules.py`) | `spark/1` with `has_magic=1` | — |
| cmini importer (in the Worker) | upstream cmini | lineage `spark` only |
| layouts.wiki (future) | `lw/1`, and `spark/1` if it wants | `lw/1` |

A lookup of a layout that exists but has no spark row must say so, not "not found" (R1: bot lookups are always correct). The bot answers "`<name>` has no spark/1 format" with the formats it does have.

## 3. Slices

Each slice runs in its own worktree on a branch cut from `ldb-formats`, built by a Sonnet agent from a self-contained brief, and reviewed by the lead before it merges back. One agent edits at a time (subagent-worktree lesson). Docs and invariants ride in the same slice as the code (D9).

### F1 — spark/1 cleanup (format package)

- D5: delete `toCmini`, the `adapter:cmini` alias and the `cmini/1` read path (`registry.ts` ALIASES/translate, `adapters/cmini/translate.ts`, `adapters/cmini/edits.ts`, `cminiBoardWord` if only `toCmini` uses it), and the `held` bookkeeping for it in `db/src/import/diff.ts`.
- D10: drop `x` from `spark/1/schema.json`, `validateX`, `fromCmini`'s `x.cmini` writes and the bot's `x.cmini.link` reads (`bot/src/commands/shared.ts:133,162`).
- D12: delete `LEGACY_STORED`, `storedAsSpark`, the `akl/1` alias, the legacy half of `migrate.ts`, `scripts/migrate_records_to_spark.py`.
- D11: `frozen.test.ts` reads an explicit frozen list (empty), and says so in its output.
- Regenerate the spark/1 and mana2/1 fixtures that carry `x`; delete `x.test.ts`, the `toCmini` round-trip tests and `registry-aliases` rows for the removed aliases.
- New spark/1 spec page (§5).

### F2 — several formats per layout (the Worker)

Schema (§2.1), core (`records.ts`, `events.ts`, `write.ts`, `ifmatch.ts`, `etag.ts`, `upstream.ts`, `follows.ts`, `migrate.ts`), routes (§2.4), `registry.translate` taking the stored row the request named, import (`apply.ts`, `strip.ts`, `diff.ts`, `difftick.ts` write and compare lineage `spark` only), dump + restore + the drill (LDB-D5's byte-equality holds across the new tables), `WIRE_VERSION`. Tests register a test-only second stored format (`db/tests/formats/stub-lineage.ts` already has the pattern) so every multi-format path is exercised without a real second format.

### F3 — clients

Split into three sub-slices, in this order, each against the F2 Worker running locally:
- **F3a bot:** `client/types.ts` wire types, `client/http.ts`, `cache/boot.ts` (reads the new dump tables), `cache/feed.ts` (`?format=spark/1`; ignores other formats' events), `cache/store.ts` (the B65 monotonic guard tracks `layout_rev` and the spark `rev` separately), the stats memo keyed by `(id, spark rev, corpus)`, every write verb's If-Match, the "has no spark/1 format" answer.
- **F3b site:** `web/src/data/db.ts`, `web/src/state/db.ts` (rebase, `expectedRev`), `Draft.origin.rev` = the spark rev, `functions/_lib/magicdb.mjs`, `functions/api/db/**` pass-through.
- **F3c scripts:** `sync_cmini_data.py`, `stats_service/dbclient.py` + `rules.py`, `build_magic_rules.py`, `fetch_d1_rules.py`, `migrate_magic_rules_to_db.py`, `scripts/e2e/bot_db_site.mjs`.

### F4 — rebuild and prove it live

Apply the migration to prod `akl-db`, wipe, re-import from cmini, reset magic from akl.gg's published `magic_rules.json` (the 2026-09-11 cutover step), redeploy the bot, restart the stats service, then:
- the spark-tester e2e harness, 46/46 or better, plus new scenarios for a layout with a second (test) format and a layout with no spark row;
- `scripts/e2e/bot_db_site.mjs --dry-run` re-recorded;
- the trial site (`db.cmini-web.pages.dev`) publishing a draft and reading it back.

D1's branch merges into `ldb-formats` before F4 so one deploy carries both.

## 4. Invariants

New or changed; ids are placeholders until the slice picks the next free number in `db/INVARIANTS.md` / `bot/INVARIANTS.md` / `design/INVARIANTS.md`.

| id | invariant | enforced by |
|---|---|---|
| MF-1 | **Format independence.** For any sequence of writes, a write to format A never changes format B's payload, rev, created_at or modified_at. | property test: random write sequences over two stored formats (the test-only second format), checking every other format row is byte-equal before and after each write |
| MF-2 | **Rev partition.** Every rev-bumping event is exactly one of: layout-level (`format` NULL, bumps `layout_rev` by 1) or format-level (names one format, bumps that format's `rev` by 1). Per `(layout, lineage)`, `format_revs.rev` is gapless from 1. | property test over the same sequences, plus a SQL check in the drill |
| MF-3 | **Replay equivalence.** Folding a layout's events in seq order reproduces `layouts` and every `layout_formats` row exactly. | property test (extends today's `foldRecord` test) |
| MF-4 | **Explicit format.** Every route that returns or changes a payload answers `400 format_required` without one; no route has a default. | generated matrix: enumerated from the router table (`LDB-G10` already walks it), one row per route × {format missing, present, absent on this layout, unknown} |
| MF-5 | **Last format.** A live layout always has at least one format; removing the last one is `409 last_format`. | matrix row + property test |
| MF-6 | **Concurrency per scope.** Two writers racing on the same format: exactly one wins, the other gets `412` with the current format rev. Two writers on different formats of the same layout: both win. Same for `layout_rev` vs a format write. | race tests (extend `db/tests/events/races`) |
| MF-7 | **Derived formats are never stored.** A `?format=mana2/1` read never writes, and its response names `derived_from`. | matrix row |
| MF-8 | **The bot only reads spark.** Every layoutdb GET the bot issues names `format=spark/1`; an event for another format never changes the bot's cache. A layout with no spark row answers "has no spark/1 format", never "not found". | bot test over a feed with mixed-format events; a matrix row per lookup verb |
| MF-9 | **fromCmini is exact where spark has a place.** Every cmini key, finger, free position and board word survives into spark/1; nothing lands anywhere else. | property test over `upstream-100` (replaces the `toCmini` round trip deleted by D5) |
| LDB-F10 | retired (D10). | — |
| LDB-F6 | suspended: the frozen list is empty (D11). | `frozen.test.ts` |
| LDB-P2 | restated: the concurrency guard is `format_revs`' PK per `(layout, lineage, rev)`, plus the `layout_rev` compare for layout-level writes. | existing tests, updated |
| LDB-B65 | restated: the bot's monotonic guard tracks `layout_rev` and the spark `rev` separately. | existing test, updated |

## 5. Docs

| doc | what changes |
|---|---|
| `design/layout-db/architecture.md` (the `/layoutdb/` page) | §1 no longer says "every record is stored in one format"; §2 shows a layout with several formats (new figure); §3 the formats table drops `cmini/1` export, `akl/1` and `x`; §4 read/write walk-throughs name the format; §5 invariants; new section **"Adding a second format: layouts.wiki"** (below). |
| new `design/layout-db/22-spark-spec.md` (renders to `/layoutdb/`) | the spark/1 spec xsznix asked for: every field, its rules, what it can't express (repeated letters, per D2), how it lowers to mana2, with one worked example layout. |
| `design/layout-db/03-api.md`, `db/README.md` (Formats, If-Match), `db/INTEGRATION.md`, `db/docs/adoption.md` (§3 Read, §4 Stay current, §5 Write, §7 For format authors, §9 endpoint table) | the §2.3 wire shape, §2.4 routes, the two revs, `format_required`. |
| `design/layout-db/01-format.md`, `20-spark.md`, `db/formats/spark/1/README.md`, `db/formats/adapters/cmini/README.md` | a dated note at the top pointing here for D5, D10, D12 (these are design history, not rewritten). The READMEs are current docs and are rewritten. |
| `bot/README.md`, `bot/INVARIANTS.md`, `db/INVARIANTS.md`, `design/INVARIANTS.md` | the slices' invariants. |

### The layouts.wiki section (architecture.md)

A worked example, not a promise: what it takes to add `lw/1` as a second stored format, written so xsznix could follow it. Three inline SVG figures, matching the page's existing six:

1. **One layout, two formats.** The `layouts` row with its two `layout_formats` rows (spark, lw), each with its own rev and history, and the events log interleaving layout-level and per-format events.
2. **Who reads and writes what.** The bot and akl.gg on spark; layouts.wiki on lw (and spark if it wants); the importer on spark only; mana2 derived from spark on read; keymaxx IR as layouts.wiki's own lowering, outside layoutdb.
3. **A write, end to end.** layouts.wiki PUTs `lw/1` with `If-Match: <lw rev>` → validate with the `lw/1` module → one `format_revs` row + one event naming `lw/1` → the feed and webhooks → the bot sees an event for a format it doesn't read and ignores it.

Then the steps, as a checklist:
- register an `lw/1` module in `db/formats/` (id, owner, schema or validator, `hasMagic`, role `stored`); an opaque non-JSON payload needs `payload_json` widened to a bytes column first, since only JSON formats exist today;
- no `to`/`from` edges are required (D3); add one only for a projection someone wants, such as `lw/1 → spark/1` for clients that only read spark;
- the format's own versioning: `lw/2` ships `up`/`down` to `lw/1` (LDB-F18), so clients pinned to `lw/1` keep working;
- a client credential for layouts.wiki (`POST /v1/admin/clients`);
- nothing in the bot, akl.gg or the stats service changes.

## 6. Questions for the reviewer

1. Is keying `layout_formats` by lineage rather than full format id right, given D3 says "each format"? (Lead's view: yes; spark/1 and spark/2 of one layout are the same thing at two ages, not two formats.)
2. Should `upstream_*` (cmini follow state) live on the spark format row, or on `layouts`? The importer only ever writes spark, and a user's write to another format must not fork the layout from upstream.
3. `has_magic` per format: is there any reader that wants "any format has magic"?
4. Does anything else in §2.4 hide a default? (`?format=` on list, the history filter, dump.)
5. What does the bot's boot path (`cache/boot.ts` folds raw dump rows) need beyond reading two tables instead of one?
