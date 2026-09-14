# 17 — Magic rules are akl.gg's: the DB is their home, cmini's are ignored

Status: proposal, 2026-09-10 (saltorbit: "aklgg should read from the new db
to get its magic rules, meaning that aklgg needs to change to publish its
magic rules to the db (and the db needs to ignore rules coming from
cmini)"; #304: "drop cmini magic rules on the floor, only use aklgg magic
rules everywhere"). Refines `11-implementation-phase3.md` §1 W5/W6 and
`03-api.md` §5's import semantics; supersedes nothing yet. **M1 DONE**
(`import/apply.ts`/`import/strip.ts`, LDB-I9/I10/I11). **M2's prerequisite
DONE** (2026-09-10, `18-command-decisions.md` §2 item 1, LDB-I12): a
magic-only write (`PATCH {magic}`, or its migration-script PUT equivalent)
never forks a record from upstream any more, `followsUpstream` skips it,
and a `magic` PATCH on a `cmini/1` record lifts it to `akl/1` losslessly
(§3's "format wrinkle" below, now implemented) -- `import/apply.ts`'s
`akl/1` branch of case 4 (this doc's own §4 M1 TODO) is implemented too.
With LDB-I12 the "10 forks" question is moot (saltorbit, 2026-09-10: the
rule fixed the mechanism, not a per-layout call): the seed forks nothing.
The exact procedure is `db/README.md`'s "Magic rules seed (one-time, M2)"
section; preview first, then production.

**Amended 2026-09-11 (20-spark.md S7, decision 6): magic edits fork going
forward.** The paragraph above described LDB-I12 as a standing exemption
— true through M2's seed, and still true of the seed itself, but no
longer true of any *new* write. `20-spark.md`'s decision 6 retires the
magic-only exemption: a `PATCH {magic}` (or any write that changes only
`magic`) now forks an upstream-following record exactly like any other
edit, and bumps `modified_at` (the lead's answer to that plan's §8 Q1 —
a magic edit is an edit; there is nothing left for an unbumped
`modified_at` to keep in step with once the record no longer mirrors
upstream). `LDB-I12` is **narrowed, not deleted** (`03-api.md` §5,
`20-spark.md` §4): its text is now the definition of `legacyFollows`
(`core/follows.ts`), read only by `upstreamOf`'s fallback for a record
whose stored `upstream` column predates 0005, and by the S4 record
migration when it computes a record's *initial* `upstream` value. No
code path sets a new `detail.magic_only: true` marker again. The **67
records M2 seeded stay `following`**, deliberately (decision 7, flagged
here and in the migration's own report as
`legacy_magic_only_following`): the legacy rule walks back past their
magic-only seed event to the `import:cmini` write underneath, so their
*initial* `upstream` comes out `following` even though a magic-only write
made after this landed would fork them like anything else. akl.gg's
editor (M3, below) writes ordinary `PATCH {magic}` calls, so from the
site's perspective nothing here changes — the difference is only in what
the record's `upstream` field now says afterward.

## 1. Where rules live today

| store | writer | reader |
|---|---|---|
| cmini's `magic` field on a layout | `!cmini` users | the DB import copies it into every `cmini/1` record's payload; `has_magic` derives from it; the bot's `!magic`/`!image` caption read it (LDB-B24 is removing that) |
| D1 `cb-magic.magic_rules` (83 sets) | akl.gg's rules editor via `functions/api/magic-rules/[id].js` PUT (session cookie, owner-or-admin) | `scripts/build_magic_rules.py` → `web/data/magic_rules.json` (seed ⊕ D1) → the site, the pipeline's magic-aware harvest, and (LDB-B24) the bot |
| the DB record's `magic` (akl/1) | nobody yet in production (W5's migration is dry-run only) | `?as=akl/1` readers |

Two sources of truth, and the wrong one (cmini's) is the one every
imported record carries.

## 2. The rule

**The record is the one home of a layout's magic.** akl.gg's current
rule sets are the *seed* — imported once, then never consulted again as
a source: after the seed akl.gg writes rules to the record like any other
client and reads them back from it; its D1 table and `magic_rules.json`
become derived or retired. cmini's magic never enters the DB. The cmini
import writes keys, board and name; it never reads or writes `magic`.
Everything that wants a layout's rules — the site, the bot, the
pipeline — reads the record.

## 3. Why "a layer the cmini import never touches", not "publishing flips the record"

**Amended:** `LDB-I2a`'s check below is now the **legacy fallback**
(`legacyFollows`, `03-api.md` §5) read only for a record whose stored
`upstream` column predates 0005 — the live answer is the stored field
(decision 5), computed by `nextUpstream` the same way on every write. The
reasoning underneath — the import must not let publishing a rule set look
like an ordinary write that stops the layout's `!cmini` key edits — is
unchanged; it is why the *import's own* writes (never the site's) are the
one write kind exempt from forking (decision 6's "only system writes never
fork: the importer and one-time migrations").

`LDB-I2a`: a record follows upstream iff its latest rev-bumping event
has `via = import:cmini`. If akl.gg's rules were published as an ordinary
write, every layout with rules would stop receiving its author's `!cmini`
key edits until spark has replaced `!cmini` (`15-transition.md`). That is
most of the layouts people care about. So the import must keep following
upstream **for keys** while leaving **magic** alone:

- the import's change detection (`import/apply.ts`'s `projectUpstreamNoLikes`
  vs `projectLocalNoLikes`) compares the cmini/1 projection **minus
  `magic`**;
- an import write carries the record's existing `magic` forward
  unchanged (the `imported` event's `after` shows keys moved, magic kept);
- the import strips `magic` from upstream's payload before validation, so
  a freshly imported record has none; `has_magic` = the format's
  `hasMagic(payload)` as today, which is now "akl.gg rules present";
- the daily upstream diff (`db/scripts/diff-upstream.mjs`, LDB-P5) compares
  with `magic` excluded on both sides, so "diff vs cmini = zero" keeps its
  meaning for what the DB actually mirrors.

Format wrinkle (**historical**, resolved by the one-stored-format
redesign): a `cmini/1` record could not hold `akl/1` magic (its `magic`
shape was cmini's flat rows), so publishing rules to one had to lift it
to `akl/1` first. **Since S2 (`20-spark.md`, LDB-F16) every write —
`setMagic` included, not only a magic write — carries a legacy-stored
record's payload through `storedAsSpark` before applying anything**, so
this is no longer a magic-specific wrinkle: any PATCH lifts a still-legacy
record to `spark/1`. Later imports for that record translate upstream's
keys into the record's current (now always `spark/1`) format and keep
the magic. `?as=cmini/1` still lowers spark rules into cmini's flat rows
for readers that want that shape (the bot's cmini-view, external tools).

## 4. The steps

**M1 — DB: the import ignores cmini's magic** (`db/`; no client change).
Strip on import; compare minus magic; carry the record's magic through
import writes; diff minus magic. A one-time admin pass (`POST
/v1/admin/import/strip-magic`, or simply the next import tick once the
plan treats "upstream magic present, local none" as no change) drops the
cmini magic already sitting in the 4 000+ imported records — as an
`imported` rev bump so `/v1/changes` consumers (the bot, the site sync)
refold. Invariants: **LDB-I9** an imported payload never carries `magic`;
**LDB-I10** an import write preserves the record's `magic` byte-for-byte;
**LDB-P5** amended: the projection compared is magic-less. Tests: the
import cases (upstream adds/changes/removes magic → no event), the
apply-preserves-magic case, the diff fixture.

**M2 — seed the records from akl.gg's rules, then akl.gg writes to the
DB.** Run `scripts/migrate_magic_rules_to_db.py` for real (W5's script,
today `--dry-run`): each of the 83 sets becomes its record's akl/1
`magic` via the ops client, `via: migration`, one event each, records
lifted to `akl/1`. That is the last time akl.gg's copy is read as a
source. From then on akl.gg's editor writes `PATCH /v1/layouts/{id}
{magic}` through the existing `/api/db/*` proxy on the user lane
(I-225/I-226) — owner or admin, the same rule the current PUT enforces —
and the D1 `magic_rules` PUT is deleted. The former "10 forks" (ledger §6 Q2) are
no longer a question: LDB-I12 makes the seed a magic-only write. Invariant:
**I-2xx** after the seed, akl.gg never writes a rule set anywhere but
the record (`magic_rules_log` frozen, the PUT route gone).

**M3 — akl.gg reads rules from records.** **Sync half DONE** (2026-09-10,
`ldb-m3-sync`): `scripts/build_magic_rules.py --source db --base-url
<layoutdb>` builds `web/data/magic_rules.json` from every `has_magic=true`
record's `?as=akl/1` payload (cursor-paged list + a per-id detail GET --
`full=1` doesn't compose with `has_magic`, so it can't be one dump),
merged with the hand-authored seed for any site-only layout the DB
doesn't have a record for yet (`seed-only: <id>`, logged); D1 is not
consulted in this mode at all. `.github/workflows/build.yml`'s "Build
magic rules data" step now branches on the same `DB_BASE_URL` repo
variable the scrape step already uses (`design/DEPLOY.md`), so flipping
that one variable moves both the catalog and the rules onto the DB
together. **Live half DONE** (2026-09-10, `ldb-m3-live`, LDB-S7..S11 =
I-245..I-249): with the Pages env var `DB_BASE_URL` set (the site-side
twin of the same knob, `design/DEPLOY.md`), `functions/api/magic-rules/*`
switch at their first line to `functions/_lib/magicdb.mjs` and D1's
`magic_rules`/`layout_authors` are never queried --
- `GET /api/magic-rules/:id` is a public read of the record's `?as=akl/1`
  `payload.magic` (the rule set verbatim, no conversion), same wire shape;
  `updated_at` is the record's latest `created`/`updated`/`restored`
  event's `at` (a magic-only write keeps `modified_at`, LDB-I12, so that
  field can't date the rules; the editor's pending-sync poll needs the
  write time, or a later bound, to compare the stat patch against);
- `PUT /api/magic-rules/:id` reads the record through the user-lane proxy
  (its sign-in gate; ownership is the DB's own 403), validates as before,
  honours `X-Magic-Base-Sig` against the record's current magic (same 409
  shape), then `PATCH /v1/layouts/{id} {magic}` with `If-Match "<rev
  read>"`; a `409 stale` is rebased once; `400 magic_collision` and every
  other DB answer pass through verbatim (the sheet already handles them);
- `GET /api/magic-rules` (the load-time overlay `state/catalog.ts` merges
  over the static file) is the tail of the DB's event feed, detailed and
  capped -- the free-tier Pages Function can't fan out over 80+ records
  and `full=1` doesn't compose with `has_magic`; an overlay is what the
  frontend's `mergeServerRules` wanted anyway;
- after a 2xx the route fires `db_site_write` (nothing consumes it yet)
  AND the existing `magic_rules_submit`, because the layout's NUMBERS
  still come from `magic-rules-sync.yml`'s per-layout stat patch -- that
  workflow's rules-fetch step, `live-sync.yml`'s compute
  (`live_patch_sync.py --db-base-url`) and `magic-rules-backup.yml` (parks)
  all branch on `vars.DB_BASE_URL` too (`fetch_d1_rules.py --source db`).
Frontend untouched: `web/src/data/magic-api.ts`'s four calls see the same
shapes. Still open: D1's table and `magic-rules-sync.yml`'s D1 branch
retire after a parity window with a daily D1-vs-DB diff (the same shape
as the cmini one); `compact_stat_patches.py`/`check_magic_freshness.py`
still read D1 (build-time readers of a frozen table -- harmless until the
retirement, listed in `13-ledger.md` §6 item 6). The pipeline's
magic-aware harvest keeps reading `magic_rules.json`, so nothing changes
for stats either way.

Order: M1 done; M2 done (2026-09-10); M3's sync half done (2026-09-10);
M3's live half done (2026-09-10, waits only on W6's env-var flips).

**2026-09-14, `26-magic-reseed.md`:** M2's "the last time akl.gg's copy is
read as a source" did not hold -- the M3 live half is built but akl.gg prod's
`DB_BASE_URL` is not flipped, so the site keeps publishing to D1 and the
records drift. Until the flip, akl.gg prod is reseeded into akldb daily
(`scripts/reseed-magic.mjs`, LDB-P25/LDB-C8), guarded so an akldb-side edit
is never clobbered. The reseed retires with the flip; the D1 table retires
with saltorbit/aklgg#1.

## 5. What this changes for the bot

Nothing beyond LDB-B24: its `rulesFor(rec)` reads an `akl/1` record's
own magic first (the DB is the truth), falls back to akl.gg's file only
for a record not yet seeded, and never reads a `cmini/1` record's. After
M2 the fallback never fires; after M3 it is deleted and the bot reads the
record only.
