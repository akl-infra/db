# 22 — spark/1 spec (normative, as implemented)

This is the normative specification of `spark/1`, the one stored layout
format (`db/formats/spark/1/`). Every rule below is backed by the schema, a
`validate()` branch, an invariant id (`LDB-F..`/`LDB-P..`), or a golden
file, cited in small print under the rule. Known gaps between this page
and the code are tracked in `design/layout-db/review/LEDGER.md` (row S1)
rather than resolved silently here.

## 0. Status and versioning

`spark/1` is edited in place until akldb's first outside adopter. Today
the frozen-fixture list is empty, so no fixture is protected from a
same-slice edit.

*Enforced by: `db/tests/formats/frozen.test.ts` (empty list); `db/INVARIANTS.md` LDB-F6 (suspended).*

After the first outside adopter, a change is same-major iff every existing
fixture's `.lowered.json` and `.mana2-1.json` golden stays byte-identical.
Anything that changes a golden is a new major. A pinned major keeps
reading and writing (the promise `db/docs/adoption.md` §8 makes for a
future major).

*This rule is a review policy, not yet a mechanical gate: `frozen.test.ts` only compares against an explicit list that is empty today, so nothing in CI currently stops a same-major edit from changing a golden (LEDGER.md row S1).*

akl.gg and the spark bot read and write `spark/1`. Nothing requires any
other client to.

*`db/docs/adoption.md` §1.*

Owner: `DB` (+ akl.gg). Changes go through `db/formats/spark/1/OWNERS`.

## 1. Record vs payload

A layout is one record. The record's own fields (its **envelope**) are
independent of any format it stores; `spark/1` is only the payload shape
below.

