# layoutdb (`db/`) architecture + implementation audit

Read-only audit of branch `ldb-arch-review` at a695bc57c, 2026-09-12. Evidence is `file:line` under `db/` unless prefixed. Suite run locally: **94 files passed, 1 skipped (`tests/upstream-diff.test.ts`, gated on `DB_BASE_URL`), 15,897 tests passed, 40 skipped, 97.8 s wall** (`npx vitest run`, fresh `npm ci`). Nothing deployed or touched.

**Verdict up front:** the core (Hono Worker + D1 + one event log + `layout_revs (layout_id, n)` as the sole concurrency guard) is sound and well tested. Keep it. The problems are (a) the cmini importer can wedge itself permanently and can silently revert user likes, (b) backup is nightly-only, same-account, with no proven fresh-D1 restore path except in tests, and (c) roughly a third of the code is speculative generality (multi-major chains, SSE, per-major dumps, the HTML changelog, a Fly drill) that adds review surface without serving the four requirements.

---

## A. Data model and write path

**Tables** (`migrations/0001..0009`): `layouts` (identity: name/owner/`n`/`layout_rev`/deleted/like_count/upstream_*/source_*), `layout_formats` (one row per (layout, lineage), payload), `layout_revs` (every rev, both scopes, PK `(layout_id, n)`), `events` (AUTOINCREMENT `seq`, before/after JSON snapshots), `likes`, `authors` + `authors_head` (trigger-maintained version counter, 0007), `admins`, `import_state`, `import_map`, `auth_cache`, `ratelimit`, `clients`, `nonces`, `webhooks` (+ lease columns, 0008).

**Source of truth is dual, kept in lockstep by one batch.** `commitWrite` (`src/core/events.ts:179-414`) builds one `db.batch()` containing: one `events` INSERT per scope, a `layout_revs` INSERT per event (`event_seq = last_insert_rowid()`, `:281-285`), one `layouts` upsert (`:302-330`), an optional `layout_formats` upsert (`:332-356`), and a `like_count` read-back (`:365`). D1 `batch()` is one transaction, so events and folded rows commit or roll back together. `foldLayout` (`:660-699`) is the replay function; it is checked against the live rows after every step of a fast-check model over random user + import ops (`tests/events/fold.test.ts`, LDB-P16..P19, P23) and over a full dump→restore round trip (`tests/rehost.test.ts:130-146`). **Replayability is real and tested**, with one caveat: `n` is not on any snapshot, so a fold reconstructs every column except `n` (`events.ts:637-641`); a rebuild-from-log would have to recount it.

**Concurrency guard.** Every writer reads the layout fresh (`byRefWithFormats`, one LEFT JOIN, `records.ts:276-282`), computes its write from that read, and inserts `layout_revs` at `currentN + 1`. A stale base collides on the PK and the whole batch rolls back (`events.ts:373`, mapped to `RevConflictError`). User writes retry up to 3× from a fresh read (`write.ts:112-136`) and only surface `409 stale` when their *own* scope moved (`:89-102`); the importer never retries (`import/cmini.ts:156-163`). Races are tested with real interleaving via spies (`tests/events/races.test.ts`, `tests/api/mf6-http-races.test.ts`, `mf1-like-race.test.ts`, `mf-l2-unlike-race.test.ts`). Name uniqueness is a partial unique index (`0009:...layouts_name_live`) with a pre-check outside the batch (`events.ts:190-196`) and the constraint error mapped (`:372`). `seq` stays gapless because AUTOINCREMENT's `sqlite_sequence` update rolls back with the transaction.

**If-Match** is scoped per part (`"layout:N"` / `"<lineage>:N"` / `*`), parsed before any read (`core/ifmatch.ts:14-41`), required on every mutating verb except create/restore/like (`write.ts:336,428,470,551,638`). Restore takes no If-Match (`:585`, one possible next state). Transfer checks presence only, not rev (`:638`) - documented, but it means a transfer can land on a layout the caller has not seen at its current rev.

**Likes** are their own truth: `appendLike` (`events.ts:470-569`) gates event + row on `EXISTS` re-evaluated at commit, `like_count` is recomputed by subquery on every write (`:310`), and the fold tallies liked/unliked events (`:683-686`).

**Where a write can be lost, doubled, or misreported:**

