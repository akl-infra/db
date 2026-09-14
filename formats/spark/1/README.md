# `spark/1`

The one stored format (`design/layout-db/20-spark.md` §1 decision 1; was
`akl/1`, renamed byte-for-byte -- the payload shape is unchanged): what
akl.gg writes and what most clients read. Joins the site's existing shapes
rather than inventing new ones -- cmini's `keys`/`free` map and the
magic-rules authoring shape from `design/magic-rules/02-schema.md`, plus a
raw-rule escape hatch (`magic.rules[]`). **No board field**
(`design/layout-db/26-no-board.md`): a record says where its keys sit and
which finger presses each, never what physical board it is drawn or
analysed on -- that is the reader's own choice (the site's rowstag/ortho
comparison view, the bot's engine context). 23-geometry.md's one-word
`board` (and the object before it) is gone, together with the iso width
rule, `coords`/`STAGGER_BY_KIND` and `cminiBoardWord`; `geometry.ts` keeps
the hand split and the fingering classification, both functions of `keys`
alone. No free-form `x` bag (dropped by `design/layout-db/
21-formats.md` D10, lead's call: after the D8 wipe no stored row carries
one, no format's `to`/`from` writes one, and the one reader -- the cmini
adapter's now-deleted `toCmini` -- is gone too, so there is nothing left
to reserve namespaced space for).

`magic` carries **intent** (`magic_keys`/`chiral_keys`/`adaptive_swaps`),
never the flattened rows an analyzer reads -- `compileMagic()` (was
`lower()`) derives those on demand (`?as=mana2/1`), and the registry never
stores a lowering in place of what was written (LDB-F3).
`compileMagic()`/`liftRules()` live in `magic.ts`, ported from
`scripts/magic_interop.py` (`origin/magic-api-interop` @
`f49b870f16e5261b3d2f52f3ff262e4ba94cb2d7`) and `functions/_lib/rules.mjs`
(`f6c836af561d2ff07d6c44d4f0072786a785073a`) with three deliberate
differences from the python (07 §5.2, and `magic.ts`'s own header comment
for the fourth one real upstream data forced -- a magic/chiral key's own
scaffold excludes only ITS OWN char, not every other special key's, or
`auditor`'s "b" -- both a magic key AND a normal repeat-scaffolded char --
silently loses a row on relower):

1. `except` is honoured (a char in a magic/chiral key's `except` never gets
   a scaffold row).
2. `chiral`/`default:<c>` rows are tagged (the older bridgecore/rules.mjs
   compile this format also descends from has no tags at all).
3. No rank-based dedupe: two rows sharing one `inputs` are refused
   (`magic_collision`, 01 §3 "D4"), except that an explicit
   `magic_keys[].rules[]` entry replaces its OWN key's scaffold row for the
   same `after` -- not a collision.

`db/formats/adapters/cmini/translate.ts` is the ONE place cmini import is
implemented (`fromCmini` = 01 §6.1; moved out of this directory by
20-spark.md S1 -- cmini is an import source now, not a registered format,
and D5, `21-formats.md`, deleted the `toCmini` direction and the
`?as=cmini/1` read path entirely -- there is no `cmini <-> spark/1` round
trip anymore, only cmini -> spark/1). The dependency runs adapter -> spark,
never the reverse.

## What it can't express

Layers, combos, hold-taps, per-key timing, alternate fingerings (`#148` --
an additive minor once that design closes). Those belong to advanced
formats until an idiom for them is proven in one (01 §4).

## What importing from cmini loses

`db/formats/adapters/cmini/translate.ts`'s `fromCmini` is the only cmini
conversion left (D5). It drops, permanently (there is no `x` bag to park
them in since D10, and nothing downstream reads them if there were):

- `tag`, `blame`, `combos`, `link` -- cmini-only fields `spark/1` has no
  place for.
- `board` -- cmini's `stagger`/`angle`/`ortho`/`mini` word. `spark/1` has
  no board field (26-no-board.md); the angle mod is already in the keys'
  own fingers (a fingering, 23-geometry.md §4.3), and which board a
  layout is drawn on is the reader's choice.
- `magic.rules[].note` has no cmini idiom and is dropped.

`db/tests/formats/mf9-fromcmini.test.ts` (LDB-F23, MF-9,
`design/layout-db/21-formats.md` §4) is the invariant that replaces the
old `toCmini` round-trip test: over every `upstream-100` fixture layout,
the `(char, row, col, finger)` multiset survives `fromCmini` exactly, and
the fields dropped are exactly `tag`/`blame`/`combos`/`link`/`board` --
nothing else vanishes or leaks in.

## Owner

`DB` (+ akl.gg) -- this format lives with the service. Changes go through
`OWNERS`.
