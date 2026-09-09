# `mana2/1`

A parsed mana2 `.jsonc` layout object (`design/layout-db/01-format.md` §4:
"mana's own write format", federation §13's "mana's write format"):
`layout.fingers`/`thumbs` row strings, `board.isRowStaggered`/
`rowOrColumnStagger` geometry, `fingermap` finger digits, an optional flat
`magic.rules[]`. `vendor/mana2/docs/layouts.md` says "Specification: todo" --
this README (and `translate.ts`'s own header comment) states every
derivation below against `vendor/mana2/core/load_layout.go`, the Go code
that actually reads these files, with the real vendored-file evidence for
each claim (`vendor/mana2/data/layouts/*.jsonc`, 75 files at the commit
these fixtures were frozen from -- see each fixture's header comment).

## Column/finger/thumb arithmetic (derived, not documented upstream)

- **Column = a row's token ordinal position**, after whitespace-splitting
  (`load_layout.go`'s `addFingerMap`: `for keyX, fingerString := range
  strings.Fields(...)`). A single space and a double space between tokens
  are identical (`docs/layouts.md`'s examples use a double space to
  visually mark the hand split; several real files -- `hours.jsonc`,
  `cyclone.jsonc` -- use a single space throughout and mean the same
  thing). A row's LEADING whitespace (several files use it to visually
  suggest a row's rightward shift, e.g. `hours.jsonc`'s row 1/2) is
  stripped by the same trim and carries no column information --
  `board.rowOrColumnStagger` is the only place a physical shift is
  recorded.
- **A `fingermap` row may have MORE tokens than its `fingers` row** (unused
  padding -- `addFingerMap` looks up a coordinate that has no real key and
  finds nothing, silently) but never fewer. Five real vendored files rely
  on exactly this: `cyclone.jsonc` row 2 (7 fingers tokens, 10 fingermap
  tokens), `knightest.jsonc`/`standlight.jsonc` row 1 (10 vs 11, the extra
  a duplicate `"9"`), `nystyc.jsonc` row 2 (9 vs 10), `vigil.jsonc` row 2
  (8 vs 9). `validate()` enforces "at least as many", not "equal".
- **Finger digits 0-9 = LP LR LM LI LT RT RI RM RR RP**
  (`core/stats.go`'s `fingerSuffixNames`), confirmed against every
  vendored qwerty-shaped fingermap (`qwerty.jsonc` row 0: `q w e r t` ->
  `0 1 2 3 3` = LP LR LM LI LI; `y u i o p` -> `6 6 7 8 9` = RI RI RM RR
  RP).
- **Thumbs**: `layout.thumbs[0]` is the LEFT thumb string, `[1]` the RIGHT
  (`addThumbsToLayout`: `case 0: finger = 4` (LT), `case 1: finger = 5`
  (RT) -- hardcoded, no fingermap lookup at all for thumbs). Each string is
  tokenised the SAME way as a fingers row -- a thumb slot can hold more
  than one key (`chantries.jsonc`: `"thumbs": ["l h", "space"]`, two left-
  thumb keys). The RIGHT string's columns are offset by the LEFT string's
  own token count (`coordinate.Column += len(strings.Fields(thumbs[0]))`),
  not a fixed number. Thumbs sit at `row = layout.fingers.length`
  (`thumbYCoordinate := layout.Board.GetRowsLength()`) -- always row 3 in
  every vendored fixture (all 75 have exactly 3 `fingers` rows), but this
  format computes it rather than hardcoding 3.
- **`skip`** (`parseList`: `tok.value == "skip" -> ""`, then the empty
  value is `continue`d in `addFingersToLayout`/`addThumbsToLayout`) means
  "no key AT ALL", not even a placeholder -- mana2's own runtime never
  records a `skip` position's finger past parse time. This format keeps it
  on the akl/1 side as `free` (`row/col/finger`, 01-format.md §6.3), which
  mana2's own model does not retain once loaded.
- **Board**: `isRowStaggered: true` indexes `rowOrColumnStagger` PER ROW,
  `false` (or absent -- Go's zero value) indexes it PER COLUMN
  (`addBoardShape`) -- the exact akl/1 rowstag/colstag dichotomy
  (01-format.md §2). akl/1's own `board.kind`/`stagger` is a best-effort
  DERIVED view (`translate.ts`'s `boardToAkl`): `isRowStaggered: true` ->
  `rowstag` (kept even when `rowOrColumnStagger` is all-zero, e.g. the
  docs' own "minimal layout" example -- see "Documented losses" below for
  why); `false` with any non-zero entry -> `colstag`; `false` with an
  absent/all-zero array -> `ortho`. This derived view alone cannot
  round-trip an "ortho-shaped" mana2 board exactly (it cannot tell
  `isRowStaggered: false` with no stagger from `isRowStaggered: true` with
  an all-zero one) -- that exactness comes from `x.mana2` (below), not
  from `board.kind`/`stagger`.

## `x.mana2` -- the escape hatch (01-format.md §6.1's `x.cmini` pattern)

akl/1 has no idiom for `board.mirrorLeftRowStagger`/`splitAngle` (tilt and
mirroring), `magic.magicKeys` (present -- usually `null`, once seen as `[]`
in `opaline.jsonc` -- in every vendored fixture, but unused even by mana2
itself: `addMagicDirectionals` is a stub whose real body is commented out
`// TODO: Implement`), top-level `layers` (mana2's own docs: "Layers:
todo"), or the RAW `isRowStaggered`/`rowOrColumnStagger` pair itself (as
opposed to the derived `board.kind`/`stagger` view above). `to["akl/1"]`
carries every one of these that was PRESENT on the source payload (at ANY
value, including `false`/`0`/`null`) into `x.mana2`, keyed by presence
(`"k" in extra`, never `!== undefined`) exactly the way `x.cmini` works for
`tag`/`blame`/`combos`/`link`. `from["akl/1"]` prefers `x.mana2` over the
derived `board.kind`/`stagger` view whenever present. The result: a
mana2-sourced record's OWN round trip (`mana2 -> akl/1 -> mana2`) is exact,
not merely "modulo key order" for magic/geometry -- only JSON object key
order and (for a genuinely akl-native record with no `x.mana2`) the
documented losses below apply.

## Magic: no lift, ever

mana2's own rule shape (`{inputs, output}`) carries no `type` at all, so
this format's `lower()` always tags every row `"raw"` (01-format.md §2's
vocabulary). `akl/1/magic.ts`'s `liftRules` treats every untyped/`"raw"`
row as an unconditional leftover, so calling it from `to["akl/1"]` would be
a no-op that just re-wraps every row as the same raw leftover -- skipped
entirely. `to["akl/1"]` therefore maps `magic.rules[]` 1:1 into
`magic.rules[]` (type `"raw"`), in the SAME order, with no reordering. The
REVERSE direction, `from["akl/1"]`, always LOWERS (`akl/1/magic.ts`'s
`computeRows`, over whatever `magic_keys`/`chiral_keys`/`adaptive_swaps`/
`rules` the akl payload holds) into a flat rule list -- mana2 has no idiom
concept at all, so an idiom-bearing akl/1 payload's STRUCTURE cannot
survive an `akl/1 -> mana2/1 -> akl/1` round trip, only its flattened rows
do (as raw rules) -- see "Documented losses".

## `TB` (either thumb)

akl/1's `TB` finger (either thumb, 01-format.md §2's enum) has no mana2
idiom -- mana2 always names a specific physical thumb (index 0 or 1).
`from["akl/1"]` places a `TB` key on the LEFT thumb: arbitrary but
deterministic. An author who cares which physical thumb a `TB` key sits
under has no akl/1-only way to say so in the first place -- that is what
`TB` means.

## What it can't express

Layers, combos (mana2's own docs: both "todo"; no vendored fixture uses
combos, `d5.jsonc` is the only one with non-null `layers`-adjacent content
and it is excluded from this format's fixtures for an unrelated reason,
below), tap-hold or directional keys (`(...)`/`<...>`/`$...`-prefixed
tokens in `load_layout.go`'s tokeniser -- an undocumented mini-language
`docs/layouts.md` never mentions; the ONE vendored file that uses it,
`d5.jsonc`, is excluded from this format's fixtures -- see below), per-key
timing, alternate fingerings.

### `d5.jsonc` is excluded from this format's fixtures

`vendor/mana2/data/layouts/d5.jsonc` is the one file (of 75) whose
`layout.fingers`/`thumbs` use the tap-hold/directional/layer-trigger
mini-language `core/load_layout.go`'s tokeniser implements but
`docs/layouts.md` never documents (`(<space repeat> $shift)`,
`u (i $numbers)`). Concretely, that breaks this format's row-shape
agreement (row 0 has 14 whitespace-split tokens against 10 fingermap
tokens -- the opposite direction from the five real "extra padding" files
above) AND its duplicate-char rule (the bracketed group and the literal
`"y"` each appear twice on one row). Both are genuine, correct refusals,
not bugs: this format's schema/`validate()` cover the SAME surface
`docs/layouts.md` documents (fingers/thumbs/board/fingermap/flat magic
rules) -- exactly parallel to layers/combos being out of scope. `d5.jsonc`
is NOT copied into `fixtures/` (the other 74 vendored layouts are); a
dedicated `mana2.test.ts` case parses it (proving the JSONC reader handles
its comments/escapes) and asserts `validate()` refuses it, naming why.

## Documented losses (`to["akl/1"]`, `from["akl/1"]`)

- **`akl/1 -> mana2/1 -> akl/1` loses magic IDIOM structure**: any
  `magic_keys`/`chiral_keys`/`adaptive_swaps` on the source payload survive
  only as their FLATTENED rows (raw `magic.rules[]`) on the way back --
  mana2 has no idiom concept to preserve them in (see "Magic: no lift,
  ever" above). Parallel to, but strictly more lossy than, `akl/1 ->
  cmini/1 -> akl/1` (cmini's rows are typed, so an exact LIFT is often
  possible there; mana2's are never typed, so no lift is ever attempted
  here).
- **`akl/1 -> mana2/1 -> akl/1` loses `TB`**: becomes `LT` (see above).
- **`akl/1 -> mana2/1 -> akl/1` loses every `x` key except `x.mana2`**:
  parallel to LDB-F10's "only `x.cmini` survives `to["cmini/1"]"`.
- **`akl/1 -> mana2/1 -> akl/1` loses an akl-native `board.kind: "ortho"`**
  (no `x.mana2` hint to recover it from): it becomes
  `isRowStaggered: true` with an all-zero `rowOrColumnStagger` (matching
  `docs/layouts.md`'s own "minimal layout" example, whose comment reads
  "// Will be an ortho shape") -- translating THAT back to akl/1 yields
  `board.kind: "rowstag"` with an all-zero stagger, not `"ortho"`: an
  honest, asymmetric loss inherent to mana2 having no explicit ortho flag,
  the mirror image of `colstag`'s own documented loss against `cmini/1`.
- **`akl/1 -> mana2/1 -> akl/1` compacts non-contiguous columns**: a
  row/thumb-hand's tokens are ordered by ascending `col` and packed
  contiguously from 0 (mana2's own strings carry no absolute column
  number, only token order) -- the exact inverse of `to["akl/1"]`'s own
  `col = token's ordinal position` for anything THIS format produced (so
  lossless for a mana2-sourced payload). A genuinely akl-native payload
  whose columns are NOT already contiguous per row/hand has them
  renumbered: real, common, not a corner case -- cmini's own absolute-
  column convention leaves gaps routinely (e.g. a thumb key at col 6 with
  nothing at cols 0-5 on that hand), and several cmini-derived akl/1
  fixtures exercise it (`011-40kwh`, `012-apt26`, `014-abyss` among them;
  `tests/formats/mana2.test.ts`'s own round-trip assertion accounts for
  this per-fixture, it is not skipped). The two hand-authored akl-native
  fixtures (`900-colstag`, `901-idioms`) and `001-graphite` happen to be
  contiguous already, so THEIR round trip needs no renumbering, but that is
  incidental, not the general case.
- **`akl/1 -> mana2/1 -> akl/1` always gains an `x.mana2` hint**, even
  starting from a payload with no `x` at all: `from["akl/1"]` never leaves
  `board.isRowStaggered`/`rowOrColumnStagger` unset on the mana2 payload it
  produces (falling back to the same kind-based derivation `to["akl/1"]`
  itself would use when no hint exists to prefer), so the very next
  `to["akl/1"]` call finds them present and faithfully carries them into a
  NEW `x.mana2` -- harmless (it always agrees with the returned
  `board.kind`/`stagger`) but present where the original had none. The
  mirror image of a genuinely mana2-sourced record's `x.mana2` appearing on
  purpose.
- **`mana2/1 -> akl/1 -> mana2/1`**: lossless on every DATUM (modulo JSON
  object key order) for every one of the 74 vendored fixtures this format
  carries -- `x.mana2` is exactly what makes this true (see above) -- with
  two purely cosmetic exceptions that carry no information: row-string
  WHITESPACE (a single vs double space between tokens, and a row's leading
  whitespace, are re-rendered as `fromAkl`'s canonical single-space-joined
  form -- never data, `core/load_layout.go`'s own tokeniser collapses them
  identically) and a `fingermap` row's UNUSED PADDING past its
  corresponding `fingers` row's token count (five real vendored fixtures
  have it: `cyclone` row 2, `knightest`/`standlight` row 1, `nystyc` row 2,
  `vigil` row 2 -- `to["akl/1"]` never reads past that count, so nothing
  stores it to give back). `tests/formats/mana2.test.ts` verifies this
  precisely (canonicalising row whitespace and trimming fingermap padding
  to the fingers width before comparing), not by skipping those fixtures.

## Owner

`Zak (mana2)` -- mana2's own maintainer(s); `04 Q3` notes the mirror is not
set up yet, so `OWNERS` (DB-side review) is `saltorbit` until then.