1. **Non-atomic multi-step sequences after a commit.** `createLayout` copies a tombstone's likes as separate `appendLike` batches after the create commits (`write.ts:292-297`); `applyNew` inserts `import_map` in a second statement after `importCreate` commits (`import/apply.ts:241-243`, `:272-274`). A crash between steps leaves a durable create with partial likes / no map row. The import case self-heals next tick via case 2 with a spurious `upstream_changed` event; the user case does not self-heal. Low frequency, not data loss, but a misreport (client may get a 500 for a write that landed).
2. **`5xx after commit`**: the HTTP response is built after `commitWrite` returns; any throw in the post-commit tail (like inheritance, `fullWire`) yields a 500 for a committed write. Retrying a POST then gets `409 name_taken`. Acceptable, but undocumented for clients.
3. **`n` not reconstructible** from the log (above). A "rebuild folded tables from events" tool does not exist; only dump→restore does, which copies rows verbatim (`dump/restore.ts:81-234`), not by replay.

Nothing else I could construct loses or double-applies a write. The `layout_revs` PK guard is a correct optimistic lock.

## B. The cmini import

`tick()` (`import/cmini.ts:78-232`): meta-token gate → `/layouts` list → `planTick` (pure, `import/plan.ts:62-137`) → per-id detail (or `?full=1` above 50 ids) → `applyFetchedId` → deletes → authors → state. Follow state is a column (`layouts.upstream_state`); any user write to the layout scope or to lineage `spark` flips it to `forked` (`core/upstream.ts:13-18`), after which the importer only appends `upstream_changed`/`upstream_deleted` info events (`apply.ts:349-370, 404-406`). Import writes use the fresh read's `n` so a racing user write wins and the import's write rolls back (`apply.ts:305-336`, `:387-400`; `RevConflictError` counted as `raced`, `cmini.ts:162`). **Following/forked as designed cannot clobber a user's layout or payload edit.** Verified by `tests/import/cases.test.ts` (LDB-I2), `tests/events/upstream.test.ts` (LDB-P14 property).

**Real defects:**

- **B1. Following-layout likes made through layoutdb are reverted within one tick.** `appendLike` never forks (likes touch no version, D13 L3). For a `following` layout the importer replaces likes wholesale: it *unlikes* every local liker absent from cmini's list (`apply.ts:339-345`). `planTick` triggers the fetch precisely because `like_count` differs (`plan.ts:98-101`). So: bot user likes a mirrored layout → within 5 minutes the import emits `unliked` as that user. This is the spec (`design/layout-db/07-implementation-phase1.md:526`) and tested as such (`cases.test.ts:261-278`), but it is a silent drop of a user action, directly against requirement 1. Only forked layouts keep union semantics (`apply.ts:366-369`).
- **B2. An upstream rename onto a name held by a live local layout wedges the import permanently.** Case 4 writes the new name through `commitWrite`, which throws `nameTaken` (an `ApiError`, `events.ts:195`/`:372`). `tick()` rethrows anything that is not `RevConflictError` (`cmini.ts:162`), aborting the tick before `meta_token` is stored (`:228`), so every subsequent tick replans and hits the same id. Same class: a tombstoned following layout whose name has since been claimed locally, then re-listed upstream. Only `applyNew` handles clashes (shadow names, `apply.ts:262-274`). No test covers a rename collision (`grep name_taken tests/import` is empty).
- **B3. Same-id upstream re-add with identical name/owner/created_at never revives the tombstone.** Revival only happens through case 4 when `layoutFieldsDiffer` (`apply.ts:144-146` compares name/owner/created_at, never `deleted`). Identical content → no write → the row stays deleted while `planTick` re-fetches it every tick forever (`plan.ts:106-109`). The tested case (`cases.test.ts:233-259`) only covers a moved `created_at`.
- **B4. Overlapping ticks have no lock.** No `import_state` "running" key exists; the `*/5` cron and `POST /v1/admin/import/tick` can overlap, and a slow tick (500 per-id GETs with 1/2/4 s backoff, `import/upstream.ts:21-22`) can outlive its 5-minute slot. Two ticks planning the same new id both pass `readByName` and one dies on `layouts_name_live` or the `import_map` PK, aborting that tick (no data loss; next tick recovers).
- **B5. Aborting on one bad id.** Any non-conflict throw from one id (including B2, or a D1 hiccup) aborts the remaining ids of the tick. Errors from shape validation are collected (`apply.ts:420-423`), but write-path errors are not.

Daily diff (`import/difftick.ts`, `import/diff.ts` 691 lines) reads D1 directly and compares following layouts to upstream in spark; it writes a `last_diff` record that `/v1/meta` exposes. Sound, low value relative to size.

## C. Backup / restore

