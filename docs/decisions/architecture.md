# How the layout database works, and what formats it holds

*layoutdb · design round 2 · 2026-09-10*

One Cloudflare Worker over one D1 database. Every record is stored in one format, **spark**, which akl.gg and the bot both read and write. cmini is an import source: its layouts become spark records the moment they arrive. **mana2** is the format the analyzer reads, produced from spark on request. Green is this design. Amber is planned or still open.

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

## 1 · The system

<figure>
  <div class="frame">
    <svg viewBox="0 0 1000 640" role="img" aria-label="Clients on the left (akl.gg, the Discord bot, scripts) write spark to the akl-db Worker; the cmini upstream is polled and converted to spark on arrival. The Worker authenticates on two lanes, routes to the /v1 API, validates spark on write and produces mana2 on read, and writes to D1 and R2 on the right. One five-minute cron runs import, webhook delivery, the nightly dump, and the daily diff. Consumers along the bottom read the event log.">
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
      <text class="lbl" x="358" y="270">validate spark on write</text>
      <text class="lbl" x="358" y="285">?as=mana2/1 on read: the analyzer's view</text>
      <text class="lbl" x="358" y="300">spark/1 → mana2/1</text>

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
      <text class="lbl" x="782" y="80">layouts · layout_revs</text>
      <text class="lbl" x="782" y="95">events · likes · authors</text>
      <text class="lbl" x="782" y="110">import_map · import_state</text>
      <text class="lbl" x="782" y="125">admins · clients · nonces</text>
      <text class="lbl" x="782" y="140">webhooks · auth_cache</text>
      <text class="lbl" x="782" y="155">ratelimit</text>
      <text class="s" x="782" y="184">every payload is spark</text>
      <text class="s" x="782" y="199">record = fold of events</text>
      <text class="s" x="782" y="214">every rev kept</text>

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
  <figcaption>Every client writes spark. The cmini import is one more writer that happens to convert before it writes. The registry has one job on the way in, validating spark, and one on the way out, producing mana2 for anything that analyzes.</figcaption>
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
    <svg viewBox="0 0 960 260" role="img" aria-label="A write appends one event with a sequence number, one layout_revs row keyed by record id and rev, and updates the layouts row, which is the fold of the events and now carries the upstream state. Likes are separate events that move like_count only. Reads of rev n combine layout_revs with the event's after snapshot.">
      <defs>
        <marker id="ar2" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="8" markerHeight="8" orient="auto-start-reverse">
          <path d="M0 0 L10 5 L0 10 z" fill="currentColor"/>
        </marker>
      </defs>
      <rect class="box" x="20" y="60" width="150" height="66" rx="3"/>
      <text class="t" x="32" y="82">accepted write</text>
      <text class="lbl" x="32" y="101">PUT PATCH POST</text>
      <text class="lbl" x="32" y="116">DELETE import like</text>

      <path class="edge" d="M170 92 H230" marker-end="url(#ar2)"/>
      <text class="lbl" x="200" y="84" text-anchor="middle">1 batch</text>

      <rect class="store" x="230" y="30" width="240" height="120" rx="3"/>
      <text class="t" x="242" y="52">events</text>
      <text class="lbl" x="242" y="72">seq · kind · at · actor · via</text>
      <text class="lbl" x="242" y="87">before / after (no payload)</text>
      <text class="lbl" x="242" y="102">rev-bumping · like · info</text>
      <text class="s" x="242" y="128">the truth; served from seq 1</text>

      <path class="edge" d="M470 70 H540" marker-end="url(#ar2)"/>
      <text class="lbl" x="505" y="62" text-anchor="middle">rev + 1</text>
      <rect class="store" x="540" y="30" width="220" height="82" rx="3"/>
      <text class="t" x="552" y="52">layout_revs</text>
      <text class="lbl" x="552" y="72">(layout_id, rev)</text>
      <text class="lbl" x="552" y="87">format · payload_json</text>
      <text class="s" x="552" y="104">never rewritten</text>

      <path class="edge" d="M470 125 H540 V160" marker-end="url(#ar2)"/>
      <text class="lbl" x="480" y="117">fold</text>
      <rect class="store" x="540" y="160" width="220" height="82" rx="3"/>
      <text class="t" x="552" y="182">layouts</text>
      <text class="lbl" x="552" y="202">id name owner rev deleted</text>
      <text class="lbl" x="552" y="217">spark payload · like_count</text>
      <text class="lbl acc-text" x="552" y="232">upstream state</text>

      <path class="edge faint" d="M760 70 H800 V200 H760" marker-end="url(#ar2)"/>
      <text class="lbl" x="806" y="128">GET /rev/{n} =</text>
      <text class="lbl" x="806" y="143">revs row ⊕ after</text>

      <rect class="store" x="230" y="180" width="240" height="50" rx="3"/>
      <text class="t" x="242" y="202">likes</text>
      <text class="lbl" x="242" y="220">(layout_id, user_id)</text>
      <path class="edge faint" d="M470 205 H540" marker-end="url(#ar2)"/>
      <text class="lbl" x="505" y="197" text-anchor="middle">±1</text>
    </svg>
  </div>
  <figcaption>The record is the fold of its events. A rev-bumping event writes a payload row and the folded record in the same batch. Likes and informational events touch no rev. History is served by replaying, never by a second copy.</figcaption>
