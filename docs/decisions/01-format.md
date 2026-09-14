# The layout record and its formats

Status: proposal (2026-09-08). Part of `00-plan.md`. The one document here
worth reading slowly: every other piece can be changed later; a stored
record cannot.

**Amended 2026-09-11 (20-spark.md S7).** `akl/1` is renamed `spark/1`
(decision 1): the payload shape below is unchanged byte-for-byte, only the
id and the directory move. `spark/1` is the **one stored format** — every
write, whatever id it names, ends up stored as `spark/1` (`04 §4`, S2).
cmini is an **import adapter**, not a registered format (decision 2): it
has no `to`/`from`/`validate` in the registry any more, only
`fromCmini`/`toCmini` at `db/formats/adapters/cmini/`, reached through the
alias table (§4). `mana2/1` is **output-only** (decision 3): produced from
`spark/1` on read, never stored. `akl/1` and `?as=cmini/1` survive as
**transitional aliases** (§4) for the deployed bot, the preview site, and
`publish-ux` until each moves to `spark/1`; see
`design/layout-db/20-spark.md` for the full plan, the ledger of what
actually shipped, and the alias removal checklist.

**Dated note (2026-09-11, `21-formats.md` F1).** The alias removal
checklist above ran: `akl/1` and `?as=cmini/1` are no longer aliases at
all, transitional or otherwise -- `GET .../{ref}?as=cmini/1` now answers
exactly like any other unregistered format id, and `toCmini` (the
`spark/1 -> cmini` lowering §6.2 below describes) is deleted along with
it, per `21-formats.md` D5. `spark/1` also lost the free-form `x` field §2
describes (D10) -- there is no more per-client namespaced escape hatch on
the stored payload. The prose below (§2's `x` paragraph, §6.2's `toCmini`
walkthrough) is kept as the historical record of what F1 removed and WHY
it was shaped that way; it is no longer what the code does. `22-spark-spec.md`
is the current, accurate spec for `spark/1` as shipped.

## 1. Record vs payload

A **record** is what the database owns about a layout — identity, ownership,
history. A **payload** is the layout itself, in one of several **formats**.
The record is the same shape for every layout; the payload's shape is named by
`format`.

```jsonc
{
  "id": "01J7Q9Z3M4K2R6X8V0B1N5C7D9",     // ULID, minted at create, never changes
  "name": "hours",                        // unique, case-insensitive; what humans type
  "owner": "383900587877597186",          // Discord user id (string)
  "rev": 7,                               // integer, +1 per accepted write of the record
  "created_at": "2026-06-25T00:00:03Z",
  "modified_at": "2026-09-08T19:40:11Z",  // last write of the record; likes do not move it
  "deleted": false,                       // tombstones keep id, name, owner, rev
  "like_count": 7,                        // derived; the id list is GET /v1/layouts/{id}/likes
  "has_magic": true,                      // derived on every write: the format's hasMagic(payload)
  "format": "spark/1",                    // the payload's format id (native; a request that named the
                                           // transitional `akl/1` alias gets this label back instead, §4)
  "payload": { … }                        // see §2
}
```