- **What exists:** nightly (03:00Z slot) `writeDump` → whole-DB JSON, gzipped, sha256, `dump-YYYY-MM-DD.json.gz` + `latest.json` + per-stored-major `latest.spark-1.json` (+sidecar), monthly copy on the 1st (`dump/write.ts:334-371`). `meta` is read strictly before table pages (MF-13, `:196-212`, tested `mf13-dump-floor.test.ts`). `restoreSql`/`restoreInto` (`dump/restore.ts:81-250`) wipe and re-insert verbatim; the daily CI job restores the live dump into a throwaway miniflare D1 and replays the conformance suite (`.github/workflows/db.yml:148-157`; `tests/rehost.test.ts:104-190`). A Fly "drill" (`drill/`, `scripts/drill-*.mjs`) does the same off-Cloudflare and reports into `/v1/meta.last_drill`.
- **RPO = up to 24 h** for a D1 loss, longer if the 03:00 slot is missed (see D). `auth_cache`, `webhooks`, `ratelimit`, `nonces`, `clients` are never dumped (`dump/write.ts:90-91`, restore deletes `webhooks`, `restore.ts:38`); `clients` is *not* restored either (not in `TABLE_ORDER_DELETE` and no INSERT) - a rehost loses every registered bot key and needs the admin bootstrap redone. Not documented in README §Rehost.
- **Missing:** (1) no retention/lifecycle rule on R2 (fine for cost, unbounded growth); (2) no copy outside the Cloudflare account - the CI and Fly drills fetch and discard (`db.yml` has no artifact upload; `drill/run.sh:33` `rm -rf`); (3) **D1 Time Travel is not used or documented** (only mention is a string in `tests/tools/ciwiring.test.ts`); it gives 30-day point-in-time restore on Workers Paid for free and would cut RPO to minutes; (4) no proven restore *into a fresh production D1 via `wrangler d1 execute --file`* other than the README procedure (`README.md:310-343`) - tests exercise `restoreInto` (batch API), the drill exercises `restoreSql` through wrangler locally; a real prod rehost has never been rehearsed per the ledger; (5) the whole DB is materialized in Worker memory and `canonical()`'d (`write.ts:335`) - fine at ~4k layouts, a CPU/memory cliff later (no `[limits] cpu_ms` in `wrangler.toml`).

## D. Concurrency + scheduling

One `*/5` trigger dispatches four jobs by `scheduledTime` (`src/index.ts:202-236`). Each guarded by `runJob` (`core/jobs.ts`). Problems:

- **D1. Slot-based dispatch misses work.** The nightly dump runs only if an invocation lands at exactly hour 3 minute 0; the diff only at 4:00. A delayed or dropped dispatch (the account had a 9-hour outage on 2026-09-09, `design/layout-db/13-ledger.md:7,15`) skips that day's dump entirely with no retry and no alarm other than a stale `latest.json`. There is no "last dump older than 25 h → run now" catch-up. Double-run is impossible (one slot per day) but so is recovery.
- **D2. No overlap protection** for the import (B4) - and every write nudges a webhook drain via `waitUntil` (`index.ts:67-88`), so drains overlap routinely; that one *is* handled by the lease (`core/webhooks.ts:444-452`, `commitOutcome` CAS on `lease_id`, tested LDB-H6).
- **D3. Limits.** Batches are ≤6 statements. The heaviest invocation is a 500-write import tick: ~8 D1 round trips per id plus one upstream GET with 1/2/4 s backoff, so wall time (15 min cron cap), not the per-batch statement count, is the binding limit; `buildDump` runs 9 parallel pagers. Cron wall limit is 15 min; a full first import is designed to span ticks (`cmini.ts:225-230`). No CPU limit raised in `wrangler.toml`.
- **D4. SSE stream** (`routes/stream.ts`): polls `feed()` every 2 s per open client for up to 5 min (`STREAM_MAX_MS`), each poll a D1 read. Cost scales with connected clients; the bot is the only consumer. Correct (LDB-H2) but a polling loop dressed as push.

## E. Auth

