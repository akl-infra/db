# cmini adapter

cmini's own v3 layout detail (`GET /layoutapi/v3/layouts/{id}`), minus the
fields the database treats as record fields (`name user likes created_at
modified_at`). Everything else -- `board keys free? magic? combos? tag?
blame? link?` -- is kept verbatim, so `?as=cmini/1` of an imported record
reproduces upstream exactly (`design/layout-db/01-format.md` §6.1's D12
diff).

Was the registered format `cmini/1`; moved here and unregistered by
`design/layout-db/20-spark.md` S1, decision 2 ("cmini is an import source,
not a format"): `fromCmini`/`toCmini` (`translate.ts`) are the conversion
to/from `spark/1`, the one stored format now. `?as=cmini/1` stays readable
through the registry's alias table (`ALIASES`); a `cmini/1` write is
refused from S2 on. Its own `id` constant (below) stays `cmini/1` -- that's
the format identity these functions still implement, only its registration
status changed.

`link` stays **in the payload**, not as a record field: keeping cmini's
value here is what keeps the diff exact, and nothing else ever reads it
(`design/layout-db/00-plan.md` §6).

## What it can't express

Nothing that upstream itself can express is lost: this format's job is to
hold what cmini holds, including the parts of the live set that violate the
bot's own rules (07 §0.1) -- empty `keys`, non-thumb fingers on thumb rows
and vice versa, a row 4, 3-code-point `magic.inputs`. There is deliberately
**no thumb-row rule and no non-empty-keys rule** in `validate()`.

What it *cannot* express, because upstream can't either: layers, combos as
an idiom (they ride as opaque `{inputs,output}` pairs, not lowered),
per-column stagger amounts (cmini's four board words are coarser than
`spark/1`'s `stagger` array), alternate fingerings, `except` on magic keys.
Writing a `spark/1` record with any of those and reading it back
`?as=cmini/1` degrades to what cmini can hold -- that's `toCmini`'s
documented loss (01 §6.2), not a bug here.

## Owner

`DB` -- this format lives with the service, not with any one client. Changes
go through `OWNERS`.
