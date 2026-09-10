# 20 — spark: one stored format (plan + ledger)

Status: **implementing** on branch `ldb-spark` (worktree
`.claude/worktrees/worktree-ldb-upcast`), off `ldb-v3`. Design source: the
architecture page saltorbit approved on 2026-09-10
(https://claude.ai/code/artifact/8bb80647-956e-4daf-96ac-b15685366c5d),
plus `19-upcast.md` (the chain, renamed here to spark). **Pick-up guide:
read §0, then §7 (ledger, newest last).**

## 0. How this branch lands

- `ldb-v3` is owned by the #304 session (cmini-web-c7). **Never move
  `ldb-v3` from here.** When ready: rebase `ldb-spark` onto `ldb-v3`'s head
  at that moment, push, send the SHA to cmini-web-c7; it runs the gates
  (below) and fast-forwards `ldb-v3` + pushes `layout-db-pr` (#307).
- Its gates, which must be green on the SHA: db `npm run typecheck` +
  `npx vitest run` (goldens regenerated); bot `npm run typecheck`,
  `npm run lint`, `npx vitest run` (after rebuilding `packages/akl-core`
  and `db/formats`); site `sh web/tests/tools/gates.sh --fast`; pytest over
  `scripts/tests/test_build_magic_rules.py test_fetch_d1_rules.py
  test_live_patch_sync.py test_fast_sync_patch.py`.
- **Files owned elsewhere — do not edit here:** `design/INVARIANTS.md`,
  `design/behaviors/*`, `bot/INVARIANTS.md`, `bot/src/render/image.ts`,
  `web/src/core/copyimage/*`, `design/layout-db/{13-ledger,05-bot,
  14-copy-signoff,18-command-decisions}.md` (c7 + its agents), and
  `web/src/core/akl1.ts`, `web/src/data/db.ts`,
  `functions/api/db/layouts/index.js` (the publish-ux branch,
  cmini-web-0c). Bot invariant rows go in this doc (§5) until
  `bot/INVARIANTS.md` is free; they are copied over at the rebase.
- **Deploys are not this branch's.** c7 deploys preview after the merge and
  asks saltorbit before any production D1 migration or record migration.

## 1. Decisions (all saltorbit's, 2026-09-10, unless marked)

1. **`spark/1` is the one stored format** — today's `akl/1`, renamed; the
   payload shape is unchanged byte-for-byte. akl.gg and the bot read and
   write it.
2. **cmini is an import source, not a format.** The importer converts each
   upstream detail to spark on arrival (`fromCmini`, already lossless,
   LDB-F5). `x.cmini` keeps `tag blame combos link` while the import runs.
3. **mana2 is the lowered format**: produced from spark on read
   (`?as=mana2/1`), never stored; a write in `mana2/1` is refused.
4. **No registry-level lowering.** `lower` leaves the `FormatModule`
   contract. spark keeps its magic compile (LDB-F14/F15 exactly as landed)
   as a named export used by `to["mana2/1"]`, `hasMagic`, collision
   validation and the bot.
5. **Top-level `upstream` field** `{source: "cmini", id, state:
   "following" | "forked"}` or `null`, folded from events, stored on the
   row.
6. **Magic edits fork** like any user write (retires LDB-I12's
   magic-only exemption going forward). Only system writes never fork: the
   importer and one-time migrations.
7. **The 67 M2-seeded records stay following** (stated on the approved
   page: the seed was a system migration). The record migration computes
   each record's initial state with the *legacy* rule (LDB-I12's, magic-only
   events skipped), so they come out following. c7 asked that this be
   flagged: it is, here and in the report the migration prints.
8. **Restore has no time limit** for owner or admin (was 30 days for the
   owner). Tombstones were never pruned, so no storage change.
9. **Restore under a reclaimed name** (judgment call, ledgered; the page
   recommended it): `POST .../restore` takes an optional `{name}`; without
   it a reclaimed name answers `409 name_taken` with `holder` as today.
   Both records keep their likes.
10. **Always store the latest spark major** (19-upcast.md round 2, renamed):
    single-step `up`/`down` chain per major, `format_behind` on a blind
    older-major overwrite, `written_as` on the event, per-major dumps. With
    only `spark/1` registered, the chain is exercised by a test-only stub
    lineage.
11. **Record migration is operator-driven, not a cron** (c7's request,
    2026-09-10): `POST /v1/admin/migrate/tick {dry_run}` + a script
    `scripts/migrate_records_to_spark.py --dry-run` that pages it and prints
    a report, same style as `migrate_magic_rules_to_db.py`.
12. **Transitional aliases** (needed by the deployed bot, the preview site,
    and the publish-ux branch until each is redeployed/updated):
    - `akl/1` ≡ `spark/1` on write (stored as `spark/1`) and on read
      (`?as=akl/1` answers the spark payload **labelled `format: "akl/1"`**,
      because the deployed bot branches on `format === 'akl/1'`).
    - `?as=cmini/1` stays readable (the adapter's `toCmini` of the spark
      payload) for the preview site's sync and the daily diff's HTTP path.
      `cmini/1` writes are refused.
    - All aliases live in one table in the registry with a removal
      checklist (§6). LDB-F20.
13. **Site code (`web/src`) is not touched this round**: it writes `akl/1`
    through the alias; the publish-ux branch owns those files and moves to
    `spark/1` after it merges.

## 2. Deploy order (for c7 / saltorbit; nothing here deploys)

The bot boots from the nightly dump, whose rows carry each record's
**stored** format. After the record migration those rows say `spark/1`,
which the deployed bot holds as unreadable. So:

1. Worker to preview with 0005 applied (aliases live; every stored record
   still reads as before).
2. Bot redeploy (reads `spark/1`, `akl/1` and legacy `cmini/1` rows).
3. Preview site rebuild (functions + scripts read `?as=spark/1`).
4. `migrate_records_to_spark.py --dry-run` on preview → report → real run →
   checks: daily diff zero, `verify_magic_migration.py` still 67/83,
   bot `!view` on a migrated record.
5. Ask saltorbit → the same on production.
6. Later: publish-ux moves the site to `spark/1`; then remove the aliases
   (§6 checklist).

## 3. Slices (serial; one Sonnet agent at a time, each in its own worktree
## from `origin/ldb-spark`; the lead reviews every diff before merging)

**S1 · formats.** `db/formats/akl/1` → `db/formats/spark/1` (id, types
`AklPayload`→`SparkPayload`, README, OWNERS, fixtures, goldens moved not
edited). `FormatModule` gains `role: "stored" | "output"`, loses `lower`.
`db/formats/cmini/1` → `db/formats/adapters/cmini/` (not registered; keeps
`validate`, `project*`, `fromCmini`/`toCmini` move here from spark's
`translate.ts`; exported as `@akl/layout-formats/adapters/cmini`). spark
exports its compile as `compileMagic` (was `lower`) and a pure
`cminiBoardWord(board)`. `mana2/1` keeps its code; `role: "output"`. Alias
table + `resolveFormat(id)` in `registry.ts`. Package `exports` updated.
Tests: every existing format test renamed/kept green; new F16, F17, F20.

**S2 · Worker read/write path.** `db/src`: writes resolve aliases then
require `role: "stored"` (`400 format_not_writable` for `mana2/1`;
`unknown_format` for anything unregistered, `cmini/1` included); reads
echo the alias label; `?as=cmini/1` via the adapter; `patchLayout`'s
cmini lift and `isMagicOnlyReplace`'s literal pair go through the
registry. Restore: window removed, optional `name` (§1.9). `/v1/formats`
lists `role`. Tests: F16/F20 API matrices, P8 amended, conformance sweep.

**S3 · upstream state + importer.** Migration `db/migrations/0005_spark.sql`:
`layouts.upstream_state TEXT NULL` (`following|forked`), `upstream_source`,
`upstream_id` (`import_map` stays the lookup index). `RecordRow` and the
wire record gain `upstream`; every event `after` carries it (fold). Write
rule I14 in `commitWrite`'s callers. Importer: converts at arrival, writes
`spark/1`, compares in spark (minus magic, likes), reads the field instead
of `followsUpstream`; `followsUpstream` survives only as `legacyFollows`
for S4. `strip.ts` keeps working. Diff: upstream converted to spark,
ours read `?as=spark/1`. Tests: I13, I14, P11 (replay property),
I1–I11 kept green.

**S4 · record migration.** `db/src/core/migrate.ts`: selects live and
deleted records whose stored format ≠ `latest(spark)` (i.e. `cmini/1`,
`akl/1`), converts (`fromCmini` / relabel), writes one `migrated` event
each (rev + 1, `layout_revs` row, `modified_at` unchanged, `actor:
system:migration`, `via: migration`, `detail {from, to, upstream_state}`),
initial upstream state from `legacyFollows` + `import_map`. Bounded batch,
idempotent, `dry_run` writes nothing and returns the same report.
`POST /v1/admin/migrate/tick`. `scripts/migrate_records_to_spark.py
--base-url --dry-run` pages it and prints totals + the 67-record note.
Tests: P12 (fake clock, seeded mixed store, dry-run = zero rows).

**S5 · the chain.** `registry.ts`: `lineage()`, `latestOf()`, `up`/`down`
on `FormatModule` (required for major > 1), `path()`/`walk()`, translate
over `path()`. Write path: `format_behind` + chain-to-latest + `written_as`.
`migrate.ts` generalises to any record below its lineage's latest. Nightly
dump writes `latest.<name>-<N>.json` per stored major. Stub lineage
`t/1..t/3` under `db/tests/formats/`. Tests: F18, F19, P13, D6.

**S6 · consumers.** Bot: `translateToAkl1` → `toSpark` accepting
`spark/1`, `akl/1`, legacy `cmini/1` rows (adapter); reads `?as=spark/1`;
writes `spark/1`; `magic/source.ts`, `magic.ts`, `cells.ts` (via
`cminiBoardWord`), `akl1board.ts`, commands. Functions:
`functions/_lib/magicdb.mjs` + `magic-rules/[id].js` read `?as=spark/1`.
Scripts: `build_magic_rules.py`, `fetch_d1_rules.py`,
`live_patch_sync.py`, `verify_magic_migration.py`,
`migrate_magic_rules_to_db.py`, `tools/compile_rules.mjs`,
`sync_cmini_data.py --source db` (reads `?as=spark/1`, converts to its
cmini shape in Python — parity-tested against the adapter's `toCmini`
goldens), `.github/workflows/magic-rules-sync.yml`. Tests: bot B48+ (rows
in §5), pytest parity.

**S7 · docs.** Amend `01-format.md`, `03-api.md`, `06-akl-integration.md`,
`17-magic-ownership.md`, `19-upcast.md` (spark rename, ids), and
`db/INVARIANTS.md` (every new/changed row). Retire LDB-I12, narrow LDB-F5,
F11, I2a.

## 4. Invariants (the covenant) — ids checked free 2026-09-10

| id | invariant | enforced by |
|---|---|---|
| LDB-F16 | One stored format: every accepted write stores `spark/<latest>`; a write whose format resolves to an `output` role is `400 format_not_writable`; an unregistered format (incl. `cmini/1`) is `400 unknown_format` | registry matrix × every write verb (POST/PUT/PATCH/import/migrate) |
| LDB-F17 | spark stays lowerable: `to["mana2/1"]` never returns `held` for a valid spark payload | every spark fixture + random single-field mutations that still validate |
| LDB-F18 | Chain contract (19 §8's F16): `up`/`down`/`edits` required for major > 1; `down` is held or `up∘down ≡ id`; `down∘up ≡ id`; `to`/`from` never name the own lineage | stub lineage + registry enumeration |
| LDB-F19 | Path composition (19's F17): translate walks chain → pinned cross edge → chain; held iff a step holds; `can_translate_to` = reachable set | stub lineage |
| LDB-F20 | Aliases: every alias is in one table; `akl/1` writes store `spark/1` byte-identical; `?as=akl/1` = the spark payload labelled `akl/1`; `?as=cmini/1` = adapter `toCmini`; `cmini/1` writes refused | alias matrix |
| LDB-I13 | The cmini adapter is exact: for a following record, `fromCmini(upstream)` equals its payload minus `magic` (replaces the cmini/1-level F5/F11 wording) | fixtures per PR + the daily diff |
| LDB-I14 | Upstream write rule: import create/update → `following`; every user rev-bumping write (PUT, PATCH incl. `{magic}`, rename, transfer, delete, restore) → `forked`; `migrated` leaves it unchanged; the importer never writes a `forked` record; `null` stays `null` | matrix: event kind × prior state |
| LDB-P11 | `upstream` is a fold: the row's value equals the latest rev-bumping event's `after.upstream`; replay from events reproduces it | replay property test |
| LDB-P12 | Record migration: after ticks to quiescence no record's stored format ≠ `spark/<latest>`; one `migrated` event per converted record, rev + 1, `modified_at` unchanged, payload = the converter of the previous rev, initial `upstream` = the legacy rule; dry-run writes zero rows and reports the same counts; a quiet tick writes nothing | fake-clock suite over a seeded mixed store |
| LDB-P13 | Older-major write (19's P11): stored at latest with `written_as`; `409 format_behind` iff the down-view is held; the stored major never decreases | stub lineage matrix + property |
| LDB-D6 | Per-major dumps: one file per registered stored major, held rows marked, sha256 sidecars; `latest.json` unchanged | dump tests |
| LDB-P8 (amended) | A tombstone is restorable by id at any time by its owner or an admin; with a reclaimed name, restore takes `{name}` or answers `409 name_taken` with `holder` | `restore.test.ts` |

## 5. Bot invariant rows (copy to `bot/INVARIANTS.md` at the rebase)

| id | invariant | enforced by |
|---|---|---|
| LDB-B48 (tentative; grep first) | The bot reads every stored record format it can meet during the transition (`spark/1`, `akl/1`, `cmini/1` dump rows) to the same spark payload, and writes only `spark/1` | `bot/tests/cache/translate.test.ts` |

## 6. Alias removal checklist

Remove `akl/1` and `?as=cmini/1` only when all are true: bot redeployed on
this branch; preview + production site built from a commit whose scripts
read `?as=spark/1`; publish-ux merged and moved to `spark/1`; the daily
diff's HTTP path reads spark; a week of Worker logs shows no `as=akl/1`,
`as=cmini/1`, or `format: "akl/1"` request.

## 7. Ledger (newest last)

- **2026-09-10 ~16:30Z** — branch `ldb-spark` created from `ldb-upcast`
  (rebased onto `ldb-v3` e16fe3cf), pushed. Rendezvous agreed with
  cmini-web-c7 (#304, owns ldb-v3; merge protocol §0) and cmini-web-0c
  (publish-ux; keep the `akl/1` alias). Plan written; next: Fable review
  of this doc, then S1.