- **User lane** (`auth/discord.ts:97-205`): bearer → `GET /oauth2/@me`, cached by sha256 for 300 s / 60 s. **Any Discord OAuth2 application's token with `identify` is accepted**; the app id is recorded (`source_client: discord-app:<id>`) but not allow-listed. Any third-party app a user has authorized can write as that user. Design-intentional (client-neutral), worth stating as a risk. Revocation lag ≤5 min by design.
- **Client lane** (`auth/client.ts:102-197`): Ed25519 over `method\npath?query\nts\nnonce\nactor\nsha256(body)`, ±300 s skew, nonce PK insert after verification (`:156-162`), caps `act-as-owner-only` enforced (`:165-167`), `clients.status` read per request (`:126-131`). Solid; vectors + mutation matrix (`tests/auth/client.test.ts`, LDB-A4). One nit: nonce insert occurs *before* the caps check, so a request refused by caps still burns its nonce - harmless.
- **Gate placement:** `requireActorOnWrites` on `/v1/*` for all non-safe methods (`index.ts:44`), enumerated over `app.routes` (`tests/auth/routes.test.ts`). Admin gate is `admins` table read per request. `GET /v1/webhooks` resolves its own actor (`routes/webhooks.ts:52`). No hole found that lets a non-owner write (`loadForWrite`, `write.ts:61-74`) or blocks a legitimate one, except that a Discord 429/5xx becomes a 503 with nothing cached (`discord.ts:145-148`) - correct behaviour.
- **Rate limit:** one upsert per attempt (`core/ratelimit.ts:35-44`), 1000/10 min actor + 5000 per client; unauthenticated floods bypass it but hit the 60 s failure cache per token.

## F. Complexity inventory (blunt)

Lines: `src/` 8,989; `formats/` 3,190; `scripts/` 2,601; `drill/`+migrations ~500; **tests 23,065** + 357 conformance JSON fixtures + 1.4 MB fixtures. Prose-to-code ratio in `src/` is very high (most files are >50 % comments cross-referencing design docs).

| Mechanism | Lines (approx) | Load-bearing for the 4 requirements? |
|---|---|---|
| `commitWrite`/`foldLayout`/`appendLike`, `records.ts`, `write.ts`, `ifmatch.ts` | ~2,000 | **Yes.** The core. Keep. |
| Discord bearer lane + `auth_cache` | 235 | Yes. |
| Ed25519 client lane + `nonces` + `clients` admin routes | ~400 | Yes for the bot (the bot cannot hold user tokens). Keep. |
| Rate limit (2 counters) | 133 | Cheap insurance; keep, or drop the per-client counter. |
| cmini import (`import/*` minus diff) | ~1,200 | Yes while cmini is the upstream. Needs the B-fixes. |
| Daily diff (`import/diff.ts` + `difftick.ts` + live test) | ~900 | Speculative. A weekly `layout_count` + sampled compare would do. **Delete or shrink.** |
| Nightly dump + `restoreSql` + `rehost.mjs` | ~700 | Yes. Keep; add Time Travel. |
| Per-major `latest.<fmt>.json` dumps (LDB-D6) | ~120 | Speculative (no consumer named). **Delete.** |
| Fly restore drill (`drill/`, 4 scripts, 4 tests, `/v1/admin/drill`, `last_drill` in `/v1/meta`) | ~600 | Speculative; duplicates the CI rehost job. **Delete**, or keep CI's only. |
| Webhooks + lease (`core/webhooks.ts` 510, route, migration 0004/0008) | ~600 | Not load-bearing: the only consumer (the bot) uses SSE/polling. **Delete** until a second consumer exists. |
| SSE stream | 100 | Marginal; `/v1/changes?since=` polling every few seconds gives the same latency. Keep only if the bot measurably needs it. |
| HTML `/admin/changelog` page | 170 | Speculative. **Delete.** |
| Formats registry: multi-major `up/down/walk/path/chainViolations/reachingLineages`, `written_as`, `format_behind` | ~450 in `formats/registry.ts` + `write.ts:183-197,351-360,492-502` + stub-lineage tests | Speculative generality for a `spark/2` that does not exist. Every registered lineage has exactly one major. The read-path `withPayload` optimisation (`routes/layouts.ts:141`) exists only to dodge this machinery. **Freeze or delete**; reintroduce when spark/2 is real. |
| Multi-format `layout_formats` (one row per lineage) | schema + ~300 | Half-speculative: only `spark` is ever stored (`apply.ts:28`, registry `:126`). Harmless now, but it doubled the write model's surface (MF-1..MF-13). Keep, since it is landed and tested; do not add lineages without a consumer. |
| `authors_head` triggers + ETag validators (0007, LDB-R9..R11) | ~150 + 50 tests | Load-bearing for the bot's 304 heartbeat. Keep. |
| Edge cache (`caches.default`) | 30 | Inert on `workers.dev` (`etag.ts:122-125`). Delete or leave. |
| Admin routes: pause/resume/tick×3/drill/health/admins/clients | 209 | tick×3 + clients + admins yes; drill/health mostly speculative. |
| Docs-site generator tests, CODEOWNERS generator, package build (`tsup`), split-repo dry run | ~700 tests/scripts | Repo tooling, not service. Speculative for a one-maintainer project. |