No provenance field (saltorbit, round-1 review): where a record came from —
imported from cmini, created by the bot, edited on akl.gg — is the event log
(`03 §5`: `imported` events carry `source` and the upstream id; every write
carries `via`). One client adds and another edits is the normal case, so a
flag on the record would only go stale. **Amended:** one narrow, explicitly
transitional exception exists — `upstream` (decision 5, `03 §5`), a
fold of the cmini-import events kept on the row only for as long as that
import runs (decision 16). It answers one question ("does the importer
still own this record's keys and board"), not "where did this come from";
see `20-spark.md` §6b for its retirement.

No `core` field, and no `core/1` format (saltorbit, round-1 review: "overkill").
A reader asks for the format it speaks; the list endpoint carries record
fields only.

Rules:

- `id` is the only key another system should store. `name` is a display and
  lookup handle; `GET /v1/layouts/{ref}` accepts either.
- `rev` is per record and continues across deletion (a recreate under the
  same name is a new record with a new id; the tombstone keeps the old one).
- `payload` is stored **exactly as written**, byte-for-byte after JSON
  canonicalisation, under the `format` the writer declared. It is never
  rewritten in place by a schema change. Reads translate (§6).

## 2. `spark/1` — the common format

(Renamed from `akl/1`, 20-spark.md decision 1; the payload shape below is
unchanged byte-for-byte.) This is what akl.gg writes and what most clients
will read. It is the site's existing shapes joined, so nothing is invented:
cmini's `keys` map, the board geometry from #261, the magic authoring shape
from `design/magic-rules/02-schema.md`.

```jsonc
{
  // ── keys ────────────────────────────────────────────────────────────
  // char → position. Same shape and same finger vocabulary as cmini
  // (LP LR LM LI RI RM RR RP LT RT TB; TB = either thumb). By convention
  // rows 0-2 are the main block and row 3 is thumbs, but the format holds
  // what cmini holds (07 §0.1: live data has row 4, thumb fingers on
  // rows 0-2, non-thumb fingers on row 3, and 52 layouts with no keys at
  // all) — so the rule is rows 0-4, cols ≥ 0, finger ∈ the enum, nothing
  // about which finger sits on which row. Columns are ABSOLUTE for every
  // row (cmini v3 semantics, 2026-08-31). A char appears at most once.
  "keys": {
    "a": { "row": 1, "col": 8, "finger": "RR" },
    "e": { "row": 3, "col": 6, "finger": "RT" },
    "@": { "row": 0, "col": 1, "finger": "LR" }
  },
  // positions that exist on the board but hold no character (cmini's `~`)
  "free": [ { "row": 2, "col": 5, "finger": "RI" } ],

  // ── board ───────────────────────────────────────────────────────────
  // kind: "rowstag" | "colstag" | "ortho".
  // stagger: per ROW for rowstag (rows 0..2, in key widths; ANSI is
  // [0, 0.25, 0.75]), per COLUMN for colstag (in key heights, one entry per
  // column present); absent or all-zero = ortho. Matches mana2's
  // rowOrColumnStagger so mana2/1 round-trips losslessly.
  // cmini: the word cmini would use ("stagger" | "angle" | "ortho" | "mini"),
  // kept so an imported record lowers back to the same cmini word.
  // Optional; derived when absent (§6.2).
  "board": { "kind": "rowstag", "stagger": [0, 0.25, 0.75], "cmini": "angle" },

  // ── magic (optional) ────────────────────────────────────────────────
  // The AUTHORING shape from design/magic-rules/02-schema.md, verbatim.
  // Intent lives here; engines get the lowering (§3).
  "magic": {
    "magic_keys": [
      { "key": "@", "default": "repeat_previous",
        "rules": [ { "after": "n", "output": "nl" }, { "after": "r", "output": "rn" },
                   { "after": "u", "output": "u'" }, { "after": "y", "output": "ys" } ],
        // keys the default does NOT scaffold a row for (#221's "uncovered
        // key" finding: opal has `,` but no `,◇` row). Optional.
        "except": [","] }
    ],
    // `except` exists on chiral keys too, for the same reason (a swap
    // whose trigger+member would collide with the chiral scaffold, §3).
    "chiral_keys": [ { "key": ";", "same": "ee", "opposite": "ei", "except": [] } ],
    "adaptive_swaps": [ { "trigger": "t", "swap": ["h", "e"] } ],

    // ── the escape hatch ─────────────────────────────────────────────
    // Flat rules in mana2's own vocabulary, appended to the lowering
    // unchanged. For things the idioms above cannot say yet. `inputs` is
    // ≥ 2 code points (cmini serves 3-code-point inputs, `he*→her`, 07
    // §0.1), the last being the pressed key. `type` is optional: "raw"
    // (default) or one of §3's tags when the writer knows it is honest —
    // an imported row keeps whatever tag upstream gave it. `note` is for
    // the human reading the record later.
    "rules": [ { "inputs": "th", "output": "te", "type": "raw", "note": "…" } ]
  },

  // ── anything else ───────────────────────────────────────────────────
  // Free-form, validated only as JSON, preserved verbatim, ignored by
  // lowering. Where a client keeps its own extras without inventing a
  // format. Namespaced by client: "x": { "keymaxx": {…}, "mana": {…} }.
  // `x.cmini` is reserved: it holds the cmini fields spark/1 has no idiom
  // for (`tag`, `blame`, `combos`, `link`) so an imported record loses nothing
  // when its owner moves it to spark/1, and `toCmini` (`?as=cmini/1`) copies
  // them back out (§6.2). Every other `x` key is dropped by every translation.
  "x": {}
}
```

What is deliberately **not** in `spark/1`: layers, combos, hold-taps, per-key
timing, alternate fingerings (#148 — will be an additive minor once its
design closes). Those belong to advanced formats (§4) until an idiom for
them is proven in one.

### 2.1 Validation (write-time, 400 with the offending path)

- `keys`: may be empty; each char is one code point; rows 0–4; cols ≥ 0
  (negative columns crash the wasm engine — see memory: negative-col crash);
  finger ∈ the enum; no two chars (or `free` entries) share a position.
  No thumb-row rule: the live cmini set violates every version of it
  (07 §0.1), and the format's job is to be lossless against cmini. (The
  bot's `setfingermap` message stays a *bot* check; a stricter rule for
  new akl.gg writes, if ever wanted, is a route-level check in phase 2.)
