# 26 — No board: `spark/1` stops saying what board a layout is on

*2026-09-13 · scope: `db/formats/spark/1`, its translators, the API's
PATCH surface, and every client that wrote or read the field (akl.gg's
publish path, the spark bot). Reverses the `board` half of
`23-geometry.md`; leaves its thumbs, fingerings and hand-split decisions
untouched.*

saltorbit, 2026-09-13: "i want to remove the board type from spark/1.
that also means we should remove the same thing from akl.gg on publish."

## Decision

**A `spark/1` record never says what physical board it is drawn or
analysed on.** It says where every key sits (`row`, `col`) and which
finger presses it; the board is the **reader's** choice — akl.gg's
rowstag/ortho comparison view, the bot's engine context, a mana user's
own `.jsonc` — never a property of the layout. So:

| what | before (`23-geometry.md`) | now |
|---|---|---|
| `spark/1` payload | `{keys, board: "ansi"\|"iso"\|"ortho"\|"colstag", magic?}`, `board` required | `{keys, magic?}`; a payload carrying `board` is refused (`additionalProperties: false`, `400 invalid_payload` at `/`) |
| `validate()` | the four-word enum; on `iso`, row 2 at most one wider than rows 0–1 | both gone; the thumb-row rule and the space refusal stay (pure functions of `keys`) |
| `geometry.ts` | `KINDS`, `Board`, `STAGGER_BY_KIND`, `coords(kind, row, col)` + the hand split and `classifyFingering` | only the hand split and `classifyFingering` (+ `gridIndent`, `FINGERING_REFS`); every board-keyed export deleted, `cminiBoardWord` with it |
| `PATCH /v1/layouts/{ref}` | `{format, fingermap? \| board? \| magic?}` | `{format, fingermap? \| magic?}`; a body naming `board` is `400 bad_request` (route schema); spark/1's `edits` are `{setFingermap, setMagic}` |
| cmini import (`fromCmini`) | `stagger`/`angle` → `ansi`, `ortho`/`mini` → `ortho` (LDB-F31) | cmini's `board` word is dropped, like `tag`/`blame`/`combos`/`link` (LDB-F23's list grows by one; LDB-F31 retired). An upstream board-only change is no longer a content diff (LDB-P5/LDB-C4) |
| mana2 → spark (`toSpark`) | `board` object → one word, or **held** when a row stagger's 4th entry disagreed with the 3rd | the whole mana2 `board` object is dropped, never held (`908-held-stagger-mismatch` became the plain fixture `908-stagger-mismatch`) |
| spark → mana2 (`fromSpark`, `?format=mana2/1`) | `STAGGER_BY_KIND[board]`, colstag → `isRowStaggered: false` | always the **fixed ANSI row stagger** `[0, 0.25, 0.75]` (`DEFAULT_ROW_STAGGER`), padded to the row count by repeating row 2's offset; `isRowStaggered: true`, `mirrorLeftRowStagger: false`, `splitAngle: 0`. A reader that wants another board edits the file; the DB never guesses one from the keys |
| stored rows | every payload carried `board` | migration `0016_no_board.sql` strips the key from every `layout_formats` and `layout_revs` spark payload in place (`json_remove`; byte-identical to `canonical()` of the board-less payload; revs untouched; idempotent). No wipe, no re-import |
| wire version | 11 | 12 (`CHANGELOG-API.md` 1.12) |
| akl.gg publish | the publish sheet's board picker (ansi/iso/ortho chips, hover previews, the geometry guess for a new layout, the record's own board for an update) and `toAkl1`/`toAkl1Update` writing `board` | gone: the site never writes, reads, guesses or shows a record's board. Its own rowstag/ortho comparison view is untouched — that was always the reader's choice |
| the bot | `board`/`board!` verbs, board words on `add`, "angle only on ansi" for `fingers!`, the iso out-dent in the text grid, `cminiBoardWord(payload)` feeding the engine | all gone; the engine and the overlay get the fixed default word (the site's default view, rowstag → cmini's `stagger`) |

## Why

`23-geometry.md` §2's own data: on a 4,191-layout catalog "the board
word is noise for ~80 % of records". The word was inferred at the door
(cmini's indentation, then cmini's own word, then a geometry guess on the
publish sheet, I-423), and every consumer then had to reconcile it with
its own view: the site draws and computes every layout under BOTH
rowstag and ortho anyway (`defs.boards`), the bot computes its cells per
board context regardless, and the mana lowering needed a table to turn
one word back into amounts. A stored word that no reader trusts and
every writer guesses is a field the format is better off without. The
one thing it genuinely carried — "this layout has an ISO key" — is
already visible in the keys themselves (row 2 one column wider).

## What this is not

- Not a change to thumbs (`LT`/`RT` is the hand, `23-geometry.md` §4.2),
  to the derived hand split, or to the named fingerings (§4.3) — all
  functions of `keys` alone, unchanged.
- Not a `spark/2`. The format is edited in place under `21-formats.md`
  D11 (no outside adopter yet; layoutdb is disposable), the same way
  `23-geometry.md` landed as wire version 6. `25-api-versioning.md`'s
  "a removal is a `/v2`" rule is about the envelope; the one envelope
  field removed here (`PATCH`'s `board` edit) existed only to edit the
  format field that is gone, and is recorded as 1.12 with that caveat
  stated — the day this needs to be a `/v2` instead is the day the
  first outside client exists.
- Not a data wipe: 0016 rewrites stored rows in place, so the runbook in
  `23-geometry.md` §10.1 is NOT needed for this change. The bot's
  snapshot version bumps (a snapshot written under the old shape is
  discarded and the replica cold-boots from the dump, LDB-B234's rule).

## Invariants

| id | invariant | enforced by |
|---|---|---|
| LDB-F40 | everything in the table above on the DB side, in one row (`db/INVARIANTS.md`) | `tests/formats/mutations.test.ts`, `edits.test.ts`, `mf9-fromcmini.test.ts`, `mana2.test.ts`, `tests/api/patch.test.ts`, `tests/api/migration-0016.test.ts`, `tests/import/diff-unit.test.ts`, `difftick.test.ts` |
| LDB-F27, F23, F24, F30, F5 | restated minus the board (`db/INVARIANTS.md`) | as before |
| LDB-F31 | retired | — |
| site / bot | their own registries (`design/INVARIANTS.md`, `bot/INVARIANTS.md`) carry the client-side rows: a publish never writes `board`; the bot never sends one and ignores a stray one | the aklgg repo's own tests |