</figure>

The record header is the same for every layout. The one addition in this round is `upstream`, which makes a record's relationship to cmini visible at the top level instead of something a reader has to reconstruct from the log.

```json
{
  "id": "01J7Q9Z3M4K2R6X8V0B1N5C7D9",   // ULID, never changes; the key to store
  "name": "hours",                      // unique, case-insensitive; reclaimable after delete
  "owner": "383900587877597186",        // Discord user id
  "rev": 7,
  "created_at": "2026-06-25T00:00:03Z",
  "modified_at": "2026-09-08T19:40:11Z",
  "deleted": false,
  "like_count": 7,                      // derived
  "has_magic": true,                    // derived
  "upstream": { "source": "cmini", "id": "hours", "state": "following" },  // null if never imported
  "format": "spark/1",
  "payload": { … }
}
```

Deleting frees the name. A later `POST` under the same name is a new record with a new id, and it inherits the tombstone's likes. The tombstone stays restorable by its owner with no time limit. Tombstones are already kept forever, since the nightly job never prunes them, so this costs no storage that is not already being spent. It can be revisited if storage ever becomes a problem.

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
    <svg viewBox="0 0 440 210" role="img" aria-label="Option A: writers send spark; only spark is stored; mana2 is produced on read. A write in mana2 is refused.">
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
      <text class="s" x="225" y="94" text-anchor="middle">only store</text>
      <path class="edge" d="M280 80 H330" marker-end="url(#ar6)"/>
      <text class="lbl" x="305" y="72" text-anchor="middle">read</text>
      <rect class="box" x="330" y="60" width="96" height="40" rx="3"/>
      <text x="378" y="85" text-anchor="middle">mana2/1</text>
      <rect class="ghost" x="330" y="140" width="96" height="40" rx="3"/>
      <text x="378" y="165" text-anchor="middle">PUT mana2</text>
      <path class="edge faint" d="M330 160 H240 V104" marker-end="url(#ar6)"/>
      <text class="lbl" x="250" y="152">refused</text>
      <text class="s" x="16" y="202">no held records; no cross-format writes</text>
    </svg>
  </div>
  <figcaption><span class="rec">Decided 2026-09-10.</span> One stored format means no record is ever unreadable, and a cross-format write cannot happen. If mana wants to write later, a mana2 input adapter converts to spark on the way in, exactly like the cmini import.</figcaption>
</figure>

Not chosen: storing mana2 as a second format. It would bring back held reads, a visibility check on cross-format writes, and records the site could only show partially, because mana2 loses magic idioms and the either-thumb finger on the way to spark.

## 4 · A read and a write, end to end

