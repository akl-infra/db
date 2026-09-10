# The layout record and its formats

Status: proposal (2026-09-08). Part of `00-plan.md`. The one document here
worth reading slowly: every other piece can be changed later; a stored
record cannot.

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
  "has_magic": true,                      // derived on every write: the format's hasMagic(payload) (lower() non-empty)
  "format": "akl/1",                      // the payload's format id
  "payload": { … }                        // see §2
}
```

No provenance field (saltorbit, round-1 review): where a record came from —
imported from cmini, created by the bot, edited on akl.gg — is the event log
(`03 §5`: `imported` events carry `source` and the upstream id; every write
carries `via`). One client adds and another edits is the normal case, so a
flag on the record would only go stale.

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

## 2. `akl/1` — the common format

This is what akl.gg writes and what most clients will read. It is the site's
existing shapes joined, so nothing is invented: cmini's `keys` map, the
board geometry from #261, the magic authoring shape from
`design/magic-rules/02-schema.md`.

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
  // kept so an imported record lowers back to the same cmini/1 word.
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
  // `x.cmini` is reserved: it holds the cmini fields akl/1 has no idiom
  // for (`tag`, `blame`, `combos`, `link`) so an imported record loses nothing
  // when its owner moves it to akl/1, and `to["cmini/1"]` copies them
  // back out (§6.2). Every other `x` key is dropped by every translation.
  "x": {}
}
```

What is deliberately **not** in `akl/1`: layers, combos, hold-taps, per-key
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
  `repeat_previous` sentinel). Plus: `magic_keys[].key`,
  `chiral_keys[].key`, `adaptive_swaps[].trigger` and `.swap[]` exist in
  `keys` (the scaffold needs their hand/position); `except[]` entries are
  single code points. A rule's `after` need **not** be a key (opal's `?◇`
  row names a char the layout does not carry — 07 §0.1).
- `magic.rules[]`: `inputs` ≥ 2 code points, `output` non-empty; no
  duplicate `inputs`; chars need not be keys.
- The lowering (§3) must succeed with no collision.

## 3. Intent and lowering