- `board.stagger` length matches kind (3 for rowstag; one per distinct
  column for colstag); `board.cmini`, when present, must agree with the
  geometry it names (the cmini `add` heuristic on `stagger`).
- `magic`: every rule in `02-schema.md`'s list, unchanged (single-char keys,
  `output` starts with `after`, no duplicate `after` per key, no duplicate
  `trigger`+member pair, a key is magic or chiral never both,
  `repeat_previous` sentinel). *Amended 2026-09-11 (saltorbit: "layoutdb
  validation right now should match aklgg validation"; LDB-F22):* a `null`
  chiral `same`/`opposite` reads as absent. *Amended again 2026-09-13
  (saltorbit/aklgg#322, added to akl.gg's validator at the same time):* the
  keys a rule set names (`magic_keys[].key`, `chiral_keys[].key`,
  `adaptive_swaps[].trigger`/`.swap[]`) must exist in `keys` (the scaffold
  needs their hand/position). `notes` and `updated` are refused (dropped
  from the payload, 24-spark-wire-review.md round 2 item 2).
  `except[]` entries are single code points. A rule's `after` need **not** be a key (opal's `?◇`
  row names a char the layout does not carry — 07 §0.1).
- `magic.rules[]`: `inputs` ≥ 2 code points, `output` non-empty; no
  duplicate `inputs`; chars need not be keys.
- The lowering (§3) must succeed with no collision involving a raw
  `rules[]` row (idiom overlaps resolve as akl.gg does, D4 as amended).

## 3. Intent and lowering

`compileMagic(payload) → [{inputs, output, type}]` is a pure, deterministic
function exported by the format itself (`db/formats/spark/1/index.ts`,
named `compileMagic` — decision 4 retired the old registry-level `lower()`
slot from the `FormatModule` contract entirely, so this is a plain named
export the registry never dispatches generically; the registry only calls
`to["mana2/1"]`/`hasMagic`, which use it internally). It is what
`?as=mana2/1` (`to["mana2/1"]`, i.e. `fromSpark`) and the cmini adapter's
`toCmini` (`?as=cmini/1`) emit in their `magic` fields; a pure
`cminiBoardWord(board)` export (also on spark/1) does the matching board
→ cmini-word half of that same translation (§6.2). It is the
existing compile in `scripts/build_magic_rules.py` / `functions/_lib/rules.mjs`
(magic keys → one row per layout key not in `except` and per explicit
`after`; chiral → one row per key on the named hand; adaptive swap
`t:[h,e]` → `th→te`, `te→th`) followed by the raw `rules` appended in order.
A magic key's board-char scaffold enumerates every layout key except its
own `except` list AND every magic/chiral key's own char (LDB-F15,
`web/src/core/magicScaffold.ts`'s `magicScaffoldChars`: one GLOBAL
exclusion set built from `magic_keys[]`/`chiral_keys[]` and shared across
every key's scaffold) — corrected from an earlier version of this format
that excluded only the scaffolding key's own char, reasoning from a
misread of upstream's `auditor` data (S3: 'b' is its own magic key AND
its stored `magic` array carries `*`'s repeat row `b*→bb`; the row is
real, but recompiling `auditor`'s own idiom through today's site compiler
does NOT reproduce it — the row survives only because `liftRules`
recognizes a repeat/default row whose `after` is itself a special char and
promotes it into an EXPLICIT `magic_keys[].rules[]` override instead,
which relowers tagged `magic`, not `repeat`/`default:<c>` — same
`(inputs, output)`, intentionally relabeled). A chiral key's scaffold,
separately, enumerates every layout key WITH A HAND (`except` aside),
the chiral key's own char included: same hand as itself, so it always
takes `same` (never `opposite`), producing a self row `key+key`. The
repeat/default scaffold enumerates **the layout's keys**, not a–z
(#221 §3.1: cmini's own rows do, and a–z gives non-Latin layouts nothing).
A `default:<c>` scaffold (never `repeat_previous`) also gets one extra
word-start row, `{inputs: ' '+key, output: ' '+c}` — word-initial text has
no preceding board character for the scaffold above to enumerate, and the
site's own compile (`web/src/core/rules.ts`'s `magicRulesFlatCompile`,
I-153) emits it unconditionally whenever the default is literal, `except`
included (the site's authoring shape has no `except` list to consult for
this row at all); an explicit `magic_keys[].rules[]` entry for
`after: ' '` still replaces it, same as any board char (LDB-F14).

