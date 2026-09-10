# 17 — Magic rules are akl.gg's: the DB is their home, cmini's are ignored

Status: proposal, 2026-09-10 (saltorbit: "aklgg should read from the new db
to get its magic rules, meaning that aklgg needs to change to publish its
magic rules to the db (and the db needs to ignore rules coming from
cmini)"; #304: "drop cmini magic rules on the floor, only use aklgg magic
rules everywhere"). Refines `11-implementation-phase3.md` §1 W5/W6 and
`03-api.md` §5's import semantics; supersedes nothing yet.

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

Format wrinkle: a `cmini/1` record cannot hold akl/1 magic (its `magic`
shape is cmini's flat rows). When akl.gg publishes rules to a `cmini/1`
record, the write lifts the record to `akl/1` (`cmini/1 → akl/1` is
lossless, LDB-F5) and sets `magic`; later imports for that record
translate upstream's keys into the record's current format and keep the
magic. `?as=cmini/1` still lowers akl rules into cmini's flat rows for
readers that want that shape (the bot's cmini-view, external tools).

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
and the D1 `magic_rules` PUT is deleted. The 10 layouts whose rules the
seed would fork (ledger §6 Q2) need saltorbit's call first. Invariant:
**I-2xx** after the seed, akl.gg never writes a rule set anywhere but
the record (`magic_rules_log` frozen, the PUT route gone).

**M3 — akl.gg reads rules from records.** `sync_cmini_data.py --source db`
builds `web/data/magic_rules.json` from `?as=akl/1` records with magic
(planned in `11` §1 W5); the live `/api/magic-rules/:id` read becomes a
proxy of the record's `magic`; `magic-rules-sync.yml` and D1's table
retire after a parity window with a daily D1-vs-DB diff (the same shape
as the cmini one). The pipeline's magic-aware harvest keeps reading
`magic_rules.json`, so nothing changes for stats.

Order: M1 now (DB only, no user-visible change except cmini-flagged
records losing a flag nobody wanted); M2 after the fork question; M3 with
W6.

## 5. What this changes for the bot

Nothing beyond LDB-B24: its `rulesFor(rec)` reads an `akl/1` record's
own magic first (the DB is the truth), falls back to akl.gg's file only
for a record not yet seeded, and never reads a `cmini/1` record's. After
M2 the fallback never fires; after M3 it is deleted and the bot reads the
record only.
