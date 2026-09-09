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
| LDB-G2 | No admin id is a constant in code (the migration seed is data) | `tests/tools/noconst.test.ts` |
| LDB-G5 | Nothing imports across the `db/` boundary in either direction | `tests/tools/boundary.test.ts` |
| LDB-T1 | Every registry id has a tagged test and every tag has a registry row | `tests/tools/invariants.test.ts` |