**Typed rows.** Every lowered row carries a `type` from a closed vocabulary
— the shape cmini's API already serves (`magic: [{inputs, output, type}]`)
and the finding of `design/cmini-live-api/02-magic-rules-interop.md`
(#221): with honest tags the flat list lifts back to the idioms *exactly*
(verified on opal: 32 rows ⇄ one repeat key + 6 exceptions + 2 swaps). An
analyzer ignores `type`; an editor trusts it. Each tag has an invariant a
writer must satisfy:

| `type` | produced by | invariant |
|---|---|---|
| `repeat` | a `repeat_previous` magic key's scaffold | `output == inputs[0]*2` |
| `default:<c>` | a magic key whose default is the literal `c` | `output == inputs[0] + c` |
| `magic` | an explicit `rules[]` entry on a magic key | `output` starts with `inputs[0]` |
| `chiral` | a chiral key | rows sharing `inputs[1]` agree on `output[1:]` within a hand |
| `adaptive` | one half of an adaptive swap | exactly one mate shares `inputs[0]` |
| `raw` | the escape hatch | none |

Unknown tags are legal on read (kept as the row, shown as raw). `chiral`
and `default:<c>` are the two tags cmini's vocabulary lacks today (#221
§2); this format adds them.

**Collision rule (D4), amended 2026-09-11.** saltorbit: "layoutdb validation
rules for the spark format should match what we already have with aklgg".
Two rows from IDIOMS with the same `inputs` are resolved the way akl.gg's
compile resolves them (`web/src/core/rules.ts` `magicRulesFlatCompile`):
phase order scaffold < chiral < explicit rules < adaptive swaps, the last
row wins. The text below (refusal, `except` hints) now applies only to a
collision a raw `rules[]` row is part of; `except` stays valid and still
removes a scaffold row. Original text:

Two lowered rows with the same `inputs` — whether
from two idioms, or an idiom and a raw rule — are refused at write time:

```
400 { "error": "magic_collision",
      "inputs": "th",
      "from": [ "adaptive_swaps[0]", "rules[0]" ],
      "message": "two rows fire on 'th': adaptive_swaps[0] and rules[0]" }
```

Not last-wins (mana2's load behaviour, which `02-schema.md` already calls a
footgun) and not "raw overrides" — an author who wants the raw row deletes
the idiom, and the record then says what they meant. The escape hatch is for
what the idioms cannot express, not for overriding them.

The one collision the site's existing data relies on is *scaffold vs
idiom*: bunya's repeat key `@` scaffolds `f@→ff` and its swap `f:[@,d]`
claims `f@` too (`data/magic_rules.json`; `#221 §3.1` resolves it by rank,
adaptive over repeat). Here the record says it explicitly: `@` gets
`except: ["f"]`, the scaffold emits no `f@` row, the swap owns it. The
error body carries the fix — `"hint": { "path": "magic_keys[0].except",
"add": "f" }` — whenever one side of a collision is a scaffold row, and
the magic migration (06 §4) applies that hint automatically so no existing
rule set is refused. An explicit `rules[]` entry on the same `after` is
**not** a collision with its own key's scaffold: it replaces the scaffold
row, as `rules.mjs`/`magic_interop.py` already do.

