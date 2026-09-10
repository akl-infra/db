# `spark/1`

The one stored format (`design/layout-db/20-spark.md` §1 decision 1; was
`akl/1`, renamed byte-for-byte -- the payload shape is unchanged): what
akl.gg writes and what most clients read. Joins the site's existing shapes
rather than inventing new ones -- cmini's `keys`/`free` map, the board
geometry from `#261`, and the magic-rules authoring shape from
`design/magic-rules/02-schema.md`, plus a raw-rule escape hatch (`magic.
rules[]`) and a free-form, client-namespaced `x`.

`magic` carries **intent** (`magic_keys`/`chiral_keys`/`adaptive_swaps`),
never the flattened rows an analyzer reads -- `compileMagic()` (was
`lower()`) derives those on demand (`?as=cmini/1`, `?as=mana2/1`), and the
registry never stores a lowering in place of what was written (LDB-F3).
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

`db/formats/adapters/cmini/translate.ts` is the ONE place `cmini <-> spark/1`
is implemented (`fromCmini` = 01 §6.1, `toCmini` = 01 §6.2; moved out of
this directory by 20-spark.md S1 -- cmini is an import source now, not a
registered format). This format only exports the pure `cminiBoardWord`
helper (was the private `deriveCminiWord`) the adapter's `toCmini` calls
back into; the dependency runs adapter -> spark, never the reverse.

## What it can't express

Layers, combos, hold-taps, per-key timing, alternate fingerings (`#148` --
an additive minor once that design closes). Those belong to advanced
formats until an idiom for them is proven in one (01 §4).

## Documented losses (the cmini adapter's `toCmini`, 01 §6.2)

- `board.kind: "colstag"` has no cmini word: it becomes `"ortho"` and the
  per-column stagger amounts are dropped.
- A board with no `cmini` hint gains one on the round trip (cmini
  "remembers" its own word); a `rowstag` board's `stagger` is normalised to
  the ANSI amount `[0, 0.25, 0.75]` regardless of what it held (cmini has no
  other way to say "rowstag").
- `magic.rules[].note` has no cmini idiom and is dropped.
- Every `x` key other than `x.cmini` is dropped (LDB-F10); `x.cmini`
  round-trips as cmini's own `tag`/`blame`/`combos`/`link`.
- A row whose tag's invariant doesn't hold under `compileMagic()`/`lift()` (an
  untyped row, an `inputs` that isn't 2 code points, a chiral group that
  disagrees within a hand, a lone adaptive half) is never silently dropped
  -- it stays a leftover in `magic.rules[]` with its tag kept (`"raw"` when
  absent).

## Owner

`DB` (+ akl.gg) -- this format lives with the service. Changes go through
`OWNERS`.
