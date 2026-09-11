# What changes on akl.gg

Status: proposal (2026-09-08). Part of `00-plan.md`. The site is the DB's
first client (P7) and nothing here needs the bot.

**Amended 2026-09-11 (20-spark.md S7).** `akl/1` is renamed `spark/1` and
is the one stored format (`01-format.md` decision 1); `cmini/1` is a
read-only adapter projection (`?as=cmini/1`), kept only as a transitional
alias. Below, `sync_cmini_data.py --source db` reads `?as=spark/1` and
does the spark→cmini-shape conversion **itself**, in Python, rather than
asking the DB for the `cmini/1` adapter's projection (§1, `20-spark.md`
S6) — the DB-side `?as=cmini/1` route stays for other readers (the bot,
emulayout) but the site's own sync does not use it. Magic edits now
**fork** an upstream-following record like any other write (decision 6);
see §4.

## 1. Reads: the pipeline keeps its shape

Today (`design/cmini-live-api/01-migration.md` §6–7, `design/DEPLOY.md`):
`scripts/sync_cmini_data.py` scrapes `clemenpine.com/layoutapi/v3` into a
data root; `workers/meta-watch` polls `/v3/meta` every 2 min and dispatches
`live-sync.yml`; the nightly rebuilds the base. All of it keyed on the API's
shape.

Change, in order:

1. **Phase 1 (mirror):** nothing on the site. The DB imports from cmini; the
   D12 diff compares every record whose `upstream.state` is `following`,
   read `?as=cmini/1`, with upstream (`03 §9` LDB-P5, amended by S3b).
2. **Phase 3 (cutover):** `sync_cmini_data.py` grows a `--source db` mode:
   list from `/v1/layouts` (rows are the record minus payload),
   details (and the batch path) from `/v1/layouts?full=1&as=spark/1` /
   `/v1/layouts/{id}?as=spark/1`, authors from `/v1/authors`, and the
   change signal from `/v1/meta` (`revision`/`seq` in place of cmini's
   `last_modified`). **Amended (20-spark.md S6):** the script reads the
   native `spark/1` payload and converts it to the cmini shape **itself**
   — only the fields `normalize_detail` reads (`board` → word, the same
   rule as the adapter's `cminiBoardWord`: `board.cmini` wins, rowstag →
   `stagger`, ortho/colstag → `ortho`; `keys`; `free`; no magic compile in
   Python) — rather than asking the DB for `?as=cmini/1`. It is
   parity-tested against the adapter's `toCmini` goldens on those fields
   (`scripts/tests/test_sync_db_source.py`). The extracted per-layout
   files are the same cmini shape either way, so content hashes,
   manifests and everything downstream are untouched. `workers/meta-watch`
   polls the DB's `/v1/meta` (later: a webhook subscription replaces the
   2-min poll, `03 §5`). The `cmini-backup` orphan branch keeps
   committing the scraped set (it now backs up our own DB, which is fine
   and cheap).
3. **Later:** the sync reads `?as=spark/1` (not the transitional `akl/1`
   alias) so board geometry and magic intent reach `layouts.json`;
   `build_web.py`'s `layout_meta_and_keys()` grows the fields.

`data/layout-dates.json` **stays through phase 3** (`11 §3.2`): `build_web.py`
keeps reading it and `sync_cmini_data.py --update-dates` keeps rolling it
forward from the DB list's `created_at`/`modified_at`; it stops being
needed only when the site reads dates off the record (phase 5, with the
`?as=spark/1` sync). Measured 2026-09-08 (`07 §0.1`): upstream's `created_at` now spans
2022-12-07 onward and 1965 layouts have `created == modified`, so the
"stamped 2026-08-20" premise of round 1 no longer holds — whether the
committed history file still has anything older or more precise than
upstream is **Q1**, to be answered by a one-off diff before phase 3.

## 2. The cmini import (runs inside the DB, not the site)

