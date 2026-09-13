# 22 — spark/1 spec (as shipped, F1)

The current, accurate spec for `spark/1` — the one stored format today,
though `21-formats.md` (F2, 2026-09-11) lets a layout hold a second one
alongside it (`lw/1`, illustrative, `architecture.md`'s "Adding a second
format" section) — after `21-formats.md` F1 (2026-09-11) removed the
transitional `akl/1` alias, `?as=cmini/1`, and the free-form `x` field.
`01-format.md` §2 and `20-spark.md` describe the earlier design and its
ledger; where they disagree with this page, this page is what the code
does today (each carries a dated note pointing here). This page is
deliberately narrower than either: it is the format's reference, not the
plan that produced it. Everything below is `spark/1`'s OWN payload shape
and validation rules -- unaffected by how many OTHER formats a layout
might also store (`db/docs/adoption.md` §3/§5 has the wire-level
`?format=`/`If-Match` mechanics that changed with F2).

## 1. What it is

`spark/1` (`db/formats/spark/1/index.ts`) is a **stored** format (`role:
"stored"`), owned by `DB (+ akl.gg)`. It joins three existing shapes
rather than inventing new ones: cmini's positions (one array now,
`design/layout-db/23-geometry.md`'s duplicate-characters follow-up folded
the old separate `free` list into it), the board geometry `#261`/
`23-geometry.md` introduced, and the magic-rules authoring shape from
`design/magic-rules/02-schema.md`, plus a raw-rule escape hatch. It is
what akl.gg writes and what most clients read.

## 2. Payload shape

```
Payload
├─ keys: Key[]                        -- required, one entry per PHYSICAL position
├─ board: Board                       -- required, one word (§4)
└─ magic?: MagicIntent

Key
├─ char?: string        -- one code point; ABSENT means a free position (no
│                           separate `free` array any more -- one list). The
│                           SAME char may repeat across several entries (a
│                           duplicate letter, e.g. a mirrored key on both
│                           hands) -- see §4.8.
├─ row: integer, 0..4
├─ col: integer, >= 0
└─ finger: one of LP LR LM LI RI RM RR RP LT RT

Board
└─ "ansi" | "iso" | "ortho" | "colstag"   -- one word; no stagger amounts, no
                                             split -- both are derived (§4)

MagicIntent
├─ magic_keys?: MagicKey[]
├─ chiral_keys?: ChiralKey[]
├─ adaptive_swaps?: AdaptiveSwap[]
└─ rules?: RawRule[]        -- the escape hatch, mana2's own flat vocabulary
                               (`notes`/`updated` are DROPPED --
                               24-spark-wire-review.md round 2 item 2:
                               no writer ever produced them)
```

`db/formats/spark/1/schema.json` is the normative shape check
(`additionalProperties: false` everywhere — an unknown field, `x` included,
is a `400 invalid_payload`, not silently dropped). Everything a plain JSON
Schema can't express — single-code-point-ness, a rule's `output` starting
with its own `after`, no duplicate `(row, col)` across `keys`, a
magic-named character being unique among `keys` (§4.8), the iso-width board
rule (§4), magic referencing real keys, the lowering having no collision —
is `validate()`'s job (`index.ts`), in that order. `validate()` never
throws; every failure is `{ ok: false, error }`. **Restated by
design/layout-db/24-spark-wire-review.md finding 10:** the fourth §4.4 rule
this page used to state ("angle/nokwts/meteorite needs board: ansi") is
dropped from `validate()` entirely — `classifyFingering` is a derived,
read-time label, never a write-time refusal; the bot enforces that rule for
its own `fingers!`/`board!` verbs instead.

No `x` field. `21-formats.md` D10 removed spark/1's free-form,
client-namespaced escape hatch entirely: no format's `to`/`from` writes
one, the one format that ever read it (`toCmini`, deleted by D5) is gone,
and after the 2026-09-11 wipe no stored row carries one. A client that
needs to keep its own extras alongside a layout owns that state itself —
it is not the DB's job to shuttle it.

**Identity (24-spark-wire-review.md finding 11):** a `char` is refused if it
is a space (`" "`) — pending `#333`'s declared space thumb, spark/1 has no
idiom for a space key yet, only mana2's own `space` token (which becomes a
free position on import instead, a documented loss). Characters are
compared by exact code point as stored: no case-folding, no Unicode
normalization, no locale-awareness — `"E"` and `"e"` are different keys.

## 3. Magic: intent vs. lowering

`magic` holds **authoring intent**, never the flattened rows an analyzer
consumes. `compileMagic(payload)` (in `magic.ts`, formerly `lower()`)
derives those on demand — `GET .../{ref}?format=mana2/1` is the one format
that ever asks for them; the registry never stores a lowering in place of
what was written (LDB-F3). Three deliberate differences from the Python
tool this ported from, plus one real-data-forced fourth, are in
`spark/1/README.md` and `magic.ts`'s own header.

## 4. Board geometry

`board` is one required word — `ansi`, `iso`, `ortho` or `colstag`
(design/layout-db/23-geometry.md §4.1) — never an object: no stagger
amounts, no split column, both are derived, never stored. The kind fixes
the physical stagger (`db/formats/spark/1/geometry.ts`'s
`STAGGER_BY_KIND`): `ansi` is cmini's ANSI row stagger (`[0, 0.25, 0.75]`);
`iso` shifts row 2 the OTHER way (`[0, 0.25, -0.25]`) and gets one extra key
at col 0; `ortho`/`colstag` are flat (`[0, 0, 0]`) — a colstag board's
per-column amounts have no place in the record at all (23-geometry.md §4.1:
"colstag does not get to set stagger"). The hand split (`handSplit()`) and
the named-fingering classification (`classifyFingering()`) are likewise
pure functions of `(board, keys)`, never stored.

