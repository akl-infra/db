# How the layout database works, and what formats it holds

*layoutdb · design round 2 · 2026-09-10*

One Cloudflare Worker over one D1 database. A layout can hold **several formats**, each its own row -- **spark** is the one every layout has today, which akl.gg and the bot both read and write. cmini is an import source: its layouts become spark rows the moment they arrive. **mana2** is derived from whichever one stored format reaches it (spark today), produced on request, never stored. Green is this design. Amber is planned or still open.

This is round 2, following a review of round 1. It differs from what is deployed on `ldb-v3`; the last section lists how.

**Dated note (2026-09-11, `21-formats.md` F1).** §6/§7 below describe the
one-time migration this design proposed (the `migrated` event kind, the
migrate tick, `core/follows.ts`'s legacy upstream fallback, keeping
`tag`/`blame`/`combos`/`link` in a `spark/1` `x.cmini` bag during the
transition) as a still-open plan. It ran, then F1 deleted the whole
mechanism -- there is no migrate tick, no `migrated` event, no `x` field
at all (D10), and no `x.cmini` (D5): `fromCmini` just drops those four
fields now, permanently. §3's formats table is current; §5's "migrate
tick" bullet and §6/§7's migration-plan rows are the historical record of
what got built and removed, not what exists today. `22-spark-spec.md` is
the current spec for `spark/1`.

**Dated note (2026-09-11, `21-formats.md` F2).** The single biggest change
since round 2 was written: **a layout is no longer "one record, one
payload."** `layouts` keeps name/owner/deletion and its own `layout_rev`;
a NEW table, `layout_formats`, holds one row per `(layout, lineage)` --
today always exactly one (`spark`), but the schema, the write model and
every route now support several at once, independently versioned, each
with its own `If-Match` scope. §1, §2, §4 and §5 below are updated in
place for this (each edit is called out where it lands); the new
"Adding a second format: layouts.wiki" section after §5 is F2's own
worked example of what a SECOND stored format actually looks like end to
end. `db/docs/adoption.md` is the up-to-date, machine-checked reference
for the wire shape; `21-formats.md` is the design source. §6/§7 below are
untouched by this note -- they were already the historical "ldb-v3 vs.
round 2" snapshot the F1 note above disclaims, and stay exactly that; treat
every `rev`/format claim in them (like every other pre-F1/F2 mention of a
bare `rev` or "the one stored format" outside the sections named above) as
what shipped THEN, never what the API does today.

## 1 · The system

<figure>
  <div class="frame">
    <svg viewBox="0 0 1000 640" role="img" aria-label="Clients on the left (akl.gg, the Discord bot, scripts) write spark to the akl-db Worker; the cmini upstream is polled and converted to spark on arrival. The Worker authenticates on two lanes, routes to the /v1 API, validates the named format on write and derives mana2 on read from whichever stored format reaches it, and writes to D1 (layouts plus one layout_formats row per format) and R2 on the right. One five-minute cron runs import, webhook delivery, the nightly dump, and the daily diff. Consumers along the bottom read the event log.">
      <defs>
        <marker id="ar" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="8" markerHeight="8" orient="auto-start-reverse">
          <path d="M0 0 L10 5 L0 10 z" fill="currentColor"/>
        </marker>
      </defs>

      <text class="s" x="20" y="24">CLIENTS</text>
      <rect class="box" x="20" y="36" width="230" height="52" rx="3"/>
      <text class="t" x="32" y="57">akl.gg</text>
      <text class="lbl" x="32" y="76">site, Pages proxy, sync script</text>

      <rect class="box" x="20" y="104" width="230" height="52" rx="3"/>
      <text class="t" x="32" y="125">Discord bot</text>
      <text class="lbl" x="32" y="144">Fly.io, same engine as the site</text>

      <rect class="box" x="20" y="172" width="230" height="52" rx="3"/>
      <text class="t" x="32" y="193">scripts, other clients</text>
      <text class="lbl" x="32" y="212">magic migration, anyone later</text>

      <rect class="ghost" x="20" y="290" width="230" height="52" rx="3"/>
      <text class="t" x="32" y="311">cmini upstream</text>
      <text class="lbl" x="32" y="330">import source, not a format</text>

      <path class="edge" d="M250 62 H330" marker-end="url(#ar)"/>
      <text class="lbl" x="290" y="54" text-anchor="middle">spark</text>
      <path class="edge" d="M250 130 H330" marker-end="url(#ar)"/>
      <text class="lbl" x="290" y="122" text-anchor="middle">spark</text>
      <path class="edge" d="M250 198 H330" marker-end="url(#ar)"/>
      <text class="lbl" x="290" y="190" text-anchor="middle">spark</text>
      <path class="edge faint" d="M250 316 H290 V478 H346" marker-end="url(#ar)"/>
      <text class="lbl" x="282" y="384" text-anchor="end">polled</text>
      <text class="lbl" x="282" y="400" text-anchor="end">every 5 min,</text>
      <text class="lbl" x="282" y="416" text-anchor="end">converted to</text>
      <text class="lbl" x="282" y="432" text-anchor="end">spark on arrival</text>

      <rect class="zone" x="330" y="36" width="380" height="530" rx="4"/>
      <text class="s" x="342" y="54">WORKER  akl-db</text>

      <rect class="box" x="346" y="64" width="348" height="52" rx="3"/>
      <text class="t" x="358" y="85">auth</text>
      <text class="lbl" x="358" y="104">Discord token, or Ed25519-signed request</text>

      <rect class="box" x="346" y="132" width="348" height="82" rx="3"/>
      <text class="t" x="358" y="153">/v1 routes</text>
      <text class="lbl" x="358" y="172">layouts · likes · authors · history</text>
      <text class="lbl" x="358" y="187">changes · stream · webhooks · dump</text>
      <text class="lbl" x="358" y="202">formats · meta · me · admin</text>

      <rect class="acc-fill" x="346" y="230" width="348" height="82" rx="3"/>
      <text class="t acc-text" x="358" y="251">format registry</text>
      <text class="lbl" x="358" y="270">validate the named format on write</text>
      <text class="lbl" x="358" y="285">?format=mana2/1 on read: derived, never stored</text>
      <text class="lbl" x="358" y="300">spark/1 → mana2/1 (one source lineage, MF-10)</text>

      <rect class="box" x="346" y="328" width="348" height="66" rx="3"/>
      <text class="t" x="358" y="349">write pipeline</text>
      <text class="lbl" x="358" y="368">actor → If-Match → validate →</text>
      <text class="lbl" x="358" y="383">one D1 batch, all or nothing</text>

      <rect class="box" x="346" y="410" width="348" height="140" rx="3"/>
      <text class="t" x="358" y="431">cron  */5 * * * *</text>
      <text class="lbl" x="358" y="452">every tick: cmini import → spark</text>
      <text class="lbl" x="358" y="467">every tick: webhook drain</text>
      <text class="lbl" x="358" y="482">03:00 UTC: nightly dump to R2</text>
      <text class="lbl" x="358" y="497">04:00 UTC: diff vs upstream, in spark</text>
      <text class="lbl prop-text" x="358" y="522">planned: migrate tick</text>
      <text class="lbl prop-text" x="358" y="537">(records below the latest spark major)</text>

      <path class="edge" d="M694 168 H770" marker-end="url(#ar)"/>
      <path class="edge" d="M770 184 H694" marker-end="url(#ar)"/>
      <text class="lbl" x="732" y="160" text-anchor="middle">SQL</text>
      <path class="edge faint" d="M694 482 H770" marker-end="url(#ar)"/>
      <text class="lbl" x="732" y="474" text-anchor="middle">writes</text>

      <text class="s" x="770" y="24">STORES</text>
      <rect class="store" x="770" y="36" width="210" height="220" rx="3"/>
      <text class="t" x="782" y="57">D1  akl-db</text>
      <text class="lbl" x="782" y="80">layouts · layout_formats</text>
      <text class="lbl" x="782" y="95">layout_revs · events</text>
      <text class="lbl" x="782" y="110">likes · authors</text>
      <text class="lbl" x="782" y="125">import_map · import_state</text>
      <text class="lbl" x="782" y="140">admins · clients · nonces</text>
      <text class="lbl" x="782" y="155">webhooks · auth_cache · ratelimit</text>
      <text class="s" x="782" y="181">spark is the one stored format</text>
      <text class="s" x="782" y="195">today -- a layout may hold several</text>
      <text class="s" x="782" y="209">layout = fold of its own events</text>
      <text class="s" x="782" y="223">each format keeps every rev</text>

      <rect class="store" x="770" y="440" width="210" height="96" rx="3"/>
      <text class="t" x="782" y="461">R2  akl-db-dumps</text>
      <text class="lbl" x="782" y="482">dump-YYYY-MM-DD.json.gz</text>
      <text class="lbl" x="782" y="497">latest.json + sha256</text>
      <text class="lbl prop-text" x="782" y="518">planned: one per spark major</text>

      <text class="s" x="20" y="596">CONSUMERS</text>
      <rect class="box" x="110" y="580" width="140" height="36" rx="3"/>
      <text x="180" y="603" text-anchor="middle">poll /v1/changes</text>
      <rect class="box" x="264" y="580" width="140" height="36" rx="3"/>
      <text x="334" y="603" text-anchor="middle">SSE stream</text>
      <rect class="box" x="418" y="580" width="140" height="36" rx="3"/>
      <text x="488" y="603" text-anchor="middle">webhook POSTs</text>
      <rect class="box" x="572" y="580" width="140" height="36" rx="3"/>
      <text x="642" y="603" text-anchor="middle">/v1/dump</text>
      <rect class="box" x="726" y="580" width="180" height="36" rx="3"/>
      <text x="816" y="603" text-anchor="middle">site sync, reads spark</text>
      <path class="edge faint" d="M520 566 V580" marker-end="url(#ar)"/>
      <text class="lbl" x="530" y="576">from the event log</text>
    </svg>
  </div>
  <figcaption>Every client writes spark today; a layout could hold a second stored format alongside it (see "Adding a second format" below), each its own independently-versioned row. The cmini import is one more writer that happens to convert before it writes. The registry has one job on the way in, validating whichever format a write names, and one on the way out, deriving mana2 from the one stored format registered to reach it.</figcaption>