**Round trip.** `spark/1 → compileMagic → spark/1` is lossy by construction
(that is the point: the lowering forgets the idiom). The **write** path therefore never
accepts a lowering as the record's magic when the client had the intent: a
client that only speaks flat rules writes them into `magic.rules` and the
record honestly says "raw rules". A client that wants to *recover* intent
from a flat list may run the format's `liftRules()`: exact for typed rows
(#221 §3.2 — group by tag, verify each tag's invariant, anything that fails
is a *leftover* kept in `magic.rules` with its tag), a best-effort guess for
untyped ones (mana2's `hours.jsonc`). A row with no tag, an unknown tag, or
an `inputs` that is not exactly two code points is always a leftover. A
guessed lift must be shown to the author before it is written; an exact
lift may be applied by the import (§8 Q3). Live upstream today (07 §0.1):
opal's rows are all `type: magic` (its repeat key lifts to a magic key
with `default: none` and 27 explicit rules — exact, if unlovely); auditor
and friends carry `repeat`; four rows are 3-code-point; one is untyped.

## 4. The registry

A **registered** format — one the registry (`db/formats/registry.ts`)
actually dispatches `validate`/`to`/`from`/`hasMagic` through — is a
directory:

```
db/formats/<name>/<major>/
  schema.json      JSON Schema for the payload (draft 2020-12)
  index.ts         validate(payload)
                    hasMagic(payload) → boolean
                    to:   { "<other format>/<N>": fn } (optional)
                    from: { "<other format>/<N>": fn } (optional)
                    edits?: { setFingermap?, setBoard?, setMagic? }   (PATCH helpers, §5 in `03-api.md`)
                    plus whatever named exports the format wants (spark/1: `compileMagic`, `cminiBoardWord`)
  fixtures/        frozen: NNN-<name>.json (+ .lowered.json goldens, + .<to-format>.json per declared translation)
  OWNERS           GitHub handles who review changes here (04 §2)
  README.md        what this format is for, what it cannot express
```

Every `FormatModule` also declares a `role`: `"stored"` (a write may store
this format) or `"output"` (produced on read only; a write naming it is
refused, `400 format_not_writable`). `lower()` is **not** part of the
contract (decision 4) — the old registry-level dispatch was retired; a
format that needs a compile step exports it itself, by name, and calls it
from its own `to[...]`.

Registered:

| format | role | owner | what it is | translations |
|---|---|---|---|---|
| `spark/1` | `stored` | DB (+ akl.gg) | §2 (renamed from `akl/1`, decision 1; payload unchanged) | `to["mana2/1"]` (= `fromSpark`); the cmini adapter's `toCmini`/`fromCmini` (import, and `?as=cmini/1`) |
| `mana2/1` | `output` | Zak (mana2) | a mana2 `.jsonc` layout object (`layout.fingers/thumbs`, `board`, `fingermap`, `magic.rules`) | reachable only *from* `spark/1`; its own registry `to`/`from` are `{}` (decision 3 — nothing is ever stored as mana2, so nothing translates from it). Converters are named exports `toSpark`/`fromSpark` (were `toAkl`/`fromAkl`). |

That is the **whole** registered set (two `FormatModule`s). cmini is not
one of them (decision 2): it has no `to`/`from`/`validate` slot in the
registry at all. Its adapter lives, unregistered, at
`db/formats/adapters/cmini/` (`fromCmini`/`toCmini`, plus the `rows`
helper cmini fixtures use in place of `compileMagic`); it is reachable
only through the alias table below, never through `lineage()`/`path()`
(19-upcast.md §4, implemented in S5) — `"adapter:cmini"` is not a chain
step.

### 4.1 Aliases and legacy-stored reads

Two transitional aliases (decision 12), kept until the removal checklist
(`20-spark.md` §6) clears, live in one table in the registry
(`ALIASES: Record<string, {target, relabel, write}>`):

