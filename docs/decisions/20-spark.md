# 20 — spark: one stored format (plan + ledger)

Status: **implementing** on branch `ldb-spark` (worktree
`.claude/worktrees/worktree-ldb-upcast`), off `ldb-v3`. Design source: the
architecture page saltorbit approved on 2026-09-10
(https://claude.ai/code/artifact/8bb80647-956e-4daf-96ac-b15685366c5d),
plus `19-upcast.md` (the chain, renamed here to spark). **Reviewed
2026-09-10 (Fable, before S1): findings and the reasons for every change
are in §8; §3/§4 already carry the fixes.** **Pick-up guide: read §0, then
§8, then §7 (ledger, newest last).**

## 0. How this branch lands

- `ldb-v3` is owned by the #304 session (cmini-web-c7). **Never move
  `ldb-v3` from here.** When ready: rebase `ldb-spark` onto `ldb-v3`'s head
  at that moment, push, send the SHA to cmini-web-c7; it runs the gates
  (below) and fast-forwards `ldb-v3` + pushes `layout-db-pr` (#307).
- Its gates, which must be green on the SHA: db `npm run typecheck` +
  `npx vitest run` (goldens regenerated); bot `npm run typecheck`,
  `npm run lint`, `npx vitest run` (after rebuilding `packages/akl-core`
  and `db/formats`); site `sh web/tests/tools/gates.sh --fast` **plus
  `npx vitest run web/tests/core/akl1.vitest.ts`** (it reads the schema by
  path, §3 S1); pytest over `scripts/tests/test_build_magic_rules.py
  test_fetch_d1_rules.py test_live_patch_sync.py test_fast_sync_patch.py
  test_sync_db_source.py test_migrate_magic_rules.py` (the last two added
  in review: S6 edits both scripts they cover).
- **Per-slice green.** Every slice lands green on db typecheck + vitest on
  its own. `LDB-T1` fails on a tagged test with no registry row and on a
  row with no tagged test, so **each slice adds or amends its own
  `db/INVARIANTS.md` rows in the same commit as the tests**. S7 does only
  the prose docs. The bot and site gates must be green at S6 and at the
  rebase; S1 keeps them green with the transitional subpath exports
  (§1.12).
- **Files owned elsewhere — do not edit here:** `design/INVARIANTS.md`,
  `design/behaviors/*`, `bot/INVARIANTS.md`, `bot/src/render/image.ts`,
  `web/src/core/copyimage/*`, `design/layout-db/{13-ledger,05-bot,
  14-copy-signoff,18-command-decisions}.md` (c7 + its agents), and
  `web/src/core/akl1.ts`, `web/src/data/db.ts`,
  `functions/api/db/layouts/index.js` (the publish-ux branch,
  cmini-web-0c). Bot invariant rows go in this doc (§5) until
  `bot/INVARIANTS.md` is free; they are copied over at the rebase.
  `web/tests/core/akl1.vitest.ts` is not on that list, but it tests
  0c's file: S1 changes only its `SCHEMA_PATH` constant, and the lead
  tells 0c (§8 R-C1).
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
   Both records keep their likes. *Refined in review (§8 R-L1):* the body
   is optional (absent, `{}` or `{name}`; any other key → `400` per
   LDB-A7); a `name` goes through `check_name` (LDB-N1 amended), and a
   restore that names a different name is recorded as `restored` with
   `detail: {renamed_from}`. LDB-P4 is untouched, since a restore frees
   no name.
10. **Always store the latest spark major** (19-upcast.md round 2, renamed):
    single-step `up`/`down` chain per major, `format_behind` on a blind
    older-major overwrite, `written_as` on the event, per-major dumps. With
    only `spark/1` registered, the chain is exercised by a test-only stub
    lineage.
11. **Record migration is operator-driven, not a cron** (c7's request,
    2026-09-10): `POST /v1/admin/migrate/tick {dry_run}` + a script
    `scripts/migrate_records_to_spark.py --dry-run` that pages it and prints
    a report, same style as `migrate_magic_rules_to_db.py`. *Refined in
    review (§8 R-L2):* the body is `{dry_run: bool, after?: <id>, limit?:
    ≤ 100}` and the response carries `next_after`. A dry run writes
    nothing, so repeating the same call would re-select the same batch
    forever; the script pages dry runs by `after` and repeats real runs
    until `converted == 0`.
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
    - *Refined in review (§8 R-L3, R-H3):* the wire `format` field is the
      record's **native** format everywhere (03 §1); the relabel is the one
      exception, and it follows the request: a response to a request that
      named `akl/1` (`?as=akl/1` on detail, `/rev/{n}` and `full=1`; the
      **write responses** and **`409 stale` bodies** of a write whose body
      said `format: "akl/1"`) carries `format: "akl/1"`. The deployed bot
      reads `format` in three places, all fed by those responses:
      `cache/apply.ts:21` (write responses), `magic/source.ts:89` and
      `commands/magic.ts:38` (the cached `record.format`). List rows,
      events' `before`/`after`, `/v1/changes`, webhooks and the dump stay
      native (`spark/1`). `?as=cmini/1` is **not** relabelled: it is an
      adapter projection, not the same format. The table also covers the
      list filter (`?format=akl/1` → `spark/1`) and the package's subpath
      exports (`@akl/layout-formats/akl/1` → spark,
      `@akl/layout-formats/cmini/1` → the adapter). Those exports keep the
      bot, the functions and the scripts building between S1 and S6.
13. **Site code (`web/src`) is not touched this round**: it writes `akl/1`
    through the alias; the publish-ux branch owns those files and moves to
    `spark/1` after it merges.
14. **Every edit carries its source client** (saltorbit, 2026-09-10, during
    implementation: "all edits should always come with a source in the
    record (source client) so we know what happened and can facilitate
    better rollbacks"). Every rev-bumping event records `source: {client,
    version}`, and the record carries the source of its latest rev-bumping
    write (a fold, like `upstream`). `client` is **proven, never
    declared**: `client:<id>` on the client lane (the signature),
    `discord-app:<application id>` on the user lane (Discord's
    `GET /oauth2/@me`, which replaces `/users/@me` at the same cost and
    returns the same user object plus the application the token was
    issued to), `system:cmini-import` and `system:migration` for system
    writers. `version` is declared by the client (`X-Client-Version`
    header) and stored as sent, after validation. History is not
    rewritten: events written before 0005 read `source: {client:
    "legacy:<via>", version: null}`. A rollback-by-source admin tool is
    the follow-up this enables; it is not in this branch. Slice S3s.
15. **An API adoption guide, and every layoutdb doc on the site,
    cross-linked** (saltorbit, 2026-09-10, during implementation: "a clear API
    adoption document that humans and agents can both follow if they want
    to write a discord bot or user client. Also all of these docs we're
    writing should end up on the site. Make sure they're linked to each
    other somewhere so you can navigate between them"). Slice S8. The
    guide lives with the service (`db/docs/adoption.md`, so it moves with
    `db/` at the repo split) and is written after S2–S6 settle the API it
    describes. The site gets a docs hub at `/layoutdb/`: one page per doc,
    a shared navigation listing every doc on every page, and each page's
    raw `.md` beside it for agents. Nothing in the main app links to the
    hub yet: that would be new UI copy, which needs saltorbit's sign-off.

## 2. Deploy order (for c7 / saltorbit; nothing here deploys)

The bot boots from the nightly dump, whose rows carry each record's
**stored** format. After the record migration those rows say `spark/1`,
which the deployed bot holds as unreadable. So:

1. Worker to preview with 0005 applied (aliases live; every stored record
   still reads as before **through the legacy-stored read path, LDB-F21**).
   From this moment **every write stores `spark/1`**. A deployed bot that
   reboots from a dump before step 2 holds every record written since as
   unreadable (nothing is lost; its feed refetches `?as=akl/1` and heals
   each one). So **do steps 1 and 2 back to back.**
2. Bot redeploy (reads `spark/1`, `akl/1` and legacy `cmini/1` rows;
   applies `migrated` events without a refetch, LDB-B49). Without that
   fast path, the ~4 200 `migrated` events in step 4 would each cost the
   bot one detail GET inside `ensureFresh()`, which runs before every
   command.
3. Preview site rebuild (functions + scripts read `?as=spark/1`).
4. `POST /v1/admin/nightly/tick` first: that dump is the **rollback
   point** (§8 R-M4). Then `migrate_records_to_spark.py --dry-run` on
   preview → report (`invalid` must be empty, §3 S4) → real run → checks:
   daily diff zero, `verify_magic_migration.py` still 67/83, bot `!view`
   on a migrated record, `/v1/layouts?full=1&as=akl/1` byte-equal
   (payloads) to the same call before the run.
5. **Rebuild the site again** after the run. Every record's `rev` moved by
   one, and the static catalog's `_rev` (sync, W4d) is what a
   publish-as-update sends as `If-Match`, so until the rebuild the site's
   publish gets one `409 stale` per layout.
6. Ask saltorbit → the same on production (steps 1–5).
7. Later: publish-ux moves the site to `spark/1`; then remove the aliases
   (§6 checklist).

## 3. Slices (serial; one Sonnet agent at a time, working in this branch's own worktree — no per-slice worktrees, because the disk hit 95% on 2026-09-10; the lead reviews every diff before committing)

Order: S1 → S2 → S3a → S3s → S3b → S4 → S5 → S6 → S7 → S8.

Shared vocabulary, defined once in S1 (`db/formats/registry.ts`) and used by
every later slice:

- `ALIASES: Record<string, {target: string; relabel: boolean; write:
  "store" | "refuse"}>` = `{"akl/1": {target: "spark/1", relabel: true,
  write: "store"}, "cmini/1": {target: "adapter:cmini", relabel: false,
  write: "refuse"}}`. `resolveFormat(id)` → `{module, label}` or
  `undefined`.
- `LEGACY_STORED: Record<string, (p) => SparkPayload>` = `{"akl/1":
  identity, "cmini/1": fromCmini}`. `storedAsSpark(format, payload)` →
  `{format: "spark/1", payload}`. It is the **one** conversion used by
  every read of a legacy row (`layouts` before S4, `layout_revs` forever),
  by every write that carries a legacy record's payload forward, and by
  the S4 migration. Nothing else converts a stored legacy payload.

**S1 · formats (zero wire-behaviour change except format listings).**
- `db/formats/akl/1` → `db/formats/spark/1` (id, types
  `AklPayload`→`SparkPayload`, README, OWNERS, fixtures, goldens
  byte-identical). Golden **filename suffixes** `.akl-1.json` →
  `.spark-1.json` everywhere (`mana2/1/fixtures/*`, `cmini/1/fixtures/*`),
  contents untouched. LDB-F6 is a skip today (`origin/main` has no
  `db/formats`; checked 2026-09-10), so this is the last free rename.
  Once #307 merges, `spark/1` is frozen.
- `FormatModule`: gains `role: "stored" | "output"`, loses `lower`. spark
  exports its compile as `compileMagic` (was `lower`; `hasMagic` =
  `compileMagic(p).length > 0`) and a pure `cminiBoardWord(board)` (today's
  private `deriveCminiWord`, `translate.ts:34`).
- `db/formats/cmini/1` → `db/formats/adapters/cmini/` (not registered;
  keeps `validate`, `lower` as `rows`, `project`/`projectNoMagic`, and
  `edits.ts` until S2 deletes it; `fromCmini`/`toCmini` move here from
  spark's `translate.ts`; exported as `@akl/layout-formats/adapters/cmini`;
  explicit `.ts` specifiers throughout, because `src/import/diff.ts` loads
  it with plain Node ESM).
- `mana2/1`: `role: "output"`; its registry `to`/`from` become `{}`
  (nothing is ever stored as mana2, so nothing translates from it). Its
  converters stay as named exports `toSpark`/`fromSpark` (were
  `toAkl`/`fromAkl`) for `mana2.test.ts` (LDB-F5's mana2 half, F13) and
  its `.spark-1.json`/`.cmini-1.json` goldens. spark's `to["mana2/1"]` =
  `fromSpark`. spark's `to` no longer lists `cmini/1`.
- `registry.ts`: `ALIASES`, `resolveFormat`, `LEGACY_STORED`,
  `storedAsSpark`. `translate(rec, as)` first normalizes `rec` through
  `storedAsSpark` when `rec.format` is in `LEGACY_STORED`, then resolves
  `as` through `ALIASES` (`cmini/1` → `toCmini`). `held` bodies name the
  requested id verbatim (`format: "akl/1"`).
- Worker wrapper `db/src/formats/registry.ts`: `get(id)` resolves aliases
  **and** keeps a temporary `LEGACY_WRITABLE = {"cmini/1": <adapter as a
  FormatModule shim: validate, hasMagic, edits>}` so every existing call
  site (`write.ts:82`, `:487`; `layouts.ts:76`) and every existing test
  keeps working unchanged. S2 deletes `LEGACY_WRITABLE`. Import paths
  updated in `src/core/write.ts:13-14`, `src/import/apply.ts:6-8`,
  `strip.ts:15`, `diff.ts:24`.
- Package: `exports` + `tsup.config.ts` entries for `./spark/1`,
  `./mana2/1`, `./adapters/cmini`, plus the alias subpaths `./akl/1` (→
  spark's dist) and `./cmini/1` (→ the adapter's dist) derived from
  `ALIASES`. `tests/tools/package.test.ts` (LDB-G7) asserts the map equals
  registered ids ∪ alias ids ∪ adapters.
- Tests that construct a `FormatModule` literal lose `lower` and gain
  `role`: `tests/api/held.test.ts:17-27` (the only one; grep
  `registerForTest`). `goldens.test.ts`'s LDB-F2 block calls
  `compileMagic` for spark and the adapter's `rows` for cmini fixtures
  (`.lowered.json` unchanged). New `tests/formats/adapter-cmini.test.ts`
  holds the cmini fixtures' `fromCmini` goldens (`.spark-1.json`) and the
  spark fixtures' `toCmini` goldens (`.cmini-1.json`). goldens.test only
  walks registered formats, so without this file those goldens would go
  untested.
- Out-of-`db/formats` path users updated in S1: `db/scripts/goldens.mjs:50-52`,
  `db/scripts/validate-akl1-payload.mjs:33` (import path only; keep the
  file name, which `scripts/migrate_magic_rules_to_db.py:85` names),
  `db/scripts/{check-convert-parity,gen-vectors,diff-upstream}.mjs`
  (grep `formats/`), `web/tests/core/akl1.vitest.ts:21` (`SCHEMA_PATH`
  only).
- `GET /v1/formats` gains `role` and, on spark, `aliases: ["akl/1"]`;
  `can_translate_to` for spark = `["mana2/1", "akl/1", "cmini/1"]`
  (reachable ids, aliases included). `/v1/meta.formats`
  (`src/index.ts:129`) and the dump's `meta.formats` (`dump/write.ts:158`)
  = registered ids. Conformance fixtures `formats-list`, `meta`, `dump`
  regenerated (LDB-R3: a documented change, 03 §1).
- Rows in `db/INVARIANTS.md`: F17, F20 (registry half), F21 (registry
  half); F2/F4/F8/F14/F15 reworded `lower()` → `compileMagic()`; F7's
  "declared translation" includes the adapter goldens.

**S2 · Worker read/write path (behaviour).**
- Delete `LEGACY_WRITABLE`. Every write resolves `body.format` through
  `resolveFormat`: `mana2/1` → `400 format_not_writable` (new factory in
  `src/core/errors.ts`; the error appendix is regenerated,
  `db/scripts/gen-error-table.mjs`, LDB-G8); `cmini/1` and anything
  unregistered → `400 unknown_format` (listing registered ids only).
  Stored format is always `spark/1`.
- **Every write that carries an existing record's payload forward stores
  `storedAsSpark(record)`**, not `record.format` verbatim:
  `deleteLayout` (`write.ts:305`), `restoreLayout` (`:348`),
  `transferLayout` (`:392`), `patchLayout` (`:480-487`: the cmini-only
  `magic` lift becomes "any legacy record is converted first, whatever
  the PATCH names", so `fingermap`/`board` PATCHes on a `cmini/1` record
  stop needing cmini's `edits`), `replaceLayout`. Also `has_magic` is
  recomputed from the converted payload. Otherwise a delete of an
  unmigrated record re-stores `cmini/1` and breaks LDB-F16. The importer
  writes move in S3b, the migration's in S4.
- `isMagicOnlyReplace` (`write.ts:237-246`) and the `detail.magic_only`
  marker (`:279`, `:535`) are **deleted** (decision 6). `modified_at`
  bumps on a magic-only write like on any user edit (`:274`, `:528` lose
  their exception; lead's answer to §8 Q1, below).
- Reads: `DEFAULT_FORMAT` (`layouts.ts:22`) → `"spark/1"`;
  `resolveAsFormat` (`:74`) accepts aliases; every payload-bearing
  response applies the §1.12 label rule. `records.ts:159` (`?format=`)
  resolves aliases.
- `wireVersion`: `etagFor` (`core/etag.ts:16`) folds a `WIRE_VERSION = 2`
  constant into the hashed query. Without it, a pre-deploy `If-None-Match`
  (or an edge-cached body) at an unchanged head seq keeps serving the old
  labels and shape (LDB-R1 amended).
- Restore: `RESTORE_WINDOW_MS` (`write.ts:37`) and its check (`:338`)
  removed; new `parseRestoreBody` in `routes/schemas.ts` (§1.9); route
  `routes/write.ts:67` reads it. The bot has no restore verb; the site's
  restore (if any) sends no body, which stays valid.
- Tests: F16 (API matrix: verb × {spark/1, akl/1, cmini/1, mana2/1,
  unknown}), F20 (API matrix: route × alias × label), F21 (API: every read
  route over a record stored `cmini/1` and one stored `akl/1`, inserted
  with `appendWrite` directly, each equal to its `storedAsSpark` twin),
  P8 amended, conformance sweep, `held.test.ts`'s `?as=akl/1` case
  (label `akl/1`, `see: "held/1"`).

**S3a · the `upstream` field (plumbing, no importer logic yet).**
- `db/migrations/0005_spark.sql`: `ALTER TABLE layouts ADD COLUMN
  upstream_source TEXT NULL; … upstream_id TEXT NULL; … upstream_state TEXT
  NULL` (`following|forked`; all three NULL together or set together).
  `import_map` stays the lookup index. Nothing is backfilled in SQL: the
  legacy rule needs the event walk, and S4 does it.
- `RecordRow.upstream: Upstream | null`; `LayoutDbRow` +3 columns;
  `rowToRecord`; `toWire`; `sansPayload` (list rows, `full=1`). Because
  `RecordSansPayload = Omit<RecordRow, "payload">`, every event's
  `after`/`before` then carries `upstream` too, and so do `/v1/changes`
  and webhooks.
- `Write.upstream: Upstream | null` is **required** at the type level, so
  every `appendWrite` call site must state it and tsc enumerates them.
  `appendWrite` puts it in `after` and the upsert (`events.ts:219-230`,
  `:264-270`).
- The write rule (LDB-I14) lives in one function, `core/upstream.ts`
  `nextUpstream(prior, kind, via)`, and every call site uses it.
  `prior` comes from `upstreamOf(db, rec)` = `rec.upstream` when
  non-null, else `legacyUpstream(db, rec.id)`: the `import_map` row plus
  `legacyFollows`, i.e. today's `followsUpstream` renamed, which now also
  skips `migrated` events. That fallback is permanent: it keeps writes
  correct between the deploy and S4, and on any restore of a pre-0005
  dump.
- `core/follows.ts` becomes `legacyFollows` (only `upstreamOf` and S4 call
  it). `followsUpstream` is deleted, and every caller reads
  `upstreamOf(...).state === "following"`: `import/apply.ts:311`,
  `:420`; `import/strip.ts:54`.
- `appendWrite` gains `expectRev?: number`. When set and `current.rev !==
  expectRev`, it throws `RevConflictError` before any write
  (`events.ts:179-185`). This closes a race that exists today: a system
  writer (import, strip, S4) reads a record, a user write lands, then the
  system write's own re-read bumps on top of the user's rev with a
  payload built from the stale read (§8 R-H4).
- Dump/restore/drill: `dump/restore.ts:87` column list +3 (a dump without
  them restores NULL); `db/scripts/drill-verify.mjs:67-88` expected
  projection gains `upstream` from the row. The bot's `DumpRecordRow`
  needs no change (extra columns are ignored).
- Tests: I14 matrix (write kind × prior ∈ {null, following, forked} ×
  import_map row ∈ {yes, no}), P11 (replay property), P14 (expectRev),
  D1/D5 amended (dump + restore round-trip the columns; an old-shape dump
  restores NULL and `upstreamOf` reproduces the legacy state).

**S3s · source client (after S3a, before S3b).**
- `0005_spark.sql` (S3a's file, not yet applied anywhere) gains:
  `events.source_client TEXT NULL`, `events.source_version TEXT NULL`,
  `layouts.source_client TEXT NULL`, `layouts.source_version TEXT NULL`,
  `auth_cache.app_id TEXT NULL`.
- Auth (`src/auth/discord.ts:94`): call `GET /oauth2/@me` instead of
  `/users/@me`; read `user` and `application.id` from its body; cache
  `app_id` beside `user_id`. A cached row with `app_id IS NULL` (written
  before 0005) is a cache miss. `Actor` (`auth/actor.ts:13`) gains
  `source_client`: `discord-app:<app_id>` on the user lane,
  `client:<id>` on the client lane (`auth/client.ts`). Tests' Discord
  fake serves `/oauth2/@me`.
- `X-Client-Version`: parsed once in the actor middleware; ≤ 64 chars of
  `[A-Za-z0-9._+/:-]`; anything else → `400 invalid_client_version` (new
  factory, error table regenerated). Absent → `null`. It never influences
  `client`.
- `Write.source: {client: string; version: string | null}` is
  **required** (tsc enumerates call sites). `appendWrite` stores it on the
  event row and folds it onto the `layouts` row. `RecordRow.source`,
  `toWire`, `sansPayload`, so `after`/`before`, `/v1/changes` and webhooks
  carry it. System writers: importer and strip `system:cmini-import`, S4
  `system:migration`, likes/informational events carry the actor's
  source but do not move the record's.
- Reads: `/history` rows and `/rev/{n}` gain `source`; a NULL column
  reads `{client: "legacy:" + via, version: null}`. Dump + `restoreSql` +
  drill carry the two new `layouts` columns and the two `events` columns
  (D1/D5 amended again).
- Tests: P15 (matrix: lane × write verb × version header {absent, valid,
  invalid}; a spoofing matrix proves no header or body field can set
  `client`; replay property shared with P11), A2 amended (the cache keys
  `app_id`; a pre-0005 row is a miss), R-rows for the new error.

**S3b · importer + diff.**
- Importer (`import/apply.ts`): `applyNew` cases 1/3 (`:228`, `:270`) write
  `format: "spark/1"`, `payload: fromCmini(detail.payload)`, `hasMagic:
  spark.hasMagic(payload)`, `upstream: {source: "cmini", id, state:
  "following"}`. `applyMapped` case 4 keeps only today's akl branch
  (`:337-354`): `{...fromCmini(detail.payload), magic: existing.magic}`,
  with the existing payload taken through `storedAsSpark` first. The
  cmini branch (`:355-373`) is deleted. Case 2 (`:246-257`) writes
  nothing, so the mapped local record keeps its `upstream`
  (null) and `applyMapped` treats null and forked alike. `applyDelete`'s
  rev-bumping `upstream_deleted` (`:422`) keeps `following` and stores
  `storedAsSpark(record)`. Every system write passes `expectRev:
  record.rev`, and the tick catches `RevConflictError` per id and counts
  it as `raced`: the next tick re-evaluates that record.
- `contentDiffers` (`:172`) compares in spark: `{name, owner, created_at,
  modified_at, payload: fromCmini(upstream) minus magic}` against the
  record's same fields with `storedAsSpark(...)` minus magic (likes
  excluded, as today). `upstream_changed` event `detail` **stays
  upstream's cmini projection** (it is upstream's data;
  `latestUpstreamChangedNoLikes`, `:287`, keeps comparing like with like).
  Changing its shape mid-log would re-announce every not-following record
  once.
- `import/strip.ts`: keeps selecting `format = 'cmini/1'` (legacy rows
  only). It uses `upstreamOf`, writes `storedAsSpark` of the stripped
  payload with `upstream` unchanged, and becomes a permanent no-op after
  S4.
- D12 diff (`import/diff.ts`, `import/difftick.ts`): **compares only
  records whose `upstream.state === "following"`**, as LDB-P5's own
  wording says. Today `diffCorpus` (`diff.ts:284-326`) compares every
  name-matched record. Name-matched records that are forked or null are
  counted as `divergent` (informational; never fails). `extra` resolution
  reads the field. The `/history` and event-`via` derivations are
  deleted: `difftick.ts:97-106` (`d1Ours.followsUpstream`) and
  `diff.ts:507` (`httpOurs.followsUpstream`). After S4 every record's
  latest rev-bumping event is `migrated` (`via: migration`), so both
  would answer `false` for every record and `extra` would go silently
  empty. Comparison happens in spark: `d1Ours` yields `storedAsSpark`
  payloads (`difftick.ts:59` stops translating to `cmini/1`), and
  `httpOurs.full` reads `?full=1&as=spark/1` (`diff.ts:480`) with
  `upstream` from the item. `parseUpstreamRaw` also runs `fromCmini`, and
  a result that fails spark `validate` is an `invalidUpstream` line.
- Tests: I13 (+ live: `cmini-envelope.test.ts` extended so every
  upstream-100 detail's `fromCmini` validates as spark), I1–I11 green, P5
  amended (`diff-unit.test.ts`: a forked name-matched record is
  `divergent`, not a content diff), F16's `import` column, P14's importer
  case.

**S4 · record migration.** `db/src/core/migrate.ts` `migrateTick(db, now,
{dryRun, after, limit})`:
- Selection, ordered by id, `id > after`, `LIMIT min(limit, 100)`:
  `format != 'spark/1'` (legacy `cmini/1`, `akl/1`; live **and** deleted)
  **or** `(upstream_state IS NULL AND id IN (SELECT layout_id FROM
  import_map))`. The second arm backfills records a write already stored
  as spark between the deploy and this run: for those, the rule "migrate
  only `format ≠ spark`" would leave `upstream` null forever.
- Per record: `next = storedAsSpark(record)`. `validate` as spark: on
  failure, write nothing and add `{id, name, format, path, message}` to
  `invalid` (the record keeps reading through LDB-F21). Otherwise
  `appendWrite` with `kind: "migrated"`, `expectRev: record.rev`, name,
  owner, `created_at`, `modified_at`, `deleted` and likes unchanged,
  `hasMagic: spark.hasMagic(next.payload)` (asserted equal to the stored
  `has_magic`; a mismatch goes to `invalid`), `upstream` = `upstreamOf`
  (legacy rule when null), `actor: "system:migration"`, `via:
  "migration"`, `detail: {from, to: "spark/1", upstream_state}` (`from ==
  to` for a backfill-only row; still a rev, because LDB-P11 is a fold).
  `RevConflictError` → `raced` (re-selected next call).
- `dry_run`: same selection, conversion and validation, zero D1 writes,
  identical report shape.
- Report `{selected, converted, by_from: {"cmini/1": n, "akl/1": n,
  "spark/1": n}, deleted, upstream: {following, forked, null},
  legacy_magic_only_following, invalid: [...], raced, next_after}`.
  `legacy_magic_only_following` counts the records that come out
  following only because magic-only events were skipped: the 67-record
  flag (§1.7).
- `WriteKind` gains `"migrated"` (`events.ts:24`). `KNOWN_KINDS` follows
  automatically (`routes/changes.ts:28` is a `Record<WriteKind, true>`).
  The changelog page prints `kind` raw, so there is no copy to sign off.
- `POST /v1/admin/migrate/tick` in `routes/admin.ts`: glue only (LDB-W1),
  admin-only, not gated on the import pause (`expectRev` makes the two
  safe to interleave). `admins.recordManualTick` gains `which: "migrate"` →
  InfoKind `"admin.migrate_ticked"` (`core/admins.ts:125`).
- `scripts/migrate_records_to_spark.py --base-url [--dry-run]`: dry run =
  page by `next_after` to the end. Real = call with no `after` until
  `converted == 0 && raced == 0`. It prints totals + the 67 note and
  exits non-zero if `invalid` is non-empty. It comes with
  `scripts/tests/test_migrate_records_to_spark.py`.
- Budget (§8 R-M3): about 7 D1 queries per record, so a batch of 100
  stays well under Workers Paid's 1 000 queries per invocation. Rows
  written are about 3 per record plus index entries (≈ 8–10), so ≈ 40 k
  for ~4.2 k records. That is trivial on Paid (13-ledger: the `akl`
  account is Workers Paid), and it also fits the free tier's 100 k/day.
- Tests: P12 (fake clock, seeded mixed store: cmini/1 live + tombstone,
  akl/1 with magic-only history (the 67 shape), spark/1 with null
  upstream + import_map row, one adapter-invalid legacy payload); dry run
  = zero rows (statement counter, like LDB-H5); quiet tick writes
  nothing; A5 amended (the admin tick calls the same `migrateTick`).

**S5 · the chain.** `registry.ts`: `lineage()`, `latestOf()`, `up`/`down`
on `FormatModule` (required for major > 1), `path()`/`walk()`, translate
over `path()`. `LEGACY_STORED` and `ALIASES` are **not** chain steps
(`akl/1` is a different lineage name): `translate` normalizes
legacy-stored → spark/1 first, then walks. Write path: `format_behind` +
chain-to-latest + `written_as`. `migrate.ts` generalises to any record
below its lineage's latest (the S4 selection gains `OR major(format) <
latest`). Nightly dump writes `latest.<name>-<N>.json` per stored major.
Stub lineage `t/1..t/3` under `db/tests/formats/`. Tests: F18, F19, P13,
D6.

**S6 · consumers.**
- Bot: `translateToAkl1` → `toSpark(format, payload)` accepting `spark/1`,
  `akl/1` and legacy `cmini/1` rows (adapter). It is used by `cache/boot.ts:73`,
  `cache/apply.ts:21` (write responses: missed by the first draft) and
  `cache/feed.ts:102`. `?as=spark/1` in `cache/feed.ts:80`,
  `commands/shared.ts:247`. Every bot request sends `X-Client-Version:
  spark-bot/<build id>` (LDB-B50; use the build/deploy id the bot already
  logs at boot). Writes `spark/1` in `commands/add.ts:138`,
  `mirror!.ts:38`, `cycle!.ts:55`, `angle!.ts:47`, `unangle!.ts:38`.
  `magic/source.ts:89` and `commands/magic.ts:38` test `format ===
  'spark/1' || format === 'akl/1'`. Type imports in `render/magic.ts:12`,
  `akl1board.ts`. `cells.ts` uses `cminiBoardWord`. `feed.ts`
  `applyEvent`: a `migrated` event updates the cached `rev`/`format` from
  `event.after` with **no refetch** (LDB-B49). `bot/tests/tools/deps-parity.test.ts`
  dist paths.
- Functions: `functions/_lib/magicdb.mjs:134,171,221` +
  `functions/api/magic-rules/[id].js` read `?as=spark/1`.
- Scripts: `build_magic_rules.py:319`, `fetch_d1_rules.py:61`,
  `verify_magic_migration.py:66` (compile spark magic through
  `scripts/tools/compile_rules.mjs`, which it already uses, instead of
  reading `?as=cmini/1` rows), `migrate_magic_rules_to_db.py:222,312,343,360`
  (`spark/1`), `.github/workflows/magic-rules-sync.yml:148`.
  `live_patch_sync.py` has no format literal or `?as=` (grep, 2026-09-10):
  verify, and drop it from the list if it is a no-op.
  `sync_cmini_data.py --source db` (`:584`, `:608`) reads `?as=spark/1`
  and converts in Python **only the fields `normalize_detail` reads**:
  `board` → word (`cminiBoardWord`'s rule: `board.cmini` wins, rowstag →
  `stagger`, ortho/colstag → `ortho`), `keys`, `free`. No magic compile in
  Python. It is parity-tested against the adapter's `toCmini` goldens on
  those fields (`test_sync_db_source.py`).
- Tests: bot B48, B49 (§5), pytest parity.

**S8 · adoption guide + docs hub (after S7; the API is final by then).**
- `db/docs/adoption.md`: for a human or an agent building (a) a Discord
  bot on the client lane, (b) a user client on the user lane. Sections in
  task order: pick a lane; register (client lane: the admin registration
  and the Ed25519 signing recipe with the `tests/vectors/client-signing.json`
  vectors; user lane: Discord OAuth `identify`, the Bearer header); read
  (`/v1/layouts`, `?as=spark/1` and `?as=mana2/1`, `full=1`, `/v1/formats`,
  schemas); stay current (`/v1/changes?since=`, the SSE stream, webhooks,
  dumps; how to fold events, `migrated` included); write (spark payloads,
  `If-Match` and `409 stale` handling, `X-Client-Version`, PATCH verbs,
  errors); limits (rate limits, the 409/400 table); conformance (the
  vectors and fixtures a client can test itself against). Every request
  and response shown as a copy-pasteable example. Agent-first details: one
  endpoint table with method, path, auth, body, success and error codes.
  Plus two sections added by saltorbit (2026-09-10):
  - **For format authors:** adding a new format (directory contract,
    `role`, schema, validate, edits, translations, fixtures and goldens,
    OWNERS, registry wiring, the tests that must pass); adding a new major
    of an existing format (the `up`/`down` steps, "down is held or
    lossless", frozen fixtures, the migrate tick that moves stored records,
    per-major dumps); lowering to mana2 (what `to["mana2/1"]` must produce,
    what may be lost, why it must never hold for a valid payload, how to
    test it against the mana2 engine's own loader).
  - **For clients moving to a new major:** how to detect it
    (`/v1/formats` `latest`, `lineage`, `major`; a `409 format_behind`),
    what keeps working meanwhile (reads via `?as=<old major>`, writes in
    the old major chained up, `held` and `format_behind` handling), the
    switch itself (read the new major, write it, drop the old `?as=`), and
    how to test it (the per-major dump files, the stub lineage fixtures).
- `design/layout-db/build_site.mjs`: renders the hub into `web/layoutdb/`
  with the federation renderer (`design/federation/build_page.mjs`'s
  `render`): `index.html` (what layoutdb is, who each doc is for, the
  list), one `web/layoutdb/<slug>/index.html` + `<slug>.md` per doc, and
  the architecture page (the approved artifact's HTML, checked in as
  `design/layout-db/architecture.html`) wrapped with the same nav. Docs,
  in reader order: architecture, adoption guide, formats (01), API (03),
  auth (02), governance (04), the spark plan (20), upcast (19), then the
  design record (00, 05–18) in a collapsed group. Every page carries the
  same side navigation with every doc exactly once, plus previous/next.
  Replaces `design/layout-db/build_page.mjs`'s single `proposal.html`.
- `scripts/assemble_dist.mjs` `ENTRIES` gains `['layoutdb', 'layoutdb',
  true]`; the gate's sparse-checkout cone gains what the test imports.
- Tests (db, `tests/tools/docs-site.test.ts`): LDB-G9 and LDB-G10.

**S7 · docs.** Amend `01-format.md`, `03-api.md` (native-`format` +
label rule, `upstream`, `migrated`, `format_not_writable`, restore body,
`/v1/formats` `role`/`aliases`), `06-akl-integration.md`,
`17-magic-ownership.md`, `19-upcast.md` (spark rename, ids),
`08-infrastructure.md` (the tier row: Workers Paid per 13-ledger; §8
R-M3). **Rows are not moved here**: each slice already landed its rows
(§0).

## 4. Invariants (the covenant) — ids checked free 2026-09-10

Registered today (grep `db/INVARIANTS.md`, 2026-09-10): F ≤ 15, I ≤ 12,
P ≤ 10, D ≤ 5, G ≤ 8; bot B ≤ 47. This plan claims F16–F21, I13–I14,
P11–P15, D6, G9–G10, B48–B50.

| id | slice | invariant | enforced by |
|---|---|---|---|
| LDB-F16 | S2 (+S3b import, S4 migrate) | One stored format: every accepted write stores `spark/<latest>` — including delete/restore/transfer/upstream_deleted/strip of a legacy-stored record; a write whose format resolves to an `output` role is `400 format_not_writable`; an unregistered format (incl. `cmini/1`) is `400 unknown_format` | registry matrix × every write verb (POST/PUT/PATCH/delete/restore/transfer/import/strip/migrate) × stored format ∈ {spark/1, akl/1, cmini/1} |
| LDB-F17 | S1 | spark stays lowerable: `to["mana2/1"]` never returns `held` for a valid spark payload | every spark fixture + random single-field mutations that still validate |
| LDB-F18 | S5 | Chain contract (19 §8's F16): `up`/`down`/`edits` required for major > 1; `down` is held or `up∘down ≡ id`; `down∘up ≡ id`; `to`/`from` never name the own lineage | stub lineage + registry enumeration |
| LDB-F19 | S5 | Path composition (19's F17): translate walks legacy-normalize → chain → pinned cross edge → chain; held iff a step holds; `can_translate_to` = reachable set (aliases included) | stub lineage |
| LDB-F20 | S1 (registry), S2 (API) | Aliases: every alias is in one table (`ALIASES`), and so is every package alias subpath and the `?format=` filter; `akl/1` writes store `spark/1` byte-identical; the wire `format` is native except that a response to a request naming `akl/1` (read `?as=`, write body, `409 stale`) says `akl/1`; `?as=cmini/1` = adapter `toCmini`, labelled native; `cmini/1` writes refused | alias matrix: route × alias × {read, write, stale} |
| LDB-F21 | S1 (registry), S2 (API) | Legacy stored rows read as spark: a `layouts` or `layout_revs` row stored as `akl/1`/`cmini/1` reads on every route (`?as=` each registered id and alias, `/rev/{n}`, `full=1`, D12 `d1Ours`) exactly as its `storedAsSpark` twin; `storedAsSpark` is the only converter of a stored legacy payload (read, carry-forward write, migration) | matrix: legacy format × read route; grep test that `fromCmini` is imported only by the adapter, `registry.ts` and `import/*` |
| LDB-I13 | S3b | The cmini adapter is exact: for a following record, `fromCmini(upstream)` equals its payload minus `magic` (replaces the cmini/1-level F5/F11 wording); every live upstream detail's `fromCmini` validates as spark | fixtures per PR, `cmini-envelope.test.ts` over upstream-100, the daily diff (`invalidUpstream`) |
| LDB-I14 | S3a (rule), S3b (importer) | Upstream write rule, one function (`nextUpstream`): import create/update and import revival → `following`; `upstream_deleted` (rev-bumping) and strip keep `following`; every user rev-bumping write (PUT, PATCH incl. `{magic}`, rename, fingermap, transfer, delete, restore) → `forked` when prior is non-null; `migrated` leaves it unchanged (initial value = legacy rule); the importer never writes a `forked` record (guarded by `expectRev`, P14); `null` stays `null`; `state: "following"` ⇒ an `import_map` row maps `upstream.id` to this record; prior = `upstreamOf` (field, else legacy fallback) | matrix: event kind × prior {null, following, forked} × import_map {yes, no} |
| LDB-P5 (amended) | S3b | The D12 diff compares exactly the records whose `upstream.state` is `following` (on the spark projection, magic and likes excluded); name-matched forked/null records are `divergent`, never a failure; follow status comes from the field, never from event `via` | `diff-unit.test.ts`, `upstream-diff.test.ts` (daily) |
| LDB-P11 | S3a | `upstream` is a fold: the row's value equals the latest rev-bumping event's `after.upstream`; replay from events reproduces it; a restore of an old-shape dump (no columns) yields NULL and `upstreamOf` then equals the legacy rule | replay property test; restore test |
| LDB-P12 | S4 | Record migration: after ticks to quiescence no record's stored format ≠ `spark/<latest>` except those reported `invalid`, and no record with an `import_map` row has null `upstream`; one `migrated` event per converted record, rev + 1, `layout_revs` row, `modified_at`/`created_at`/`deleted`/likes/`has_magic` unchanged, payload = `storedAsSpark` of the previous rev, initial `upstream` = the legacy rule; ≤ 100 records per call; dry-run writes zero rows and reports the same counts page for page; a quiet tick writes nothing | fake-clock suite over a seeded mixed store |
| LDB-P13 | S5 | Older-major write (19's P11): stored at latest with `written_as`; `409 format_behind` iff the down-view is held; the stored major never decreases | stub lineage matrix + property |
| LDB-P14 | S3a | A write with `expectRev` commits only if the record is still at that rev: a user write interleaved between a system writer's read and its write survives, and the record stays `forked` | property: random interleavings of {import, strip, migrate} × {user write} |
| LDB-P15 | S3s | Every rev-bumping event written after 0005 carries `source.client` derived from the authenticated identity (`client:<id>`, `discord-app:<app id>`) or the system writer (`system:cmini-import`, `system:migration`), never from a header or body; `source.version` is the validated `X-Client-Version` or null; the record's `source` equals its latest rev-bumping event's (fold); `/history` and `/rev/{n}` return per-rev source; pre-0005 events read `legacy:<via>` | lane × verb × header matrix; spoof matrix; replay property (with P11) |
| LDB-A2 (amended) | S3s | The Discord cache also keys the token's application id from `/oauth2/@me`; a cached row without it is a miss | `tests/auth/discord.test.ts` |
| LDB-G9 | S8 | The docs hub ships and cannot drift: every page in `web/layoutdb/` equals a fresh render of its source; every page's navigation lists every doc exactly once; every internal link and every raw `.md` link resolves; every `design/layout-db/*.md` and `db/docs/*.md` is in the hub | `tests/tools/docs-site.test.ts` |
| LDB-G10 | S8 | The adoption guide covers the API exactly: the set of public routes enumerated from the router equals the guide's endpoint table (method + path); every error code the guide lists is one the error factories can produce; its format-author checklist names every member the registry requires of a stored format and of a major > 1 (enumerated from the same required-member list LDB-F18 enforces) | `tests/tools/docs-site.test.ts` |
| LDB-D6 | S5 | Per-major dumps: one file per registered stored major, held rows marked, sha256 sidecars; `latest.json` unchanged | dump tests |
| LDB-D1 / D5 (amended) | S3a | The dump carries `upstream_source/id/state`; `restoreSql` round-trips them; a dump without them restores NULL; the drill's per-record HTTP check includes `upstream` | `dump.test.ts`, `rehost.test.ts`, `drill/verify.test.ts` |
| LDB-R1 (amended) | S2 | The ETag also changes when the wire version changes (`WIRE_VERSION` folded into the query hash) | `etag.test.ts` |
| LDB-A5 (amended) | S4 | `POST /v1/admin/migrate/tick` calls the same `migrateTick()` and is event-logged as `admin.migrate_ticked` | `admin.test.ts` |
| LDB-N1 (amended) | S2 | `check_name` also applies to restore's optional `name` | `names.test.ts`, `restore.test.ts` |
| LDB-P8 (amended) | S2 | A tombstone is restorable by id at any time by its owner or an admin; with a reclaimed name, restore takes `{name}` or answers `409 name_taken` with `holder` | `restore.test.ts` |
| LDB-I2a / I12 (narrowed, not deleted) | S3a | Their text becomes the definition of `legacyFollows` (magic-only and `migrated` events skipped), used only by `upstreamOf`'s fallback and S4; their existing tests keep enforcing that rule (the 67 records depend on it). Nothing else reads it | `follows.test.ts` (retargeted) |

## 5. Bot invariant rows (copy to `bot/INVARIANTS.md` at the rebase)

| id | invariant | enforced by |
|---|---|---|
| LDB-B48 (free: grep 2026-09-10, bot ≤ B47) | The bot reads every stored record format it can meet during the transition (`spark/1`, `akl/1`, `cmini/1` dump rows, `?as=spark/1`/`akl/1` details, write responses) to the same spark payload, and writes only `spark/1` | `bot/tests/cache/translate.test.ts`, `apply` + `boot` + `feed` cases |
| LDB-B50 | Every request the bot makes to the DB carries `X-Client-Version: spark-bot/<build id>` | `bot/tests/client/http.test.ts` |
| LDB-B49 | A `migrated` event advances the cached record's `rev`/`format` from `event.after` without a detail fetch, and the cached payload equals a fresh `?as=spark/1` read of that rev | `bot/tests/cache/feed.test.ts` (fetch spy: zero calls) |

## 6. Alias removal checklist

Remove `akl/1` and `?as=cmini/1` only when all are true: bot redeployed on
this branch; preview + production site built from a commit whose scripts
read `?as=spark/1`; publish-ux merged and moved to `spark/1`; the daily
diff's HTTP path reads spark; a week of Worker logs shows no `as=akl/1`,
`as=cmini/1`, `format=akl/1`, or `format: "akl/1"` request. Removing them
also removes: the `./akl/1` and `./cmini/1` package subpath exports (bump
`@akl/layout-formats` major), the `akl/1` label branch, `/v1/formats`
`aliases`. `LEGACY_STORED` is **never** removed: `layout_revs` keeps
legacy rows forever (history is not rewritten), and `/rev/{n}` must keep
reading them (LDB-R5, F21).

## 7. Ledger (newest last)

- **2026-09-10 ~16:30Z** — branch `ldb-spark` created from `ldb-upcast`
  (rebased onto `ldb-v3` e16fe3cf), pushed. Rendezvous agreed with
  cmini-web-c7 (#304, owns ldb-v3; merge protocol §0) and cmini-web-0c
  (publish-ux; keep the `akl/1` alias). Plan written; next: Fable review
  of this doc, then S1.
- **2026-09-10 (review)** — Fable review against the code at 243fd557:
  §8 lists the findings; §2/§3/§4/§5/§6 carry the fixes (S3 split into
  S3a/S3b; F21, P14, B49 added; F16/F20/I14/P12 tightened; P5, D1/D5,
  R1, A5, N1 amended; I2a/I12 narrowed, not deleted). Four questions for
  saltorbit in §8 Q. Next: S1.
- **2026-09-10 ~17:30Z** — review folded (Opus pass; the Fable attempt hit
  the account's Fable limit mid-run). Baseline on this branch before any
  code: db typecheck 0 errors, vitest 15 751 passed (the first run's 3
  failures were load flakes while the reviewer ran; a quiet rerun was
  clean); bot typecheck 0, vitest 755 passed. c7: `ldb-v3` now at
  e2d5736f; after c7 merges this branch, remove this worktree
  (`git worktree remove`, the new CLAUDE.md rule on ldb-v3). saltorbit added
  decision 14 (source client) mid-run → slice S3s, LDB-P15, A2 amended,
  B50. §8 Q1–Q4 answered by the lead (see there). Slices run in this
  worktree, one agent at a time (disk).

## 8. Review notes (2026-09-10, Fable; newest findings first within each group)

Ranked by severity. Each finding gives the evidence (file:line at
243fd557) and where the fix went.

### High: the plan as written would break correctness or availability

- **R-H1 · Legacy stored rows become unreadable the moment `cmini/1` is
  unregistered.** The pure `translate()` looks up `byId.get(rec.format)`
  (`db/formats/registry.ts`, translate): with `cmini/1` gone, `source` is
  undefined, so every `cmini/1`-stored record reads `held` for every `as`.
  `/rev/{n}` reads `layout_revs.format` (`routes/layouts.ts:262-276`),
  and those rows keep `cmini/1`/`akl/1` **forever**, since history is not
  rewritten. §2 step 1's "every stored record still reads as before" had
  no mechanism behind it. Fix: `LEGACY_STORED`/`storedAsSpark` in S1, used
  by every read and every carry-forward write; LDB-F21; §6 says it is
  never removed.
- **R-H2 · Carry-forward writes re-store legacy formats.** `deleteLayout`,
  `restoreLayout`, `transferLayout` write `format: record.format`
  (`core/write.ts:305,348,392`) and `applyDelete` does too
  (`import/apply.ts:427`). After the deploy, deleting an unmigrated
  `cmini/1` record would store `cmini/1` again, against LDB-F16. Fix: S2
  and S3b store `storedAsSpark(record)`; F16's matrix includes those
  verbs.
- **R-H3 · The alias relabel missed the write responses.** The deployed
  bot folds write responses by `response.format`
  (`bot/src/cache/apply.ts:21`); the Worker answers `toWire(record)` with
  the stored format. So every `!add`/`mirror!` from the deployed bot after
  step 1 would cache its own record as `unknown format 'spark/1'` (held)
  until the feed refetches it. Also: the wire `format` is the **native**
  format today, not the `as` format (`routes/layouts.ts:211` spreads
  `sansPayload(rec)`; `bot/src/cache/feed.ts:94-101` documents it), so the
  relabel is an exception to a rule, and it has to be stated precisely.
  Fix: §1.12 refinement (label follows the request; write responses and
  stale bodies included); F20.
- **R-H4 · System writes can clobber a concurrent user write.**
  `appendWrite` re-reads `current` and writes `current.rev + 1`
  (`core/events.ts:179-207`). A payload computed from an earlier read
  (import case 4, strip, the migration) lands on top of a user's newer
  rev with no conflict, and the `layout_revs` PK only catches equal revs.
  Today this silently loses the user's edit, and it would falsify LDB-I14
  ("the importer never writes a forked record"). Fix: `Write.expectRev`
  (S3a), used by every system writer; LDB-P14.
- **R-H5 · Between the deploy and S4, the importer would treat every
  record as not following.** 0005 adds NULL columns; S3 "reads the field
  instead of `followsUpstream`"; so every existing following record reads
  null until S4 runs. Case 4 updates stop and upstream deletions stop
  tombstoning. And user writes in that window store `spark/1`, which the
  S4 selection (`format ≠ spark`) never revisits, so their `upstream`
  stays null forever. Fix: `upstreamOf` (the field, else the legacy
  fallback) in S3a; the S4 selection's backfill arm; P12's "no
  import-mapped record with null upstream".
- **R-H6 · The D12 diff's follow checks die at migration.**
  `d1Ours.followsUpstream` (`import/difftick.ts:97-106`) and
  `httpOurs.followsUpstream` (`import/diff.ts:507`) read the latest
  rev-bumping event's `via`. After S4 that is `migrated`/`migration` for
  every record, so both answer `false`, and `extra` (a following record
  upstream dropped) stops reporting without a failure. The d1 copy also
  never skipped magic-only events (it already disagreed with
  `core/follows.ts`). Separately, `diffCorpus` (`diff.ts:284-326`)
  content-compares **every** name-matched record, so with magic edits now
  forking (and, if Q1 goes that way, bumping `modified_at`) every site
  edit of an imported layout would turn the daily diff red. Fix: S3b
  reads the field and compares following only (LDB-P5's own wording);
  §8 Q2.
- **R-H7 · S1 was not green on its own.** Renaming the registered id
  breaks every Worker call site that passes `"akl/1"`/`"cmini/1"` to
  `getFormat` (`write.ts:82,487`, `layouts.ts:76`) and ~300 test literals
  (e.g. `tests/api/write.test.ts`: 33). It also breaks the bot's
  `@akl/layout-formats/{akl,cmini}/1` subpath imports
  (`bot/src/cache/translate.ts:27-29`, `render/magic.ts:12`), and the
  site's `web/tests/core/akl1.vitest.ts:21` schema path. Fix: S1 keeps
  the wire unchanged through an alias-aware `get()` + `LEGACY_WRITABLE`
  (deleted in S2), and alias subpath exports (removed at §6); S2 carries
  the behaviour change; `db/INVARIANTS.md` rows land per slice, because
  LDB-T1 would fail an S1 test tagged `[LDB-F20]` with the row deferred
  to S7.

### Medium: gaps a Sonnet agent would hit or guess at

- **R-M1 · restore.ts and the drill drop the new columns.**
  `dump/restore.ts:87` lists `layouts` columns explicitly, so a rehost
  would lose `upstream`. `db/scripts/drill-verify.mjs:67-88` builds the
  expected wire object field by field, so the drill would go `ok: false`
  on every record once the wire carries `upstream`. Fix: S3a; D1/D5
  amended.
- **R-M2 · Adapter-invalid legacy payloads had no outcome.** spark's
  `validate` is stricter than cmini's: magic semantics and collisions
  after `liftRules`, and the 16 KiB `x` cap (`x.cmini` holds
  combos/blame) (`akl/1/index.ts:189-242`). Non-following `cmini/1`
  records still carry legacy cmini magic (strip only touched following
  ones, `import/strip.ts:54`). LDB-F16 forbids storing an invalid
  payload, and P12 demanded quiescence. Fix: the migration skips and
  reports them (`invalid`, script exits non-zero; they keep reading via
  F21); the importer reports a spark-invalid `fromCmini` as a parse error
  (I13); §8 Q3.
- **R-M3 · Budget and limits.** Rows written are about 8–10 per record
  with indexes, ≈ 40 k total: well inside Workers Paid, and inside one
  free-tier day. The binding limit is **queries per invocation** (Paid:
  1 000): about 7 per record, hence a batch of 100. The strip route's
  `BATCH_LIMIT = 500` (`import/strip.ts:28`) is the wrong model to copy.
  `08-infrastructure.md:14` still says "free tier" while `13-ledger.md:13`
  says the `akl` account is Workers Paid; S7 fixes 08 (Q4 if unsure).
- **R-M4 · Rollback is a dump, not a redeploy.** Nothing is lost
  (`layout_revs` and `events` keep every legacy rev). But once records are
  `spark/1`, a pre-S1 Worker reads every one as held, and a pre-S6 bot
  holds every dump row. So a code rollback after the run is not a
  rollback; restoring the pre-run dump is. Fix: §2 step 4 takes the
  manual nightly dump first.
- **R-M5 · The bot would stall on ~4 200 refetches.** `applyEvent` fetches
  the detail for every rev-bumping event (`bot/src/cache/feed.ts`), and
  `ensureFresh()` drains before every command (`bot/src/cache/fresh.ts`,
  header). Fix: LDB-B49 (no refetch on `migrated`); §2 step 2 note.
  Webhook subscribers with `kinds = NULL` also receive ~4 200 deliveries;
  that is fine per LDB-H1/H5 and noted here.
- **R-M6 · Stale `_rev`s in the static site catalog.** Sync stores each
  record's `rev` as `_rev` (`scripts/sync_cmini_data.py:572-574`); the
  migration moves every rev by one. Fix: §2 step 5.
- **R-M7 · Pre-deploy ETags and edge-cached bodies survive the shape
  change.** ETag = head seq + query (`core/etag.ts:16`); a deploy alone
  moves neither. Fix: `WIRE_VERSION` (S2), LDB-R1 amended.
- **R-M8 · `upstream_changed` detail shape was unspecified.** "Compares
  in spark" could reasonably be read as "store spark in the event too".
  That would break `latestUpstreamChangedNoLikes`' like-with-like
  repeat-suppression (`import/apply.ts:287-301`) and re-announce every
  not-following record once. Fix: S3b keeps the cmini projection.
- **R-M9 · Missing call sites.** `cache/apply.ts:21`, `magic/source.ts:89`,
  `commands/magic.ts:38` (bot); `import/strip.ts:15,21,54`;
  `import/difftick.ts:20,59,97`; `import/diff.ts:24,480,507`;
  `routes/changes.ts:28`; `core/admins.ts:125`;
  `dump/write.ts:158` and `src/index.ts:129` (`formats` lists);
  `records.ts:159` (`?format=`); `db/scripts/{goldens,validate-akl1-payload}.mjs`;
  `web/tests/core/akl1.vitest.ts:21`; `tests/api/held.test.ts:17-27`;
  `bot/tests/tools/deps-parity.test.ts`. All are now in §3.
  `scripts/live_patch_sync.py` has no format literal, so it may be a no-op
  (S6 says to verify). `scripts/build_web.py`, `build_copy_review.py` and
  `design/stat-*` matched only Python's `.lower()`: false positives.
- **R-M10 · Unowned but load-bearing tests missing from the gates.**
  `test_sync_db_source.py` and `test_migrate_magic_rules.py` cover
  scripts S6 edits. Added to §0.

### Low / clarifications

- **R-L1 (item 9, lead judgment, refined):** the restore body is optional,
  `check_name` applies, and `detail.renamed_from` is recorded. The
  deployed site/bot send no body, so they keep working.
- **R-L2 (item 11, lead judgment, refined):** `after`/`limit`/`next_after`
  paging; ≤ 100 per call; `raced` count; the script's exit code gates on
  `invalid`.
- **R-L3 (item 12, lead judgment, refined):** native-`format` rule +
  request-following relabel; `?format=` and package subpaths added to the
  table. `?as=cmini/1` is not relabelled.
- **R-L4:** `mana2/1`'s registry `to`/`from` go to `{}`, its converters
  become named exports, and golden suffixes are renamed. The first draft's
  "keeps its code" left it ambiguous whether `to["akl/1"]` stayed, and
  keeping it would make `goldens.test.ts` look up an unregistered target.
- **R-L5:** LDB-I2a/I12 are narrowed to define `legacyFollows`, not
  deleted. Deleting them orphans their tagged tests (LDB-T1), and the
  rule is still what S4 and the fallback compute. Decision 6 stands (no
  new write is ever magic-only).
- **R-L6:** import case 2 (`import/apply.ts:246-257`) maps a local record
  without writing, so its `upstream` stays null. I14 now says what
  `following` implies (an `import_map` row) rather than an iff.
- **R-L7:** between S3 and S4, a magic edit on one of the 67 forks it
  (decision 6), so the report's `legacy_magic_only_following` may read
  below 67. That is expected; the report prints the ids.

### Conflicts with a settled decision (evidence + proposed resolution)

- **R-C1 · §1.13 (site not touched) vs S1's rename.**
  `web/tests/core/akl1.vitest.ts:21` reads
  `db/formats/akl/1/schema.json` by path (it tests 0c's
  `web/src/core/akl1.ts`). Renaming the directory breaks the site's
  vitest. Proposed: S1 changes only that constant (a test, not site
  code); the lead tells 0c before merging S1. The alternative, a second
  copy of the schema at the old path, would be a second source of truth.
- **R-C2 · §1.12's stated reason vs the code.** The deployed bot's feed
  does **not** branch on `format` (`bot/src/cache/feed.ts:102` always
  translates as `akl/1`). The branches are `apply.ts:21`,
  `magic/source.ts:89` and `commands/magic.ts:38`. The relabel is still
  needed, and more of it (R-H3). The decision stands; only its scope
  changed.
- No conflict found for items 1–8, 10: every one is implementable as
  stated.

### Q · Only saltorbit can answer

1. **Magic-only writes and `modified_at`.** Today a magic-only write
   leaves `modified_at` alone, to keep mirroring upstream's
   (`core/write.ts:270-274`). Now that it forks, should it bump
   `modified_at` like any user edit (the layout then sorts as "recently
   modified")? The plan keeps today's behaviour until you say.
2. **Diff scope.** The daily diff (LDB-P5) compares only
   upstream-following records; forked name-twins are reported as
   `divergent` but never make it red. That is P5's own wording, but not
   what the code does today. OK?
3. **Adapter-invalid legacy records.** If the dry run finds any, the plan
   skips and lists them: they stay readable, stored in the legacy format.
   Alternatives: hold the whole migration until each is fixed by hand, or
   store them `held` in some form. Skip-and-list is proposed.
4. **Tier.** `08-infrastructure.md` says free tier; `13-ledger.md` says
   the `akl` account is Workers Paid. The migration fits either (≈ 40 k
   rows); please confirm which, so 08 can be corrected.

**Lead's answers (2026-09-10, taken so the slices can run; each is
ledgered and flippable by saltorbit):**
1. **Bump.** Magic edits now fork, so the record no longer mirrors
   upstream and there is nothing left for an unbumped `modified_at` to
   keep in step with. A magic edit is an edit. S2 carries it.
2. **Yes, following-only.** It is what I13/P5 say, and a forked record
   is by definition allowed to differ.
3. **Skip and list.** The migration's report fails the script
   (non-zero exit) when `invalid` is non-empty, so nobody can miss them;
   they stay readable through LDB-F21.
4. **Workers Paid**, per 13-ledger and the account memory (`akl`,
   Workers Paid). S7 corrects 08.
- **2026-09-10 ~17:45Z** — S1 agent (Sonnet) started in this worktree.
  saltorbit added decision 15 mid-run (adoption guide + docs hub on the site,
  cross-linked) → slice S8, LDB-G9/G10. Root `node_modules` is missing in
  this worktree and main's lockfile differs, so the site test
  (`akl1.vitest.ts`) and `gates.sh --fast` need a root `npm ci` before the
  rebase (disk: 26 GB free).
- **2026-09-10 ~17:50Z** — saltorbit widened S8's guide: format authoring (new
  format, new major, lowering to mana2) and client migration across
  majors. LDB-G10 now also ties the author checklist to F18's required
  members.