</figure>

### Who writes what

- **The cmini import** converts each upstream layout to spark and writes it, marking the record `upstream: following`.
- **akl.gg** reads and writes spark. Its magic editor writes `PATCH {magic}`, which forks a following record like any other edit.
- **The bot** reads and writes spark: transforms are computed client-side then `PUT`, small edits are `PATCH` verbs.

### What is derived, never written directly

- `like_count`, `has_magic` and `upstream` are folded from the event log and stored on the row so they can be queried.
- The mana2 view is computed from spark on read.
- Names are lookup handles. The ULID is the only key anything else should keep.

## 2 · A record, and the log underneath it

<figure>
  <div class="frame">
    <svg viewBox="0 0 1040 320" role="img" aria-label="A write appends one event per scope it touches into the events table -- format null for a layout-scope write, a lineage for a format-scope write -- plus a shared layout_revs row keyed by the layout's own write counter n. A layout-scope event folds into the layouts row (name, owner, layout_rev, upstream); a format-scope event folds into a layout_formats row, one per lineage the layout has stored, each with its own rev. Likes move only like_count on layouts, with no rev bump.">
      <defs>
        <marker id="ar2" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="8" markerHeight="8" orient="auto-start-reverse">
          <path d="M0 0 L10 5 L0 10 z" fill="currentColor"/>
        </marker>
      </defs>

      <rect class="box" x="20" y="75" width="150" height="66" rx="3"/>
      <text class="t" x="32" y="97">accepted write</text>
      <text class="lbl" x="32" y="116">PUT PATCH POST</text>
      <text class="lbl" x="32" y="131">DELETE import</text>
      <path class="edge" d="M170 108 H230" marker-end="url(#ar2)"/>
      <text class="lbl" x="200" y="100" text-anchor="middle">1 batch</text>

      <rect class="store" x="230" y="20" width="250" height="190" rx="3"/>
      <text class="t" x="242" y="42">events</text>
      <text class="lbl" x="242" y="62">seq · kind · at · actor · via</text>
      <text class="lbl" x="242" y="77">format: null (layout scope)</text>
      <text class="lbl" x="242" y="92">or a lineage (format scope)</text>
      <text class="lbl" x="242" y="107">before / after (no payload)</text>
      <text class="lbl" x="242" y="122">rev-bumping · like · info</text>
      <text class="s" x="242" y="145">the truth; served from seq 1</text>
      <text class="s" x="242" y="160">create/import: 2 events, 1 batch</text>

      <rect class="store" x="230" y="225" width="250" height="60" rx="3"/>
      <text class="t" x="242" y="247">likes</text>
      <text class="lbl" x="242" y="265">(layout_id, user_id)</text>
      <text class="s" x="242" y="280">±1 like_count, no rev bump</text>

      <path class="edge" d="M480 55 H560" marker-end="url(#ar2)"/>
      <text class="lbl" x="515" y="47" text-anchor="middle">n + 1</text>
      <rect class="store" x="560" y="20" width="220" height="95" rx="3"/>
      <text class="t" x="572" y="42">layout_revs</text>
      <text class="lbl" x="572" y="62">(layout_id, n) PK</text>
      <text class="lbl" x="572" y="77">lineage · rev · payload_json</text>
      <text class="s" x="572" y="92">lineage=null: layout scope</text>

      <text class="lbl" x="800" y="42">GET .../rev/n?format=F</text>
      <text class="lbl" x="800" y="57">= revs row ⊕ after</text>

      <path class="edge" d="M480 175 H560" marker-end="url(#ar2)"/>
      <text class="lbl" x="515" y="167" text-anchor="middle">fold: layout</text>
      <rect class="store" x="560" y="130" width="220" height="90" rx="3"/>
      <text class="t" x="572" y="152">layouts</text>
      <text class="lbl" x="572" y="172">id · name · owner</text>
      <text class="lbl" x="572" y="187">layout_rev · deleted</text>
      <text class="lbl acc-text" x="572" y="202">like_count · upstream</text>

      <path class="edge faint" d="M480 255 H520 V202 H560" marker-end="url(#ar2)"/>
      <text class="lbl" x="490" y="232" text-anchor="middle">±1</text>

      <path class="edge" d="M480 195 H540 V277 H560" marker-end="url(#ar2)"/>
      <text class="lbl" x="530" y="240" text-anchor="end">fold:</text>
      <text class="lbl" x="530" y="255" text-anchor="end">format scope</text>
      <rect class="store" x="560" y="235" width="220" height="85" rx="3"/>
      <text class="t" x="572" y="257">layout_formats</text>
      <text class="lbl" x="572" y="277">(layout_id, lineage) PK</text>
      <text class="lbl" x="572" y="292">format · rev · has_magic</text>
      <text class="s" x="572" y="310">MF-1: independent per format</text>
    </svg>
  </div>
  <figcaption>Two independent write scopes, one shared batch. A layout-scope write (rename, transfer, delete) folds into `layouts` and bumps `layout_rev`; a format-scope write (a payload edit) folds into that lineage's own `layout_formats` row and bumps that format's own `rev`, leaving every other format untouched. `layout_revs` is the one shared payload archive for both scopes, keyed by the layout's own write counter `n`. Likes and informational events touch no rev at all.</figcaption>
