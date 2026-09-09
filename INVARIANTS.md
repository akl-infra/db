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
| LDB-C1 | `db.yml`'s shape (test job on PR/push under `db/**`; deploy needs test, main+push only, migrations before deploy; daily job runs rehost + diff; actions pinned) is asserted from the parsed YAML | `tests/tools/ciwiring.test.ts` |
| LDB-C2 | `canonical()` is key-order-invariant and lossless | `tests/core/canonical.test.ts` |
| LDB-F1 | Every stored payload validates against its format's frozen schema; a write that does not is refused with the failing path | `tests/formats/goldens.test.ts`, `tests/formats/mutations.test.ts` |
| LDB-F2 | `lower()` is deterministic across versions | `tests/formats/goldens.test.ts` (`.lowered.json` goldens) |
| LDB-F6 | Merged format majors are immutable | `tests/formats/frozen.test.ts` |
| LDB-F7 | Every format has ≥ 1 fixture and a frozen golden per declared translation | `tests/formats/goldens.test.ts` |
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
| LDB-P4 | A name is released only by delete or rename | `tests/events/names.test.ts` |
| LDB-P6 | `/v1/changes` serves from `since=0`, including after a restore | `tests/events/feed.test.ts` |
| LDB-R2 | `/v1/meta` counts and `seq`/`revision` equal the tables | `tests/api/meta.test.ts` |
| LDB-T1 | Every registry id has a tagged test and every tag has a registry row | `tests/tools/invariants.test.ts` |
