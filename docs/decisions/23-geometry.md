# 23 — Boards and thumbs: explicit in spark, explicit at the bot (round 1)

**Status:** design round, nothing built. Branch `ldb-geometry` (worktree
`.claude/worktrees/ldb-geometry`, off `ldb-arch-review`). Picks for saltorbit in
§8; rendered options at `design/artifacts/ldb-geometry.html` (artifact link in
`design/artifacts/index.json`). This is the `W3` "spark/1 format discussion"
item of `review/LEDGER.md` plus the parked `D4`/`D8` round of
`18-command-decisions.md` §2, resumed 2026-09-13 on saltorbit's ask:

> I want to make sure there's a way to set the board type (default ansi, but
> also support iso and ortho). Maybe treadstone too. I also want to make it
> natural to add thumb keys. It's a non-goal to support weird things like
> svalboard and pinchord. We have had to infer a lot of things in akl.gg, and
> I want to introduce new things so we have that explicit.

**Scope:** what a record says about its physical board and its thumb keys;
how the bot takes that in (`add`, `setfingermap`, new geometry verbs); how the
importer fills it from cmini; what the site and the pipeline must read
instead of guess. **Non-goals:** key wells / 3-D boards (svalboard), chorded
input (pinchord), layers, combos, hold-taps, duplicate letters (#322,
deferred), the magic authoring DSL (xsznix's thread, a separate topic).

## 1. What is inferred today

Every row below is a place where a client guesses at something the record
never said. The pattern to end: *the record is ambiguous, so every reader
re-derives the same thing, each slightly differently.*

| what | who guesses | how | what goes wrong |
|---|---|---|---|
| board type | `bot/src/commands/add.ts` `parseAddGrid` (cmini's `add.py`) | leading-space pattern of the three rows: rising = `stagger`, flat = `ortho`, flat-then-one = `angle`, flat-then-two = `mini` | an un-indented paste is `ortho` whatever the author types on; **3,343 of 4,191** catalog layouts are `ortho` this way, 288 `stagger`, 555 `angle`, 5 `mini` |
| the angle mod | same parser; `web/src/core/geometry.ts` `BOARD_MISMATCH_FINGERMAPS` | the `angle` *board word* selects `FMAP_ANGLE` for row 2 and a one-cell indent | a fingering is stored as a board shape; the site then has to flag `angle mod` fingermaps as "mismatched" under ortho |
| stagger amounts | `db/formats/adapters/cmini/translate.ts` (`[0, .25, .75]`), `core/geometry.ts` `ROW_OFFSET`, `staggeredX` (`-.25 / 0 / +.5`, cmini's fspeed convention) | fixed per word | two unreconciled stagger conventions on the site (`geometry.ts` header admits it); no way to say a non-ANSI row stagger |
| ISO | nobody | — | no client can say "there is a key left of Z on the bottom row"; mana2's own `stand_iso.jsonc` needs `skip` + an 11-token row + stagger `[0, .25, -.25]` to express it |
| thumb side | `core/geometry.ts` `physicalThumbSide`, `build_web.py`, bridgecore `PhysicalThumbSide`, `core/spacegrams.ts` `thumbKeySide`, mana2 lowering `thumbDigitForCol` | `col < 4.5` → left, whatever the finger label says | 96 catalog thumb keys carry a label that disagrees with their column; three ports of one rule "kept in lockstep" by comment |
| `TB` | `core/spacegrams.ts` `isThumbKey`, the same four ports | "a thumb whose hand cmini never labelled" → resolved by column | 152 catalog thumb keys are `TB`; every consumer needs the special case |
| thumb columns | `add.ts` D13 (`floor(leading spaces / 2)`, finger by `> 8`) | indentation arithmetic; every key on the thumb line gets the same column | two thumb keys on one line collapse onto one column; 40 catalog thumb keys sit at col 0 (pre-v3 relative encodings that never got shifted) |
| the space key | `core/spacegrams.ts` auto rules 1a/1b/2/3; `cache/cells.ts` `resolveSpace` in the bot | from the alpha thumb keys, else the lower Redirect Total wins, tie → left | the author's own space thumb is never recorded; 2,553 layouts have no thumb key at all and get a synthetic one on a computed side |
| hand split / center gap | `ui/board/layout.ts`, mana2 lowering ("hand split after the 5th column"), `render/matrix.ts` (`j === 4` padding) | fixed at col 4 \| 5 | 913 layouts are 11 wide, 99 are 12, 58 are 13 — the extra columns are assumed to be on the right; a 6+6 colstag board cannot be drawn |
| colstag | nothing authors it | `spark/1` allows `kind: colstag`, the site's `core/types.ts` `Board` is `'rowstag' \| 'ortho'` | only mana2's vendored `whirl`/`nstd-repeat`/`d5` are colstag; the site cannot draw one |
| `board.cmini` | `cminiBoardWord()`; the bot's text grid indent | carried so the old cmini export could round-trip | the export is deleted (21 D5); the field survives only to pick a text indent |
| symmetric stagger | mana2 `mirrorLeftRowStagger` (dropped by the lowering as rendering-only) | — | the Go formula (`load_layout.go:447`) flips the sign per *row parity*, not per hand — not what a Treadstone is |

## 2. What the data says (4,191 catalog layouts, 2026-09-12 harvest)

- Board word: `ortho` 3,343 · `angle` 555 · `stagger` 288 · `mini` 5.
- Main-row width: 10 → 3,000 · 11 → 913 · 12 → 99 · 13 → 58 · other → 121.
- Thumb keys per layout: 0 → 2,553 · 1 → 1,348 · 2 → 211 · 3 → 50 · 4+ → 29
  (one layout has 26). 259 layouts have two or more thumb keys on one side.
- Thumb labels: `LT` 1,270 · `RT` 677 · `TB` 152. Thumb columns cluster at 3
  (963) and 6 (670); 40 sit at col 0, 27 at cols 10–25.
- 22 layouts have a row-3+ key whose finger is not a thumb (number rows,
  `fingermap: other`). 140 layouts use `_` as a key; none has `" "`.
- 3 layouts are named "iso" (`stand-iso` is stored as `ortho`).

So: the common case is a 10-wide board with zero or one thumb key, and the
board word is noise for ~80 % of records. Anything the new shape makes
*required* must be trivially defaulted for that case.

## 3. Principle

**Infer once, at the door; store it explicitly; never infer at read time.**
The bot's `add` and the cmini importer may guess (indentation, column, the
old `TB`), but they write a record that says what they guessed, and the reply
draws it back so the author sees it. Every reader — the site's board drawer,
the bot's text grid and image, the mana2 lowering, spacegrams — reads the
record. There is exactly one definition of each geometric fact, in the
format's `validate()`, and the invariants in §9 make the readers agree with
it by construction rather than "in lockstep".

## 4. The format

`spark/1`'s payload keeps its shape (`keys`/`free`/`board`/`magic`); this
round changes `board`, adds `space`, and tightens `Position.finger`.

```
Payload
├─ keys: Record<char, Position>      -- unchanged
├─ free?: Position[]                 -- unchanged
├─ board: Board                      -- REQUIRED now (was optional)
├─ space?: "left" | "right"          -- NEW: the thumb that types space
└─ magic?: MagicIntent               -- unchanged

Position
├─ row: 0..4                         -- unchanged
├─ col: integer >= 0                 -- unchanged (absolute column, thumbs too)
└─ finger: LP LR LM LI RI RM RR RP LT RT   -- TB REMOVED

Board
├─ kind: "ansi" | "iso" | "ortho" | "colstag" | "symmetric"   -- required
├─ stagger?: number[]   -- ansi/iso/symmetric: 3 per-row amounts, default per kind;
│                          colstag: one per column, REQUIRED; ortho: forbidden
└─ split?: integer      -- first column of the right hand; default 5
```

`board.cmini` is gone (nothing exports to cmini since 21 D5; the bot's text
indent derives from `kind`). `rowstag` is gone as a word: it was `ansi` with
an explicit stagger, and the two names for one thing is what let "ortho"
mean "unspecified".

### 4.1 The kinds

| kind | physical x of `(row, col)` | default stagger | meant for |
|---|---|---|---|
| `ansi` | `col + stagger[row]` | `[0, 0.25, 0.75]` | every row-staggered board; the **default** for a bot `add` with no `board` line |
| `iso` | `col + stagger[row]`; row 2's col 0 is the ISO key, so row 2 is one column wider and its stagger is `-0.25` | `[0, 0.25, -0.25]` | ANSI + the key between Shift and Z; the "ISO angle mod" home |
| `ortho` | `col` | none | grids, ortholinear boards |
| `colstag` | `x = col`, `y = row + stagger[col]` | none (required) | corne/ferris/sofle-shaped splits; per-column amounts in key units |
| `symmetric` | right hand `col + stagger[row]`, left hand `col - stagger[row]` (mirror across `split`) | `[0, 0.25, 0.75]` | Treadstone-style symmetric row stagger — *if saltorbit wants it; §8 P2* |

`stagger` on `ansi`/`iso`/`symmetric` is an override for non-standard row
staggers (some 40 % boards use `[0, .25, .5]`); the default is filled in by
`validate()` so readers never see it absent. Only finger rows (0–2) take a
stagger; a thumb row is drawn under row 2's offset, as today
(`ui/board/layout.ts`).

### 4.2 Thumbs

- A thumb key is any key whose finger is `LT` or `RT`, on any row ≥ 3. Its
  `col` is its absolute column, the same axis as the finger rows (the
  2026-08-31 v3 convention; unchanged).
- **The label is the hand.** `LT` is analysed and drawn as a left thumb
  wherever its column is. `physicalThumbSide` and its three ports go away;
  the importer applies that rule *once*, relabelling the 96 disagreeing
  catalog keys and the 152 `TB` keys by column at import (§4.6), and from
  then on nothing re-derives a side.
- More than one thumb key per side is ordinary (259 layouts have it); their
  columns order them. A key at `col < split` labelled `RT` is *allowed*
  (validate only warns in the bot reply) — it's how a one-handed board says
  what it means.

### 4.3 Space

`space: "left" | "right"` records the thumb that types space. Nothing else
changes: spacegrams keep computing the `lt`/`rt` variants, and **auto** means
"the record's `space` if present, else the rules". Absent on every imported
record; set by the bot's `space` line / `space!` verb and by the bench.
Not a key in `keys` — 140 layouts already use `_`, no catalog layout has
`" "`, and a real space key would change every stat table's shape (§6).

### 4.4 Validation (`validate()`, in order after the schema)

1. `board.kind` names a kind; `stagger` length matches (3 for row kinds, one
   per column `0..maxCol` for colstag, absent for ortho); `split` in `1..maxCol`.
2. On `iso`, row 2 may be one column wider than rows 0–1; on every other
   kind rows 0–2 share the width rule they have today (none — cmini never
   had one; `free` fills holes).
3. Finger rows are 0–2 (plus 3 when no key on row 3 is a thumb — the 22
   number-row layouts); a thumb key never sits on rows 0–2.
4. Everything spark/1 checks today (single code point, no duplicate
   `(row, col)`, magic references, lowering collision).

### 4.5 Lowering to mana2 (`db/formats/mana2/1/translate.ts` `fromSpark`)

| kind | `isRowStaggered` | `rowOrColumnStagger` | notes |
|---|---|---|---|
| `ansi` | true | the 3 amounts | today's path |
| `iso` | true | `[0, .25, -.25]` (or the override) | row 2's 11 tokens as-is; mana2's own `stand_iso` shape |
| `ortho` | true | `[0, 0, 0]` | today's path |
| `colstag` | false | per column, padded to width | `split` decides where the row string's hand gap goes |
| `symmetric` | true + `mirrorLeftRowStagger: true` | the 3 amounts | mana2's formula is per row parity, not per hand — file it with Zak or emit the per-hand physical coords ourselves; only fspeed/distance stats see physical x |

Thumb strings: left = `LT` keys by column, right = `RT` keys by column
(today's `col < 4.5` re-anchoring goes; `LDB-F12`'s parity fixture is
regenerated from the relabelled import, which by construction gives the
same strings).

### 4.6 Import from cmini (`fromCmini`), the one place that still guesses

| cmini | spark |
|---|---|
| `board: stagger` | `kind: ansi` |
| `board: angle` | `kind: ansi` (the angle mod is already in the keys' fingers) |
| `board: ortho` | `kind: ortho` — faithful; see §8 P4 for the alternative |
| `board: mini` | `kind: ortho` |
| finger `TB`, or `LT`/`RT` disagreeing with the column | relabelled by `col < 5` (today's physical rule), the last time it runs; an `import_relabel` info event names the key |
| no `space` | absent |

Held: nothing new. A cmini layout is always expressible.

### 4.7 Worked examples

ANSI, one thumb key each side (the common "advanced" case):

```json
{ "keys": { "…": {}, "e": { "row": 3, "col": 3, "finger": "LT" },
             "r": { "row": 3, "col": 6, "finger": "RT" } },
  "board": { "kind": "ansi" }, "space": "right" }
```

ISO with the ISO angle mod (mana2's `stand_iso`): row 2 has 11 keys, col 0
is the ISO key, fingers `LP LR LM LI LI LI | RI RI RM RR RP`:

```json
{ "keys": { "q": { "row": 2, "col": 0, "finger": "LP" },
             "k": { "row": 2, "col": 1, "finger": "LR" }, "…": {} },
  "free": [ { "row": 2, "col": 5, "finger": "LI" } ],
  "board": { "kind": "iso" } }
```

Colstag 3×6+3 (corne), outer pinky columns, three thumbs per side:

```json
{ "board": { "kind": "colstag", "split": 6,
             "stagger": [0.4, 0.2, 0, -0.2, 0, 0.2, 0.2, 0, -0.2, 0, 0.2, 0.4] } }
```

## 5. The bot

### 5.1 `add` — identical for the simple case, header lines for the rest

```
!sp add mine
```
b l d w z  ' f o u j
n r t s g  y h a e i
q x m c v  k p . - /
```
```

parses exactly as today except the board is `ansi`, not `ortho`
(indentation no longer picks the board). Optional header lines *inside the
code block, before the grid*, one word each:

| line | values | default | writes |
|---|---|---|---|
| `board` | `ansi` `iso` `ortho` `colstag <n n n …>` `symmetric` | `ansi` | `board.kind` (+ `stagger` for colstag) |
| `fingers` | `standard` `angle` or a digit row per finger row (today's `setfingermap` matrix, inline) | `standard`; `angle` when the grid has cmini's angle indent (so old angle pastes keep their meaning) | the keys' fingers |
| `space` | `left` `right` | absent | `space` |
| `split` | a column number | `5` | `board.split` |

The board type never comes from indentation. Indentation is cosmetic, with
two exceptions kept for old pastes: cmini's angle indent (rows 0–1 flush,
row 2 in by one) still means `fingers angle`, and an ISO grid is written the
way it looks — row 2 out-dented by one cell:

```
board iso
  q w e r t  y u i o p
  a s d f g  h j k l ;
\ z x c v b  n m , . /
```

**Thumb keys** are a fourth line, each key under the column it sits in; the
hand is the side of the center gap it's on. That is what the D13 rule meant
to do; the difference is that every key gets its own column and label, and
the reply draws them back:

```
q w e r t  y u i o p
a s d f g  h j k l ;
z x c v b  n m , . /
      e    r
```

→ `e` at row 3 col 3 `LT`, `r` at row 3 col 5 `RT`. A key in the gap column
is an error naming the key ("put `e` under a column").

**The reply** renders what was understood — the text grid drawn per `kind`
(§5.3), a `· iso · 2 thumbs · space right` line under the name, and the
akl.gg link — so an inference at the door is visible before anyone relies on
it.

### 5.2 Verbs for an existing layout

Owner-only, cmini's preview/`!` pair like `swap`/`swap!`:

| verb | does |
|---|---|
| `board <name> <kind> [n n n …]` / `board! …` | preview / set `board` |
| `space <name> left\|right\|none` / `space! …` | preview / set `space` |
| `angle` / `angle!`, `unangle` / `unangle!` | unchanged in effect, but now they only change fingers (row 2 → `FMAP_ANGLE`/standard) — the board stays what it is |
| `setfingermap` | unchanged; the digit matrix still accepts `8`/`9` for thumbs; the `r <= 3` quirk (row 3 forbids thumbs) is dropped since row 3 *is* the thumb row |

Adding or moving thumb keys on an existing layout stays a site job (the
bench), reached by the link every write reply already carries (18 C9). A
`thumbs!` verb is deferred (§8 P6).

### 5.3 Text grid per kind

`ansi`: today's 0/1/2 indents. `iso`: rows 0–1 indented by one relative to
row 2 (row 2 flush left, its col 0 the ISO key). `ortho`, `colstag`: flat
(colstag amounts can't be shown in monospace; the image can). `symmetric`:
right hand as `ansi`, left hand mirrored (row 0 in by 2, row 2 flush). The
angle mod no longer changes the indent — a fingering isn't a shape; the
`fingermap` verb shows it.

## 6. What the site and the pipeline have to change

- `core/types.ts` `Board` grows to the five kinds; `ui/board/layout.ts`
  gains an ISO row-2 shift, per-column y offsets for colstag, and a mirrored
  left hand for symmetric; `split` replaces the hard-coded col 4 | 5 gap.
- **The Board toggle.** Today every layout is computed under both `rowstag`
  and `ortho` (`defs.boards`, 39 cells per layout) and the user picks a view;
  the layout's own board is ignored (`keyboardBoard`'s header says so). Keep
  the two comparison views (they're what makes fspeed comparable across the
  catalog) and add ONE native cell family for layouts whose kind is `iso`,
  `colstag` or `symmetric`; `ansi` = the rowstag view, `ortho` = the ortho
  view, so the common case costs nothing. The bot's default view is the
  native one. This is the one pipeline change and it is additive.
- `staggeredX` (cmini's fspeed convention) vs `ROW_OFFSET`: the record's
  `stagger` becomes the one source; `fspeed` reads it through the lowering.
- `physicalThumbSide`/`thumbKeySide`/`isThumbKey`'s `TB` branch, bridgecore's
  `PhysicalThumbSide`, `build_web.py`'s `physical_thumb_side`: deleted;
  readers use the label. `normalizeLayoutColumns` stays (it guards the wasm
  against negative columns, not a geometry guess).
- `copy-as-image` and the bot's image share `drawImage`; one renderer change.

## 7. How the format change lands

**Recommendation: edit `spark/1` in place, wipe and re-import.** That is
exactly how 21-formats landed (D8 "no data migration, wipe instead"; D11
"F6 freeze suspended until the first outside adopter"); layoutdb is
disposable (saltorbit, 2026-09-11); no client outside this repo reads spark
yet. It unblocks `L6` (delete the frozen chain machinery): the first real
`spark/2` gets its `up`/`down` when there is an adopter to protect.
Alternative: mint `spark/2` now and keep `spark/1` served through `down`
— it exercises the chain, at the cost of maintaining a lossy `down` (no
`iso`/`colstag`/`symmetric` word in spark/1, `space` dropped) for zero
readers. §8 P1.

## 8. Picks for saltorbit

| # | question | options | my recommendation |
|---|---|---|---|
| P1 | how it lands | (a) edit spark/1 in place + wipe/re-import; (b) spark/2 with `up`/`down` | **(a)**, §7 |
| P2 | kinds | (a) `ansi iso ortho colstag`; (b) + `symmetric` (Treadstone) | **(b)** — cheap in the format, one mirrored offset in the drawers; skip if nobody types on one. Name: `symmetric` over `treadstone` (a shape, not a product) |
| P3 | word for the row-staggered default | `ansi` vs keep `rowstag` | **`ansi`** — it is what people say; `rowstag` invited "ortho = unspecified" |
| P4 | imported cmini `ortho` (3,343 records) | (a) faithful `ortho`; (b) `ansi` (the new default), since most are un-indented pastes | **(a)** — the record says what the author wrote; `board!` fixes one in a message. (b) would silently move 3,343 layouts' fspeed numbers and misdraw real ortho boards |
| P5 | how `add` takes geometry | (a) header lines inside the code block; (b) arguments on the command line (`!sp add mine iso`); (c) both | **(a)** — the block is where the shape lives, and multi-value lines (colstag amounts, digit rows) don't fit on the command line |
| P6 | adding/moving thumb keys on an existing layout | (a) site only (bench link); (b) a `thumbs!` verb taking a thumb line | **(a)** for round 1; add (b) if people ask |
| P7 | `space` | (a) `space: left\|right` on the record; (b) a literal space key in `keys` | **(a)** — (b) changes every stat table's shape and collides with the `_` convention |
| P8 | copy | the header words `board fingers space split`, the kind names, the reply line, the errors | pending saltorbit, as always |

## 9. Invariants this adds (ids provisional; registry `db/INVARIANTS.md`, `bot/INVARIANTS.md`, `design/INVARIANTS.md`)

| id | invariant | enforced by |
|---|---|---|
| LDB-F27 | `validate()` accepts a payload iff `board.kind` ∈ the five kinds and `stagger`/`split` obey §4.4; a valid payload always reads back with `stagger` and `split` filled (defaults are materialised, never implied) | schema mutation matrix + fixture per kind |
| LDB-F28 | `TB` never reaches storage: the schema refuses it, and `fromCmini` maps every `TB`/mislabelled thumb to `LT`/`RT` by the import rule, emitting one info event per relabelled key | `mf9-fromcmini` extended over `upstream-100` + a property test over random thumb columns |
| LDB-F29 | For every valid payload, `fromSpark` (mana2) puts a key in the left thumb string iff its finger is `LT` — the label, never the column | property test |
| LDB-F30 | Physical coordinates are one function of `(kind, stagger, split, row, col)` exported by the format package; the site's board drawer, the bot's image and the mana2 lowering call it (the lowering's `rowOrColumnStagger` reproduces it for every kind on every fixture) | parity test over the fixtures; archlint: no second definition |
| LDB-F31 | `fromCmini` maps the board word by the fixed table in §4.6 and nothing else in the record changes (extends LDB-F23) | `mf9-fromcmini` |
| LDB-B15x | `parseAddGrid` never reads the board from indentation: the same grid with any leading-space pattern yields the same `board` (angle indent → `fingers` only); every thumb key on the thumb line gets its own `(col, finger)` from its text column and side of the gap; the reply names every inferred fact | property test over random indents; golden replies |
| LDB-B15y | `space` resolution in the bot's `auto` mode: record's `space` wins when present, else the site's rules — proven equal to `@akl/core/spacegrams` on every catalog layout without `space` | parity test |
| I-xxx (site) | the Board toggle draws and computes every `ansi` layout as rowstag and `ortho` as ortho unchanged; a native view exists iff `kind ∉ {ansi, ortho}` | matrix row per kind |

## 10. Order of work, once picked

1. `db/formats/spark/1`: schema + `validate()` + the physical-coord function + fixtures per kind + goldens; `fromCmini` relabel + word table; `fromSpark` per kind. Wipe + re-import on prod (`ldb-formats`'s F4 recipe).
2. Bot: `parseAddGrid` rewrite (header lines, thumb line, reply), `board`/`space` verbs, text grid per kind, `angle!` to fingers-only, spacegrams auto reads `space`.
3. Site: `Board` type + drawers + toggle native view; `physicalThumbSide` family deleted; `toAkl1`/`fromAkl1` carry `space` and the new `board`.
4. Pipeline: native cell family for non-ansi/ortho kinds; `fspeed` stagger from the record.
5. `L6`: delete the chain machinery.

Each step is a Sonnet slice off `ldb-geometry`, reviewed here, per the
LEDGER's standing rules.