`cminiBoardWord(board)` derives the cmini word a board renders as, for
clients (the bot) that still speak cmini's vocabulary: `ansi`/`iso` →
`"stagger"` (cmini can't distinguish them, or tell ANSI stagger from the old
`"angle"` word — the angle mod is a FINGERING now, not a board word, §4.3);
`ortho`/`colstag` → `"ortho"` (colstag's shape has no cmini analogue).
`"mini"` is never produced any more.

**Validation (`validate()`, §4.4 of 23-geometry.md, in order):** (1) `board`
is one of the four words (the schema's `enum`); (2) on `iso`, row 2 may be at
most one column wider than rows 0-1 (never an error for narrower or equal);
(3) a thumb key (`LT`/`RT`) never sits on a finger row (0-2). §4.4's ORIGINAL
fourth rule ("angle/nokwts/meteorite needs board: ansi") is NOT enforced
here any more (24-spark-wire-review.md finding 10) — see the note above.

## 4.8 Duplicate characters

`keys` is one array of positions (§2), not a char-keyed map, exactly so the
same character can sit on more than one physical position (a mirrored key
on both hands, e.g. a `y` on each side of a symmetric-ish layout). The only
constraint: every character a MAGIC construct actually *names* — a magic or
chiral key's own `key`, an adaptive swap's `trigger` or either `swap[]`
member, a magic key rule's `after`, any `except[]` entry — must be unique
among `keys`' char-bearing entries; magic addresses a layout by character,
so a named char with more than one occurrence is genuinely ambiguous.
Refused `400 magic_needs_unique_key`, naming the character (at MOST one
entry — zero is fine: a char no magic construct's own scaffold enumerates
just never gets a row for it, no error). A plain duplicate letter that no
magic construct references carries no such requirement — UNLESS its own
entries span both hands, in which case any `chiral_keys[]` whose scaffold
would enumerate it is refused the same way (a chiral scaffold needs one
well-defined hand per char) unless that key excepts the char OR a raw
`rules[]` row already covers the exact `(char, chiral key)` pair (chiral
keys have no `rules[]` of their own to carve this out any other way).

Both the magic-key/chiral-key board-char scaffold and the chiral self-row
enumeration reach EVERY layout char, thumb-key chars included (LDB-F15's
"every layout key" has always meant every key, not just the three finger
rows) — a magic key on a thumb, or a thumb char used as a chiral scaffold
target, is ordinary. Two thumb rows are allowed (row 3 AND row 4, both
`>= 3`); a renderer places them by column, same as a single thumb row. A
free entry (no `char`) still requires `finger` — there is no "positionless"
entry.

Lowering to `mana2/1` (which refuses duplicate letters outright) resolves a
duplicate by picking the FIRST ENTRY FOR THAT CHAR IN LIST ORDER
(24-spark-wire-review.md finding 5 — `keys`' own array order, NEVER
resorted or canonicalised by row/col) as the analysed key; every later
occurrence of that same character becomes a `skip` cell — the position
survives (and its finger, for stats), the character does not. A documented,
permanent `LDB-F5` loss, not a hold.

## 5. What it can't express

Layers, combos, hold-taps, per-key timing, alternate fingerings (`#148` —
an additive minor once that design closes). Those belong to advanced
formats until an idiom for them is proven in one (`01-format.md` §4).

## 6. Importing from cmini

`db/formats/adapters/cmini/translate.ts`'s `fromCmini` is the only
conversion into `spark/1` from outside the format (D5 deleted the
reverse). It is exact on everything `spark/1` has a place for — the
`(char, row, col, finger)` multiset (over `keys`' entries, `char` absent
for what used to be a separate `free` array) — the board word by the fixed
table in §4 (`stagger`/`angle` → `ansi`, `ortho`/`mini` → `ortho`; NO
angle-family bump any more, 24-spark-wire-review.md finding 10 — import is
faithful to the word alone) — and drops, permanently, exactly four
cmini-only fields it has no place for: `tag`, `blame`, `combos`, `link`. It
also relabels every `TB` finger, or `LT`/`RT`
thumb whose column disagrees with `col < 5 => LT else RT` (cmini never has
duplicate characters, so this relabelling is unambiguous). `db/tests/
formats/mf9-fromcmini.test.ts` (LDB-F23, MF-9) is the invariant: run over
every `upstream-100` fixture layout, checked against a test-local
projection of cmini's own shape (not a resurrected `toCmini`).

## 7. Worked example

A minimal but complete, schema-valid, `validate()`-passing `spark/1`
payload — extracted and checked by `db/tests/formats/spec-example.test.ts`
against this file's own copy, so this block can never silently drift from
what the code actually accepts:

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

Reading it: `@` sits at the top-left key, row 0, left ring finger. Typing
`n` then `@` lowers, via `compileMagic`, to a rule emitting `nl` — the `@`
key's *default* behavior (`{"kind": "repeat"}`, meaning "repeat whatever was
typed before it" — design/layout-db/24-spark-wire-review.md finding 6's
tagged sentinel, round 2's `kind`-discriminated spelling, replacing the old
bare string `"repeat_previous"`) applies to every OTHER preceding key. The
board is
`ansi` (row-staggered, `0, 0.25, 0.75` key-widths). `e` sits on TWO
positions (row 1 and row 2, both left index) — a duplicate character, valid
because nothing in `magic` names `e` (§4.8); lowering to `mana2/1` would
keep only the row-1 occurrence as the analysed `e`, the row-2 one becoming
a `skip` cell. The one entry with no `char` (row 2, col 5) is a free
position — a key cmini's board has, but this layout leaves empty.

## Owner

`DB` (+ akl.gg). Changes go through `OWNERS`, same as the format itself.
