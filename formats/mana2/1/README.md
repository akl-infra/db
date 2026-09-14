# `mana2/1`

A parsed mana2 `.jsonc` layout object (`design/layout-db/01-format.md` §4:
"mana's own write format", federation §13's "mana's write format"):
`layout.fingers`/`thumbs` row strings, `board.isRowStaggered`/
`rowOrColumnStagger` geometry, `fingermap` finger digits, an optional flat
`magic.rules[]`/`combos[]`/`layers`. `vendor/mana2/docs/layouts.md` says
"Specification: todo" -- `12-implementation-phase5.md` §0.4/§2.5 (which
**replaces** `01-format.md` §6.3) states every derivation against
`vendor/mana2/core/load_layout.go`, the Go code that actually reads these
files; this README restates the same derivations in prose with the real
vendored-file evidence, and `translate.ts`'s own header comments cite the
exact function/line each claim comes from.

## Column/finger/thumb arithmetic

- **Column = a row's token ordinal position** after whitespace-splitting,
  with one wrinkle: a `(...)`/`<...>` GROUP (tap-hold / directional) counts
  as ONE column, matching `core/load_layout.go`'s own `root.children`
  indexing -- `translate.ts`'s `splitCells`/`parseRow` implement the same
  grouping the loader's tokeniser does, not a naive `String.split`. A
  single vs double space between tokens, and a row's leading whitespace, are
  never data (`docs/layouts.md`'s own examples use a double space to mark
  the hand split; several real files use a single space throughout and mean
  the same thing; leading whitespace is purely a visual stagger cue).
- **A `fingermap` row may have MORE tokens than its `fingers` row** (unused
  padding) but never fewer. Five real vendored files rely on exactly this:
  `cyclone.jsonc` row 2 (7 cells, 10 fingermap entries), `knightest.jsonc`/
  `standlight.jsonc` row 1 (10 vs 11, the extra a duplicate `"9"`),
  `nystyc.jsonc` row 2 (9 vs 10), `vigil.jsonc` row 2 (8 vs 9).
- **Finger digits 0-9 = LP LR LM LI LT RT RI RM RR RP**
  (`core/stats.go`'s `fingerSuffixNames`), confirmed against every
  qwerty-shaped vendored fingermap.
- **Thumbs**: `layout.thumbs[0]` is the LEFT thumb string, `[1]` the RIGHT
  (`addThumbsToLayout`: finger 4/5, hardcoded, no fingermap lookup). A
  slot can hold more than one key (`chantries.jsonc`: `"l h"`). Thumbs sit
  at `row = layout.fingers.length` (computed, not hardcoded -- always 3 in
  every vendored fixture).
- **`skip`** occupies its column (a real cell with no character) --
  `fingermap[y][x]` still names its finger. mana2's own runtime keeps no
  record of a `skip` position once loaded; this format keeps it on the
  akl/1 side as a `free` entry.
- **Board**: `isRowStaggered: true` indexes `rowOrColumnStagger` PER ROW,
  `false` PER COLUMN -- the exact akl/1 rowstag/colstag dichotomy.

## `to["akl/1"]` (mana2 -> akl/1) -- exact, per 12 §2.5

| mana2 | akl/1 | held? |
|---|---|---|
| `fingers[y]` cell (1 code point, or `space` -> `" "`) | `keys[c] = {row:y, col:x, finger: letters[fingermap[y][x]]}` | no |
| `skip` at `(x,y)` | `free[] += {row:y, col:x, finger: letters[fingermap[y][x]]}` | no |
| `(a b)`, `<a b>` tokens | -- | **held**: "tap-hold token has no akl/1 idiom" / "directional token has no akl/1 idiom" |
| left thumb cell `i` of `n` (`n<=5`) | `row=fingers.length, col=4-(n-1-i), finger:"LT"` | no |
| right thumb cell `j` | same row, `col=5+j, finger:"RT"` | no |
| `n>5` on one thumb side | -- | **held**: "more than five keys on one thumb" |
| `board` (any shape: row- or column-staggered, any amounts, `mirrorLeftRowStagger`, `splitAngle`) | -- (dropped: `spark/1` has no board field, `design/layout-db/26-no-board.md`; the lowering back always emits the ANSI row stagger `[0,0.25,0.75]`, `translate.ts`'s `DEFAULT_ROW_STAGGER`) | no -- a documented loss, never held (the old "entries past the 3rd must equal the 3rd" hold went with the field) |
| `magic.rules` (duplicate `inputs` -> last wins, mana2's own load-time semantics) | `magic.rules[] = {inputs,output,type:"raw"}`, same order, no lift (untyped rows are never lifted without the author, `01-format.md` §3) | no (dedup happens first) |
| non-empty `combos` | -- | **held**: "combos have no akl/1 idiom" |
| `mirrorLeftRowStagger`/`splitAngle`/`magicKeys`/`layers` | carried into `x.mana2` (below), NEVER held -- this format's own override of `12 §2.5`'s table, approved because the hatch preserves them exactly | no |

## `x.mana2` -- the escape hatch (`01-format.md` §6.1's `x.cmini` pattern)

`12 §2.5` says `mirrorLeftRowStagger`/`splitAngle`/`magicKeys`/`layers` are
held. This format overrides that for exactly those four fields: akl/1 has
no idiom for any of them, but none of them change what a position/
character/board-SHAPE actually is (unlike a tap-hold or a >5-thumb
cluster, which change what akl/1 would even need to represent), so holding
the whole payload over them would refuse translation for information that
doesn't matter to akl/1's own model. `to["akl/1"]` carries whichever of
the four were PRESENT on the source payload (at any value, including
`false`/`0`/`null`) into `x.mana2`, keyed by presence
(`"k" in extra`, never `!== undefined`). `from["akl/1"]` restores them
when present, else defaults to `false`/`0`/`null`/`null` (mana2's own
zero values). Board geometry itself (`isRowStaggered`/
`rowOrColumnStagger`) does NOT need `x.mana2` -- see "Round trips" below
for why the plain akl-facing `board.kind`/`stagger` already carries it
losslessly for every real (3-row) vendored file.

Because `from["akl/1"]` NEVER leaves these four fields unset (defaulting
when no hint exists), a payload that started with no `x` at all still
gains a NEW `x.mana2` the moment it passes through `akl/1 -> mana2/1 ->
akl/1` -- harmless (it always agrees with the returned board/etc.) but
real, and asserted exactly (not glossed over) in `mana2.test.ts`.

## Duplicate `magic.rules[].inputs`: last wins, not refused

mana2's own loader re-parses `rules` into a map keyed by `inputs` --  a
later entry silently REPLACES an earlier one with the same `inputs`. This
format's `lower()` and `to["akl/1"]` both dedupe the same way
(`translate.ts`'s `dedupeRulesLastWins`, shared by both so they can never
disagree). `akl/1`'s own `magic.rules[]` schema still refuses a duplicate
`inputs` outright -- so an `akl/1 -> mana2/1 -> akl/1` round trip that
starts with a genuine mana2-style duplicate (hand fixture `904-dup-rules`)
loses the earlier, overwritten rule for good: dedup happens at the FIRST
hop, before there is anything left to lift back.

## `TB` (either thumb)

akl/1's `TB` finger has no mana2 idiom -- mana2 always names a specific
physical thumb by which STRING a key sits in. `from["akl/1"]` classifies
ANY key with finger `LT`/`RT`/`TB` (on any row -- several live upstream
layouts put thumb-fingered keys on rows 0-2, e.g. `test12222`) as a thumb
key, then assigns its SIDE by `col < 4.5` (the site's own
`PhysicalThumbSide` rule, `bridgecore/cmini.go`) -- the original finger
LABEL is not consulted for side assignment, only the column. `TB` never
survives the round trip; it becomes whichever side its column falls on.

## `d5.jsonc`: a real, verified finding -- refused, not held

`vendor/mana2/data/layouts/d5.jsonc` is the one vendored file (of 75)
using the tap-hold/directional/`$`-token mini-language
`core/load_layout.go`'s tokeniser implements but `docs/layouts.md` never
documents. The original plan assumed this file would demonstrate `held`.
Traced BY HAND against the exact Go source (both branches of
`createTapHoldFromNode`'s `tokenOpenParen` case): d5's row 0,
`"(<space repeat> $shift) g d m y y b f z (<space repeat> $shift)"`,
parses as 10 cells (two tap-hold groups + 8 plain words) -- and BOTH
tap-hold groups resolve WITHOUT ERROR (the loader's own `tokenOpenParen`
branch for a directional-first tap-hold never reads or validates its own
outer second slot at all -- `$shift` is silently unused, a real quirk in
mana2 itself, reproduced faithfully here, not "fixed"). Row 0 then
proceeds through its plain words -- `g d m y y b f z` -- where the SECOND
`"y"` collides with the first, and `addKeyToLayout`'s duplicate-key check
refuses the file with `"Duplicate keys are not allowed. If you need them,
implement them through magic"` at `/layout/fingers/0`, BEFORE either
tap-hold cell's held-ness would ever matter.

d5.jsonc therefore VALIDATES (schema + grammar) as false, is REFUSED, not
held -- this format's own `mana2.test.ts` asserts the exact verified
reason and, separately, `to["akl/1"]` never even runs on it. `LDB-F13`'s
"enumerated held vendored files" list is consequently EMPTY for the real
75-file corpus (matching `12 §0.5`'s own table: "held reasons... none --
every held reason except d5's needs a hand-written fixture" -- true, but
for a different reason than planned, since d5 turns out not to demonstrate
one either). Every held reason (`tap-hold`, `directional`, `>5 thumb keys`,
`non-empty combos`, `rowstag stagger mismatch`) is instead demonstrated by
a dedicated hand-written fixture at 900+ (below), each using a construct
d5's own duplicate-key defect does not also trip.

## Fixtures

`formats/mana2/1/fixtures/001` through `013` are named witnesses picked by
`scripts/pick-mana2-fixtures.mjs` from the vendored corpus (one row of `12
§0.5`'s own table each: `hours` docs-shape + thumb magic, `graphite`
12/11/10 ragged rows, `stand_iso` a `skip`, `whirl`/`bunya` colstag/ortho,
`chantries` two-key thumb, `vigil`/`cyclone` extra fingermap padding,
`nystyc` uppercase/pipe, `lucens_de` non-ASCII, `opal`/`sturdy`/
`sturdy_ortho` real layouts with magic / two boards for one layout). All
75 vendored layouts (including `d5`) are separately snapshotted verbatim
at `tests/fixtures/mana2-vendored/*.json` (+ `SOURCE`, the vendored
submodule commit) for the envelope test.

Hand-written `900`-`908` cover every held reason and every hatch/edge
case a 75-file corpus of REAL layouts happens not to exercise:
`900-held-combos`, `903-held-sixthumbs`, `906-held-taphold`,
`907-held-directional`, `908-held-stagger-mismatch` (all held, each for
its own reason); `901-splitangle-hatch`/`902-mirror-hatch` (non-default
`splitAngle`/`mirrorLeftRowStagger`, `x.mana2` round trip, NOT held);
`904-dup-rules` (duplicate `inputs`, last wins); `905-colstag-zeros` (an
all-zero colstag derives to ortho, same as an all-zero rowstag).

## Round trips (`mana2.test.ts`)

**`mana2/1 -> akl/1 -> mana2/1`** is identity under `normalizeMana2()`
(trim each row; drop fingermap digits past a row's own cell count; drop
stagger entries past the rows/width; treat `layers:null`/`magicKeys:null`/
`mirrorLeftRowStagger:false`/`splitAngle:0` as absent; object key order)
for every valid vendored file and every non-held hand fixture -- `904` and
`905` are excluded from the generic loop (they are DESIGNED to be lossy;
asserted exactly by name instead, see above).

**`akl/1 -> mana2/1 -> akl/1`** is identity off the thumb row for every
`akl/1` and `cmini/1`-derived fixture, with two real, byte-exact
mechanics `mana2.test.ts`'s own `adjustForMana2RoundTrip` replicates
rather than guesses:
- **Grid gaps get filled, and trailing ones get trimmed.** A main-row
  column with neither a key nor a `free` entry becomes `skip` (fingermap
  digit `0`); a column that IS a `free` entry ALSO becomes `skip` (its own
  finger digit) -- both are the SAME token once lowered, so mana2 cannot
  tell them apart. Trailing `skip` cells (from either source) are trimmed
  off the row entirely -- a `free` entry that happens to sit at a row's
  end vanishes on the round trip (`012-apt26`); a genuine gap elsewhere
  reappears as a NEW `free` entry with finger `LP` (`011-40kwh`,
  `007-crescent`, `008-sanrie-cmini-test2`, and others -- common, not a
  corner case, since cmini's absolute-column convention leaves real gaps
  routinely).
- **`010-test12222`** ("both thumbs; thumb fingers on rows 0-2") puts more
  than five re-anchored keys on one thumb side once `col < 4.5` groups
  them -- **held**, asserted by name, not a round trip.
- An originally EMPTY akl/1 layout (0 keys, 52 live upstream layouts, `07
  §0.1`) needs special handling on the way OUT: mana2's own schema
  requires >=1 `fingers` row (every real FILE has one), so `fromAkl` emits
  a single empty-string row (`layout.fingers: [""]`) rather than `[]` for
  this one case -- verified to match `LDB-F12`'s live parity check too
  (the site's converter emits `[]` for the same input; both mean "no keys
  at all", normalized as equal by the parity test).

## `cmini/1 <-> mana2/1`: the composition through akl/1

Declared on both modules, `12 §2.5`'s own words: `cmini1.to["mana2/1"] =
p => mana2FromAkl(fromCmini(p))` (never held: `cmini -> akl` and
`akl -> mana2` never hold), `mana2_1.to["cmini/1"] = p => { const akl =
toAkl(p); if (held) return held; return toCmini(akl); }` (held passed
through). `akl/1/index.ts` gained reciprocal `to["mana2/1"]`/
`from["mana2/1"]` entries too (both re-exporting THIS format's own
`fromAkl`/`toAkl` -- no second implementation). A `mana2/1` record read
`?as=cmini/1` carries `keys[" "]` when the file had a `space` token
(`12`'s decision #8; asserted in `mana2.test.ts` against `001-hours`).

## `LDB-F12`: the DB's grid equals the site's real wasm converter

`scripts/check-convert-parity.mjs` runs the SITE's own compiled engine
(`swapengine.convertLayout('rowstag','none', cminiDetailJSON)`, the exact
surface `tools/swapengine/smoke.js` already exercises -- a file read of
`web/data/swap/{wasm_exec.js,engine.wasm}`, never an import, `LDB-G5`
untouched) over every `cmini/1` fixture and freezes
`tests/fixtures/mana2-convert/<id>.json`; `mana2-convert-parity.test.ts`
compares this format's own `cmini1.to["mana2/1"]` against that committed
snapshot at test time (no wasm needed then). 18/18 fixtures matched on
the FIRST run against the real engine, modulo two documented, narrow
tolerances the design brief itself names: the site does not trim a row's
trailing `skip` tokens (this format does -- see "Round trips" above), and
the fingermap digit under a `skip` cell uses a different convention on
each side (the site always emits `0`; this format emits a `free` entry's
own finger when one exists). Both are trimmed/ignored identically on both
sides before comparing, never silently.

## What it still can't express

Layers and combos ride opaque (`layers`/`combos` are read/written
verbatim, in `x.mana2`/schema respectively, but never interpreted --
mana2's own docs call both "todo"); per-key timing; alternate fingerings.
`combos` chars are checked against the layout's own resolved keys
(`0.4`'s "every char must be a key"); non-empty `combos` is always
**held** for `akl/1` (no override -- unlike the four `x.mana2` fields,
combos genuinely change what a translated record would need to express).

## Owner

`OWNERS` = the DB maintainers, a mirror of mana2's loader at the vendored
submodule commit; Zak's handle is added once confirmed (`12 §1`).