**Routes: 42** (13 admin, 6 layout writes, 2 likes, 3 webhooks, 1 SSE stream, 1 HTML changelog, 16 public reads incl. 4 dump routes). **Cron jobs: 4** in one trigger. **Migrations: 9** (0009 drops and recreates the core tables - "disposable" is real). **Format modules: 3** (`spark/1` stored, `mana2/1` output, `cmini` import adapter).

## G. Test suite

- 95 files, 15,897 tests, 98 s locally (workers project dominates; `authors-validator` alone 89 s). The count is inflated by generated matrices (357 conformance fixtures × lane × error, `format-required-matrix`, `ifmatch` matrix). Meaningful coverage: fold/replay identity under random ops (`tests/events/fold.test.ts`), real HTTP races via spies (`mf1/mf6/mf-l2`), import case table (`tests/import/cases.test.ts`), dump→restore→conformance replay (`tests/rehost.test.ts`), auth vectors + mutations, LDB-T1 (every invariant id has a tagged test, `tests/tools/invariants.test.ts`).
- **Misses:** import rename collision (B2); identical re-add revival (B3); overlapping ticks (B4); a like on a following layout being reverted is *asserted as correct* (B1); restore of `clients`; a slot-dispatch miss (D1); any test that runs `restoreSql` through `wrangler d1 execute` against a *fresh* schema (only the Fly drill does, off-CI); memory/CPU of `buildDump` at 10× data. `tests/upstream-diff.test.ts` and remote `rehost` run only in the daily CI job (skip locally by design). Stale comment: `rehost.test.ts:174-176` says the conformance replay "is expected to fail" - it passes.

## H. Top 10 risks, ranked

1. **Import wedge on rename collision (B2).** Fix: catch `ApiError name_taken` in case 4, apply the same shadow-name rule as `applyNew`, record an `import_conflict` info event; test it. Also catch-all per id (B5) so one bad id never aborts the tick.
2. **User likes on following layouts silently reverted (B1).** Decide: either likes fork the layout, or the import uses union semantics for likes everywhere (drop `unliked` from case 5), or the bot must route likes to cmini. Whichever, it must be a stated invariant; today it contradicts requirement 1.
3. **Nightly dump depends on one exact 5-minute slot firing (D1).** Fix: store `last_dump_at` in `import_state`; every tick runs the dump if it is >24 h old. Same for the diff. Alarm when `latest.json.date` is older than 2 days.
4. **RPO 24 h, single account, no off-Cloudflare copy (C).** Fix: enable/document D1 Time Travel (`wrangler d1 time-travel restore`), rehearse it once on preview; have the daily CI job `upload-artifact` the dump with 30-day retention (free, off-account). Rehearse `restoreSql` into a *fresh* D1 once and write down the time it took.
5. **`clients` not in the dump/restore (C).** Fix: dump and restore `clients` (pubkeys are public); document that `webhooks`/`auth_cache` are deliberately dropped.
6. **Tombstone never revives on identical re-add (B3).** Fix: include `deleted` in `layoutFieldsDiffer`, or special-case `record.deleted && following` → restore. Test it.
7. **No import lock (B4).** Fix: `import_state['cmini.running'] = {at}` set with a CAS INSERT, expire after 10 min; manual tick returns 409 while held.
8. **Speculative machinery increases review surface (F).** Delete: webhooks + lease (0004/0008 tables can stay empty), Fly drill, HTML changelog, per-major dumps, multi-major chain code paths behind a "single major" assertion. Roughly -2,500 lines of `src`+`formats`, -4,000 of tests, and INVARIANTS.md shrinks by ~15 rows. Nothing the bot or akl.gg calls today goes away.
9. **`buildDump` materializes the whole DB in memory** (C). Fix: stream table pages into the gzip stream, or set `[limits] cpu_ms` and add a size alarm; not urgent below ~50k events.
10. **Any Discord app's token writes as the user (E).** Accept explicitly (client-neutrality) or allow-list `application.id`s alongside `clients`. At minimum document it in `INTEGRATION.md`.

**Keep or restart?** Keep. The event-log + folded-rows + PK-guard core is correct, replayable, and has the strongest test coverage in the repo; restarting would re-derive exactly this. Spend the effort on the six import/backup fixes above and on deleting the mechanisms in row 8, not on a rewrite.
