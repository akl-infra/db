# 23 — Boards, fingerings and thumbs: explicit in spark, explicit at the bot (round 3, decided)

**Status:** decided 2026-09-13 ("let's go ahead and implement"); Q1–Q3 in §8 carry defaults; implementation runs from §10. Branch `ldb-geometry` (worktree
`.claude/worktrees/ldb-geometry`, off `ldb-arch-review`). Rendered options
at `design/artifacts/ldb-geometry.html` (artifact link in
`design/artifacts/index.json`). This is the `W3` "spark/1 format
discussion" item of `review/LEDGER.md` plus the parked `D4`/`D8` round of
`18-command-decisions.md` §2, resumed on saltorbit's ask:

> I want to make sure there's a way to set the board type (default ansi, but
> also support iso and ortho). Maybe treadstone too. I also want to make it
> natural to add thumb keys. It's a non-goal to support weird things like
> svalboard and pinchord. We have had to infer a lot of things in akl.gg, and
> I want to introduce new things so we have that explicit.

**saltorbit's decisions (rounds 1–3, 2026-09-13):**

| decision | detail |
|---|---|
| kinds | `ansi · iso · ortho · colstag`. No `symmetric` ("delete symmetric for now"). |
| board is one word | no stagger amounts, no split: "colstag does not get to set stagger (it's always ortho)"; "split should always happen between left hand and right hand fingers. you do not set split yourself." |
| default | `ansi` when no word is given ("implicit ansi as default is great"); imported cmini `ortho` stays `ortho` (P4a) |
| `add` grammar | geometry as trailing words on the command line: `!sp add mine iso` ("fantastic") |
| lookup / preview / write | `board stand` (lookup, no argument) · `board stand iso` · `board! stand iso`; same trio for `fingers` |
| fingerings | `fingers! stand angle` ("great"), plus `nokwts` and `meteorite`, "which should apply the fingermap and the visual ascii stagger" — with the two looks saltorbit gave (§5.4); "angle is only compatible with ansi"; cmini's angle indent still implies `angle` on old pastes ("implicit angle is great") |
| looks | **flat** for everything ("represented normally, including qwerty etc, and including weird layouts" — graphite's three rows flush); only `angle` gets rows 0–1 flush + row 2 in by one, only `nokwts` and `meteorite` get the full 0/1/2 stagger (round 3 correction: "only nokwts and meteorite should be fully staggered like that"; "meteorite, like aguacero, should present more like [nokwts]") |
| format vs bot rules | "the format should be able to represent things even if the bot doesn't want to" (saltorbit, after review 24 F10): the format never refuses a write over a derived label; "angle only on ansi" is a bot rule for `fingers!`/`board!` |
| space thumb | not now → #333 |
| akl.gg | the §6 concept "sounds good" |
| landing | edit spark/1 in place, wipe + re-import |
| duplicate keys | "the bijection thing sounds bad. we should be able to support duplicate keys, at least in the format" → `keys` becomes an ORDERED LIST (`{char?, row, col, finger}`), `free` folds in as char-less entries, the same char may appear on several entries; a char named by magic has at most one entry (review 24 F5: a two-handed char needs `except` or a raw rule); the mana2 lowering keeps the FIRST ENTRY in list order and emits the rest as `skip` |

**Scope:** what a record says about its physical board, its fingering and
its thumb keys; how the bot takes that in (`add`, `board`, `fingers`); how
the importer fills it from cmini; what the site and the pipeline read
instead of guess. **Non-goals:** key wells / 3-D boards (svalboard),
chorded input (pinchord), symmetric/Treadstone stagger, per-column stagger
amounts, layers, combos, hold-taps, duplicate letters (#322), a declared
space thumb (#333), the magic authoring DSL.

## 1. What is inferred today

Every row is a place where a client guesses at something the record never
said. The pattern to end: *the record is ambiguous, so every reader
re-derives the same thing, each slightly differently.*

| what | who guesses | how | what goes wrong |
|---|---|---|---|
| board type | `bot/src/commands/add.ts` `parseAddGrid` (cmini's `add.py`) | leading-space pattern of the three rows: rising = `stagger`, flat = `ortho`, flat-then-one = `angle`, flat-then-two = `mini` | an un-indented paste is `ortho` whatever the author types on; **3,343 of 4,191** catalog layouts are `ortho` this way, 288 `stagger`, 555 `angle`, 5 `mini` |
| the angle mod | same parser; `web/src/core/geometry.ts` `BOARD_MISMATCH_FINGERMAPS` | the `angle` *board word* selects `FMAP_ANGLE` for row 2 and a one-cell indent | a fingering is stored as a board shape; the site then flags `angle mod`/`nokwts`/`meteorite` fingermaps as "mismatched" under ortho |
| stagger amounts | `db/formats/adapters/cmini/translate.ts` (`[0, .25, .75]`), `core/geometry.ts` `ROW_OFFSET`, `staggeredX` (`-.25 / 0 / +.5`, cmini's fspeed convention) | fixed per word | two unreconciled stagger conventions on the site (`geometry.ts` header admits it) |
| ISO | nobody | — | no client can say "there is a key left of Z"; mana2's own `stand_iso.jsonc` needs `skip` + an 11-token row + stagger `[0, .25, -.25]` |
| thumb side | `core/geometry.ts` `physicalThumbSide`, `build_web.py`, bridgecore `PhysicalThumbSide`, `core/spacegrams.ts` `thumbKeySide`, mana2 lowering `thumbDigitForCol` | `col < 4.5` → left, whatever the finger label says | 96 catalog thumb keys carry a label that disagrees with their column; three ports of one rule "kept in lockstep" by comment |
| `TB` | `core/spacegrams.ts` `isThumbKey`, the same ports | "a thumb whose hand cmini never labelled" → by column | 152 catalog thumb keys are `TB`; every consumer needs the special case |
| thumb columns | `add.ts` D13 (`floor(leading spaces / 2)`, finger by `> 8`) | indentation arithmetic; every key on the thumb line gets the same column | two thumb keys on one line collapse onto one column; 40 catalog thumb keys sit at col 0 |
| hand split / center gap | `ui/board/layout.ts`, the mana2 lowering, `render/matrix.ts` | fixed at col 4 \| 5 | 913 layouts are 11 wide, 99 are 12, 58 are 13 — extra columns assumed on the right; a 6+6 colstag board cannot be drawn |
| `board.cmini` | `cminiBoardWord()`; the bot's text-grid indent | carried for the deleted cmini export | survives only to pick a text indent |
| the fingering name | `build_web.py` `_build_fingermap_refs`, `core/geometry.ts` `FINGERMAP_REFS` (`standard`, `angle mod`, `nokwts`, `meteorite`, else `other`) | classification of the per-key fingers against four references | fine as a *derived label*; cmini has no fingering concept, so `nokwts` is entered as a `stagger` grid plus a digit matrix |

## 2. What the data says (4,191 catalog layouts, 2026-09-12 harvest)

- Board word: `ortho` 3,343 · `angle` 555 · `stagger` 288 · `mini` 5.
- Fingering × word: `standard × ortho` 3,158 · `angle mod × angle` 517 ·
  `other` 274 · `nokwts` 78 (57 `stagger`, 21 `ortho`) · `meteorite` 51
  (26 `stagger`, 20 `angle`, 5 `ortho`) · `angle mod × stagger` 25 ·
  `angle mod × ortho` 7.
- Main-row width: 10 → 3,000 · 11 → 913 · 12 → 99 · 13 → 58.
- Thumb keys: 0 → 2,553 · 1 → 1,348 · 2 → 211 · 3 → 50 · 4+ → 29; 259 have
  two or more on one side. Labels `LT` 1,270 · `RT` 677 · `TB` 152.
- 22 layouts have a row-3+ key whose finger is not a thumb (number rows).

So: the common case is a 10-wide board, standard fingering, zero or one
thumb key, and the board word is noise for ~80 % of records. Anything the
new shape makes *required* must be trivially defaulted for that case.

## 3. Principle

**Infer once, at the door; store it explicitly; never infer at read time.**
The bot's `add` and the cmini importer may guess (indentation, column, the
old `TB`, the wide gap), but they write a record that says what they
guessed, and the reply draws it back. Every reader — the site's board
drawer, the bot's text grid and image, the mana2 lowering, spacegrams —
reads the record. One definition of each geometric fact lives in the
format package; the invariants in §9 make readers agree by construction.

A *derived label* (the fingering name, the hand split, `vowel_hand`) is
fine: it is a pure function of explicit data, computed by one shared
function, and nothing stores it.

## 4. The format

`spark/1`'s payload keeps its shape; this round replaces `board` with one
word and tightens `Position.finger`.

```
Payload
├─ keys: Key[]                       -- a LIST (was a char-keyed map); fingers per key ARE the fingering
├─ board: "ansi" | "iso" | "ortho" | "colstag"   -- REQUIRED, one word
└─ magic?: MagicIntent               -- unchanged

Key
├─ char?: string                     -- one code point; ABSENT = a free position (was the `free` list)
├─ row: -1..4                        -- widened from 0..4 by the row-minus-one decision (§4.1a, below)
├─ col: integer >= 0                 -- unchanged (absolute column, thumbs too)
└─ finger: LP LR LM LI RI RM RR RP LT RT   -- TB REMOVED
```

Gone: `board.kind/stagger/cmini` (the object), `rowstag`, `mini`, `TB`,
the `free` list, the char-keyed `keys` map. Not added: `stagger`, `split`,
`space` (#333), a fingering name.

**Duplicates.** The same `char` may appear on several entries (neon's two
`y`s); no two entries share `(row, col)`. A char named by magic intent
(`magic_keys[].key`, `chiral_keys[].key`, adaptive triggers/swaps, rule
`after` chars, `except[]`) must be unique on the layout
(`400 magic_needs_unique_key`) — magic with duplicates is undefined.
`keys` is an ORDERED list: the first entry for a char is its primary
(review 24 F5 — author priority, not geometry). Lowering to mana2 (which
refuses duplicate letters): the primary is the analysed key, later ones are
emitted as `skip` cells; a documented loss (LDB-F5), revisable when an
analyzer can pick by cost. Magic scaffolds enumerate distinct chars; a char
whose entries span both hands must be in a chiral key's `except` or have an
explicit rule (24 F5). Magic sentinels are tagged with a `kind` discriminator (24 F6, round 2):
`default` is `{kind: "repeat"}` | `{kind: "char", char: "e"}` | absent
(= none), same for chiral `same`/`opposite`; `magic.notes`/`updated` are
dropped (24 round 2 A). `fromCmini` emits `keys` sorted by `(row, col)`;
full-payload writers preserve fetched order (24 round 2 D).

### 4.1 The kinds

| kind | physical x of `(row, col)` | text grid | meant for |
|---|---|---|---|
| `ansi` | `col + [0, .25, .75][row]` | flat (the look comes from the fingering, §5.4) | every row-staggered board; the **default** |
| `iso` | `col + [0, .25, -.25][row]` — z at col 1 lands at 0.75, exactly its ANSI spot; the only new thing is the ISO key at col 0, x = −0.25 | flat, row 2 out-dented by one cell so the ISO key sticks out left and z stays under q | ANSI + one extra key between Shift and Z, nothing else moves |
| `ortho` | `col` | flat | grids, ortholinear boards |
| `colstag` | `col` (stats and text as ortho) | flat | column-staggered splits; the word is for renderers and readers, not for amounts |

The stagger is a fixed function of the kind — nothing in the record
overrides it. The **hand split** is derived, never stored: for each finger
row, the gap sits after the last column whose key has a left-hand finger
(`L*`); the board's split column is the minimum over rows 0–2 of the first
right-hand column, `5` when a row has no right-hand key. One function,
`handSplit(keys)`, exported by the format package (§9 F30).

#### 4.1a Row −1: the number row (decided 2026-09-21)

A row ABOVE the 3×10 alpha block is stored as `row: -1` — rows 0/1/2 keep
their one meaning everywhere (top/home/bottom of the alpha block); below
the alpha block is thumbs, unchanged. Only ONE row above the alpha block
exists: −1 is the new minimum, never −2. Rejected alternatives: shifting
every row down so the new top row becomes 0 (breaks every existing
consumer's assumption that row 0 is the alpha block's own top row, for
every layout that never had a number row); bottom-anchoring the stagger by
row count (loses the distinction between "a number row" and "a 4th finger
row below the alpha block", which the 22 pre-existing number-row layouts
already used row 3 for, ambiguously — see §4.6, `fromCmini` never produces
row −1). Physical x of `(row, col)`, added to §4.1's table:

| kind | physical x of `(-1, col)` |
|---|---|
| `ansi` | `col - .5` |
| `iso` | `col - .5` |
| `ortho`, `colstag` | `col` (flat, same as every other row) |

`handSplit(keys)`/`handSplitRows(keys)` (§4.1's own functions) are
UNCHANGED — row −1 is outside `handSplitRows`' 0-indexed array and outside
`handSplit`'s rows-0-2 board-split candidates, same as it was always
outside both. A new function, `handSplitForRow(keys, row)`, is the same
per-row rule as one call for ANY row, including −1. `classifyFingering`
(§4.3) is also unchanged: row −1 is outside its fixed 3×10 grid and is
never looked at, same as row 3+ already was.

### 4.2 Thumbs

A thumb key is refused on row −1 the same as on rows 0–2 (§4.4 rule 3,
below) — row −1 is a finger row, not a thumb row; a thumb key still only
ever sits on a row ≥ 3.

- A thumb key is any key whose finger is `LT` or `RT`, on any row ≥ 3. Its
  `col` is its absolute column, the same axis as the finger rows.
- **The label is the hand.** `LT` is analysed and drawn as a left thumb
  wherever its column is. `physicalThumbSide` and its ports go away; the
  importer applies that rule *once*, relabelling the 96 disagreeing keys
  and the 152 `TB` keys by column at import (§4.6).
- More than one thumb key per side is ordinary (259 layouts); their
  columns order them.

### 4.3 Fingerings: per-key fingers are the truth, the name is derived

The four named fingerings are the site's `FINGERMAP_REFS` (= `build_web.py`
`_build_fingermap_refs()`), left hand only; the right hand is always
`RI RI RM RR RP`:

| name | row 0 left | row 1 left | row 2 left | boards | text look (§5.4) |
|---|---|---|---|---|---|
| `standard` | `LP LR LM LI LI` | same | same | any | flat |
| `angle` (site: "angle mod") | standard | standard | `LR LM LI LI LI` | **ansi only** | the angle look |
| `nokwts` | `LP LR LM LM LI` | standard | `LP LR LI LI LI` | **ansi only** | full stagger 0/1/2 |
| `meteorite` | `LP LR LM LM LI` | standard | `LR LM LI LI LI` | **ansi only** | full stagger 0/1/2, like nokwts (saltorbit: "meteorite, like aguacero, should present more like [nokwts]") |

Anything else is `custom` (the site's `other`), written as a digit matrix.
The name is classified from the keys at read time (site build, bot reply)
by one shared function — never stored. "ansi only" is saltorbit's rule for
`angle` ("angle is only compatible with ansi"), applied to all three named
non-standard fingerings since each carries the ansi visual (§8 Q1). On
`iso`/`ortho`/`colstag` a non-standard fingering is written as digits (the
ISO angle mod is `iso` + the `LP LR LM LI LI LI` row typed as
`0 1 2 3 3 3`).

### 4.4 Validation (`validate()`, in order after the schema)

1. `board` is one of the four words.
2. On `iso`, row 2 may be one column wider than rows 0–1.
3. Finger rows are −1..2 (plus 3 when no key on row 3 is a thumb — the 22
   number-row layouts, now more naturally expressed on row −1 instead, §4.1a);
   a thumb key never sits on rows −1..2.
4. ~~fingering needs ansi~~ — dropped per review 24 F10: the classifier
   is a derived label and never refuses a write; the BOT enforces "angle
   only on ansi" for its `fingers!`/`board!` verbs (§5.2). `" "` is refused
   as a `char` pending #333 (24 F11).
5. Everything spark/1 checks today (single code point, no duplicate
   `(row, col)`, magic references, lowering collision).

### 4.5 Lowering to mana2 (`db/formats/mana2/1/translate.ts` `fromSpark`)

| kind | `isRowStaggered` | `rowOrColumnStagger` |
|---|---|---|
| `ansi` | true | `[0, .25, .75]`, `-0.5` PREPENDED when the layout has a row −1 (§4.1a) |
| `iso` | true | `[0, .25, -.25]`; row 2's 11 tokens as-is (mana2's own `stand_iso` shape) |
| `ortho`, `colstag` | true | `[0, 0, 0]` |

Row strings split at `handSplit(keys)` (today: "after the 5th column").
Thumb strings: left = `LT` keys by column, right = `RT` keys by column
(today's `col < 4.5` re-anchoring goes; `LDB-F12`'s parity fixture is
regenerated from the relabelled import).

Row ORDER is ascending stored row (§4.1a): row −1, when present, becomes
`layout.fingers[0]`/`fingermap[0]`, and every row from 0 up shifts its own
array index up by one. `toSpark` (mana2 → spark, the reverse direction) is
NOT taught this: a mana2 array index always reconstructs as that same row
number, unconditionally — mana2's own rows carry no "this one is physically
above" signal to recover −1 from. A spark → mana2 → spark round trip of a
number-row layout therefore loses row identity on the way back (every row
shifts down by one), the same class of loss a 4th finger row already caused
before this decision (§9 F42).

### 4.6 Import from cmini (`fromCmini`), the one place that still guesses

| cmini | spark |
|---|---|
| `board: stagger` | `ansi` |
| `board: angle` | `ansi` (the angle mod is already in the keys' fingers) |
| `board: ortho`, `board: mini` | `ortho` — faithful, always (the angle-family bump was dropped with rule 4.4-4; the 33 such layouts keep `ortho` and their angle look) |
| finger `TB`, or `LT`/`RT` disagreeing with the column | relabelled by `col < 5`, the last time it runs; an `import_relabel` info event names the key |

### 4.7 Worked examples

ANSI, angle mod, one thumb key each side, a free position, a duplicated `y`:

```json
{ "keys": [ { "char": "z", "row": 2, "col": 0, "finger": "LR" }, "…",
            { "char": "y", "row": 0, "col": 5, "finger": "RI" },
            { "char": "y", "row": 2, "col": 4, "finger": "LI" },
            { "row": 2, "col": 9, "finger": "RP" },
            { "char": "e", "row": 3, "col": 3, "finger": "LT" },
            { "char": "r", "row": 3, "col": 6, "finger": "RT" } ],
  "board": "ansi" }
```

ISO with the ISO angle mod (mana2's `stand_iso`): row 2 has 11 keys, col 0
is the ISO key, fingers `LP LR LM LI LI LI | RI RI RM RR RP` (custom digits):

```json
{ "keys": [ { "char": "q", "row": 2, "col": 0, "finger": "LP" },
            { "char": "k", "row": 2, "col": 1, "finger": "LR" }, "…",
            { "row": 2, "col": 5, "finger": "LI" } ],
  "board": "iso" }
```

Colstag 3×6+3 (corne): 12-wide rows, left fingers on cols 0–5 (so
`handSplit` = 6), three thumbs per side:

```json
{ "keys": [ { "char": "q", "row": 0, "col": 0, "finger": "LP" }, "…",
            { "char": "y", "row": 0, "col": 5, "finger": "LI" },
            { "char": "u", "row": 0, "col": 6, "finger": "RI" } ],
  "board": "colstag" }
```

## 5. The bot

### 5.1 `add` — words on the command line, digits in the block

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
| `ansi` `iso` `ortho` `colstag` | board | `board` |
| `standard` `angle` `nokwts` `meteorite` | fingering | the keys' fingers |

```
!sp add mine iso            → board iso, standard fingers
!sp add mine nokwts         → board ansi (default), nokwts fingers
!sp add mine ortho angle    → Error: angle is only for ansi boards
```

Words are consumed from the right while they are in the vocabulary; the
rest is the name (dash-joined, as today). A one-word `add iso` is a layout
named `iso`. The only header line is `fingers` followed by digit rows
(today's `setfingermap` matrix) — the custom fingering, which wins over a
word.

**The wide gap is the hand split.** cmini grids already show two spaces
between the hands; the parser now reads it: keys left of the gap get
left-hand default fingers, keys right of it right-hand ones (`LP LR LM LI
LI` outward-in, extra inner columns `LI`/`RI`, extra outer columns
`LP`/`RP`). A grid with no wide gap splits after col 4, as today. So a 6+6
colstag is just a grid with its gap where the hands are:

```
!sp add mine colstag
```
q w e r t y  u i o p [ ]
a s d f g h  j k l ; ' \
z x c v b n  m , . / - =
        e r  _ i
```
```

Old pastes keep their meaning: cmini's angle indent (rows 0–1 flush, row 2
in by one) still means `angle` when no fingering word is given; any other
indentation is cosmetic. Finger rows are tokenised per row (a key's column
is its token index; `~` is a free position; the wide gap is the hand
split), so an ISO grid is simply row 2 with one more key at the front —
typed flush or out-dented, both parse the same:

```
!sp add mine iso
```
q w e r t  y u i o p
a s d f g  h j k l ;
\ z x c v b  n m , . /
```
```

→ `\` at row 2 col 0 (`LP`), `z` at col 1 (`LP`), … `b` at col 5 (`LI`),
`n` at col 6 (`RI`). The reply out-dents row 2 so z sits under q.

**Thumb keys** are a fourth line, each key under the column it sits in;
the hand is the side of the gap. Every key gets its own column and label
(today every key on the thumb line collapses onto one column), and the
reply draws them back:

```
q w e r t  y u i o p
a s d f g  h j k l ;
z x c v b  n m , . /
      e    r
```

→ `e` at row 3 col 3 `LT`, `r` at row 3 col 5 `RT`. A key on the gap column
is an error naming the key.

**The reply** renders what was understood: the text grid drawn per §5.4, a
`· iso · 2 thumbs` line under the name (the fingering name when it isn't
`standard`), and the akl.gg link.

### 5.2 `board` and `fingers` — lookup, preview, write

Same shape for both, cmini's preview / `!` pair like `swap`/`swap!`;
writes are owner-only:

| form | does |
|---|---|
| `board <name>` | lookup: the kind, the grid drawn per §5.4 |
| `board <name> iso` | preview the layout on that board (`(was ortho)` noted); `not saved` footer |
| `board! <name> iso` | write `board`; refused by the BOT (not the format) with the reason when the layout's fingering is `angle`/`nokwts`/`meteorite` and the target isn't `ansi` |
| `fingers <name>` | lookup: the fingering name (`angle`, `nokwts`, …, or `custom`) + today's coloured `fingermap` grids (`fingermap` stays as an alias) |
| `fingers <name> nokwts` | preview with that fingering applied — fingers and the look |
| `fingers! <name> nokwts` | write the keys' fingers from the reference; refused on a non-`ansi` board |
| `fingers! <name>` + digit block | today's `setfingermap` (kept as an alias); the "no thumbs on row 3" quirk dropped |
| `angle!` / `unangle!` | aliases of `fingers! <name> angle` / `standard`; the board no longer changes |

### 5.3 What `fingers! x nokwts` does to a layout that isn't 10 wide

The reference covers left cols 0–4 and right cols `split..split+4`;
columns beyond keep their fingers (an 11th column stays `RP`, as
`FMAP_STANDARD`'s clamp does today). Thumb keys untouched. Preview = write
(§9 B15y).

### 5.4 Text grid: the looks (decided)

The look is a function of the **derived fingering alone** — the board word
never changes the ascii grid (it changes the image, the site and the
stats). Everything is flat unless the fingering says otherwise:

| fingering | look | example (saltorbit's, verbatim) |
|---|---|---|
| `standard`, `custom`, anything else — "including qwerty etc, and including weird layouts" | flat (rows flush) | `graphite` below |
| `angle` | rows 0–1 flush, row 2 in by one | `maya` below |
| `nokwts`, `meteorite` | full stagger: rows in by 0/1/2 | `nokwts` below |

```
graphite (stronglytyped) (78 likes)
  b l d w z  ' f o u j ; =
  n r t s g  y h a e i ,  
  q x m c v  k p . - /    
```

```
maya (lelazsq) (21 likes)
  b l d g q  j f o u ,
  n r t s v  k h a e i
   x m c w z  p y ' / .
```

```
nokwts (stronglytyped) (13 likes)
  z b r l f  j y o u '
   n t h s m  c d e i a ,
    q x w k v  p g / . ;  
```

`iso` is the one board-driven touch: flat, with row 2 out-dented by one
cell so the ISO key sticks out left and z stays under q. The hand gap sits
at `handSplit(keys)` per row (today's fixed `j === 4` padding in
`render/matrix.ts` goes).

Consequence to know: the 180 cmini-`stagger` layouts whose fingering is
`standard`/`other` are drawn 0/1/2 today and will be flat after import;
that is the rule as given ("only nokwts and meteorite should be fully
staggered like that").

## 6. akl.gg: publishing and reading these (concept agreed; later)

**Publish (`toAkl1`, the bench → spark).** The bench already has the
fingering picker (`FINGERMAP_REFS` + seat popover for custom) and places
thumb keys on a thumb row. Needed: (1) a **board row on the publish sheet**
— chips `ansi · iso · ortho · colstag`, defaulting to the session's native
board (`rowstag` → `ansi`, `ortho` → `ortho`); the angle/nokwts/meteorite
chips disable off `ansi`; (2) the bench assigns `LT`/`RT` **when a key is
dropped** on the thumb row (side of the gap at drop time) and keeps it;
(3) `iso` on the bench = row 2 grows a col-0 seat at x = −0.25; nothing else moves. `toAkl1` writes `board`
(one word) and the per-key fingers; nothing else new.

**Read (`fromAkl1`, the card, compare).** (1) The card header gets the kind
as a badge next to the existing fingermap badge (`iso · angle mod`); the
small header board draws the layout's own kind. (2) The **Board toggle**
stays what it is — a *comparison view* (rowstag/ortho) the stats are
computed under — but gains a third state, `native`, shown only when the
layout's kind is `iso` or `colstag`; the big board follows the toggle as
today. (3) Compare's per-side board (#261) reads each side's kind. (4)
`boardMismatch` ("angle mod under ortho") can't happen any more (4.4-4).

**Pipeline.** `defs.boards` (`rowstag`, `ortho`) stays the comparison
dimension; `ansi` = rowstag, `ortho`/`colstag` = ortho; `iso` gets one
native cell family (few layouts). `staggeredX` vs `ROW_OFFSET`: the kind's
fixed stagger from the format package becomes the one source.
`physicalThumbSide`/`thumbKeySide`/`isThumbKey`'s `TB` branch, bridgecore's
`PhysicalThumbSide`, `build_web.py`'s `physical_thumb_side`: deleted.

## 7. How the format change lands (decided)

Edit `spark/1` in place, wipe and re-import — how 21-formats landed (D8,
D11); layoutdb is disposable; no outside client reads spark yet. Unblocks
`L6` (delete the frozen chain machinery).

## 8. Still open

| # | question | default if unanswered |
|---|---|---|
| Q1 | are `nokwts` and `meteorite` ansi-only like `angle`? (§4.3) | yes — each carries the ansi visual; anything else is digits |
| Q2 | copy (P8): the words as typed (`angle` vs `angle mod`; verb `fingers` vs `fingermap`), the reply's `· iso · angle · 2 thumbs` line, the error texts (`angle is only for ansi boards`, `e sits in the gap`) | ship as `// COPY: sign-off pending` stand-ins, as the LEDGER rule says |
| Q3 | thumb-key edits on an existing layout stay on the site (P6) | yes |

## 9. Invariants this adds (ids provisional; registry `db/INVARIANTS.md`, `bot/INVARIANTS.md`, `design/INVARIANTS.md`)

| id | invariant | enforced by |
|---|---|---|
| LDB-F27 | `validate()` accepts a payload iff `board` ∈ {ansi, iso, ortho, colstag} and §4.4 holds; the iso width rule and the ansi-only fingering rule each have a refusing fixture | schema mutation matrix + fixture per kind |
| LDB-F28 | `TB` never reaches storage: the schema refuses it; `fromCmini` maps every `TB`/mislabelled thumb by the import rule, one info event per relabelled key | `mf9-fromcmini` over `upstream-100` + property test over random thumb columns |
| LDB-F29 | For every valid payload, `fromSpark` puts a key in the left thumb string iff its finger is `LT` — the label, never the column | property test |
| LDB-F30 | Physical coordinates (`(kind, row, col) → (x, y)`), `handSplit(keys)` and `classifyFingering(keys)` are each ONE function exported by the format package; the site's drawer, the bot's grid/image and the mana2 lowering call them (the lowering's `rowOrColumnStagger` and row-string split reproduce them on every fixture) | parity test over fixtures; archlint: no second definition |
| LDB-F31 | `fromCmini` maps the board word by §4.6's table — including the angle-family bump to `ansi` — and changes nothing else (extends LDB-F23) | `mf9-fromcmini`; a fixture per bumped case |
| LDB-F33 | `keys` is an ordered list: the same `char` may appear on several entries and no two entries share `(row, col)`; a char named anywhere in `magic` has at most one entry, and a char whose entries span both hands is refused for the chiral scaffold unless in `except` or covered by a raw rule (`400 magic_needs_unique_key`); `fromSpark` analyses the first entry in list order and emits later duplicates as `skip` (LDB-F17 holds); `canonical()` preserves array order and `fromCmini` emits `(row, col)` order | fixture with two `y`s + its goldens; mutation matrix; property test over random duplicate insertions |
| LDB-F32 | `classifyFingering` returns `angle`/`nokwts`/`meteorite`/`standard` exactly when the left-hand fingers of rows 0–2 equal the reference (right hand `RI RI RM RR RP`), else `custom`; identical in the format package, the site build and the bot | shared table + parity test over the catalog against today's `layouts.json` `fingermap` |
| LDB-B15x | `parseAddGrid` never reads the board from indentation: the same grid under any leading-space pattern yields the same `board` (the angle indent → `angle` only, and only without a fingering word); trailing vocabulary words are consumed right-to-left and the remainder is the name; the wide gap sets default fingers per hand; every thumb key gets its own `(col, finger)`; the reply names every inferred fact | property test over random indents/word orders; golden replies |
| LDB-B15y | `fingers! x <name>` writes exactly the reference over the covered columns and nothing else; `fingers x <name>` then `fingers! x <name>` produce the same keys (preview = write); refused off `ansi` | property test |
| LDB-B15z | `board <name>` / `fingers <name>` with no argument never write, and the text grid's look is a pure function of `classifyFingering(keys)` (plus the `iso` out-dent) per §5.4 — saltorbit's three reference grids (graphite, maya, nokwts) are goldens | golden test with the verbatim grids |
| I-xxx (site) | the Board toggle draws and computes every `ansi` layout as rowstag and `ortho`/`colstag` as ortho unchanged; `native` exists iff `board = iso`; a key dropped on the thumb row keeps the label assigned at drop time | matrix row per kind |

## 10. Order of work

1. **Format** (`db/formats/spark/1`): schema (`board` string, no `TB`) +
   `validate()` + `coords`/`handSplit`/`classifyFingering` + fixtures per
   kind + goldens; `fromCmini` (word table, angle-family bump, relabel);
   `fromSpark` per kind. Wipe + re-import on prod (`ldb-formats`'s F4 recipe).
2. **Bot**: `parseAddGrid` rewrite (trailing words, wide gap, `fingers`
   digit header, thumb line, reply), `board`/`board!` and
   `fingers`/`fingers!` (aliases `fingermap`, `setfingermap`, `angle!`,
   `unangle!`), text grid per §5.4 with the two goldens.
3. **Site**: `Board` type + drawers + publish-sheet board row + drop-time
   thumb labels + card badge; `physicalThumbSide` family deleted.
4. **Pipeline**: `iso` native cell family; `fspeed` stagger from the format
   package.
5. `L6`: delete the chain machinery.

Each step is a Sonnet slice off `ldb-geometry`, reviewed here, per the
LEDGER's standing rules.

### 10.1 Cutover runbook (prod), 2026-09-13

saltorbit: "i don't care about wiping the db and starting over. the akldb
layout is not actively in use yet." So: wipe + fresh cmini import (new ids;
the few native rows are accepted losses). Published cells are keyed by
layout id and payload hash, so they are rebuilt after. The ldb-arch-review
lead session owns the spark deploy, rebuild and restart; saltorbit picks the hour.

1. Pre-flight: db + bot + site green together on `ldb-geometry`; the
   importer's full run proven on the new shape against a fresh local D1
   (`npm run import -- --once --fixture`).
2. Window opens: `wrangler d1 time-travel info akl-db` (rollback bookmark);
   off-account copy of `/v1/dump/latest.json` + the gz (cheap insurance).
3. Fast-forward `ldb-geometry` into `ldb-arch-review` (push = prod Worker
   deploy with the new `validate`). **STOP THE OLD BOT FIRST** (`flyctl
   machine stop <machine> -a spark-bot`): learned 2026-09-13 — the old
   reader consuming thousands of delete + new-shape create events during
   the import stalled its main thread 5–16 s, timed out `/v1/meta` and
   pushed RSS to 83 %. The new image starts it again at step 5.
4. Wipe the live tables (the F4 recipe from `ldb-formats`; `sqlite_sequence`
   for `events` reset per the 0009 gotcha is moot on a wipe) and run the
   cmini import to completion (every page — check `/v1/meta` import state
   before moving on); spot-read a few layouts.
4b. FORCE A DUMP: `POST /v1/admin/dump` (new in the format slice), then
   confirm `/v1/dump/latest.json` has `seq` ≥ the import's head seq and
   `layout_count` ≈ the import count. Both the bot's fresh replica boot and
   `rebuild-on-fly.sh` read that dump; without this they would load the
   PRE-wipe catalog (the scheduled dump is daily at 03:00 UTC).
5. Spark deploy (`flyctl deploy` from a clean tree, `performance-1x`); the
   new bot invalidates a volume snapshot whose payload format version
   differs and rebuilds its replica from the dump (or the snapshot file is
   deleted on the volume before the restart).
6. `bash scripts/rebuild-on-fly.sh` (~17 min; fresh base, pointer swap)
   then `flyctl machine restart` the bot so its published index reloads.
7. db-alias site build last (after the pointer swap); akl.gg prod untouched.

### 10.2 Row −1, the number row (decided 2026-09-21)

saltorbit/aklgg#398 part 2: a row ABOVE the 3×10 alpha block is now stored
as `row: -1` (§4.1a) instead of being folded onto row 3+ below it (the 22
pre-existing number-row layouts' own workaround). Rejected: shifting every
row down so the new top row becomes 0 (breaks row 0/1/2's fixed meaning for
every OTHER layout); bottom-anchoring the stagger by row count (keeps the
ambiguity between "a number row" and "a genuine 4th finger row" the old
row-3 workaround already had). `Key.row`'s schema minimum widens from 0 to
−1 (`WIRE_VERSION` 15, `CHANGELOG-API.md` 1.15, `LDB-F42`) — additive, no
migration (nothing stored ever had row −1 before this).
