# 27 — Magic-key rules say what the key emits: `{after, emit}`

*2026-09-13 · scope: `spark/1`'s `magic_keys[].rules[]`, its compiler and
lifter, the cmini import, the reseed job, stored rows, and every client
that authors or reads the field (akl.gg's codec and workbench, the spark
bot's copy). The raw escape hatch `magic.rules[]` is untouched.*

xsznix (Discord, 12:57): "for magic rule `a* -> ab`: `after: a, output: b`,
not `after: a, output: ab` — the latter mixes context and output."
saltorbit (12:59): "great point, agree. it should probably be just
(ngram-in, ngram-out) for more flexibility." saltorbit, 2026-09-13, on the
proposal below: "luve it. let's do that."

## Decision

A magic key's rule names the **context** the key follows and **what the
key emits** there, and nothing else:

```json
{ "key": "*", "default": { "kind": "repeat" },
  "rules": [ { "after": "a", "emit": "b" }, { "after": "th", "emit": "e" } ] }
```

| | before (`22-spark-spec.md` §5 as shipped) | now |
|---|---|---|
| field | `{after, output}`, `output` the whole emitted n-gram, so `output` had to start with `after` (the validator refused anything else) | `{after, emit}`; `emit` is what the key produces after `after`. The field is **renamed**: new meaning, new name, so the schema's `additionalProperties: false` refuses an old-shape rule instead of silently reading `output` as an emission (`24-spark-wire-review.md` finding 8's own rule) |
| lowered row | `after+key -> output` | `after+key -> after+emit`, always. A magic key never rewrites its context |
| `after` | exactly one code point | any non-empty string — an n-gram context (`th`) is legal; a scaffold row is only replaced by an explicit rule whose `after` is that one board character, so a longer context never suppresses one |
| `emit` | (implicit, ≥ 1 code point after the context) | any non-empty string. `emit: ""` ("emit nothing") is **not** allowed — new behaviour, not decided; refuse until asked for |
| a row whose output does not start with its context (`a* -> xy`) | expressible as `{after: "a", output: "xy"}`? No — refused | not a magic-key rule; it lives in the raw `rules[]` escape hatch. The cmini import (`liftRules`) leaves such a `magic`-tagged row as a leftover (raw) instead of lifting it |
| `default`, chiral `same`/`opposite`, adaptive swaps | emit-shaped already | unchanged |
| collisions, phase order, the word-start row, `except` | — | unchanged (`explicitAfters` still keys on the rule's `after`; a bare-space `after` still suppresses the word-start row) |
| stored rows | every payload | migration `0017_magic_emit.sql` rewrites in place: `emit = output` minus the leading `after`, `output` dropped, on `layout_formats` and every `layout_revs` payload; byte-identical to `canonical()`, revs untouched, idempotent. No wipe |
| wire version | 12 | 13 (`CHANGELOG-API.md` 1.13) |
| reseed from akl.gg (`scripts/reseed-magic.mjs`, `26-magic-reseed.md`) | copied rules verbatim | converts `{after, output}` → `{after, emit}` on the way in; a rule that does not extend its context (impossible past akl.gg's own gate) is demoted to a raw `rules[]` row rather than dropped |
| `?format=mana2/1` | — | unchanged: the same rows lower from the new shape (the parity vectors and every golden prove it) |

## Amendment 2026-10-18: skip rules and `skip_repeat` (LDB-F48..F50)

`design/alts/43-skip-magic-wire.md` §1 (saltorbit, 2026-10-17/18). `after`
stays a non-empty string, and may also be a **2-item array** `[a, b]`: `a`
exactly one code point (never null), `b` one code point or `null`, the
any-middle wildcard. Like `alts` (`design/alts/07-format.md`), and not the
string `_`, which is a real key on many layouts and always a literal.

```json
{ "key": "*", "default": { "kind": "skip_repeat" },
  "rules": [ { "after": ["h", null], "emit": "e" }, { "after": "th", "emit": "e" } ] }
```

- `["h", null]` + `emit: "e"` lowers to the structured row
  `{"inputs": ["h", null, "*"], "output": ["h", null, "e"], "type": "magic"}`:
  after `h` and any one character, the key emits `e`. A skip rule never
  replaces the key's one-back scaffold row.
- `["h", "e"]` (no null) means exactly the string `"he"`: it lowers, dedupes
  and collides as `"he"`. Writers emit the array only with a null.
  `["h", null]` is a different context from `"h"` (a different tier) and from
  every string; both may sit on one key.
- Arity is exactly 2 (the engines look back two). Refused: `[null, "e"]`,
  `["h"]`, `["h", null, "e"]`, `["he", null]`, `["h", ""]`. `emit` is as
  above; akldb does not police that a skip rule's `emit` is one code point.
- Default `{"kind": "skip_repeat"}` (magic keys only; a chiral key has none):
  scaffolds `{"inputs": [c, null, key], "output": [c, null, c], "type":
  "skip_repeat"}` for every character a `repeat` default scaffolds (board
  characters, no whitespace, no magic/chiral key chars), minus the key's
  `except` and minus every `c` with an explicit `["c", null]` rule (explicit
  replaces scaffold). No space row. A new kind rather than `repeat` with
  `back: 2`, so no reader of `kind === "repeat"` silently reads it as plain
  repeat.
- The raw `rules[]` escape hatch stays strings; `_` there is the underscore.
- `?as=mana2/1` drops every array row (mana2 has no wildcard): a documented
  loss, like `alts`.

Stored data is unaffected (every stored `after` is a string). `CHANGELOG-API.md`
1.20.

## Clients

- **akl.gg** keeps its own `{after, output}` authoring model for now and
  converts at the codec boundary: `toAkl1` writes `emit = output` minus
  `after`, `fromAkl1` reads `output = after + emit`; the DB-mode rules PUT
  (`functions/_lib/magicdb.mjs`), the pipeline's `--source db` read and the
  vendored schema follow. A rule the editor cannot model (an `after` longer
  than one code point) is carried through untouched by an update that does
  not change rules, and the rules editor treats the record as view-only
  otherwise — the same posture as a duplicate-character record. Changing
  the workbench so an author types the emission rather than the whole
  n-gram is a separate, later step.
- **the bot** compiles through `@akl/core/rules` (the same code as the
  site) and vendors the DB's parity vectors; its own reads of a rule
  (`magic`, `mirror!`/`cycle!` transforms) follow the new field.

## Invariants

| id | invariant | enforced by |
|---|---|---|
| LDB-F41 | the table above on the DB side (`db/INVARIANTS.md`): the schema refuses `output`, `after`/`emit` non-empty, the lowered row is `after+key -> after+emit`, `liftRules` emits `{after, emit}` and leaves a context-rewriting row raw, migration 0017's byte-identity | `tests/formats/mutations.test.ts`, `magic-aklgg-validation.test.ts`, `lift.test.ts`, `magic-special-scaffold.test.ts`, `tests/api/migration-0017.test.ts`, `tests/tools/reseed-magic.test.ts` |
| LDB-F8, F14, F15, F22, F39 | restated for the new field | as before |

## Amendment 2026-10-18: skip chiral keys (LDB-F51)

design/alts/43-skip-magic-wire.md §2e (saltorbit): a chiral key may carry
`"skip": true` (true only). It then picks `same`/`opposite` by the hand of
the character TWO back, with any character between, and lowers to one
any-middle row per board character `c` with a hand:
`[c, null, key] -> [c, null, out]`, `out` = `c` for `{"kind":"repeat"}` (the
character two back), else the literal. A chiral key without `skip` lowers as
before; `?as=mana2/1` drops the rows (LDB-F50).

## Note 2026-10-18: compiled rows are pre-tiebreak (LDB-F50)

`computeRows`/`compileMagic` lower exactly what was authored. akl.gg's clients
add a static tiebreak on top (design/alts/43-skip-magic-wire.md §2d in
saltorbit/aklgg): where a skip rule and an explicit two-character rule on the
same key disagree, they write a named three-character row for the winner,
decided by the displaced character's home finger; generated skip rows
(`skip_repeat`, skip chiral) lose to an explicit two-character row outright.
akldb does not run it and serves no stats. **A client that computes stats or
typing from a spark/1 payload with skip rules must apply that tiebreak
itself**, as akl.gg's site compile and engine do, or a skip + swap layout means
something else to it.
