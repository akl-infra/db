# What changes on akl.gg

Status: proposal (2026-09-08). Part of `00-plan.md`. The site is the DB's
first client (P7) and nothing here needs the bot.

## 1. Reads: the pipeline keeps its shape

Today (`design/cmini-live-api/01-migration.md` §6–7, `design/DEPLOY.md`):
`scripts/sync_cmini_data.py` scrapes `clemenpine.com/layoutapi/v3` into a
data root; `workers/meta-watch` polls `/v3/meta` every 2 min and dispatches
`live-sync.yml`; the nightly rebuilds the base. All of it keyed on the API's
shape.

Change, in order:

1. **Phase 1 (mirror):** nothing on the site. The DB imports from cmini; the
   D12 diff compares every record read `?as=cmini/1` with upstream.
2. **Phase 3 (cutover):** `sync_cmini_data.py` grows a `--source db` mode:
   list from `/v1/layouts?fields=id,name,owner,rev,modified_at,like_count`,
   details (and the batch path) from `/v1/layouts?full=1&as=cmini/1` /
   `/v1/layouts/{id}?as=cmini/1`, authors from `/v1/authors`, and the
   change signal from `/v1/meta` (`revision`/`seq` in place of cmini's
   `last_modified`). The extracted per-layout files are the same
   `cmini/1` shape, so content hashes, manifests and everything downstream
   are untouched. `workers/meta-watch` polls the DB's `/v1/meta` (later: a
   webhook subscription replaces the 2-min poll, `03 §5`). The
   `cmini-backup` orphan branch keeps committing the scraped set (it now
   backs up our own DB, which is fine and cheap).
3. **Later:** the sync reads `?as=akl/1` instead of the facade so board
   geometry and magic intent reach `layouts.json`; `build_web.py`'s
   `layout_meta_and_keys()` grows the fields; the facade stays for others.

`data/layout-dates.json` stops being needed once the DB carries
`created_at`/`modified_at` for every record (imported ones keep cmini's
dates; cmini's own were stamped 2026-08-20 for pre-existing layouts — the
committed history file is the source for anything older and is imported into
the DB once, as the `created_at` of those records: **Q1**).

## 2. The cmini import (runs inside the DB, not the site)

A cron in the DB Worker (every 5 min; `/v3/meta` first, so a quiet tick is
one GET — the trust-tier idea from the migration doc, reused):

"Following upstream" is **derived, not stored** (D9): a record follows
upstream iff its latest record-changing event (`created`/`updated`/…, likes
excluded) is an `imported` event. One indexed query per candidate; no flag
to go stale. `import_map` (`03 §8`) joins cmini ids to record ids.

- new upstream id → `POST`-equivalent as `format: cmini/1`, `owner = user`,
  event `imported {source: "cmini", upstream_id}`; `import_map` row;
- changed upstream (`modified_at` moved, or content hash differs on the
  daily full pass) and the record follows upstream → apply as an update,
  event `imported` (actor `system:cmini-import`, `rev + 1`);