<figure>
  <div class="frame">
    <svg viewBox="0 0 1010 250" role="img" aria-label="Read path: GET with as equals translates the stored spark payload to the requested format and returns it, or 409 held. Write path: auth, If-Match rev, validate the spark major sent, the planned visibility check that refuses an older major overwriting content it cannot see, the planned chain to the latest major, validate again, one batch commit, then the feed and webhooks.">
      <defs>
        <marker id="ar4" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="8" markerHeight="8" orient="auto-start-reverse">
          <path d="M0 0 L10 5 L0 10 z" fill="currentColor"/>
        </marker>
      </defs>
      <text class="s" x="20" y="24">READ   GET /v1/layouts/{ref}?as=F     F = a spark major or mana2/1</text>
      <rect class="box" x="20" y="36" width="120" height="40" rx="3"/>
      <text x="80" y="61" text-anchor="middle">load record</text>
      <path class="edge" d="M140 56 H180" marker-end="url(#ar4)"/>
      <rect class="acc-fill" x="180" y="36" width="210" height="40" rx="3"/>
      <text class="acc-text" x="285" y="61" text-anchor="middle">translate spark → F</text>
      <path class="edge" d="M390 56 H430" marker-end="url(#ar4)"/>
      <rect class="box" x="430" y="36" width="130" height="40" rx="3"/>
      <text x="495" y="61" text-anchor="middle">200 payload</text>
      <path class="edge faint" d="M285 76 V108 H430" marker-end="url(#ar4)"/>
      <rect class="box" x="430" y="92" width="130" height="32" rx="3"/>
      <text x="495" y="113" text-anchor="middle">409 held</text>
      <text class="s" x="590" y="52">held happens only when an older spark</text>
      <text class="s" x="590" y="67">major cannot show what the record uses;</text>
      <text class="s" x="590" y="82">mana2 is never held</text>

      <text class="s" x="20" y="160">WRITE  PUT /v1/layouts/{ref}  {format: spark/N, payload}</text>
      <rect class="box" x="20" y="172" width="70" height="44" rx="3"/>
      <text x="55" y="199" text-anchor="middle">actor</text>
      <path class="edge" d="M90 194 H106" marker-end="url(#ar4)"/>
      <rect class="box" x="106" y="172" width="90" height="44" rx="3"/>
      <text x="151" y="199" text-anchor="middle">If-Match</text>
      <path class="edge" d="M196 194 H212" marker-end="url(#ar4)"/>
      <rect class="box" x="212" y="172" width="106" height="44" rx="3"/>
      <text x="265" y="199" text-anchor="middle">validate N</text>
      <path class="edge" d="M318 194 H334" marker-end="url(#ar4)"/>
      <rect class="prop-fill" x="334" y="172" width="160" height="44" rx="3"/>
      <text class="prop-text" x="414" y="190" text-anchor="middle">visible in N?</text>
      <text class="prop-text s" x="414" y="206" text-anchor="middle">no → 409 format_behind</text>
      <path class="edge" d="M494 194 H510" marker-end="url(#ar4)"/>
      <rect class="prop-fill" x="510" y="172" width="150" height="44" rx="3"/>
      <text class="prop-text" x="585" y="190" text-anchor="middle">chain N → latest</text>
      <text class="prop-text s" x="585" y="206" text-anchor="middle">written_as: spark/N</text>
      <path class="edge" d="M660 194 H676" marker-end="url(#ar4)"/>
      <rect class="box" x="676" y="172" width="130" height="44" rx="3"/>
      <text x="741" y="199" text-anchor="middle">validate latest</text>
      <path class="edge" d="M806 194 H822" marker-end="url(#ar4)"/>
      <rect class="box" x="822" y="172" width="80" height="44" rx="3"/>
      <text x="862" y="199" text-anchor="middle">commit</text>
      <path class="edge" d="M902 194 H918" marker-end="url(#ar4)"/>
      <rect class="box" x="918" y="172" width="80" height="44" rx="3"/>
      <text x="958" y="190" text-anchor="middle">feed</text>
      <text class="s" x="958" y="206" text-anchor="middle">webhooks</text>
      <text class="s" x="20" y="240">the amber steps only run once spark/2 exists; until then a write is validate, then commit</text>
    </svg>
  </div>
  <figcaption>Reads translate from spark. Writes are always spark. The two amber steps are the upcast plan, and with one stored format they only ever compare two spark majors.</figcaption>
</figure>

## 5 · What this design adds, as invariants

- **One stored format.** Every record's payload is spark at the latest major, whatever wrote it. A write in mana2 is refused. Enforced by the write path and the migrate tick, checked over every write verb.
- **Spark stays lowerable.** Every valid spark payload translates to `mana2/1`. Checked over every fixture and over random single-field mutations of them.
- **No silent last-wins.** Two magic rules that fire on the same input are refused at write, with both sources named.
- **The cmini adapter is exact.** Converting a following record's upstream detail again reproduces its payload, magic aside. Checked per PR on fixtures and daily against the live set.
- **Upstream state is a fold.** A record follows until the first write by a user, magic edits included. System writes, the import and one-time migrations, never fork. Forked never returns to following. The importer never writes a forked record. Checked by replaying random event sequences.

Ids get assigned when the design docs are amended. Each replaces or narrows an existing one: the cmini round-trip and cmini-envelope invariants, the lift invariant, and the follows-upstream rule.

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
