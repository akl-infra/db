# 22 — spark/1 spec (as shipped, F1)

The current, accurate spec for `spark/1` — the one stored format — after
`21-formats.md` F1 (2026-09-11) removed the transitional `akl/1` alias,
`?as=cmini/1`, and the free-form `x` field. `01-format.md` §2 and
`20-spark.md` describe the earlier design and its ledger; where they
disagree with this page, this page is what the code does today (each
carries a dated note pointing here). This page is deliberately narrower
than either: it is the format's reference, not the plan that produced it.

## 1. What it is

`spark/1` (`db/formats/spark/1/index.ts`) is a **stored** format (`role:
"stored"`), owned by `DB (+ akl.gg)`. It joins three existing shapes
rather than inventing new ones: cmini's `keys`/`free` position map, the
board geometry `#261` introduced, and the magic-rules authoring shape from
`design/magic-rules/02-schema.md`, plus a raw-rule escape hatch. It is
what akl.gg writes and what most clients read.

## 2. Payload shape

```
Payload
├─ keys: Record<char, Position>       -- required
├─ free?: Position[]                  -- positions with no character
├─ board?: Board
└─ magic?: MagicIntent

Position
├─ row: integer, 0..4
├─ col: integer, >= 0
└─ finger: one of LP LR LM LI RI RM RR RP LT RT TB

Board
├─ kind: "rowstag" | "colstag" | "ortho"   -- required
├─ stagger?: number[]                       -- 3 entries for rowstag (one per
│                                              row 0-2), one per distinct column
│                                              for colstag; absent/omitted = flat
└─ cmini?: "stagger" | "angle" | "ortho" | "mini"  -- the cmini word this
                                                       board renders as (§4)

MagicIntent
├─ magic_keys?: MagicKey[]
├─ chiral_keys?: ChiralKey[]
├─ adaptive_swaps?: AdaptiveSwap[]
├─ rules?: RawRule[]        -- the escape hatch, mana2's own flat vocabulary
├─ notes?: string
└─ updated?: string
```

`db/formats/spark/1/schema.json` is the normative shape check
(`additionalProperties: false` everywhere — an unknown field, `x` included,
is a `400 invalid_payload`, not silently dropped). Everything a plain JSON
Schema can't express — single-code-point-ness, a rule's `output` starting
with its own `after`, no duplicate `(row, col)` across `keys` ∪ `free`,
`board.cmini` agreeing with `board.kind`, magic referencing real keys, the
lowering having no collision — is `validate()`'s job (`index.ts`), in that
order. `validate()` never throws; every failure is `{ ok: false, error }`.

No `x` field. `21-formats.md` D10 removed spark/1's free-form,
client-namespaced escape hatch entirely: no format's `to`/`from` writes
one, the one format that ever read it (`toCmini`, deleted by D5) is gone,
and after the 2026-09-11 wipe no stored row carries one. A client that
needs to keep its own extras alongside a layout owns that state itself —
it is not the DB's job to shuttle it.

## 3. Magic: intent vs. lowering

`magic` holds **authoring intent**, never the flattened rows an analyzer
consumes. `compileMagic(payload)` (in `magic.ts`, formerly `lower()`)
derives those on demand — `GET .../{ref}?as=mana2/1` is the one format
that ever asks for them; the registry never stores a lowering in place of
what was written (LDB-F3). Three deliberate differences from the Python
tool this ported from, plus one real-data-forced fourth, are in
`spark/1/README.md` and `magic.ts`'s own header.

## 4. Board geometry

`board.cmini`, when present, wins outright as the cmini word this board
renders as. When absent, `cminiBoardWord(board)` derives it: `rowstag` →
`"stagger"` (cmini's vocabulary can't distinguish stagger amounts, so this
is the only word available even for a non-ANSI stagger); `ortho` and
`colstag` → `"ortho"` (a colstag board's per-column amounts have no cmini
analogue and are not recoverable from the word alone); `"mini"` is never
derived, only ever carried through an explicit `board.cmini` hint. A
`rowstag` board with no `stagger` behaves as flat for spacing purposes but
still renders as `"stagger"` once given the hint or by the derivation
above — the hint and the amounts are independent.

## 5. What it can't express

Layers, combos, hold-taps, per-key timing, alternate fingerings (`#148` —
an additive minor once that design closes). Those belong to advanced
formats until an idiom for them is proven in one (`01-format.md` §4).

## 6. Importing from cmini

`db/formats/adapters/cmini/translate.ts`'s `fromCmini` is the only
conversion into `spark/1` from outside the format (D5 deleted the
reverse). It is exact on everything `spark/1` has a place for — the
`(char, row, col, finger)` multiset, the board word by the fixed table in
§4 — and drops, permanently, exactly four cmini-only fields it has no
place for: `tag`, `blame`, `combos`, `link`. `db/tests/formats/
mf9-fromcmini.test.ts` (LDB-F23, MF-9) is the invariant: run over every
`upstream-100` fixture layout, checked against a test-local projection of
cmini's own shape (not a resurrected `toCmini`).

## 7. Worked example

A minimal but complete, schema-valid, `validate()`-passing `spark/1`
payload — extracted and checked by `db/tests/formats/spec-example.test.ts`
against this file's own copy, so this block can never silently drift from
what the code actually accepts:

```json
{
  "keys": {
    "a": { "row": 1, "col": 8, "finger": "RR" },
    "e": { "row": 3, "col": 6, "finger": "RT" },
    "n": { "row": 1, "col": 6, "finger": "RI" },
    "@": { "row": 0, "col": 1, "finger": "LR" }
  },
  "free": [{ "row": 2, "col": 5, "finger": "RI" }],
  "board": { "kind": "rowstag", "stagger": [0, 0.25, 0.75], "cmini": "angle" },
  "magic": {
    "magic_keys": [
      {
        "key": "@",
        "default": "repeat_previous",
        "rules": [{ "after": "n", "output": "nl" }],
        "except": []
      }
    ]
  }
}
```

Reading it: `@` sits at the top-left key, row 0, left ring finger. Typing
`n` then `@` lowers, via `compileMagic`, to a rule emitting `nl` — the `@`
key's *default* behavior (`repeat_previous`, meaning "repeat whatever was
typed before it") applies to every OTHER preceding key. The board is
ANSI-staggered (rows at `0, 0.25, 0.75` key-widths) and renders as cmini's
`"angle"` word (the explicit hint — without one, a `rowstag` board with
this shape would derive to `"stagger"` instead, §4). The one `free`
position is a hole in the layout — a key cmini's board has, but this
layout leaves empty.

## Owner

`DB` (+ akl.gg). Changes go through `OWNERS`, same as the format itself.