A cron in the DB Worker (every 5 min; `/v3/meta` first, so a quiet tick is
one GET — the trust-tier idea from the migration doc, reused):

"Following upstream" was **derived, not stored** (D9) in round 1. **Amended
(20-spark.md decision 5, S3a):** `upstream: {source: "cmini", id, state:
"following" | "forked"} | null` is now a stored, top-level record field —
still a fold of the event log (`nextUpstream`, `03 §5`), just no longer a
live per-read query: any rev-bumping *user* write forks the record
automatically (its `via` alone no longer has to be walked back through on
every read). The field, and this whole "following" model, is transitional
for as long as the cmini import runs (decision 16) — it is retired with
the import, not carried into steady state. `import_map` (`03 §8`) joins
cmini ids (= the lowercase name, `07 §0.1`) to record ids.

- new upstream id → `POST`-equivalent as `format: spark/1`, `payload:
  fromCmini(detail.payload)`, `owner = user`,
  name **verbatim** (case kept; `check_name` not applied), event
  `imported {source: "cmini", upstream_id}`, `upstream: {source: "cmini",
  id, state: "following"}`; `import_map` row;
- changed upstream (`modified_at` moved, list `like_count` differs, name
  differs, or content differs on the daily full pass) and the record
  follows upstream → apply as an update, event `imported` (actor
  `system:cmini-import`, `via: "import:cmini"`, `rev + 1`);
