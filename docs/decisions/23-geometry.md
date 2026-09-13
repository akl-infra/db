# 23 — Boards, fingerings and thumbs: explicit in spark, explicit at the bot (round 2)

**Status:** design round, nothing built. Branch `ldb-geometry` (worktree
`.claude/worktrees/ldb-geometry`, off `ldb-arch-review`). Picks in §8;
rendered options at `design/artifacts/ldb-geometry.html` (artifact link in
`design/artifacts/index.json`). This is the `W3` "spark/1 format
discussion" item of `review/LEDGER.md` plus the parked `D4`/`D8` round of
`18-command-decisions.md` §2, resumed 2026-09-13 on saltorbit's ask:

> I want to make sure there's a way to set the board type (default ansi, but
> also support iso and ortho). Maybe treadstone too. I also want to make it
> natural to add thumb keys. It's a non-goal to support weird things like
> svalboard and pinchord. We have had to infer a lot of things in akl.gg, and
> I want to introduce new things so we have that explicit.

**Round 2 (saltorbit's feedback on round 1, 2026-09-13):** no declared space
side for now (filed as #333); geometry words go on the command line
(`!sp add mine iso`); `board <name>` with no argument is a lookup;
fingerings (angle mod, nokwts, meteorite) need a home next to the board,
with their existing display precedents captured; and a sketch of how
akl.gg publishes and reads all of this.

**Scope:** what a record says about its physical board, its fingering and
its thumb keys; how the bot takes that in (`add`, `board`, `fingers`); how
the importer fills it from cmini; what the site and the pipeline read
instead of guess. **Non-goals:** key wells / 3-D boards (svalboard),
chorded input (pinchord), layers, combos, hold-taps, duplicate letters
(#322), a declared space thumb (#333), the magic authoring DSL (xsznix's
thread, a separate topic).

## 1. What is inferred today

Every row is a place where a client guesses at something the record never
said. The pattern to end: *the record is ambiguous, so every reader
re-derives the same thing, each slightly differently.*

| what | who guesses | how | what goes wrong |
|---|---|---|---|
| board type | `bot/src/commands/add.ts` `parseAddGrid` (cmini's `add.py`) | leading-space pattern of the three rows: rising = `stagger`, flat = `ortho`, flat-then-one = `angle`, flat-then-two = `mini` | an un-indented paste is `ortho` whatever the author types on; **3,343 of 4,191** catalog layouts are `ortho` this way, 288 `stagger`, 555 `angle`, 5 `mini` |
| the angle mod | same parser; `web/src/core/geometry.ts` `BOARD_MISMATCH_FINGERMAPS` | the `angle` *board word* selects `FMAP_ANGLE` for row 2 and a one-cell indent | a fingering is stored as a board shape; the site then flags `angle mod`/`nokwts`/`meteorite` fingermaps as "mismatched" under ortho |
| stagger amounts | `db/formats/adapters/cmini/translate.ts` (`[0, .25, .75]`), `core/geometry.ts` `ROW_OFFSET`, `staggeredX` (`-.25 / 0 / +.5`, cmini's fspeed convention) | fixed per word | two unreconciled stagger conventions on the site (`geometry.ts` header admits it); no way to say a non-ANSI row stagger |
| ISO | nobody | — | no client can say "there is a key left of Z"; mana2's own `stand_iso.jsonc` needs `skip` + an 11-token row + stagger `[0, .25, -.25]` |
| thumb side | `core/geometry.ts` `physicalThumbSide`, `build_web.py`, bridgecore `PhysicalThumbSide`, `core/spacegrams.ts` `thumbKeySide`, mana2 lowering `thumbDigitForCol` | `col < 4.5` → left, whatever the finger label says | 96 catalog thumb keys carry a label that disagrees with their column; three ports of one rule "kept in lockstep" by comment |
| `TB` | `core/spacegrams.ts` `isThumbKey`, the same ports | "a thumb whose hand cmini never labelled" → by column | 152 catalog thumb keys are `TB`; every consumer needs the special case |
| thumb columns | `add.ts` D13 (`floor(leading spaces / 2)`, finger by `> 8`) | indentation arithmetic; every key on the thumb line gets the same column | two thumb keys on one line collapse onto one column; 40 catalog thumb keys sit at col 0 |
| the space key | `core/spacegrams.ts` auto rules; `cache/cells.ts` `resolveSpace` | from the alpha thumb keys, else the lower Redirect Total, tie → left | the author's own space thumb is never recorded (→ #333) |
| hand split / center gap | `ui/board/layout.ts`, the mana2 lowering, `render/matrix.ts` | fixed at col 4 \| 5 | 913 layouts are 11 wide, 99 are 12, 58 are 13 — extra columns assumed on the right; a 6+6 colstag board cannot be drawn |
| colstag | nothing authors it | `spark/1` allows it; the site's `Board` is `'rowstag' \| 'ortho'` | the site cannot draw one |
| `board.cmini` | `cminiBoardWord()`; the bot's text-grid indent | carried for the deleted cmini export | survives only to pick a text indent |
| the fingering name | `build_web.py` `_build_fingermap_refs`, `core/geometry.ts` `FINGERMAP_REFS` (`standard`, `angle mod`, `nokwts`, `meteorite`, else `other`) | classification of the per-key fingers against four references | fine as a *derived label*; wrong when it drives anything — cmini has no fingering concept at all, so `nokwts` is entered as a `stagger` grid plus a digit matrix |
| symmetric stagger | mana2 `mirrorLeftRowStagger` | — | the Go formula (`load_layout.go:447`) flips per *row parity*, not per hand |

## 2. What the data says (4,191 catalog layouts, 2026-09-12 harvest)

- Board word: `ortho` 3,343 · `angle` 555 · `stagger` 288 · `mini` 5.
- Fingering × word: `standard × ortho` 3,158 · `angle mod × angle` 517 ·
  `other` 274 · `nokwts` 78 (57 `stagger`, 21 `ortho`) · `meteorite` 51
  (26 `stagger`, 20 `angle`, 5 `ortho`) · `angle mod × stagger` 25.
- Main-row width: 10 → 3,000 · 11 → 913 · 12 → 99 · 13 → 58.
- Thumb keys: 0 → 2,553 · 1 → 1,348 · 2 → 211 · 3 → 50 · 4+ → 29; 259 have
  two or more on one side. Labels `LT` 1,270 · `RT` 677 · `TB` 152.
- 22 layouts have a row-3+ key whose finger is not a thumb (number rows).
- 3 layouts are named "iso" (`stand-iso` is stored as `ortho`).

So: the common case is a 10-wide board, standard fingering, zero or one
thumb key, and the board word is noise for ~80 % of records. Anything the
new shape makes *required* must be trivially defaulted for that case.

## 3. Principle

**Infer once, at the door; store it explicitly; never infer at read time.**
The bot's `add` and the cmini importer may guess (indentation, column, the
old `TB`), but they write a record that says what they guessed, and the
reply draws it back. Every reader — the site's board drawer, the bot's
text grid and image, the mana2 lowering, spacegrams — reads the record.
One definition of each geometric fact lives in the format's `validate()`;
the invariants in §9 make readers agree by construction.

A *derived label* (the fingering name, `vowel_hand`) is fine: it is a pure
function of explicit data and nothing consumes it as truth.

## 4. The format

`spark/1`'s payload keeps its shape (`keys`/`free`/`board`/`magic`); this
round changes `board` and tightens `Position.finger`.

```
Payload
├─ keys: Record<char, Position>      -- unchanged (fingers per key ARE the fingering)
├─ free?: Position[]                 -- unchanged
├─ board: Board                      -- REQUIRED now (was optional)
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
indent derives from `kind` + fingering, §5.4). `rowstag` is gone as a word:
it was `ansi` with the stagger written out. No `fingering` field: the
per-key fingers are the fingering; the name is derived (§4.3). No `space`
field (#333).

### 4.1 The kinds

| kind | physical x of `(row, col)` | default stagger | meant for |
|---|---|---|---|
| `ansi` | `col + stagger[row]` | `[0, 0.25, 0.75]` | every row-staggered board; the **default** for an `add` with no board word |
| `iso` | `col + stagger[row]`; row 2's col 0 is the ISO key, so row 2 is one column wider and its stagger is `-0.25` | `[0, 0.25, -0.25]` | ANSI + the key between Shift and Z; the "ISO angle mod" home |
| `ortho` | `col` | none | grids, ortholinear boards |
| `colstag` | `x = col`, `y = row + stagger[col]` | none (required) | corne/ferris/sofle-shaped splits; per-column amounts in key units |
| `symmetric` | right hand `col + stagger[row]`, left hand `col - stagger[row]` (mirror across `split`) | `[0, 0.25, 0.75]` | Treadstone-style symmetric row stagger — *if saltorbit wants it; §8 P2* |

`stagger` on `ansi`/`iso`/`symmetric` is an override for non-standard row
staggers; `validate()` materialises the default so readers never see it
absent. Only finger rows (0–2) take a stagger; a thumb row is drawn under
row 2's offset, as today.

### 4.2 Thumbs

- A thumb key is any key whose finger is `LT` or `RT`, on any row ≥ 3. Its
  `col` is its absolute column, the same axis as the finger rows.
- **The label is the hand.** `LT` is analysed and drawn as a left thumb
  wherever its column is. `physicalThumbSide` and its ports go away; the
  importer applies that rule *once*, relabelling the 96 disagreeing keys
  and the 152 `TB` keys by column at import (§4.6).
- More than one thumb key per side is ordinary (259 layouts); their
  columns order them. `RT` at `col < split` is allowed (the bot reply
  warns) — a one-handed board says what it means.

### 4.3 Fingerings: per-key fingers are the truth, the name is derived

The four named fingerings are the site's `FINGERMAP_REFS` (= `build_web.py`
`_build_fingermap_refs()`), left hand only, right hand always `RI RI RM RR RP`:

| name | row 0 left | row 1 left | row 2 left | precedent today |
|---|---|---|---|---|
| `standard` | `LP LR LM LI LI` | same | same | cmini `stagger`/`ortho` grid |
| `angle` (site: "angle mod") | standard | standard | `LR LM LI LI LI` | cmini `angle` word: FMAP_ANGLE + the bottom row drawn one cell in |
| `nokwts` | `LP LR LM LM LI` | standard | `LP LR LI LI LI` | a `stagger` grid + `setfingermap` digits; drawn as plain stagger |
| `meteorite` | `LP LR LM LM LI` | standard | `LR LM LI LI LI` | stored as `stagger` (26) or `angle` (20); i.e. nokwts' top row with the angle mod's bottom row |

On `iso`, row 2 has six left keys; the same names extend by one pinky
column: `standard` → `LP LP LR LM LI LI`, `angle` → `LP LR LM LI LI LI`
(the ISO angle mod, mana2's `stand_iso`), `nokwts` → `LP LP LR LI LI LI`,
`meteorite` as `angle`. Anything else is `custom` (the site's `other`),
written as a digit matrix. The name is classified from the keys at read
time (site build, bot reply) — never stored, so it can never disagree with
the keys.

### 4.4 Validation (`validate()`, in order after the schema)

1. `board.kind` names a kind; `stagger` length matches (3 for row kinds,
   one per column `0..maxCol` for colstag, absent for ortho); `split` in
   `1..maxCol`.
2. On `iso`, row 2 may be one column wider than rows 0–1.
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
regenerated from the relabelled import).

### 4.6 Import from cmini (`fromCmini`), the one place that still guesses

| cmini | spark |
|---|---|
| `board: stagger` | `kind: ansi` |
| `board: angle` | `kind: ansi` (the angle mod is already in the keys' fingers) |
| `board: ortho` | `kind: ortho` — faithful; §8 P4 |
| `board: mini` | `kind: ortho` |
| finger `TB`, or `LT`/`RT` disagreeing with the column | relabelled by `col < 5`, the last time it runs; an `import_relabel` info event names the key |

### 4.7 Worked examples

ANSI, angle mod, one thumb key each side:

```json
{ "keys": { "z": { "row": 2, "col": 0, "finger": "LR" }, "…": {},
             "e": { "row": 3, "col": 3, "finger": "LT" },
             "r": { "row": 3, "col": 6, "finger": "RT" } },
  "board": { "kind": "ansi", "stagger": [0, 0.25, 0.75], "split": 5 } }
```

ISO with the ISO angle mod (mana2's `stand_iso`): row 2 has 11 keys, col 0
is the ISO key, fingers `LP LR LM LI LI LI | RI RI RM RR RP`:

```json
{ "keys": { "q": { "row": 2, "col": 0, "finger": "LP" },
             "k": { "row": 2, "col": 1, "finger": "LR" }, "…": {} },
  "free": [ { "row": 2, "col": 5, "finger": "LI" } ],
  "board": { "kind": "iso", "stagger": [0, 0.25, -0.25], "split": 5 } }
```

Colstag 3×6+3 (corne), outer pinky columns, three thumbs per side:

```json
{ "board": { "kind": "colstag", "split": 6,
             "stagger": [0.4, 0.2, 0, -0.2, 0, 0.2, 0.2, 0, -0.2, 0, 0.2, 0.4] } }
```

## 5. The bot

### 5.1 `add` — words on the command line, numbers in the block

```
!sp add mine
```
b l d w z  ' f o u j
n r t s g  y h a e i
q x m c v  k p . - /
```
```

parses exactly as today except the board is `ansi`, not `ortho`
(indentation never picks the board). Geometry is **trailing words** after
the name, in any order, from one vocabulary:

| word | is a | writes |
|---|---|---|
| `ansi` `iso` `ortho` `colstag` `symmetric` | board kind | `board.kind` |
| `standard` `angle` `nokwts` `meteorite` | fingering | the keys' fingers |

```
!sp add mine iso            → board iso, standard fingers
!sp add mine iso angle      → board iso, the ISO angle mod
!sp add mine nokwts         → board ansi (default), nokwts fingers
```

Words are consumed from the right while they are in the vocabulary; the
rest is the name (dash-joined, as today). A one-word `add iso` is a layout
named `iso`. Numbers don't go on the line: a colstag's amounts, a
non-default `split`, and a custom digit matrix are **header lines inside
the block**, before the grid:

```
!sp add mine colstag
```
stagger .4 .2 0 -.2 0 .2  .2 0 -.2 0 .2 .4
split 6
q w e r t y  u i o p [ ]
a s d f g h  j k l ; ' \
z x c v b n  m , . / - =
        e r  _ i
```
```

A `fingers` header followed by digit rows (today's `setfingermap` matrix)
is the custom fingering, and wins over a fingering word. Old pastes keep
their meaning: cmini's angle indent (rows 0–1 flush, row 2 in by one) still
means `angle` when no fingering word is given; any other indentation is
cosmetic. An ISO grid is written the way it looks — row 2 out-dented by one:

```
!sp add mine iso angle
```
  q w e r t  y u i o p
  a s d f g  h j k l ;
\ z x c v b  n m , . /
```
```

**Thumb keys** are a fourth line, each key under the column it sits in;
the hand is the side of the center gap. Every key gets its own column and
label (today every key on the thumb line collapses onto one column), and
the reply draws them back:

```
q w e r t  y u i o p
a s d f g  h j k l ;
z x c v b  n m , . /
      e    r
```

→ `e` at row 3 col 3 `LT`, `r` at row 3 col 5 `RT`. A key on the gap column
is an error naming the key.

**The reply** renders what was understood: the text grid drawn per kind
(§5.4), a `· iso · angle · 2 thumbs` line under the name, and the akl.gg
link — an inference at the door is visible before anyone relies on it.

### 5.2 `board` and `fingers` — lookup, preview, write

Same shape for both, cmini's preview / `!` pair like `swap`/`swap!`;
writes are owner-only:

| form | does |
|---|---|
| `board <name>` | lookup: the kind, the amounts and split when non-default, the grid drawn per kind |
| `board <name> iso` | preview the layout on that board (`(was ortho)` noted); `not saved` footer |
| `board! <name> iso` | write `board.kind` (+ default stagger/split) |
| `board! <name> colstag .4 .2 0 …` | kind + amounts in one line (numbers allowed here — no name ambiguity after the name) |
| `fingers <name>` | lookup: the fingering name (`angle`, `nokwts`, …, or `custom`) + today's coloured `fingermap` grids (`fingermap` stays as an alias) |
| `fingers <name> nokwts` | preview with that fingering applied |
| `fingers! <name> nokwts` | write the keys' fingers from the reference (on `iso`, the six-column left hand of §4.3) |
| `fingers! <name>` + digit block | today's `setfingermap` (kept as an alias); the "no thumbs on row 3" quirk dropped |
| `angle!` / `unangle!` | kept as aliases of `fingers! <name> angle` / `standard`; the board no longer changes |

### 5.3 What `fingers! x nokwts` does to a layout that isn't 10 wide

The reference covers left cols 0–4 (0–5 on `iso`) and right cols
`split..split+4`; columns beyond that keep their fingers (an 11th column
stays `RP`, as `FMAP_STANDARD`'s clamp does today). Thumb keys untouched.

### 5.4 Text grid per kind — and the angle-mod precedent (P9)

Board kinds: `ansi` today's 0/1/2 indents; `iso` rows 0–1 in by one, row 2
flush (its col 0 the ISO key); `ortho`/`colstag` flat (colstag amounts
can't be shown in monospace; the image can); `symmetric` right hand as
`ansi`, left hand mirrored.

The angle mod has a display precedent: cmini draws `angle` layouts with
rows 0–1 flush and row 2 in by one — a picture of the rotated hand, not of
the board. Two ways to carry it:

- **(a) board only.** The indent says what the board is; the fingering
  shows in `fingers`' coloured grid and the image. Honest, and `nokwts`
  never had an indent of its own anyway.
- **(b) cmini's precedent, derived.** On an `ansi` board, a fingering
  whose row 2 starts `LR` (`angle`, `meteorite`) draws with the angle
  indent; everything else by board. Derived from explicit fingers (no
  stored word), so it can't disagree with anything; 555 catalog layouts
  keep looking the way their authors know them.

Recommendation: **(b)** — it's the one display habit people have, and it
costs one derived predicate.

## 6. akl.gg: publishing and reading these (later, but keep in mind)

**Publish (`toAkl1`, the bench → spark).** The bench already has the
fingering picker (`FINGERMAP_REFS` + seat popover for custom) and places
thumb keys on a thumb row. Needed: (1) a **board row on the publish sheet**
— kind chips `ansi · iso · ortho · colstag · symmetric`, defaulting to the
session's native board (`rowstag` → `ansi`, `ortho` → `ortho`), with an
amounts field that appears for `colstag` and a `split` stepper; (2) the
bench assigns `LT`/`RT` **when a key is dropped** on the thumb row (side of
the gap at drop time) and keeps it — today it labels by column at read
time; (3) `iso` on the bench = row 2 grows a col-0 seat. `toAkl1` writes
`board {kind, stagger, split}` and the per-key fingers; nothing else new.

**Read (`fromAkl1`, the card, compare).** (1) The card header gets the kind
as a badge next to the existing fingermap badge (`iso · angle`); the small
header board draws the layout's own kind. (2) The **Board toggle** stays
what it is — a *comparison view* (rowstag/ortho) the stats are computed
under — but gains a third state, `native`, shown only when the layout's
kind is `iso`/`colstag`/`symmetric`; the big board follows the toggle as
today. (3) Compare's per-side board (#261) reads each side's kind. (4)
`boardMismatch` (the "angle mod under ortho" flag) becomes "fingering
assumes a row-staggered board" and keys off `kind`, not the word.

**Pipeline.** `defs.boards` (`rowstag`, `ortho`) stays the comparison
dimension; one native cell family is added per layout whose kind is
`iso`/`colstag`/`symmetric` (few); `ansi` = rowstag, `ortho` = ortho, so
the common case costs nothing. `staggeredX` (cmini's fspeed convention) vs
`ROW_OFFSET`: the record's `stagger` becomes the one source.
`physicalThumbSide`/`thumbKeySide`/`isThumbKey`'s `TB` branch, bridgecore's
`PhysicalThumbSide`, `build_web.py`'s `physical_thumb_side`: deleted.

## 7. How the format change lands

**Recommendation: edit `spark/1` in place, wipe and re-import** — how
21-formats landed (D8 "no data migration, wipe instead"; D11 "freeze
suspended until the first outside adopter"); layoutdb is disposable; no
outside client reads spark yet. Unblocks `L6` (delete the frozen chain
machinery). Alternative: mint `spark/2` and serve `spark/1` through a lossy
`down` for zero readers. §8 P1.

## 8. Picks

| # | question | options | recommendation / status |
|---|---|---|---|
| P1 | how it lands | (a) edit spark/1 in place + wipe/re-import; (b) spark/2 with `up`/`down` | **(a)** |
| P2 | kinds | (a) `ansi iso ortho colstag`; (b) + `symmetric` | **(b)**; name `symmetric` over `treadstone` |
| P3 | word for the row-staggered default | `ansi` vs keep `rowstag` | **`ansi`** |
| P4 | imported cmini `ortho` (3,343) | (a) faithful `ortho`; (b) `ansi` | **(a)** — `board! name ansi` fixes one; (b) moves 3,343 layouts' fspeed and misdraws real ortho boards |
| P5 | how `add` takes geometry | — | **settled (saltorbit): words on the command line**, numbers as header lines in the block |
| P6 | thumb-key edits on an existing layout | (a) site only; (b) a `thumbs!` verb | **(a)** for round 1 |
| P7 | space thumb | — | **deferred (saltorbit) → #333** |
| P8 | copy | header words, kind + fingering names, reply line, errors, `fingers` vs `fingermap` as the verb, `angle` vs `angle mod` as the word | saltorbit's |
| P9 | text-grid indent for the angle mod | (a) board only; (b) cmini's angle indent when row 2 starts `LR` on `ansi` | **(b)** |
| P10 | `fingers! name nokwts` on a layout whose row 0 col 3 is a real key the author fingers otherwise | overwrite (the reference is the reference) vs refuse | **overwrite**, with the preview showing the diff first |
| P11 | akl.gg Board toggle | keep two comparison views + `native` when the kind needs it (§6) | later; flagged so the cell store isn't designed around one word |

## 9. Invariants this adds (ids provisional)

| id | invariant | enforced by |
|---|---|---|
| LDB-F27 | `validate()` accepts a payload iff `board.kind` ∈ the five kinds and `stagger`/`split` obey §4.4; a valid payload always reads back with `stagger` and `split` materialised | schema mutation matrix + fixture per kind |
| LDB-F28 | `TB` never reaches storage: the schema refuses it; `fromCmini` maps every `TB`/mislabelled thumb by the import rule, one info event per relabelled key | `mf9-fromcmini` over `upstream-100` + property test over random thumb columns |
| LDB-F29 | For every valid payload, `fromSpark` puts a key in the left thumb string iff its finger is `LT` — the label, never the column | property test |
| LDB-F30 | Physical coordinates are one function of `(kind, stagger, split, row, col)` exported by the format package; the site's drawer, the bot's image and the mana2 lowering call it | parity test over fixtures; archlint: no second definition |
| LDB-F31 | `fromCmini` maps the board word by §4.6's table and changes nothing else (extends LDB-F23) | `mf9-fromcmini` |
| LDB-F32 | The fingering name is a pure classification of the keys' fingers against the four references (`standard`/`angle`/`nokwts`/`meteorite`, with the `iso` six-column variants), identical in the format package, the site build and the bot; never stored | shared table + parity test over the catalog |
| LDB-B15x | `parseAddGrid` never reads the board from indentation: the same grid under any leading-space pattern yields the same `board` (the angle indent → `angle` fingering only, and only without a fingering word); trailing vocabulary words are consumed right-to-left and the remainder is the name; every thumb key gets its own `(col, finger)` from its text column and side of the gap; the reply names every inferred fact | property test over random indents/word orders; golden replies |
| LDB-B15y | `fingers! x <name>` writes exactly the reference over the covered columns and nothing else; `fingers x <name>` then `fingers! x <name>` produce the same keys (preview = write) | property test |
| LDB-B15z | `board <name>` / `fingers <name>` with no argument never write (a lookup is byte-identical to `view`'s freshness path) | test |
| I-xxx (site) | the Board toggle draws and computes every `ansi` layout as rowstag and `ortho` as ortho unchanged; `native` exists iff `kind ∉ {ansi, ortho}`; a key dropped on the thumb row keeps the label assigned at drop time | matrix row per kind |

## 10. Order of work, once picked

1. `db/formats/spark/1`: schema + `validate()` + the physical-coord
   function + the fingering classifier + fixtures per kind + goldens;
   `fromCmini` relabel + word table; `fromSpark` per kind. Wipe + re-import
   on prod (`ldb-formats`'s F4 recipe).
2. Bot: `parseAddGrid` rewrite (trailing words, header lines, thumb line,
   reply), `board`/`board!` and `fingers`/`fingers!` (aliases `fingermap`,
   `setfingermap`, `angle!`, `unangle!`), text grid per kind + P9.
3. Site: `Board` type + drawers + publish-sheet board row + drop-time thumb
   labels + card badge; `physicalThumbSide` family deleted.
4. Pipeline: native cell family for non-ansi/ortho kinds; `fspeed` stagger
   from the record.
5. `L6`: delete the chain machinery.

Each step is a Sonnet slice off `ldb-geometry`, reviewed here, per the
LEDGER's standing rules.