| envelope (layout identity, format-independent) | payload (`spark/1`'s own shape) |
|---|---|
| `id` (ULID, the identity: see §2's note on identity), `name`, `owner`, `layout_rev`, `created_at`, `modified_at`, `deleted`, `like_count`, `link`, `upstream`, `source` | `keys`, `board`, `magic?` |
| `formats["spark/1"]`: `{rev, created_at, modified_at, has_magic, source}` | |

*Envelope shape: `db/src/core/records.ts:26-63` (`LayoutRow`, `FormatRow`).*

Identity is the record's id, an ULID minted at creation, never the name. A
rename keeps the id, rev chain, likes and history. `{ref}` in a route
resolves by id first, then by name; a lookup by name is a lookup, not an
identity.

*`db/src/core/records.ts:65-69` (`isUlidShaped`, `ULID_RE`).*

Two payload fields the earlier design proposed were dropped entirely
rather than kept as non-semantic: `magic.notes` and `magic.updated`. No
writer ever produced them (neither the importer nor `liftRules`), and a
field that is "non-semantic" but still bumps `payload_json`'s canonical
bytes (and so a format rev) on every touch is a contradiction on the wire.
The schema refuses both outright.

*`db/formats/spark/1/magic.ts:107-119`; `db/formats/spark/1/schema.json` (`magic`'s `additionalProperties: false`, lines 32-52).*

Two envelope fields the review round found genuinely missing are now
implemented, not deferred:

- **A display name for `owner`.** `GET /v1/authors` and `GET
  /v1/authors/{user_id}` map a Discord snowflake to a name and back.
  *`db/src/routes/authors.ts`.*
- **A moderated `link`.** `link: string | null` on the envelope is the
  layout's approved link; a pending, rejected or superseded value never
  reaches it or any public wire shape. The importer can also approve a
  link automatically from cmini's own `link` field.
  *`db/src/core/records.ts:46-49`; `db/INVARIANTS.md` LDB-MD3, LDB-MD5.*

Still genuinely deferred, by name: a layout date distinct from the
record's own `created_at` (cmini's own authoring date, when it differs
from when akldb first imported the layout), and view counts. Neither
has a column, a route or an invariant today.

## 2. Identity

A `char` is one Unicode code point, compared exactly as stored: no
case-folding, no Unicode normalization (writers should send NFC), no
locale rules, nothing reserved. `"E"` and `"e"` are different keys.

*Enforcement scope, as implemented, is narrower (LEDGER.md row S1): `validate()` only checks single-code-point-ness for characters a magic construct NAMES (`isSingleChar`, `db/formats/spark/1/magic.ts:37-39`, called from `validateMagicSemantics`), never for a plain `keys[].char` entry.*

`" "` (a literal space) is refused as a `char` value on any `keys` entry,
pending #333's declared space thumb. mana2's own `space` token becomes a
free position on import instead (a documented, permanent loss, §8).

*`db/formats/spark/1/index.ts:277-281` (`validateGeometry`'s first check, `400 invalid_payload`).*

A position is `(row, col)`, both integers (`row` 0 to 4, `col` >= 0). No
two `keys` entries may share a position; the same character may still sit
on more than one position (a duplicate letter, §3).

*Schema: `db/formats/spark/1/schema.json:24-25`. Uniqueness: `db/formats/spark/1/index.ts:123-134` (`findDuplicatePosition`, `400 invalid_payload`, path `/keys/<i>` of the second entry).*

## 3. Keys

`keys` is a required, ordered array. Each entry is `{char?, row, col,
finger}`. `row`, `col` and `finger` are required on every entry, including
a free position (no `char`): there is no "positionless" entry, and a free
position still needs a finger for the hand split and the mana2 fingermap.

*Schema: `db/formats/spark/1/schema.json:18-29` (`required: ["row","col","finger"]`).*

`finger` is one of `LP LR LM LI RI RM RR RP LT RT`. `TB` is not in the
enum: it never reaches storage. The importer resolves every `TB` (and
every `LT`/`RT` whose column disagrees with its side) to `LT`/`RT` by
column at import time (§8); nothing downstream ever sees `TB` again.

*Schema: `db/formats/spark/1/schema.json:26-28`. LDB-F28.*

The same character may appear on more than one entry (a mirrored key on
both hands, e.g. two `y`s). `keys` is never resorted or canonicalised by
position: **array order is the contract.** For a character with more than
one entry, the first entry in list order (never the lowest `(row, col)`)
is its primary; every later entry for that character is a secondary
occurrence (what happens to it on lowering is §7).

*`db/formats/spark/1/index.ts:136-153` (`charMap`, the primary-selection rule used by validation, magic lookups and the mana2 lowering); LDB-F33; `db/formats/mana2/1/translate.ts` (the reciprocal "list order is the analysed key" rule at the duplicate-lowering site, around line 432).*

A character that a magic construct actually **names** — a magic key's own
`key`, a chiral key's own `key`, an adaptive swap's `trigger` or either
`swap[]` member, a magic key rule's `after`, or any `except[]` entry —
must have **at most one** entry among `keys`' char-bearing entries. Zero is
fine (a named key need not be on the layout at all, LDB-F22): it simply
gets no scaffold row. More than one is refused.

*`db/formats/spark/1/index.ts:218-260` (`collectMagicChars`, `validateMagicKeysUnique`); error `400 magic_needs_unique_key`, path `/keys` — not `/keys/<i>` (LEDGER.md row S1). LDB-F33.*

A plain duplicate character that no magic construct names carries no such
requirement, **unless** its own entries span both hands. In that case any
`chiral_keys[]` entry would have no well-defined hand to enumerate it
against, so it is refused for that chiral key unless the chiral key
excepts the character, or a raw `rules[]` row already covers the exact
`(character, chiral key)` pair.

*`db/formats/spark/1/index.ts:163-210` (`bothHandsChars`, `validateChiralHandAmbiguity`); error `400 magic_needs_unique_key`, path `/keys`. LDB-F33.*

A magic-named or chiral-hand-ambiguous character that is refused this way
still resolves automatically for the case the format DOES allow: an
explicit rule for a two-handed character fires on whichever physical key
produced the emitted character, since a lowered row's context is the
emitted character (§5.4), which carries no hand. This is not a special
case anyone codes; it falls out of character-identity contexts.

## 4. Board and thumbs

`board` is a required, single word: one of `ansi`, `iso`, `ortho`,
`colstag`. There is no default at the wire level; every payload states its
own board. (A bot command line may default an unstated board word to
`ansi` at authoring time; that is a client convenience, not a format
default.)

*Schema: `db/formats/spark/1/schema.json:8,14` (`required: ["keys","board"]`; the enum).*

**The coordinate function is the contract.** Physical `(x, y)` for a
`(kind, row, col)` position:

| kind | x | y | notes |
|---|---|---|---|
| `ansi` | `col + [0, 0.25, 0.75][min(row,2)]` | `row` | cmini's ANSI row stagger; the default board |
| `iso` | `col + [0, 0.25, -0.25][min(row,2)]` | `row` | row 2 shifts left instead of right; an ISO key is simply an extra `keys` entry, no special column reserved for it |
| `ortho` | `col` | `row` | flat |
| `colstag` | `col` | `row` | flat; the word is for renderers, never for per-column stagger amounts |

*`db/formats/spark/1/geometry.ts:44-58` (`STAGGER_BY_KIND`, `coords`). LDB-F30 (one function, exported, no second port inside `db/`).*

On `iso`, row 2 may be at most one column wider than rows 0-1 (never an
error for equal or narrower width, and checked on no other board).

*`db/formats/spark/1/index.ts:283-296` (`validateGeometry`, rule 2); `400 invalid_payload`. LDB-F27.*

**The hand split is derived, never stored.** `handSplit(keys)` is, over
finger rows (row <= 2) that have both a left-hand and a right-hand entry,
the minimum "one past the last left-hand column" across those rows; the
default is column 5 when no row qualifies. The mana2 lowering splits every
row string at this column.

*`db/formats/spark/1/geometry.ts:60-108` (`handSplitRows`, `handSplit`). LDB-F30.*

**Thumbs.** A thumb key is any entry whose `finger` is `LT` or `RT`; it
must sit on row >= 3 (never on a finger row, 0-2). Two thumb rows (3 and
4) are both legal; a non-thumb key on row 3 is also legal (the 22 real
number-row layouts). **The label is the hand**: a key's finger being `LT`
or `RT` is what makes it a left or right thumb, at whatever column it
sits, never re-derived by column.

*Row restriction: `db/formats/spark/1/index.ts:298-310` (`validateGeometry`, rule 3), comment explicitly notes rows >= 3 are otherwise unrestricted. LDB-F27. Label-is-hand: `db/formats/mana2/1/translate.ts` (`fromSpark`'s thumb-string split checks `finger === "LT"` / `"RT"` directly, no column re-anchoring) and `LDB-F29`.*

**Named fingerings are derived labels, never stored, and never refuse a
write.** `classifyFingering(keys)` classifies a layout's rows 0-2 against
four fixed references (`standard`, `angle`, `nokwts`, `meteorite`, left
hand only; the right hand is always `RI RI RM RR RP`), else `custom`. The
board word never gates this classification at write time: a payload whose
fingers happen to read as `angle` on an `ortho` board is accepted. "Angle
(or nokwts/meteorite) only makes sense on ansi" is a rule the **bot**
enforces for its own `fingers!`/`board!` verbs, not something `validate()`
checks.

*`db/formats/spark/1/geometry.ts:143-190` (`classifyFingering`, `FINGERING_REFS`). LDB-F27, LDB-F30, LDB-F32. Explicit drop of the write-time rule: `db/formats/spark/1/index.ts:262-270`'s own comment ("Rule 4 ... is NOT enforced here").*

## 5. Magic

### 5.1 The primitive

Every idiom `magic` expresses expands to one shape: a binding `(context,
key) -> output`, where context is the character emitted immediately
before `key` was pressed, or `' '` at word start. `rules[].inputs` is that
same pair spelled out directly (a two-code-point string: context then
key). `magic_keys`, `chiral_keys` and `adaptive_swaps` are macros over this
one primitive; `compileMagic()` is the expansion.

*`db/formats/spark/1/magic.ts:189-297` (`computeRows`, the one function that performs every expansion).*

### 5.2 Idioms and their expansions

**Magic keys** (`magic_keys[]`, each `{key, default?, rules?, except?}`).
For every other layout character `c` not excluded (see 5.5's exclusion
rule) and not in `except`:

- `default: {kind: "repeat"}` emits the row `c+key -> c+c`, tag `repeat`.
- `default: {kind: "char", char: "e"}` emits `c+key -> c+e`, tag `default:e`.
- no `default` emits nothing for `c`.

A literal (`char`) default additionally emits one word-start row, `'
'+key -> ' '+default.char` (not gated by `except`, since the site's own
scaffold this ports has no such list for this one row); a repeat default
gets no such row (repeating a space types text nobody analyzes).

*`db/formats/spark/1/magic.ts:219-260`. LDB-F14 (the word-start row), LDB-F15 (the exclusion rule, below).*

`magic_keys[].rules[]` (each `{after, output}`) is an explicit override:
it emits `after+key -> output` directly, and REPLACES that key's own
scaffold row for the same `after` rather than colliding with it.

*`db/formats/spark/1/magic.ts:257-259`.*

**Chiral keys** (`chiral_keys[]`, each `{key, same?, opposite?, except?}`).
For every layout character `c` with a resolvable hand, not in `except`:
emits `c+key -> c+(c or same/opposite's char)`, using `same` when `c` is
on the chiral key's own hand, `opposite` otherwise. The chiral key's own
character is itself enumerated (it is always on its own hand, so it always
takes `same`), producing a self row `key+key`.

*`db/formats/spark/1/magic.ts:272-284`. LDB-F15.*

**Adaptive swaps** (`adaptive_swaps[]`, each `{trigger, swap: [a, b]}`)
emit two rows: `trigger+a -> trigger+(what b emits after trigger)` and the
mirror. "What b emits after trigger" is `b`'s own character unless `b` is
itself a magic key with a rule or default for that trigger, in which case
that rule's/default's output character is used instead.

*`db/formats/spark/1/magic.ts:169-180` (`emission`), `:286-290`.*

**The exclusion rule (LDB-F15).** Every magic key's own character and
every chiral key's own character is excluded from every OTHER key's
board-character scaffold, globally, not just from its own. This is why a
character that is itself a magic key still needs an explicit rule (not the
scaffold) to get a row from another key's default.

*`db/formats/spark/1/magic.ts:196-218` (`specialChars`, built once and passed to every scaffold loop).*

**`rules[]` is the primitive, exposed raw**, not a second vocabulary: it
is appended in author order after every idiom, addresses `(inputs,
output)` directly, and is never resolved against an idiom row on a
collision (5.3). A client writing `rules[].type` as one of the reserved,
idiom-produced words (`repeat`, `magic`, `chiral`, `adaptive`, or a
`default:<c>` shape) is refused: only the importer's own lift may produce
those tags.

*`db/formats/spark/1/magic.ts:292-294` (emission), `:777-797` (the reservation check, `400 reserved_rule_type`) — no dedicated test or fixture and no registered `LDB-F..` id yet (LEDGER.md row S1).*

### 5.3 Expansion order and collisions

Rows from every idiom are resolved by phase, lowest to highest: magic-key
scaffold (0) < chiral-key scaffold (1) < magic-key explicit rules (2) <
adaptive swaps (3). Within one `inputs`, the later phase wins; within one
phase, the later-emitted row wins. `rules[]` (phase 4, the raw escape
hatch) never takes part in this resolution: **any collision that includes
a raw row is refused**, never resolved by phase.

*`db/formats/spark/1/magic.ts:299-343` (`phaseOf`, `resolveRows`), `:356-390` (`findCollision`); error `400 magic_collision`, naming both sources and, for a scaffold/raw collision, an `except` hint. LDB-F4.*

### 5.4 Contexts are character identity

A row's context is the character the layout emits, never which physical
key produced it. Behaviour that differs between character-identity and
keystroke-identity firmware (chained magic where one key's output feeds
another key's context, overlapping contexts) is outside what this format
records. An author who needs that distinction authors in a format that has
the disambiguator; `spark/1` does not.

*Structurally: `computeRows`'s `keys: Record<string, Position>` is addressed by character, never by physical key (`db/formats/spark/1/magic.ts:152-155`, `handOf`).*

### 5.5 Duplicates, sentinels

See §3 for the uniqueness rule itself (LDB-F33). `default` (on a magic
key) and `same`/`opposite` (on a chiral key) are a `kind`-discriminated
tagged union, never a bare string: `{kind: "repeat"}` or `{kind: "char",
char: "e"}`; absent means none. The strings `"none"` and `"repeat_previous"`,
and a bare character string, are refused by the schema.

*Schema: `db/formats/spark/1/schema.json:70-79` (`magicDefault`, `chiralValue`, `oneOf` with `additionalProperties: false` per branch). Types and guards: `db/formats/spark/1/magic.ts:46-59` (`isRepeatTag`, `isCharTag`), `:61-93` (`MagicDefault`, `ChiralKey`).*

## 6. Validation

`validate(p)` never throws; it returns `{ok: true}` or `{ok: false,
error}`. Checks run in this order, each stopping at the first failure:

| # | check | error | path |
|---|---|---|---|
| 1 | JSON Schema (`schema.json`, `additionalProperties: false` everywhere) | `invalid_payload` | the failing instance path |
| 2 | no two `keys` entries share `(row, col)` | `invalid_payload` | `/keys/<i>` of the second entry |
| 3 | a `char` is never `" "` | `invalid_payload` | `/keys/<i>` |
| 4 | on `iso`, row 2 is at most one column wider than rows 0-1 | `invalid_payload` | `/keys` |
| 5 | no `LT`/`RT` finger on rows 0-2 | `invalid_payload` | `/keys/<i>` |
| 6 | every magic-named character has at most one entry (§3) | `magic_needs_unique_key` | `/keys` |
| 7 | a both-hands duplicate is excepted or ruled for every chiral key that would enumerate it (§3) | `magic_needs_unique_key` | `/keys` |
| 8 | magic semantics (single-code-point fields, rule shapes, no duplicate `after`, no magic/chiral key sharing a character, reserved `rules[].type` words) | `invalid_payload` or `reserved_rule_type` | `/magic/...` |
| 9 | the lowering has no collision (5.3) | `magic_collision` | the later side's `/magic/...` pointer |

*`db/formats/spark/1/index.ts:321-378` (`validate`), in this exact order. Checks 6-9 read `payload.magic` only when present.*

Check 1's reported error is the MOST SPECIFIC ajv error for the violation, never just the first one ajv happens to produce (LDB-F35).

PATCH edits (`setFingermap`, `setBoard`, `setMagic`,
`db/formats/spark/1/edits.ts`) apply their own change and then rely on the
pipeline re-running `validate()` on the result; they duplicate none of the
above. `setFingermap` additionally refuses a named character that is not
on the layout, or that has more than one entry (it cannot tell which one a
bare `char -> finger` map means).

*`db/formats/spark/1/edits.ts:28-41`; error `invalid_payload`, path `/keys` (LEDGER.md row S1).*

## 7. Lowering to `mana2/1`

`spark1.to["mana2/1"]` (`fromSpark`) never holds for a payload
`validate()` accepts: mana2's vocabulary is a strict subset of what
`spark/1` can express, never a lossy write target on the way up.

*`db/formats/mana2/1/translate.ts`. LDB-F17, `db/tests/formats/lowerable.test.ts`.*

The board table reverses §4's coordinate function: `ansi`/`iso` become
`isRowStaggered: true` with the matching `STAGGER_BY_KIND` amounts (`iso`
keeping its 11-token row 2 as mana2's own `stand_iso` shape expects);
`ortho`/`colstag` become `isRowStaggered: false` with an all-zero stagger.
Row strings split at `handSplit(keys)`. Thumb strings are built purely
from the finger label (`LT`/`RT`), by column within each side.

*`db/formats/mana2/1/translate.ts:400-423` (`boardFromSpark`), `:453-460` (thumb-string assembly by finger label).*

**Duplicate characters are a documented, permanent loss.** For a character
with more than one `keys` entry, the primary (§3, first in list order) is
the analysed key; every later occurrence lowers to a `skip` cell: the
position (and its finger, for stats) survives, the character does not.

*`db/formats/mana2/1/translate.ts:419-432` (comment and implementation); `db/formats/spark/1/fixtures/905-duplicate-chars.{json,mana2-1.json}` (the `y` at row 1 col 4 becomes `skip`). LDB-F33.*

An empty layout still lowers: it emits a single empty-string `fingers`
row, since mana2's own schema requires at least one row. Magic intent is
flattened to `magic.rules[]`: the idiom vocabulary is gone on the mana2
side, the rows it produced are not.

*`db/docs/adoption.md` §7 "Lowering to `mana2/1`".*

## 8. Import from cmini

`db/formats/adapters/cmini/translate.ts`'s `fromCmini` is the only
conversion into `spark/1` from outside the format; there is no reverse.

Board word table:

| cmini | spark |
|---|---|
| `stagger` | `ansi` |
| `angle` | `ansi` (the angle mod is already in the keys' own fingers) |
| `ortho` | `ortho` |
| `mini` | `ortho` |

*`db/formats/adapters/cmini/translate.ts:26-31` (`WORD_TABLE`). No angle-family bump: LDB-F31.*

A `TB` finger, or an `LT`/`RT` whose column disagrees with `col < 5 =>
LT else RT`, is relabelled by that rule (the last time this ever runs); an
`import_relabel` info event names every relabelled key.

*`db/formats/adapters/cmini/translate.ts:33-39`; LDB-F28.*

`fromCmini` is exact on the `(char, row, col, finger)` multiset (mod the
relabel above) and drops exactly four cmini-only fields it has no payload
idiom for: `tag`, `blame`, `combos`, and `magic.rules[].note`. `link` is
NOT dropped: it is carried to the record's own envelope by a separate
importer path (`importLink`), moderated the same way an admin-approved
link is, never written into the payload.

*`db/formats/adapters/cmini/translate.ts:180-190`; `db/src/import/apply.ts:242-355` (`importLink`, `latestLinkVia`). LDB-F23 (MF-9), LDB-MD3. Test: `db/tests/formats/mf9-fromcmini.test.ts` over `upstream-100`.*

## 9. Reader and writer obligations

Readers ignore unknown fields on a payload; only the server refuses them
at write time. A client that does not understand every field of a record
uses `PATCH`, never `PUT`, so it never has to round-trip fields it cannot
parse. A client validates against the schema served at `GET
/v1/formats/spark/1/schema.json`, never a copy it vendored itself.

*Schema route: `db/src/routes/formats.ts:44-52` — the served schema itself
is `additionalProperties: false` everywhere, in tension with "readers
ignore unknown fields" for a client that validates against it as
instructed (LEDGER.md row S1).*

## 10. What it cannot express

| not expressible | tracked as |
|---|---|
| layers, combos, hold-taps, per-key timing | `01-format.md` §4 (advanced formats, not this one) |
| alternate fingerings | `#148` |
| a declared space thumb / space as a `char` | `#333` |
| per-column stagger amounts, key wells, chorded input | `23-geometry.md` non-goals |

## 11. Worked examples

Extracted and pinned by `db/tests/formats/spec-example.test.ts` (`[LDB-F24]`):
every fenced JSON block below is parsed straight from this file and run
through the real `validate()`, so this section can never silently drift
from what the code accepts. Ran with:

```
cd db && npx vitest run tests/formats/spec-example.test.ts
```

**Example 1: plain ANSI, a duplicate character, tagged magic, a free
position.**

```json
{
  "keys": [
    { "char": "a", "row": 1, "col": 8, "finger": "RR" },
    { "char": "e", "row": 1, "col": 3, "finger": "LI" },
    { "char": "e", "row": 2, "col": 3, "finger": "LI" },
    { "char": "n", "row": 1, "col": 6, "finger": "RI" },
    { "char": "@", "row": 0, "col": 1, "finger": "LR" },
    { "row": 2, "col": 5, "finger": "RI" }
  ],
  "board": "ansi",
  "magic": {
    "magic_keys": [
      {
        "key": "@",
        "default": { "kind": "repeat" },
        "rules": [{ "after": "n", "output": "nl" }],
        "except": []
      }
    ]
  }
}
```

`@` sits at row 0, left ring finger. Typing `n` then `@` lowers to a rule
emitting `nl`; `@`'s default (`{"kind": "repeat"}`) repeats every OTHER
preceding key. `e` has two entries (row 1 and row 2, both left index): a
duplicate character, valid because nothing in `magic` names `e`; lowering
would keep the row-1 occurrence and turn the row-2 one into a `skip` cell.
The entry with no `char` (row 2, col 5) is a free position.

**Example 2: `iso`, a free position, one thumb key** (a real, tested
fixture: `db/formats/mana2/1/fixtures/003-stand_iso.spark-1.json`, mana2's
own `stand_iso` layout round-tripped into `spark/1`).

```json
{
  "keys": [
    { "char": "f", "row": 0, "col": 0, "finger": "LP" },
    { "char": "m", "row": 0, "col": 1, "finger": "LR" },
    { "char": "z", "row": 0, "col": 5, "finger": "RI" },
    { "char": ".", "row": 0, "col": 9, "finger": "RP" },
    { "char": "q", "row": 2, "col": 0, "finger": "LP" },
    { "char": "g", "row": 2, "col": 4, "finger": "LI" },
    { "row": 2, "col": 5, "finger": "LI" },
    { "char": ",", "row": 2, "col": 10, "finger": "RP" },
    { "row": 3, "col": 4, "finger": "LT" }
  ],
  "board": "iso"
}
```

Row 2 runs 11 columns wide (cols 0-10), one wider than rows 0-1 (10 wide):
legal under §4's iso-width rule. The `(row: 2, col: 5)` entry is a free
position, sitting exactly where the ISO board's extra key falls. The
`(row: 3, col: 4)` entry, finger `LT`, is a thumb key with no `char`
assigned.

**Example 3: `colstag`, six thumb keys across one thumb row** (a real,
tested fixture: `db/formats/spark/1/fixtures/900-colstag.json`).

```json
{
  "keys": [
    { "char": "q", "row": 0, "col": 0, "finger": "LP" },
    { "char": "y", "row": 0, "col": 5, "finger": "LI" },
    { "char": "u", "row": 0, "col": 6, "finger": "RI" },
    { "char": "]", "row": 0, "col": 11, "finger": "RP" },
    { "char": "1", "row": 3, "col": 3, "finger": "LT" },
    { "char": "2", "row": 3, "col": 4, "finger": "LT" },
    { "char": "3", "row": 3, "col": 5, "finger": "LT" },
    { "char": "4", "row": 3, "col": 6, "finger": "RT" },
    { "char": "5", "row": 3, "col": 7, "finger": "RT" },
    { "char": "6", "row": 3, "col": 8, "finger": "RT" }
  ],
  "board": "colstag"
}
```

(Rows 1-2 are omitted here for brevity; the real fixture has the full
30-key main grid.) `handSplit` reads as column 6 (the last left-hand
column in the main rows is 5). All six thumbs sit on row 3, three per
side, ordered by column; nothing about a `colstag` board changes how a
thumb is expressed.