- changed upstream and the record does not follow → **do not apply**; event
  `upstream_changed` with the upstream content in `detail` so the owner can
  see it (the site offers *take cmini's version* as a one-click PUT); not
  repeated while the upstream content stays the same;
- upstream deleted (unlisted, or a listed id whose detail 404s) →
  `upstream_deleted`: the tombstoning event (`rev + 1`) when the record
  follows upstream (the author deleted it and owns it here too), an
  informational event when it does not (**Q2**);
- upstream new name collides with a live local record: by the **same**
  owner → mapped and treated as not-following (`upstream_changed`); by a
  different owner → imported as **shadowed** (federation §6.3): stored,
  `name` set to `<name>~cmini` (`~cmini2`, … if taken), event
  `import_conflict`, owner told on their next visit. Unreachable until
  phase 2 (no local writers), built and tested in phase 1 anyway;
- likes: replaced from upstream while the record follows (`liked`/`unliked`
  events, actor = the liking user); merged (union) once it does not (**Q3**);
- authors: `/v3/authors` seeds `authors` names; a name seen at auth wins
  thereafter; no events.
- an upstream **rename** is delete + create (cmini's id is its lowercase
  name; there is nothing to match on but content). The old record is
  tombstoned, the new one gets a new id — the same history loss cmini
  itself has. A content-matching heuristic is a later addition if renames
  turn out to matter (**Q4**).

Bounded like `live-sync`'s prune rule: refuse to tombstone > `max(5, 5 %)`
of live records in one tick (the tick stalls, `import_state.cmini.stalled`,
runbook entry to clear); a list shorter than half the live count stalls
the whole tick.

The site shows a small *changed on cmini since* line on a card whose latest
`upstream_changed` event is newer than its latest write; copy TBD, gated on
sign-off.

## 3. Writes: #215's approved UX, retargeted

`design/cmini-write/06-holistic-proposal.md` (approved 2026-09-01) stands as
written — local-first drafts, the record as the unit, derived destination,
publish consumes / delete restores, conflicts as a footer line, numbers never
wait, one DB two clients. Changes:

- The proxy targets the DB: `functions/api/db/*` (rename from `api/cmini/*`),
  same design (session cookie → stored Discord token → bearer to the DB);
  `06 §3.2`'s "does the API honour `If-Match`" is answered: yes, on `rev`
  (`03 §1`), so the emulation branch is dropped.
- The write body is `spark/1` (renamed from `akl/1`, `01 §2`), assembled by
  the same builder as the `!cmini add` exporter plus `board` (from #261's
  per-side geometry) and `magic` (the workbench's `ruleSet`, verbatim — it
  *is* `02-schema.md`). I-W2 becomes "the body is the draft's `spark/1`
  projection". **Amended (decision 6):** a magic-only write forks an
  upstream-following layout like any other edit now (`modified_at` bumps
  too) — see §4 and `17-magic-ownership.md`.
- Rename / Fingermap → `PATCH` (`03 §3`; the approved UX's Link verb is
  gone with the record's `link` field, `00 §6`); Delete → `DELETE`
  (tombstone; the 8 s Undo pill calls `restore`, so the id is stable —
  better than the re-POST 06 §2.6 planned).
- Transfer: a new *Give to…* verb under *More ▾* on the owner's card
  (copy gated). Not in the approved round; small.
- Likes: the heart from round 1 (`02-ux-mockups.html`), now buildable
  (`PUT/DELETE …/like`); its arrival moves identity to the header (06 §2.7).

## 4. Magic rules: D1 `magic_rules` folds into the record

**Done, not just proposed** — `17-magic-ownership.md` has the actual
sequence as run (M1/M2/M3, all landed by 2026-09-10) and its own
invariants; what follows is this document's original round-1 plan,
kept for the reasoning. **Amended (decision 6):** a magic-only write is no
longer exempt from forking — the `magic_only` marker that used to keep it
from counting as "the latest write" for the follows-upstream check is
narrowed to a historical-events-only meaning (`LDB-I12`); every new magic
edit forks and bumps `modified_at` like any other write.

Today the site's D1 `magic_rules` is canonical for rules and `magic-rules-sync`
computes patches from it. After cutover the rules live in the record's
`payload.magic` (R2 of the approved proposal; #221's recommendation):

1. One-time migration: for every `magic_rules` row, `PUT` the layout as
   `spark/1` with `magic` = the row's `rules_json` (actor `system:magic-migrate`,
   `admin: true`, logged). Layouts whose owner never signed in are migrated
   the same way — the DB admin lane exists for this.
2. `functions/api/magic-rules/*` becomes a thin read of `GET
   /v1/layouts/{id}?as=spark/1` for a transition, then is deleted.
3. `magic-rules-sync.yml` retires; `live-sync` sees the record change like
   any other and computes the patch (rules are content now, so the
   `rules_sig` in `stat_patches` is derived from `payload.magic`).
4. `layout_authors` D1 table and `build_layout_authors.py` retire **after**
   the magic-rules PUT route is deleted (its last reader besides
   `functions/admin/*`) — a follow-up to `11` W6, not a phase-3 slice:
   `/v1/authors` has cmini's `{name: id}` shape, so nothing in that path
   changes at cutover.

## 5. Drafts, mana, `cb <layout>` (#218, #188)

- A draft is not a record (federation F-12 kept): the *try elsewhere*
  handoff is a URL-encoded `spark/1` payload (renamed from `akl/1`;
  `?draft=<base64>`), no server
  state; the same shape mana can emit for `cb <local layout>` and the site
  can import (`#188`: a mana2/1 payload pasted or opened → the format's
  `from["mana2/1"]` runs client-side too, since `formats/` is plain ESM the
  site can import as a package).
- `formats/` as a package: publish `db/formats` to npm (`@akl/layout-formats`)
  so the site, the bot's JS-free needs aside, and anyone else validate and
  translate with the same code the server runs. The site consumes the
  **package**, never a path into `db/` — `00 §7`'s boundary rule (LDB-G5)
  is absolute in both directions, and a path import would break the
  `git mv` at the split. Until the package exists the site has no
  client-side translation (nothing in phases 1–3 needs one).

## 6. Admin surfaces

`/admin/cmini-log` (the site) → the DB's `/admin/changelog` (`03 §7`);
`/admin/rule-log` retires with `magic_rules`. The site's `usage` admin page
is unrelated and stays.

## 7. Order of work on the site

| when | site work | depends on |
|---|---|---|
| phase 1 | none (D12 diff runs in `db/`) | — |
| phase 2 | `functions/api/db/*` proxy + token storage (05-impl §4.1–4.2, retargeted); publish UX per the approved round; preview deploy against a preview DB | DB writes |
| phase 3 | `--source db` + CI wiring; the proxy + publish UX on preview; magic migration; ⚠ flip the two URLs, retire the `magic_rules` write paths (`11` W1–W6) | phase 2 verified on preview |
| phase 5 | `?as=spark/1` sync; board/magic intent in `layouts.json`; Give-to verb | — |

## 8. Invariants (site side)

Site code (`web/src`) is not touched by the S1–S7 redesign (`20-spark.md`
decision 13): it still writes through the `akl/1` alias — byte-identical
to `spark/1` — until the `publish-ux` branch merges and moves it. So the
site's own function names below (`toAkl1`/`fromAkl1`, `web/src/core/akl1.ts`)
are still literally what the code exports as of this writing; they rename
to their `spark/1` equivalents as part of that move, not before.

| id | invariant | enforced by |
|---|---|---|
| LDB-S1 | `sync_cmini_data.py --source db` produces a data root byte-identical (`layouts/*`, `likes.json`, `authors.json`, `sync_digest.txt`) to the cmini source's for every record following upstream; the pipeline id stays the lowercase name. | `scripts/tests/test_sync_db_source.py` over a fixture the DB's own code exported (`11` W1) |
| LDB-S1a | The site's committed DB-response fixture equals the DB's live routes. | `db/tests/api/site-fixture.test.ts` |
| LDB-S2 | Every site write to the DB carries `If-Match: "<rev>"` unless the action is `overwrite`; no proxy response carries the bearer, `Set-Cookie` or `WWW-Authenticate`. | I-W5 / I-W7 retargeted; `web/tests/backend/db-proxy.test.js` |
| LDB-S3 | The publish body equals `toAkl1(draft)`; `fromAkl1(toAkl1(draft))` is the same draft; the body validates against the frozen `akl/1`/`spark/1` schema (byte-identical). | `web/tests/core/akl1.test.ts` (property) |
| LDB-S4 | After the magic migration, no layout's served rules differ from before it (the site's compile of the static `magic_rules.json` == the DB's lowering, as sets of `(inputs, output)`); the migration is idempotent. | `scripts/tests/test_migrate_magic_rules.py`, `web/tests/backend/magic-migration-verify.test.js`, the one-shot `verify_magic_migration.py` *Amended 2026-09-11: `migrate_magic_rules_to_db.py` applies `magic_collision` hints until the payload validates (validate() reports one collision per call), so a rule set with several scaffold-vs-idiom collisions resolves every one the way akl.gg's compile order already does (the swap wins); only a hintless collision is refused. Tests: `test_several_hinted_collisions_all_resolve`, `test_single_char_default_vs_several_swaps_resolves`, `test_unresolvable_collision_sends_no_put`.* |
| LDB-S5 | Every CI scrape passes `source-url: ${{ vars.DB_BASE_URL }}`; none calls `sync_cmini_data.py` outside the action. | `web/tests/tools/ciwiring.test.mjs` |
| LDB-S6 | The proxy is a pass-through: status, body, `ETag`, `Retry-After` equal the DB's. | `db-proxy.test.js` |

## 9. Open questions (site)

1. Does `data/layout-dates.json` still hold anything upstream's `created_at` does not (`§1`)? Diff once before the file retires (phase 5 — `11 §3.2` keeps it through phase 3); import only if so.
2. Upstream delete of an unforked record: tombstone here? (Proposal: yes.)
3. Likes on a forked record: union with upstream, or stop syncing? (Proposal: union.)
4. Upstream renames as delete + create (`§2`): acceptable, or worth a content-matching heuristic? (Proposal: acceptable; cmini loses the history too.)
