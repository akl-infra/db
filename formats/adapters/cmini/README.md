# cmini adapter

cmini's own v3 layout detail (`GET /layoutapi/v3/layouts/{id}`), minus the
fields the database treats as record fields (`name user likes created_at
modified_at`). Everything else -- `board keys free? magic? combos? tag?
blame? link?` -- is kept verbatim on this adapter's own `Payload` type, so
an import always has upstream's exact shape to translate from.

**Import-only** (`design/layout-db/21-formats.md` D5, lead's call, review
of `20-spark.md` S1's original "unregistered but still readable" design):
`fromCmini` (`translate.ts`) is the ONE conversion left, cmini -> `spark/1`
at import time. There is no `toCmini`, no `spark/1 -> cmini/1` lowering,
and no way to reach this shape from the API at all -- `GET .../{ref}
?as=cmini/1` answers exactly like any other unregistered format id (404
`unknown format`, with the list of registered ones). `cmini/1`'s own `id`
constant (below) stays for identity/testing purposes only; it was never
re-registered after `20-spark.md` S1 unregistered it, and D5 finished the
job by deleting the export path S1 had left in place. What `fromCmini`
drops on the way in (`tag`, `blame`, `combos`, `link`, and since
`design/layout-db/26-no-board.md` the `board` word -- fields `spark/1` has
no place for) is permanent: nothing downstream of the DB ever sees them
again. `db/tests/formats/mf9-fromcmini.test.ts` (LDB-F23, MF-9) is the
invariant that replaces the old cmini round trip: over every
`upstream-100` fixture layout, the `(char, row, col, finger)` multiset
survives exactly, and the fields dropped are exactly those five -- nothing
else vanishes or leaks in.

## What it can't express

Nothing that upstream itself can express is lost on the way IN: this
format's job is to hold what cmini holds, including the parts of the live
set that violate the bot's own rules (07 §0.1) -- empty `keys`, non-thumb
fingers on thumb rows and vice versa, a row 4, 3-code-point `magic.inputs`.
There is deliberately **no thumb-row rule and no non-empty-keys rule** in
`validate()`.

Going OUT (import -> `spark/1`) loses `tag`/`blame`/`combos`/`link` (D10,
D5 -- `spark/1` has no free-form `x` bag to carry them in anymore, and
nothing reads them back) and the `board` word (26-no-board.md: `spark/1`
has no board field; the angle mod it sometimes named is already in the
keys' own fingers).

## Owner

`DB` -- this format lives with the service, not with any one client. Changes
go through `OWNERS`.
