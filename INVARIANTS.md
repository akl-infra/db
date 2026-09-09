# db/ invariant registry

The `LDB-*` invariants for the layout-db service (`design/layout-db/`,
phase 1: `07-implementation-phase1.md`). This registry lives with the code
(it moves with `db/` when the service splits into its own repo, per
`00-plan.md` §7) rather than in the site's `design/INVARIANTS.md`, which
carries one pointer entry instead.

Every row here needs a test tagged `[LDB-*]` in its `test()`/`it()` title
under `db/tests/`; `tests/tools/invariants.test.ts` (LDB-T1) fails the
build when an id has no tagged test, or a tag names an id not in this
table. Each slice's PR adds its own rows (07 §6); this file starts with
the S1 rows only.

| id | invariant | enforced by |
|---|---|---|
| LDB-A1 | No write is accepted without a resolved actor; every non-GET route answers 401 to an anonymous request (enumerated from the router) | `tests/auth/routes.test.ts` |
| LDB-A2 | The Discord cache serves a success ≤ 5 min and a 401 ≤ 60 s; 5xx/429/network are never cached; the token is never stored | `tests/auth/discord.test.ts` |
| LDB-C1 | `db.yml`'s shape (test job on PR/push under `db/**`; deploy needs test, main+push only, migrations before deploy; daily job runs rehost + diff; actions pinned) is asserted from the parsed YAML | `tests/tools/ciwiring.test.ts` |
| LDB-C2 | `canonical()` is key-order-invariant and lossless | `tests/core/canonical.test.ts` |
| LDB-F1 | Every stored payload validates against its format's frozen schema; a write that does not is refused with the failing path | `tests/formats/goldens.test.ts`, `tests/formats/mutations.test.ts` |
| LDB-F2 | `lower()` is deterministic across versions | `tests/formats/goldens.test.ts` (`.lowered.json` goldens) |
| LDB-F3 | Intent is never lowered on store | `tests/formats/intent.test.ts` |
| LDB-F4 | Lowering collisions are refused with both sources named | `tests/formats/collisions.test.ts`, `tests/formats/mutations.test.ts` |
| LDB-F5 | `cmini/1 → akl/1 → cmini/1` is identity on the projection, for every fixture and (P5) the live set | `tests/formats/roundtrip.test.ts`, `tests/api/list.test.ts`, S8 |
| LDB-F6 | Merged format majors are immutable | `tests/formats/frozen.test.ts` |
| LDB-F7 | Every format has ≥ 1 fixture and a frozen golden per declared translation | `tests/formats/goldens.test.ts` |
| LDB-F8 | `liftRules(lower(m)) == (m, [])` for every valid idiom set; `lower(lift(rows)) ≡ rows` for every typed row set; leftovers are exactly the rows that fail their tag's invariant | `tests/formats/lift.test.ts` |
| LDB-F9 | A held record keeps name/owner/rev and reads as its own format | `tests/api/held.test.ts` |
| LDB-F10 | `x` survives same-format round trips; only `x.cmini` survives `to["cmini/1"]` | `tests/formats/x.test.ts`, `tests/formats/roundtrip.test.ts` |
| LDB-F11 | Every live upstream detail (snapshot) validates as `cmini/1` and `hasMagic` matches upstream's `has_magic` | `tests/formats/cmini-envelope.test.ts` |
| LDB-G2 | No admin id is a constant in code (the migration seed is data) | `tests/tools/noconst.test.ts` |
| LDB-G5 | Nothing imports across the `db/` boundary in either direction | `tests/tools/boundary.test.ts` |
| LDB-I1 | The import is idempotent: the same upstream state twice appends zero events | `tests/import/tick.test.ts` |
| LDB-I2 | The import never overwrites a record that does not follow upstream | `tests/import/cases.test.ts` |
| LDB-I2a | "Follows upstream" ⇔ the record's latest rev-bumping event has `via = import:cmini` | `tests/events/follows.test.ts` |
| LDB-I3 | Tombstoning more than `max(5, 5%)` of live records in one tick stalls the import instead | `tests/import/plan.test.ts` |
| LDB-I4 | Every import event carries `via = import:cmini` and `actor = system:cmini-import` (likes: the liking user) | `tests/import/cases.test.ts` |
| LDB-I5 | Imported names are stored verbatim (case kept, `check_name` not applied) and are unique case-insensitively | `tests/import/cases.test.ts` |
| LDB-I6 | A list shorter than half the live record count stalls the whole tick | `tests/import/plan.test.ts` |
| LDB-I7 | A tick whose `/meta` token is unchanged makes no further request and writes nothing | `tests/import/tick.test.ts` |
| LDB-I8 | Every upstream request carries the UA; 404 is never retried; other failures are retried 3x | `tests/import/upstream.test.ts` |
| LDB-P1 | Every write appends exactly one rev-bumping event and one `layout_revs` row; the record equals the fold of its events; `seq` is gapless | `tests/events/fold.test.ts`, `tests/tools/onlywriter.test.ts` |
| LDB-P4 | A name is released only by delete or rename | `tests/events/names.test.ts`, `tests/api/refs.test.ts` |
| LDB-P6 | `/v1/changes` serves from `since=0`, including after a restore | `tests/events/feed.test.ts` |
| LDB-P7 | Every error response carries `error` and `message`; every (route, status) pair has a conformance case | `tests/api/conformance.test.ts` |
| LDB-P8 | A tombstone is unreadable by name from the moment of deletion (phase 1 half; the 30-day restore is phase 2) | `tests/api/refs.test.ts` |
| LDB-R1 | Polled routes carry `Cache-Control` + strong `ETag` and answer `304` to a matching `If-None-Match`; the ETag changes iff the event head or the query changes | `tests/api/etag.test.ts` |
| LDB-R2 | `/v1/meta` counts and `seq`/`revision` equal the tables | `tests/api/meta.test.ts` |
| LDB-R3 | The conformance fixtures are the API contract; changing one is a documented API change | `tests/api/conformance.test.ts` (+ review) |
| LDB-R4 | Every `sort` × `limit` cursor walk visits every live record exactly once | `tests/api/list.test.ts` |
| LDB-R5 | `/rev/{n}` reproduces the payload stored at rev `n` for every n | `tests/api/history.test.ts` |
| LDB-T1 | Every registry id has a tagged test and every tag has a registry row | `tests/tools/invariants.test.ts` |