- changed upstream and the record does not follow → **do not apply**; event
  `upstream_changed` with the upstream content in `after` so the owner can
  see it (the site offers *take cmini's version* as a one-click PUT);
- upstream deleted → `upstream_deleted` event; tombstone when the record
  follows upstream (the author deleted it and owns it here too), keep when
  it does not (**Q2**);
- upstream new name collides with a local record by a different owner →
  imported as **shadowed** (federation §6.3): stored, `name` set to
  `<name>~cmini`, event `import_conflict`, owner told on their next visit;
- likes: replaced from upstream while the record follows; merged (union)
  once it does not (**Q3**);
- authors: `/v3/authors` seeds `authors` names; a name seen at auth wins
  thereafter.

Bounded like `live-sync`'s prune rule: refuse to tombstone > 5 % of
records in one tick without an admin resume.

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
- The write body is `akl/1` (`01 §2`), assembled by the same builder as the
  `!cmini add` exporter plus `board` (from #261's per-side geometry) and
  `magic` (the workbench's `ruleSet`, verbatim — it *is* `02-schema.md`).
  I-W2 becomes "the body is the draft's `akl/1` projection".
- Rename / Link / Fingermap → `PATCH` (`03 §3`); Delete → `DELETE`
  (tombstone; the 8 s Undo pill calls `restore`, so the id is stable —
  better than the re-POST 06 §2.6 planned).
- Transfer: a new *Give to…* verb under *More ▾* on the owner's card
  (copy gated). Not in the approved round; small.
- Likes: the heart from round 1 (`02-ux-mockups.html`), now buildable
  (`PUT/DELETE …/like`); its arrival moves identity to the header (06 §2.7).

## 4. Magic rules: D1 `magic_rules` folds into the record

Today the site's D1 `magic_rules` is canonical for rules and `magic-rules-sync`
computes patches from it. After cutover the rules live in the record's
`payload.magic` (R2 of the approved proposal; #221's recommendation):

1. One-time migration: for every `magic_rules` row, `PUT` the layout as
   `akl/1` with `magic` = the row's `rules_json` (actor `system:magic-migrate`,
   `admin: true`, logged). Layouts whose owner never signed in are migrated
   the same way — the DB admin lane exists for this.
2. `functions/api/magic-rules/*` becomes a thin read of `GET
   /v1/layouts/{id}?as=akl/1` for a transition, then is deleted.
3. `magic-rules-sync.yml` retires; `live-sync` sees the record change like
   any other and computes the patch (rules are content now, so the
   `rules_sig` in `stat_patches` is derived from `payload.magic`).
4. `layout_authors` D1 table and `build_layout_authors.py` retire: ownership
   is `record.owner`, read from the sync.

## 5. Drafts, mana, `cb <layout>` (#218, #188)

- A draft is not a record (federation F-12 kept): the *try elsewhere*
  handoff is a URL-encoded `akl/1` payload (`?draft=<base64>`), no server
  state; the same shape mana can emit for `cb <local layout>` and the site
  can import (`#188`: a mana2/1 payload pasted or opened → the format's
  `from["mana2/1"]` runs client-side too, since `formats/` is plain ESM the
  site can import as a package).
- `formats/` as a package: publish `db/formats` to npm (`@akl/layout-formats`)
  at the split so the site, the bot's JS-free needs aside, and anyone else
  validate and translate with the same code the server runs. Until then the
  site imports it by path (allowed: `formats/` has no server deps; the
  archlint rule is `web/src/data → db/formats` only).

## 6. Admin surfaces

`/admin/cmini-log` (the site) → the DB's `/admin/changelog` (`03 §7`);
`/admin/rule-log` retires with `magic_rules`. The site's `usage` admin page
is unrelated and stays.

## 7. Order of work on the site

| when | site work | depends on |
|---|---|---|
| phase 1 | none (D12 diff runs in `db/`) | — |
| phase 2 | `functions/api/db/*` proxy + token storage (05-impl §4.1–4.2, retargeted); publish UX per the approved round; preview deploy against a preview DB | DB writes |
| phase 3 | flip the two URLs; magic migration; retire `magic_rules` paths; `layout-dates` import | phase 2 verified on preview |
| phase 5 | `?as=akl/1` sync; board/magic intent in `layouts.json`; Give-to verb | — |

## 8. Invariants (site side)

| id | invariant | enforced by |
|---|---|---|
| LDB-S1 | `sync_cmini_data.py --source db` produces a data root identical to the one it produces from upstream for every record that follows upstream. | pipeline test against a DB fixture |
| LDB-S2 | Every site write to the DB carries `If-Match: "<rev>"` unless the action is `overwrite`; the browser never sees a Discord token. | I-W5 / I-W7 retargeted |
| LDB-S3 | The publish body equals `toAkl1(draft)`; `fromAkl1(toAkl1(draft))` is the same draft. | round-trip property test |
| LDB-S4 | After the magic migration, no layout's served rules differ from before it (static `magic_rules.json` before == `payload.magic` after, for every row). | one-shot verification script, kept as a test fixture |

## 9. Open questions (site)

1. Import `data/layout-dates.json` into the DB as `created_at` for pre-2026-08-20 records? (Proposal: yes, once, at phase 3.)
2. Upstream delete of an unforked record: tombstone here? (Proposal: yes.)
3. Likes on a forked record: union with upstream, or stop syncing? (Proposal: union.)