</figure>

The record header is now split across two scopes. `layouts` keeps name, owner, deletion and `upstream` (layout-level); `layout_formats` has one row per format the layout actually stores, each with its own rev and timestamps -- the addition in this round. A detail read (`GET .../{ref}?format=F`) returns both: the layout's own fields, a `formats` map listing every format it has, and the ONE format's payload you asked for.

```json
{
  "id": "01J7Q9Z3M4K2R6X8V0B1N5C7D9",   // ULID, never changes; the key to store
  "name": "hours",                      // unique, case-insensitive; reclaimable after delete
  "owner": "383900587877597186",        // Discord user id
  "layout_rev": 3,                      // bumps on rename/transfer/delete/restore only
  "created_at": "2026-06-25T00:00:03Z",
  "modified_at": "2026-09-08T19:40:11Z",
  "deleted": false,
  "like_count": 7,                      // derived
  "upstream": { "source": "cmini", "id": "hours", "state": "following" },  // null if never imported
  "formats": {
    "spark/1": { "rev": 7, "created_at": "…", "modified_at": "…", "has_magic": true, "source": { … } }
  },
  "format": "spark/1",                  // the one you asked for -- ?format= is required, no default
  "payload": { … }
}
```

Deleting frees the name (a layout-scope write; every stored format's own row is simply untouched). A later `POST` under the same name is a new record with a new id, and it inherits the tombstone's likes. The tombstone stays restorable by its owner with no time limit. Tombstones are already kept forever, since the nightly job never prunes them, so this costs no storage that is not already being spent. It can be revisited if storage ever becomes a problem.

### Forking from cmini

<figure>
  <div class="frame">
    <svg viewBox="0 0 900 240" role="img" aria-label="An imported record starts following. Import updates keep it following. Any user write, magic edits included, moves it to forked, one way. While following, an upstream delete tombstones it; once forked, upstream changes and deletes are only logged. A record created on akl.gg or by the bot has upstream null and never enters this machine.">
      <defs>
        <marker id="ar5" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="8" markerHeight="8" orient="auto-start-reverse">
          <path d="M0 0 L10 5 L0 10 z" fill="currentColor"/>
        </marker>
      </defs>
      <rect class="ghost" x="20" y="80" width="150" height="44" rx="3"/>
      <text x="95" y="107" text-anchor="middle">first import</text>
      <path class="edge" d="M170 102 H250" marker-end="url(#ar5)"/>

      <rect class="acc-fill" x="250" y="80" width="170" height="44" rx="3"/>
      <text class="t acc-text" x="335" y="107" text-anchor="middle">following</text>
      <path class="edge" d="M300 80 C300 36, 370 36, 370 80" marker-end="url(#ar5)"/>
      <text class="lbl" x="335" y="30" text-anchor="middle">import update</text>

      <path class="edge" d="M420 102 H580" marker-end="url(#ar5)"/>
      <text class="lbl" x="500" y="94" text-anchor="middle">any user write</text>
      <text class="s" x="500" y="120" text-anchor="middle">magic included</text>

      <rect class="box" x="580" y="80" width="170" height="44" rx="3"/>
      <text class="t" x="665" y="107" text-anchor="middle">forked</text>
      <path class="edge faint" d="M630 80 C630 36, 700 36, 700 80" marker-end="url(#ar5)"/>
      <text class="lbl" x="665" y="30" text-anchor="middle">upstream change: logged only</text>

      <path class="edge" d="M335 124 V180" marker-end="url(#ar5)"/>
      <text class="lbl" x="345" y="156">upstream deletes</text>
      <rect class="box" x="250" y="180" width="170" height="40" rx="3"/>
      <text x="335" y="205" text-anchor="middle">tombstoned</text>

      <rect class="ghost" x="580" y="180" width="300" height="40" rx="3"/>
      <text x="730" y="205" text-anchor="middle">native record: upstream is null</text>
    </svg>
  </div>
  <figcaption>While a record follows, the importer owns its keys and board and rewrites them from each upstream change, carrying the record's own magic forward. The first write by a user, a magic edit included, flips it to forked for good. From then on the importer only logs what upstream did.</figcaption>
</figure>

This tightens the rule the branch runs today, which lets magic-only edits keep a record following. Here a magic edit forks like any other, so a record either mirrors its cmini author exactly or belongs to its owner. Only system writes never fork: the import itself and one-time migrations. The other change is that the result is a field on the record, folded like `like_count`, so the site, the bot, and queries can all see it without replaying history. Because every imported layout is converted to spark before it is stored, this field is the only lasting trace that a record came from cmini at all. It is also transitional: following and forked only mean anything while the cmini import runs. layoutdb has no general fork concept, and when the import is retired the field is retired with it.

## 3 · The formats

| format | role | what it is | who uses it | lost converting to mana2 |
|---|---|---|---|---|
| `spark/1` | stored | today's `akl/1`, renamed. A `keys` map with row, col and finger per character, `free` positions, a `board` object (rowstag, colstag or ortho with stagger amounts), and `magic` as intent (magic keys, chiral keys, adaptive swaps, raw rules). No free-form `x` field (`21-formats.md` D10 removed it: no format writes one and nothing reads one back) | akl.gg, the bot, the cmini import; every record | magic intent becomes flat rules; the either-thumb finger; an ortho board declared as ortho |
| `mana2/1` | lowered | a mana2 `.jsonc` layout: `layout.fingers` and `thumbs` row strings, stagger geometry, finger digits, flat `magic.rules` | anything that computes stats, through `?as=mana2/1`; never stored, never written | — |
| cmini v3 | import only | not a format, and not readable back out either (`21-formats.md` D5 deleted `toCmini` and the `?as=cmini/1` read path entirely). The importer converts each upstream detail to `spark/1` and drops the four fields spark has no place for (`tag`, `blame`, `combos`, `link`) permanently -- there is no `x` left to keep them in | the importer | — |
| `spark/2` | future | the first breaking change, whenever it comes; the standing candidate is per-key alt fingerings from #148 | — | — |

<figure>
  <div class="frame">
    <svg viewBox="0 0 900 260" role="img" aria-label="cmini v3 on the left is an import source, converted one way into spark/1 by an adapter. spark/1 is stored and translates on read to mana2/1, which is where magic intent becomes flat rules. Above spark/1, a planned chain of spark/2 and spark/3 joined by single-step up and down converters.">
      <defs>
        <marker id="ar3" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="8" markerHeight="8" orient="auto-start-reverse">
          <path d="M0 0 L10 5 L0 10 z" fill="currentColor"/>
        </marker>
        <marker id="ar3p" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="8" markerHeight="8" orient="auto-start-reverse">
          <path d="M0 0 L10 5 L0 10 z" fill="var(--warn)"/>
        </marker>
      </defs>

      <rect class="ghost" x="30" y="176" width="190" height="52" rx="3"/>
      <text class="t" x="125" y="199" text-anchor="middle">cmini v3</text>
      <text class="s" x="125" y="216" text-anchor="middle">import source</text>

      <path class="edge" d="M220 202 H360" marker-end="url(#ar3)"/>
      <text class="lbl" x="290" y="194" text-anchor="middle">adapter</text>
      <text class="s" x="290" y="222" text-anchor="middle">one way, on import</text>

      <rect class="acc-fill" x="360" y="176" width="160" height="52" rx="3"/>
      <text class="t acc-text" x="440" y="199" text-anchor="middle">spark/1</text>
      <text class="s" x="440" y="216" text-anchor="middle">stored</text>

      <path class="edge" d="M520 202 H700" marker-end="url(#ar3)"/>
      <text class="lbl" x="610" y="194" text-anchor="middle">?as=mana2/1</text>
      <text class="s" x="610" y="222" text-anchor="middle">intent → flat rules</text>

      <rect class="box" x="700" y="176" width="170" height="52" rx="3"/>
      <text class="t" x="785" y="199" text-anchor="middle">mana2/1</text>
      <text class="s" x="785" y="216" text-anchor="middle">analyzer input</text>

      <rect class="prop-fill" x="360" y="100" width="160" height="44" rx="3"/>
      <text class="t prop-text" x="440" y="127" text-anchor="middle">spark/2</text>
      <rect class="prop-fill" x="360" y="30" width="160" height="44" rx="3"/>
      <text class="t prop-text" x="440" y="57" text-anchor="middle">spark/3</text>

      <path class="edge prop" d="M420 176 V144" marker-end="url(#ar3p)"/>
      <path class="edge prop" d="M460 144 V176" marker-end="url(#ar3p)"/>
      <text class="lbl prop-text" x="530" y="156">up_2</text>
      <text class="lbl prop-text" x="530" y="170">down_2 or held</text>
      <path class="edge prop" d="M420 100 V74" marker-end="url(#ar3p)"/>
      <path class="edge prop" d="M460 74 V100" marker-end="url(#ar3p)"/>
      <text class="lbl prop-text" x="530" y="82">up_3</text>
      <text class="lbl prop-text" x="530" y="96">down_3 or held</text>
      <text class="s" x="346" y="52" text-anchor="end">records live at the</text>
      <text class="s" x="346" y="66" text-anchor="end">latest major</text>
      <text class="s" x="346" y="122" text-anchor="end">the latest major owns</text>
      <text class="s" x="346" y="136" text-anchor="end">the edge to mana2</text>
    </svg>
  </div>
  <figcaption>Two formats, one direction of travel. cmini arrives and becomes spark. Spark leaves as mana2 when something needs to analyze it. The spark chain above is the upcast plan: each new major ships one step up and one step down, and whichever major is latest owns the edge to mana2.</figcaption>
</figure>

A format is a directory under `db/formats/<name>/<major>/`: a JSON Schema, a module exporting `validate`, `hasMagic`, `edits` for the PATCH verbs, and its translations; frozen fixtures with a golden per translation; an OWNERS file. A merged major is immutable. Within a major, changes are additive and optional. The server refuses a write in any format it does not store, so every record is always readable.

**Getting to the analyzer.** There is no general lowering step anymore. Lowering is an analyzer's problem, and analyzers need not share capabilities or shapes, so the DB does not host a canonical flat form. The one conversion that matters is `spark → mana2`, because mana2 is the only analyzer behind anything today. That translation is where magic intent becomes mana2's flat rules. What the DB does guarantee is that spark stays lowerable: every valid spark payload must translate to mana2, and spark refuses two magic rules that fire on the same input, because mana2 would silently keep the last one.

### Decided: mana2 is the lowered format

mana2 is produced from spark on read and never stored. A write in mana2 is refused.

<figure>
  <div class="frame">
    <svg viewBox="0 0 440 210" role="img" aria-label="Option A: writers send spark; spark is stored; mana2 is produced on read. A write in mana2 is refused, whether or not the layout has other stored formats besides spark.">
      <defs>
        <marker id="ar6" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="8" markerHeight="8" orient="auto-start-reverse">
          <path d="M0 0 L10 5 L0 10 z" fill="currentColor"/>
        </marker>
      </defs>
      <text class="s" x="16" y="22">A · MANA2 IS THE LOWERED FORMAT</text>
      <rect class="box" x="16" y="60" width="100" height="40" rx="3"/>
      <text x="66" y="85" text-anchor="middle">writers</text>
      <path class="edge" d="M116 80 H170" marker-end="url(#ar6)"/>
      <text class="lbl" x="143" y="72" text-anchor="middle">spark</text>
      <rect class="acc-fill" x="170" y="56" width="110" height="48" rx="3"/>
      <text class="t acc-text" x="225" y="77" text-anchor="middle">spark/1</text>
      <text class="s" x="225" y="94" text-anchor="middle">a stored format</text>
      <path class="edge" d="M280 80 H330" marker-end="url(#ar6)"/>
      <text class="lbl" x="305" y="72" text-anchor="middle">read</text>
      <rect class="box" x="330" y="60" width="96" height="40" rx="3"/>
      <text x="378" y="85" text-anchor="middle">mana2/1</text>
      <rect class="ghost" x="330" y="140" width="96" height="40" rx="3"/>
      <text x="378" y="165" text-anchor="middle">PUT mana2</text>
      <path class="edge faint" d="M330 160 H240 V104" marker-end="url(#ar6)"/>
      <text class="lbl" x="250" y="152">refused</text>
      <text class="s" x="16" y="202">mana2 is never held, never a write target</text>
    </svg>
  </div>
  <figcaption><span class="rec">Decided 2026-09-10.</span> mana2 stays derived-only, so it is never a write target and a read of it is never held. This is a decision about mana2 SPECIFICALLY, not a claim that spark is the only format a layout may ever store -- `21-formats.md` (F2) later lets a layout hold a second STORED format alongside spark (see "Adding a second format" below); that second format still can't be mana2. If mana2 wants to write later, a mana2 input adapter converts to spark on the way in, exactly like the cmini import.</figcaption>
</figure>

Not chosen: storing mana2 as a second format. It would bring back held reads, a visibility check on cross-format writes, and records the site could only show partially, because mana2 loses magic idioms and the either-thumb finger on the way to spark.

## 4 · A read and a write, end to end

<figure>
  <div class="frame">
    <svg viewBox="0 0 1010 270" role="img" aria-label="Read path: GET with the required format parameter translates the requested lineage's stored payload to the requested format and returns it, or 409 held, or 404 format_absent if the layout never stored that lineage at all. Write path: auth, a scoped If-Match naming the layout or a lineage, validate the spark major sent, a visibility check that refuses an older major overwriting content it cannot see, chaining to the latest major, validate again, one batch commit touching only that scope, then the feed and webhooks.">
      <defs>
        <marker id="ar4" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="8" markerHeight="8" orient="auto-start-reverse">
          <path d="M0 0 L10 5 L0 10 z" fill="currentColor"/>
        </marker>
      </defs>
      <text class="s" x="20" y="24">READ   GET /v1/layouts/{ref}?format=F     REQUIRED, no default -- F = a stored major or mana2/1</text>
      <rect class="box" x="20" y="36" width="120" height="40" rx="3"/>
      <text x="80" y="61" text-anchor="middle">load layout</text>
      <path class="edge" d="M140 56 H180" marker-end="url(#ar4)"/>
      <rect class="acc-fill" x="180" y="36" width="210" height="40" rx="3"/>
      <text class="acc-text" x="285" y="61" text-anchor="middle">translate its lineage → F</text>
      <path class="edge" d="M390 56 H430" marker-end="url(#ar4)"/>
      <rect class="box" x="430" y="36" width="130" height="40" rx="3"/>
      <text x="495" y="61" text-anchor="middle">200 payload</text>
      <path class="edge faint" d="M285 76 V108 H430" marker-end="url(#ar4)"/>
      <rect class="box" x="430" y="92" width="130" height="32" rx="3"/>
      <text x="495" y="113" text-anchor="middle">409 held</text>
      <path class="edge faint" d="M285 76 V138 H430" marker-end="url(#ar4)"/>
      <rect class="box" x="430" y="128" width="150" height="30" rx="3"/>
      <text x="505" y="148" text-anchor="middle">404 format_absent</text>
      <text class="s" x="600" y="52">held: this lineage exists but an</text>
      <text class="s" x="600" y="67">older major can't show it; absent:</text>
      <text class="s" x="600" y="82">the layout never stored F at all;</text>
      <text class="s" x="600" y="97">mana2 is derived, never held or absent</text>
      <text class="s" x="600" y="112">once its one source lineage exists</text>

      <text class="s" x="20" y="180">WRITE  PUT /v1/layouts/{ref}  {format: spark/N, payload}  If-Match: "spark:&lt;rev&gt;"</text>
      <rect class="box" x="20" y="192" width="70" height="44" rx="3"/>
      <text x="55" y="219" text-anchor="middle">actor</text>
      <path class="edge" d="M90 214 H106" marker-end="url(#ar4)"/>
      <rect class="box" x="106" y="192" width="110" height="44" rx="3"/>
      <text x="161" y="213" text-anchor="middle">If-Match</text>
      <text class="s" x="161" y="228" text-anchor="middle">scoped to lineage</text>
      <path class="edge" d="M216 214 H232" marker-end="url(#ar4)"/>
      <rect class="box" x="232" y="192" width="106" height="44" rx="3"/>
      <text x="285" y="219" text-anchor="middle">validate N</text>
      <path class="edge" d="M338 214 H354" marker-end="url(#ar4)"/>
      <rect class="box" x="354" y="192" width="150" height="44" rx="3"/>
      <text x="429" y="210" text-anchor="middle">visible in N?</text>
      <text class="s" x="429" y="226" text-anchor="middle">no → 409 format_behind</text>
      <path class="edge" d="M504 214 H520" marker-end="url(#ar4)"/>
      <rect class="box" x="520" y="192" width="140" height="44" rx="3"/>
      <text x="590" y="210" text-anchor="middle">chain N → latest</text>
      <text class="s" x="590" y="226" text-anchor="middle">written_as: spark/N</text>
      <path class="edge" d="M660 214 H676" marker-end="url(#ar4)"/>
      <rect class="box" x="676" y="192" width="130" height="44" rx="3"/>
      <text x="741" y="219" text-anchor="middle">validate latest</text>
      <path class="edge" d="M806 214 H822" marker-end="url(#ar4)"/>
      <rect class="box" x="822" y="192" width="80" height="44" rx="3"/>
      <text x="862" y="219" text-anchor="middle">commit</text>
      <text class="s" x="862" y="232" text-anchor="middle">this lineage only</text>
      <path class="edge" d="M902 214 H918" marker-end="url(#ar4)"/>
      <rect class="box" x="918" y="192" width="80" height="44" rx="3"/>
      <text x="958" y="210" text-anchor="middle">feed</text>
      <text class="s" x="958" y="226" text-anchor="middle">webhooks</text>
      <text class="s" x="20" y="252">"visible in N?"/chain/written_as only run once a lineage has a second major; with only spark/1 today, N is always latest</text>
    </svg>
  </div>
  <figcaption>Reads translate the requested lineage's own row. Writes touch exactly one scope -- the layout, or one lineage's own format row -- named by a scoped If-Match token. "PUT ... If-None-Match: *" (not drawn) adds a lineage the layout doesn't have yet instead of replacing one it does; a name-vs-format PATCH mix is refused outright (400 mixed_patch) before any of this runs.</figcaption>
</figure>

## 5 · What this design adds, as invariants

**Restated by `21-formats.md` F2 (several formats per layout):** the
one-format framing below is F1's world. F2 replaces the first bullet with
several narrower ones (`design/layout-db/21-formats.md` §4 has the full
list, `db/INVARIANTS.md` the live, code-checked registry -- every id
below is a real row there, `LDB-T1` fails the build if it isn't):

- **Format independence (`MF-1`).** A write to one format never changes another format's payload, rev or timestamps; a layout-level write changes no format row at all. Checked by one shared `fast-check` write model: every row outside a step's own scope is byte-equal before and after it.
- **At least one format, always (`MF-5`).** Every layout has at least one `layout_formats` row -- creation always takes one, and nothing in this slice removes one.
- **Explicit format, no default (`MF-4`).** Every route that returns or changes a payload answers `400 format_required` without one. Checked by a generated matrix over every such route.
- **Scoped concurrency (`MF-6`/`MF-11`).** Two writers on the SAME scope with the same `If-Match` -- exactly one lands, the other gets `409 stale`. Writers on DIFFERENT scopes of one layout never block each other and both land. A write naming the wrong scope's token, or an unscoped one, is refused before any read.
- **Derived formats are never stored (`MF-7`), unambiguously (`MF-10`).** A `?format=mana2/1` read never writes and names `derived_from`; each output format is reachable from exactly one stored lineage, checked at the registry level.
- **Spark stays lowerable.** Every valid spark payload translates to `mana2/1`. Checked over every fixture and over random single-field mutations of them.
- **No silent last-wins.** Two magic rules that fire on the same input are refused at write, with both sources named.
- **The cmini adapter is exact.** Converting a following record's upstream detail again reproduces its payload, magic aside. Checked per PR on fixtures and daily against the live set.
- **Follow state is layout-level (`MF-12`).** A layout follows until the first write to the layout itself or to lineage `spark` by a user, magic edits included; a write to any OTHER format never touches it. System writes (the import) never fork. Forked never returns to following. The importer never writes a forked layout. Checked by replaying random event sequences across both scopes.
- **The dump floor never regresses (`MF-13`).** Every table in a nightly dump is at or past the dump's own `meta.seq` -- enforced by reading `meta` strictly before any table, never alongside it.

Ids get assigned when the design docs are amended. Each replaces or narrows an existing one: the cmini round-trip and cmini-envelope invariants, the lift invariant, and the follows-upstream rule.

## Adding a second format: layouts.wiki

Everything above this line describes what shipped with `spark/1` as the only stored format. This section is F2's own worked example of the thing the schema was actually built to support: a SECOND stored format, registered alongside spark, on the SAME layouts. The running example is a future `lw/1` for layouts.wiki -- a hypothetical richer authoring shape that wants to live on a layout without going through spark at all.

<figure>
  <div class="frame">
    <svg viewBox="0 0 900 320" role="img" aria-label="One layout carries shared layout-level fields (name, owner, layout_rev, upstream) plus two independent stored-format rows: spark/1 at its own rev 7, and a hypothetical lw/1 at its own rev 1. Each format row has its own If-Match token and its own timestamps; neither format's row is affected by a write to the other. Below, one events table interleaves layout-scope and format-scope events under one shared seq counter.">
      <defs>
        <marker id="ar7" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="8" markerHeight="8" orient="auto-start-reverse">
          <path d="M0 0 L10 5 L0 10 z" fill="currentColor"/>
        </marker>
      </defs>

      <rect class="zone" x="20" y="30" width="250" height="200" rx="4"/>
      <text class="s" x="32" y="48">LAYOUT (shared, layout scope)</text>
      <rect class="box" x="32" y="60" width="226" height="88" rx="3"/>
      <text class="t" x="44" y="82">"hours"</text>
      <text class="lbl" x="44" y="101">owner · layout_rev: 4</text>
      <text class="lbl" x="44" y="116">upstream · deleted: false</text>
      <text class="s" x="32" y="170">If-Match: "layout:4"</text>
      <text class="s" x="32" y="188">renames/deletes/transfers</text>
      <text class="s" x="32" y="206">this scope only</text>

      <path class="edge" d="M270 90 H330" marker-end="url(#ar7)"/>
      <rect class="store" x="330" y="40" width="250" height="80" rx="3"/>
      <text class="t" x="342" y="62">layout_formats: spark</text>
      <text class="lbl" x="342" y="82">rev 7 · has_magic: true</text>
      <text class="s" x="342" y="102">If-Match: "spark:7"</text>

      <path class="edge" d="M270 170 H330" marker-end="url(#ar7)"/>
      <rect class="store" x="330" y="150" width="250" height="80" rx="3"/>
      <text class="t" x="342" y="172">layout_formats: lw</text>
      <text class="lbl" x="342" y="192">rev 1 · has_magic: false</text>
      <text class="s" x="342" y="212">If-Match: "lw:1"</text>

      <text class="s" x="620" y="72">MF-1: a write to spark:7 never touches</text>
      <text class="s" x="620" y="87">lw's rev, payload or timestamps, and</text>
      <text class="s" x="620" y="102">vice versa -- byte-equal, checked by</text>
      <text class="s" x="620" y="117">the shared fast-check write model</text>
      <text class="s" x="620" y="145">both rows are listed in the SAME</text>
      <text class="s" x="620" y="160">layout's `formats` map on every read</text>

      <text class="s" x="20" y="252">EVENTS (one seq counter, interleaved across both scopes)</text>
      <rect class="store" x="20" y="262" width="860" height="46" rx="3"/>
      <text class="lbl" x="35" y="283">seq 40 renamed</text>
      <text class="s" x="35" y="298">format: null (layout)</text>
      <text class="lbl" x="250" y="283">seq 41 updated</text>
      <text class="s" x="250" y="298">format: "spark/1"</text>
      <text class="lbl" x="480" y="283">seq 42 format_added</text>
      <text class="s" x="480" y="298">format: "lw/1"</text>
      <text class="s" x="700" y="283">one shared feed --</text>
      <text class="s" x="700" y="298">every reader filters by `format`</text>
    </svg>
  </div>
  <figcaption>One layout, two independently-versioned stored formats. `layout_rev` moves only on a layout-scope write; `spark/1`'s and `lw/1`'s own `rev`s move only on a write to THAT format. Each has its own `If-Match` scope -- writing one can never race, or be mistaken for, a write to the other. The event log is still ONE feed, ONE `seq` counter, shared by every scope -- a client that only cares about one format (the bot, below) filters by the event's own `format` field rather than following a separate stream per format.</figcaption>
</figure>

<figure>
  <div class="frame">
    <svg viewBox="0 0 940 320" role="img" aria-label="Who reads and writes what: the spark bot and akl.gg both read and write spark/1 only; layouts.wiki reads and writes lw/1, and may also read spark/1 if it wants (never write it); the cmini importer writes spark/1 only, never lw/1; mana2/1 is derived from spark/1 on read, with no writer at all; layouts.wiki's own keymaxx IR is a client-side lowering of lw/1, entirely outside layoutdb, the same shape mana2/1 is for spark.">
      <defs>
        <marker id="ar10" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="8" markerHeight="8" orient="auto-start-reverse">
          <path d="M0 0 L10 5 L0 10 z" fill="currentColor"/>
        </marker>
      </defs>

      <text class="s" x="20" y="16">CLIENTS</text>
      <rect class="box" x="20" y="26" width="180" height="46" rx="3"/>
      <text class="t" x="32" y="46">spark bot</text>
      <text class="s" x="32" y="62">reads spark/1 only</text>

      <rect class="box" x="20" y="86" width="180" height="46" rx="3"/>
      <text class="t" x="32" y="106">akl.gg</text>
      <text class="s" x="32" y="122">reads + writes spark/1</text>

      <rect class="box" x="20" y="146" width="180" height="46" rx="3"/>
      <text class="t" x="32" y="166">layouts.wiki</text>
      <text class="s" x="32" y="182">reads + writes lw/1</text>

      <rect class="box" x="20" y="206" width="180" height="46" rx="3"/>
      <text class="t" x="32" y="226">cmini importer</text>
      <text class="s" x="32" y="242">writes spark/1 only</text>

      <text class="s" x="380" y="16">STORED</text>
      <rect class="acc-fill" x="380" y="26" width="140" height="46" rx="3"/>
      <text class="t acc-text" x="392" y="54" text-anchor="start">spark/1</text>

      <rect class="box" x="380" y="146" width="140" height="46" rx="3"/>
      <text class="t" x="392" y="174" text-anchor="start">lw/1</text>

      <text class="s" x="620" y="16">DERIVED (no writer)</text>
      <rect class="acc-fill" x="620" y="26" width="140" height="46" rx="3"/>
      <text class="t acc-text" x="632" y="54" text-anchor="start">mana2/1</text>

      <rect class="ghost" x="620" y="146" width="300" height="70" rx="3"/>
      <text class="t" x="632" y="168">keymaxx IR</text>
      <text class="s" x="632" y="186">layouts.wiki's OWN lowering of lw/1</text>
      <text class="s" x="632" y="201">outside layoutdb entirely -- not a format</text>

      <path class="edge" d="M200 49 H380" marker-end="url(#ar10)"/>
      <path class="edge" d="M200 109 H380" marker-end="url(#ar10)"/>
      <path class="edge" d="M200 229 H380" marker-end="url(#ar10)"/>
      <path class="edge" d="M200 169 H380" marker-end="url(#ar10)"/>
      <path class="edge faint" d="M200 160 C280 60, 320 49, 380 49" marker-end="url(#ar10)"/>
      <text class="s" x="220" y="90" text-anchor="middle">read spark/1 too,</text>
      <text class="s" x="220" y="105" text-anchor="middle">if it wants (never write it)</text>

      <path class="edge" d="M520 49 H620" marker-end="url(#ar10)"/>
      <text class="lbl" x="570" y="41" text-anchor="middle">derive</text>

      <path class="edge faint" d="M520 169 H620" stroke-dasharray="4 4"/>
      <text class="s" x="570" y="90" text-anchor="middle">client-side lowering</text>
      <text class="s" x="570" y="105" text-anchor="middle">(no edge in the registry)</text>
    </svg>
  </div>
  <figcaption>Who reads and writes what, once `lw/1` exists: the bot and akl.gg stay spark-only; layouts.wiki owns `lw/1` and may read `spark/1` too if it wants (never write it -- writing a format you don't own the concept of is a client-side choice this diagram doesn't forbid, but nothing here does it for you); the cmini importer never learns `lw/1` exists. `mana2/1` keeps deriving from `spark/1` alone (MF-10, next figure). `keymaxx IR` is layouts.wiki's OWN lowering of its OWN format -- the exact role `?format=mana2/1` plays for spark, but entirely outside layoutdb, never a registered edge.</figcaption>
</figure>

<figure>
  <div class="frame">
    <svg viewBox="0 0 1000 240" role="img" aria-label="A write, end to end: layouts.wiki PUTs lw/1 with If-Match colon lw:2, the format registry validates it with the lw/1 module, commit writes one layout_revs row and one event naming format lw/1, then the feed and webhooks fire. Below, the spark bot receives the same event over the feed, checks its format field, sees lw rather than spark, and ignores it -- its cache stays exactly as it was.">
      <defs>
        <marker id="ar11" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="8" markerHeight="8" orient="auto-start-reverse">
          <path d="M0 0 L10 5 L0 10 z" fill="currentColor"/>
        </marker>
      </defs>

      <rect class="box" x="20" y="30" width="120" height="50" rx="3"/>
      <text class="t" x="32" y="51" text-anchor="start">layouts.wiki</text>
      <text class="s" x="32" y="67">PUT lw/1</text>
      <path class="edge" d="M140 55 H190" marker-end="url(#ar11)"/>
      <text class="lbl" x="165" y="47" text-anchor="middle">If-Match:</text>
      <text class="lbl" x="165" y="72" text-anchor="middle">"lw:2"</text>

      <rect class="acc-fill" x="190" y="30" width="140" height="50" rx="3"/>
      <text class="t acc-text" x="202" y="51">validate</text>
      <text class="s acc-text" x="202" y="67">lw/1 module</text>
      <path class="edge" d="M330 55 H380" marker-end="url(#ar11)"/>

      <rect class="box" x="380" y="30" width="190" height="50" rx="3"/>
      <text class="t" x="392" y="51">commit (1 batch)</text>
      <text class="s" x="392" y="67">layout_revs(lw) + event</text>
      <path class="edge" d="M570 55 H610" marker-end="url(#ar11)"/>

      <rect class="box" x="610" y="30" width="80" height="50" rx="3"/>
      <text x="650" y="59" text-anchor="middle">feed</text>
      <path class="edge" d="M690 55 H730" marker-end="url(#ar11)"/>
      <rect class="box" x="730" y="30" width="110" height="50" rx="3"/>
      <text x="785" y="59" text-anchor="middle">webhooks</text>

      <text class="s" x="880" y="45">event: seq N,</text>
      <text class="s" x="880" y="60">format: "lw/1",</text>
      <text class="s" x="880" y="75">rev: 2</text>

      <path class="edge faint" d="M650 80 V150" marker-end="url(#ar11)"/>
      <text class="s" x="660" y="115">every reader on the feed</text>
      <text class="s" x="660" y="130">sees this same event</text>

      <rect class="box" x="560" y="160" width="150" height="50" rx="3"/>
      <text class="t" x="572" y="181">spark bot</text>
      <text class="s" x="572" y="197">reads the event's `format`</text>
      <path class="edge" d="M710 185 H750" marker-end="url(#ar11)"/>

      <rect class="ghost" x="750" y="160" width="220" height="50" rx="3"/>
      <text class="t" x="762" y="181">"lw/1" != "spark" -> ignored</text>
      <text class="s" x="762" y="197">cache untouched, no re-fetch</text>
    </svg>
  </div>
  <figcaption>One write, one batch, one event -- the SAME feed every client already polls. `format: "lw/1"` is the whole signal a reader needs: the bot's own cache logic already only applies rev-bumping events for the ONE lineage it reads (`spark`, MF-8, the bot's own job), so an `lw/1` event costs it nothing beyond noticing the field and moving past it.</figcaption>
</figure>

**`mana2/1` still comes from `spark/1` alone -- adding `lw/1` doesn't change that.** Each output format is reachable from exactly one stored lineage (`MF-10`): `spark/1 → mana2/1` is the one registered edge, and it stays the one registered edge no matter how many other stored formats a layout grows. `lw/1` wanting its own bridge to `spark/1` (say, so a layouts.wiki editor can also show a layout as spark) is a package function ITS OWN client calls -- `@akl/layout-formats`'s exported converters -- never something `GET /v1/layouts/{ref}?format=` serves on the server's own initiative.

<figure>
  <div class="frame">
    <svg viewBox="0 0 900 230" role="img" aria-label="spark/1 has a registered edge to mana2/1, drawn solid: GET format equals mana2/1 derives from spark. lw/1 has no such edge -- drawn as a blocked, dashed line with no arrowhead -- so asking for mana2/1 on a layout that only has lw/1 answers 404 format_absent, never a silent derivation from the wrong lineage. A separate ghost box shows lw/1 to spark/1 as a client-side package function, not served by layoutdb.">
      <defs>
        <marker id="ar9" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="8" markerHeight="8" orient="auto-start-reverse">
          <path d="M0 0 L10 5 L0 10 z" fill="currentColor"/>
        </marker>
      </defs>

      <rect class="acc-fill" x="20" y="30" width="150" height="50" rx="3"/>
      <text class="t acc-text" x="95" y="60" text-anchor="middle">spark/1</text>
      <path class="edge" d="M170 55 H330" marker-end="url(#ar9)"/>
      <text class="lbl" x="250" y="47" text-anchor="middle">registered edge</text>
      <rect class="acc-fill" x="330" y="30" width="150" height="50" rx="3"/>
      <text class="t acc-text" x="405" y="60" text-anchor="middle">mana2/1</text>
      <text class="s" x="500" y="55">MF-10: the ONE stored lineage reaching it</text>

      <rect class="box" x="20" y="120" width="150" height="50" rx="3"/>
      <text class="t" x="95" y="150" text-anchor="middle">lw/1</text>
      <path class="edge faint" d="M170 145 H330" stroke-dasharray="4 4"/>
      <text class="s" x="250" y="137" text-anchor="middle">no edge registered</text>
      <text class="s" x="250" y="165" text-anchor="middle">?format=mana2/1 on an</text>
      <text class="s" x="250" y="180" text-anchor="middle">lw/1-only layout: 404 format_absent</text>

      <rect class="ghost" x="580" y="120" width="280" height="70" rx="3"/>
      <text class="t" x="592" y="142">lw/1 → spark/1 (hypothetical)</text>
      <text class="s" x="592" y="160">a package function YOUR client calls</text>
      <text class="s" x="592" y="175">layoutdb itself never serves this edge</text>
    </svg>
  </div>
  <figcaption>Adding a stored format never widens what an output format derives from. `spark/1 → mana2/1` stays the one registered edge (`MF-10`); a second stored lineage reaching the same output format needs an explicit way to name the source, not designed yet, so it simply can't happen by accident. A cross-lineage bridge between two STORED formats, if one is ever written, is a client-side package function, never a server read path.</figcaption>
</figure>

**What this section does and doesn't claim.** `lw/1` is illustrative -- no such format is registered today (`GET /v1/formats` still lists only `spark/1` and `mana2/1`); this section exists to prove the mechanism the schema, the write model and the registry rules above actually support, using a concrete future adopter as the worked example, the same way the chain sections above use a stub lineage before any real format needs a second major. Registering a real second format follows §7 of `db/docs/adoption.md` exactly like registering the first one did.

## 6 · What changes from what is deployed

| piece | on ldb-v3 today | this design |
|---|---|---|
| registered formats | `cmini/1`, `akl/1`, `mana2/1` | `spark/1` stored, `mana2/1` produced |
| cmini | a stored format; `?as=cmini/1` is served | an import adapter only; `?as=cmini/1` goes away |
| existing records | imports untouched since are `cmini/1`; the 67 with akl.gg magic are `akl/1` | a one-time migrate: `cmini/1` through the existing lossless converter, `akl/1` relabeled. Each gets a `migrated` event, with `modified_at` and following left alone |
| restore | owner within 30 days, admin any time | owner or admin, any time |
| upstream tracking | derived from the event log when asked; magic-only edits never fork | folded into a top-level `upstream` field; any user edit forks, magic included. The 67 records seeded with akl.gg magic stay following, because the seed was a system migration |
| lowering | `lower()` on every format, with a typed-row vocabulary for cmini interop | gone as a registry concept; `spark → mana2` does it. Typed rows only mattered for cmini's magic, which is never imported |
| site pipeline | reads `?as=cmini/1` | reads spark; the site's sync shapes it into what its build expects |
| daily diff | compares each record as `cmini/1` with upstream | converts upstream to spark and compares in spark |
| upcast plan (19-upcast.md) | chains within a lineage plus cross-format moves | chains between spark majors only; cross-format writes cannot happen |

## 7 · Open questions

1. **Does the site read spark natively, or keep a spark-to-cmini step in its own sync?** Recommendation: the sync step for the cutover, so nothing downstream of it changes. The site moves to spark natively later, on its own schedule.
2. **What does restore do when the name has been reclaimed?** Today it fails with `409 name_taken` naming the new holder. With no time limit this becomes the common case. Recommendation: restore accepts an optional new name, and both records keep the likes they have.
3. **Should the importer keep `tag`, `blame`, `combos` and `link` in `x.cmini`?** Recommendation: yes, while the import runs, because the daily diff needs them to prove the conversion exact. They go when the import goes.

Sources: `db/src/index.ts`, `db/src/core/write.ts`, `db/src/core/follows.ts`, `db/formats/registry.ts`, `db/migrations/0001–0004`; `design/layout-db/01-format.md`, `02-auth.md`, `03-api.md`, `17-magic-ownership.md`, `19-upcast.md`; the format READMEs.