| alias | target | on write | on read |
|---|---|---|---|
| `akl/1` | `spark/1` | stored, byte-identical | payload is `spark/1`'s; the wire `format` is **relabelled** `"akl/1"` when the request itself named `akl/1` (`03 §1`) — the one exception to "format is native" |
| `cmini/1` | the cmini adapter (`adapter:cmini`) | refused, `400 unknown_format` | `toCmini` of the `spark/1` payload; **never** relabelled — it is an adapter projection, not the same format, so the wire `format` stays native |

`resolveFormat(id)` resolves a native id to itself or an alias to its
target module; the `?format=` list filter and the package's alias subpath
exports (`@akl/layout-formats/akl/1` → spark's dist,
`@akl/layout-formats/cmini/1` → the adapter's) go through the same table.

Separately, `LEGACY_STORED: Record<string, (p) => SparkPayload>` (today
`{"akl/1": identity, "cmini/1": fromCmini}`) and `storedAsSpark(format,
payload) → {format: "spark/1", payload}` are what every *read* of a row
whose **stored** `format` column is still `akl/1` or `cmini/1` goes
through — `layout_revs` keeps such rows forever (history is not
rewritten), so `LEGACY_STORED`/`storedAsSpark` are **never removed**, even
after the alias table above is (`LDB-F21`, `20-spark.md` §6). It is also
the one conversion every write that carries a legacy record's payload
forward (delete, restore, transfer, PATCH) and the S4 record migration use
— nothing else converts a stored legacy payload.

`GET /v1/formats` carries `role`, and for `spark/1` an `aliases:
["akl/1"]` list, plus `can_translate_to` — the reachable set, aliases
included (`mana2/1`, `akl/1`, `cmini/1` for `spark/1`); `?as=` accepts any
advertised target.

A record whose format cannot be translated to the one a reader asked for is
**held** for that reader: stored, listed with its name/owner/rev, readable as
its own format (and any format it does translate to). Nothing is ever dropped for being
unrenderable (federation §6.5, kept). The server refuses a write in a format
it does not have registered (400 `unknown_format`) or registered `"output"`
(400 `format_not_writable`) — there is no "opaque bytes" write, because a
held record that *nobody* can read is a bug, not a feature; registering the
format is a PR (`04 §2`).

An **advanced** format (say `keymaxx/1`, with combos and layers) is added the
same way, by its author, with `to["spark/1"]` if the base layer can be
expressed there (the way to appear on akl.gg and in the bot at all). akl.gg
would show that translation and say *uses features shown fully in keymaxx* — the "see it elsewhere" card from federation §6.5, in one database.

## 5. Versioning and compatibility

- Format id = `<name>/<major>`. Within a major, changes are **additive and
  optional** (a new optional key; a new enum value with a defined fallback).
  Anything else is a new major directory.
- A major is **never deleted**, its `schema.json` never tightened, its
  fixtures never edited. Adding a fixture is allowed; that is how a bug found
  in the wild becomes a permanent regression. `spark/1` itself is frozen
  the moment its PR (#307) merges (S1's own note): the `akl/1` → `spark/1`
  directory rename was the last free one.
- **Amended (20-spark.md decision 10, implemented in S5).** Records no
  longer keep their written major: a record is always stored at its
  lineage's **latest** registered major. A `PUT` in an older major is
  upcast through the chain before it is stored (`detail.written_as` names
  what it arrived as); it is refused `409 format_behind` first if the
  client could never have read the record whole in that older major (the
  chain and its invariants — F18 chain contract, F19 path composition,
  P13 older-major write, D6 per-major dumps — are `19-upcast.md`'s design,
  renamed to spark there; see that doc for the mechanism). A reader still
  asks `?as=<major>` and gets the chain's translation, `409 held` where a
  step is lossy, with `see` naming the record's native (latest) major.
  With only `spark/1` registered, the chain has nothing to do yet — it is
  exercised by a test-only stub lineage until a real `spark/2` exists.
- API path version (`/v1/`) and format majors are independent. `/v1/` changes
  only if the record envelope (§1) breaks; adding fields to it does not count.
- Deprecation means "documented as not recommended". It never means 404.

## 6. Translations in day-1 formats

### 6.1 cmini → `spark/1` (the import; must be lossless)

| cmini | spark/1 |
|---|---|
| `keys` | `keys` unchanged (v3 absolute thumb cols) |
| `free` (positions) | `free` |
| `board: "stagger"` | `board: {kind:"rowstag", stagger:[0,0.25,0.75], cmini:"stagger"}` |
| `board: "angle"` | `board: {kind:"rowstag", stagger:[0,0.25,0.75], cmini:"angle"}` (the angle shift is already in `keys`' cols and fingers, as cmini stores it) |
| `board: "ortho"` | `board: {kind:"ortho", cmini:"ortho"}` |
| `board: "mini"` | `board: {kind:"ortho", cmini:"mini"}` |
| `magic: [{inputs, output, type?}]` | typed rows → exact lift into `magic_keys`/`adaptive_swaps` (§3); rows whose tag invariant fails, with an unknown or absent tag, or with `inputs` ≠ 2 code points → `magic.rules` with their tag kept (`raw` when absent). |
| `tag`, `blame`, `combos`, `link` | `x.cmini: { tag, blame, combos, link }` — preserved, ignored by lowering (combos are a phase-5 idiom, not a spark/1 one; `link` is import fidelity only, saltorbit's round-1 cut) |
| `name user likes created_at modified_at` | record fields, not payload |

Golden: every cmini layout at import (4174 on 2026-09-08) satisfies
`project(toCmini(fromCmini(x))) == project(x)`, where `project` is 07 §5.1's
`cminiDetail` projection under `canonical()` with `likes` sorted. This is
the D12 diff; it runs daily in CI against the live API (`db/tests/
upstream-diff.test.ts`) and at fixture level on every PR. **Amended:**
`LDB-I13` (`20-spark.md` §4) replaces this paragraph's F5/F11-level
wording for what the adapter itself must guarantee: for a following
record, `fromCmini(upstream)` equals its payload minus `magic`; every live
upstream detail's `fromCmini` validates as `spark/1`.

### 6.2 `spark/1 → cmini` (`?as=cmini/1`; what the bot and emulayout read)

`board.cmini` wins when present; otherwise derived: rowstag with ANSI stagger
→ `stagger`, ortho → `ortho`, colstag → `ortho` (cmini has no colstag; the
stagger amounts are lost, which is the documented loss), `mini` only when the
record said so (`cminiBoardWord`). `magic` → `compileMagic()`.
`x.cmini.{tag, blame, combos, link}` are copied back out; every other `x`
key is dropped.

### 6.3 `spark/1 ↔ mana2/1`

Rows → `layout.fingers` strings with column gaps rendered as mana2 does
(hand split after the 5th column; `skip` for `free`); thumbs → `thumbs`;
`board.kind/stagger` → `isRowStaggered` + `rowOrColumnStagger`; fingers →
mana2 digits (`LP..RP` = 0..9, thumbs 4/5). Magic → `compileMagic()`
(`to["mana2/1"]` = `fromSpark`). The reverse (`toSpark`: digits → finger
letters, flat rules → `magic.rules` (raw) + optional lift) exists as a
named export for tests (`mana2.test.ts`) and its goldens, but is not
reachable through the API — mana2/1's registry `to`/`from` are `{}`
(role `"output"`, decision 3): nothing is ever translated *from* a mana2
payload in the registry, only *to* one.

## 7. Invariants (the covenant)

| id | invariant | enforced by |
|---|---|---|
| LDB-F1 | Every stored payload validates against its declared format's frozen schema; a write that does not is refused with the failing path. | API test per format fixture; property test over random mutations of fixtures (each single-field corruption is refused) |
| LDB-F2 | `compileMagic()` is pure and deterministic: same payload → same rows in the same order, across server versions. | `.lowered.json` goldens per fixture, never edited |
| LDB-F3 | Intent is never silently lowered on write: a record whose client sent idioms stores idioms. | API test: PUT with `adaptive_swaps` reads back with `adaptive_swaps` |
| LDB-F4 | Idiom×idiom overlaps resolve as akl.gg's compile does (scaffold < chiral < explicit < swap, last wins); a collision involving a raw row is refused. *Amended 2026-09-11 (saltorbit).* | matrix: idiom×idiom (resolved), idiom×raw, raw×raw (refused); akl.gg parity property |
| LDB-F5 | `cmini → spark/1 → cmini` is identity on the `cminiDetail` projection (likes sorted) for every fixture and for the whole live set. **Narrowed by `LDB-I13`** (`20-spark.md` §4), which is now the operative wording for the adapter's exactness. | `roundtrip.test.ts` per PR; the daily D12 diff (LDB-P5) |
| LDB-F6 | A format major, once merged, is immutable: schema not tightened, fixtures unchanged. `spark/1` itself is frozen once #307 merges (S1). | a test diffs `formats/**` against `main` and fails on any edit to a frozen file (additions allowed) |
| LDB-F7 | Every registered format has ≥ 1 fixture, and for every translation it declares, a frozen `.<to>.json` golden the translation still reproduces. Extended by `LDB-F19` (19-upcast.md, S5) to every *reachable* format, not just a direct edge. | generated from the registry |
| LDB-F8 | `liftRules(compileMagic(m)) == (m, [])` for every valid idiom set; `compileMagic(lift+reconcile(rows)) ≡ rows` for every typed row set — the lift the import runs, which applies `except` hints for uncovered keys and verifies `adaptive` pairs by relowering (S3); the leftovers are exactly the rows that fail their tag's invariant, are untyped / not 2 code points, or an unverifiable `adaptive` half. | property test + the whole upstream snapshot (`lift.test.ts`, `roundtrip.test.ts`) |
| LDB-F9 | A held record keeps its name, owner and rev, and reads as its own format. Extended (19-upcast.md, S5): a held record cannot be overwritten through a format it is held for either. | API test with a fixture format registered only in the test; `held.test.ts`'s `PUT` case |
| LDB-F10 | `x` is preserved verbatim through write → read in the same format; only `x.cmini` survives `toCmini` (`?as=cmini/1`), nothing else survives any translation. | round-trip property test |
| LDB-F11 | Every live upstream detail validates as `cmini/1` (the frozen 100-layout snapshot per PR; the whole set on the daily diff), and `hasMagic` agrees with upstream's `has_magic`. **Narrowed by `LDB-I13`**, same as F5. | `cmini-envelope.test.ts`; D12 |

The full phase-1 registry, with the test file per id, is `07 §11`. The
spark/cmini/mana2/chain ids added by the one-stored-format redesign
(`LDB-F16`–`F21`, `I13`–`I14`, `F18`–`F19`) are `20-spark.md` §4 and
`19-upcast.md` §8.

## 8. Open questions (format)

1. **Free positions**: cmini's `free` is a list of positions with `~`; is a
   `free` list the right idea in `spark/1`, or should `keys` allow a `null`
   char? (Proposal: keep `free`; it is what cmini writes and what the site
   already parses.)
2. **Colstag amounts** are lost in cmini; fine? (Yes — cmini cannot say
   it.)
3. **Lift on import**: cmini's rows are typed, so the lift is exact (§3).
   Proposal: lift at import; rows that fail their tag's invariant stay raw
   with the tag kept, and the owner sees them as "raw rules" on the site.
3b. Add `chiral` and `default:<c>` to the tag vocabulary here even though
   cmini lacks them (the list is designed to grow; unknown tags are legal)?
   (Proposal: yes.)
4. **`x` size cap**: 16 KB? (Proposal: yes, per record.)
5. `#148` alt fingerings: additive minor to `spark/1` (`keys[c].alt: [...]`)
   once that design closes — flag now so nobody registers a format for it.
6. **Combos** (2 live layouts carry `combos: [{inputs, output}]`, 07 §0.1)
   ride in `x.cmini` until someone owns an idiom for them. Fine for round 1?
   (Proposal: yes; a `spark/1` minor can add `combos` later without moving
   anything, since `x.cmini.combos` → `combos` is one line in `from`.)
7. **Empty and odd layouts**: 52 upstream layouts have no keys, two have a
   row 4. They import (the format holds what cmini holds); should the site
   hide `key_count == 0` records as it hides them today? (Not a DB question
   — noted so nobody "fixes" the format instead.)