`lower(payload) → [{inputs, output, type}]` is a pure, deterministic function
shipped with the format (`formats/akl/1/index.mjs`) and is what
`?as=mana2/1` and `?as=cmini/1` emit in their `magic` fields. It is the
existing compile in `scripts/build_magic_rules.py` / `functions/_lib/rules.mjs`
(magic keys → one row per layout key not in `except` and per explicit
`after`; chiral → one row per key on the named hand; adaptive swap
`t:[h,e]` → `th→te`, `te→th`) followed by the raw `rules` appended in order.
A scaffold enumerates every layout key except the scaffolding key itself
and its `except` list — *not* every magic/chiral key (S3: upstream's
`auditor` gives its magic key `b` a repeat row from `*`). The
repeat/default scaffold enumerates **the layout's keys**, not a–z
(#221 §3.1: cmini's own rows do, and a–z gives non-Latin layouts nothing).

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

**Collision rule (D4).** Two lowered rows with the same `inputs` — whether
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

**Round trip.** `akl/1 → lower → akl/1` is lossy by construction (that is the
point: the lowering forgets the idiom). The **write** path therefore never
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

## 4. Other formats and the registry

A format is a directory:

```
db/formats/<name>/<major>/
  schema.json      JSON Schema for the payload (draft 2020-12)
  index.mjs        validate(payload)
                   lower(payload) → flat rules | null
                   to: { "<other format>/<N>": fn } (optional)
                   from: { "<other format>/<N>": fn } (optional)
  fixtures/        frozen: NNN-<name>.json (+ .lowered.json goldens, + .<to-format>.json per declared translation)
  OWNERS           GitHub handles who review changes here (04 §2)
  README.md        what this format is for, what it cannot express
```

Registered on day 1:

| format | owner | what it is | translations | notes |
|---|---|---|---|---|
| `cmini/1` | DB | cmini's v3 detail JSON verbatim minus the record fields: `board keys free? magic? combos? tag? blame? link?` (`name user likes created_at modified_at` are the record; `link` stays in the payload for import fidelity only — no record field, no verb, never surfaced) | ↔ `akl/1` lossless; → `mana2/1` composed through `akl/1` | Write it and you get a record whose payload is the cmini shape; `?as=cmini/1` from an `akl/1` record lowers board → cmini word and magic → flat `{inputs, output, type}` rows. The bot writes this. |
| `akl/1` | DB (+ akl.gg) | §2 | ↔ `cmini/1`, ↔ `mana2/1` | The hub: every other pair is composed through it. |
| `mana2/1` | Zak (mana2) | a mana2 `.jsonc` layout object (`layout.fingers/thumbs`, `board`, `fingermap`, `magic.rules`) | ↔ `akl/1`; → `cmini/1` composed through `akl/1` | mana's own write format (federation §13 "mana's write format"). Layers/combos are `todo` in mana2's own spec; when they land, `mana2/2`. |

`GET /v1/formats` advertises the composed pairs too (`cmini/1 → mana2/1`
and `mana2/1 → cmini/1`, each `akl/1` in the middle), so a client sees the
full reachable set in `can_translate_to` rather than only the direct edges
above; `?as=` accepts any advertised target.

A record whose format cannot be translated to the one a reader asked for is
**held** for that reader: stored, listed with its name/owner/rev, readable as
its own format (and any format it does translate to). Nothing is ever dropped for being
unrenderable (federation §6.5, kept). The server refuses a write in a format
it does not have registered (400 `unknown_format`) — there is no "opaque
bytes" write, because a held record that *nobody* can read is a bug, not a
feature; registering the format is a PR (`04 §2`).

An **advanced** format (say `keymaxx/1`, with combos and layers) is added the
same way, by its author, with `to["akl/1"]` if the base layer can be
expressed there (the way to appear on akl.gg and in the bot at all). akl.gg
would show that translation and say *uses features shown fully in keymaxx* — the "see it elsewhere" card from federation §6.5, in one database.

## 5. Versioning and compatibility

- Format id = `<name>/<major>`. Within a major, changes are **additive and
  optional** (a new optional key; a new enum value with a defined fallback).
  Anything else is a new major directory.
- A major is **never deleted**, its `schema.json` never tightened, its
  fixtures never edited. Adding a fixture is allowed; that is how a bug found
  in the wild becomes a permanent regression.
- Records keep their written `format`. A reader asks `?as=akl/2` and gets
  the `to["akl/2"]` translation; asks `?as=akl/1` of an `akl/2` record and
  gets the down-translation where it is lossless, `409 held` where it is not,
  with `see: "akl/2"`.
- API path version (`/v1/`) and format majors are independent. `/v1/` changes
  only if the record envelope (§1) breaks; adding fields to it does not count.
- Deprecation means "documented as not recommended". It never means 404.

## 6. Translations in day-1 formats

### 6.1 `cmini/1 → akl/1` (the import; must be lossless)

| cmini | akl/1 |
|---|---|
| `keys` | `keys` unchanged (v3 absolute thumb cols) |
| `free` (positions) | `free` |
| `board: "stagger"` | `board: {kind:"rowstag", stagger:[0,0.25,0.75], cmini:"stagger"}` |
| `board: "angle"` | `board: {kind:"rowstag", stagger:[0,0.25,0.75], cmini:"angle"}` (the angle shift is already in `keys`' cols and fingers, as cmini stores it) |
| `board: "ortho"` | `board: {kind:"ortho", cmini:"ortho"}` |
| `board: "mini"` | `board: {kind:"ortho", cmini:"mini"}` |
| `magic: [{inputs, output, type?}]` | typed rows → exact lift into `magic_keys`/`adaptive_swaps` (§3); rows whose tag invariant fails, with an unknown or absent tag, or with `inputs` ≠ 2 code points → `magic.rules` with their tag kept (`raw` when absent). |
| `tag`, `blame`, `combos`, `link` | `x.cmini: { tag, blame, combos, link }` — preserved, ignored by lowering (combos are a phase-5 idiom, not an akl/1 one; `link` is import fidelity only, saltorbit's round-1 cut) |
| `name user likes created_at modified_at` | record fields, not payload |

Golden: every cmini layout at import (4174 on 2026-09-08) satisfies
`project(toCmini(fromCmini(x))) == project(x)`, where `project` is 07 §5.1's
`cminiDetail` projection under `canonical()` with `likes` sorted. This is
the D12 diff; it runs daily in CI against the live API (`db/tests/
upstream-diff.test.ts`) and at fixture level on every PR.

### 6.2 `akl/1 → cmini/1` (what the bot and emulayout read)

`board.cmini` wins when present; otherwise derived: rowstag with ANSI stagger
→ `stagger`, ortho → `ortho`, colstag → `ortho` (cmini has no colstag; the
stagger amounts are lost, which is the documented loss), `mini` only when the
record said so. `magic` → `lower()`. `x.cmini.{tag, blame, combos, link}` are
copied back out; every other `x` key is dropped.

### 6.3 `akl/1 ↔ mana2/1`

Rows → `layout.fingers` strings with column gaps rendered as mana2 does
(hand split after the 5th column; `skip` for `free`); thumbs → `thumbs`;
`board.kind/stagger` → `isRowStaggered` + `rowOrColumnStagger`; fingers →
mana2 digits (`LP..RP` = 0..9, thumbs 4/5). Magic → `lower()`. Reverse: digits
→ finger letters, flat rules → `magic.rules` (raw) + optional lift.

## 7. Invariants (the covenant)

| id | invariant | enforced by |
|---|---|---|
| LDB-F1 | Every stored payload validates against its declared format's frozen schema; a write that does not is refused with the failing path. | API test per format fixture; property test over random mutations of fixtures (each single-field corruption is refused) |
| LDB-F2 | `lower()` is pure and deterministic: same payload → same rows in the same order, across server versions. | `.lowered.json` goldens per fixture, never edited |
| LDB-F3 | Intent is never silently lowered on write: a record whose client sent idioms stores idioms. | API test: PUT with `adaptive_swaps` reads back with `adaptive_swaps` |
| LDB-F4 | Lowering collisions are refused, never resolved. | matrix: idiom×idiom, idiom×raw, raw×raw |
| LDB-F5 | `cmini/1 → akl/1 → cmini/1` is identity on the `cminiDetail` projection (likes sorted) for every fixture and for the whole live set. | `roundtrip.test.ts` per PR; the daily D12 diff (LDB-P5) |
| LDB-F6 | A format major, once merged, is immutable: schema not tightened, fixtures unchanged. | a test diffs `formats/**` against `main` and fails on any edit to a frozen file (additions allowed) |
| LDB-F7 | Every registered format has ≥ 1 fixture, and for every translation it declares, a frozen `.<to>.json` golden the translation still reproduces. | generated from the registry |
| LDB-F8 | `liftRules(lower(m)) == (m, [])` for every valid idiom set; `lower(lift+reconcile(rows)) ≡ rows` for every typed row set — the lift the import runs, which applies `except` hints for uncovered keys and verifies `adaptive` pairs by relowering (S3); the leftovers are exactly the rows that fail their tag's invariant, are untyped / not 2 code points, or an unverifiable `adaptive` half. | property test + the whole upstream snapshot (`lift.test.ts`, `roundtrip.test.ts`) |
| LDB-F9 | A held record keeps its name, owner and rev, and reads as its own format. | API test with a fixture format registered only in the test |
| LDB-F10 | `x` is preserved verbatim through write → read in the same format; only `x.cmini` survives `to["cmini/1"]`, nothing else survives any translation. | round-trip property test |
| LDB-F11 | Every live upstream detail validates as `cmini/1` (the frozen 100-layout snapshot per PR; the whole set on the daily diff), and `hasMagic` agrees with upstream's `has_magic`. | `cmini-envelope.test.ts`; D12 |

The full phase-1 registry, with the test file per id, is `07 §11`.

## 8. Open questions (format)

1. **Free positions**: cmini's `free` is a list of positions with `~`; is a
   `free` list the right idea in `akl/1`, or should `keys` allow a `null`
   char? (Proposal: keep `free`; it is what cmini writes and what the site
   already parses.)
2. **Colstag amounts** are lost in `cmini/1`; fine? (Yes — cmini cannot say
   it.)
3. **Lift on import**: cmini's rows are typed, so the lift is exact (§3).
   Proposal: lift at import; rows that fail their tag's invariant stay raw
   with the tag kept, and the owner sees them as "raw rules" on the site.
3b. Add `chiral` and `default:<c>` to the tag vocabulary here even though
   cmini lacks them (the list is designed to grow; unknown tags are legal)?
   (Proposal: yes.)
4. **`x` size cap**: 16 KB? (Proposal: yes, per record.)
5. `#148` alt fingerings: additive minor to `akl/1` (`keys[c].alt: [...]`)
   once that design closes — flag now so nobody registers a format for it.
6. **Combos** (2 live layouts carry `combos: [{inputs, output}]`, 07 §0.1)
   ride in `x.cmini` until someone owns an idiom for them. Fine for round 1?
   (Proposal: yes; an `akl/1` minor can add `combos` later without moving
   anything, since `x.cmini.combos` → `combos` is one line in `from`.)
7. **Empty and odd layouts**: 52 upstream layouts have no keys, two have a
   row 4. They import (the format holds what cmini holds); should the site
   hide `key_count == 0` records as it hides them today? (Not a DB question
   — noted so nobody "fixes" the format instead.)
