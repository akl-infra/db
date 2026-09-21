# `/v1` API changelog

One line (a `## 1.<minor>` heading) per additive change to the `/v1`
envelope or route surface. This is the human-readable half of
`design/layout-db/25-api-versioning.md`'s versioning policy: the machine
half is `db/src/core/version.ts`'s `API_MINOR` (literally
`db/src/core/etag.ts`'s `WIRE_VERSION` -- the two are the SAME counter, on
purpose, so they cannot drift apart) and `db/tests/contract/
route-table.golden.json`, the checked-in fingerprint of every route's
response shape. `db/tests/contract/contract.test.ts`'s `[LDB-V5]` case
fails the build if this file's newest entry doesn't name the live
`API_MINOR`, and its `[LDB-V4]` case fails if any route's shape changed
without a new entry here.

**A `/v1` change is additive-only**: a new optional field, a new route, a
new enum value somewhere the docs already say to tolerate an unknown one.
A removal, a rename, or a meaning change under an unchanged shape is a new
major (`/v2`), never an entry here -- see the policy doc's "Policy"
section.

Entries 1.1–1.6 are reconstructed retroactively (2026-09-13, this slice)
from `core/etag.ts`'s own `WIRE_VERSION` comment trail -- every one of
those comments already narrated a real wire-shape change and its date;
this file just gives them a public, versioned home. From here on, a
`WIRE_VERSION` bump and a line here land in the SAME PR, never one without
the other (`[LDB-V5]`).

## 1.15 — 2026-09-21

The row-minus-one decision (LDB-F42, saltorbit/aklgg#398 part 2): `spark/1`'s
`Key.row` minimum widens from 0 to -1 (maximum stays 4) -- a row ABOVE the
3x10 alpha block is now storable as `row: -1` (the number row), instead of
being folded into the bottom (row 3+) as before. Rows 0/1/2 keep their one
meaning everywhere (top/home/bottom of the alpha block); rejected
alternatives were shifting every row down so the new top row becomes 0, and
bottom-anchoring the stagger by row count -- only ONE row above the alpha
block exists, so -1 is the new minimum, never -2. `validate()`'s thumb-row
rule (a thumb finger, LT/RT, never sits on a finger row) now reads rows
-1..2 as finger rows -- a thumb on row -1 is refused exactly like a thumb on
rows 0-2. `?format=mana2/1`'s lowering places a number row first
(`layout.fingers[0]`, ascending stored row) with a `-0.5` `rowOrColumnStagger`
entry (one key-width further out than row 0, the direction rows 1/2 step IN
by). A client validating a fetched record against a cached copy of the OLD
schema (`row` minimum 0) rejects a record that now has a number row --
readers should treat `row` as a signed integer >= -1, not assume 0 is the
minimum. Additive only: no existing field, route or stored payload changes
meaning, and no migration rewrites any existing row (nothing stored had
row -1 before this).

## 1.14 — 2026-09-15

LDB-I27 (saltorbit: "pine has taken down his api" -- cmini's own upstream,
`https://clemenpine.com/layoutapi/v3`, was taken down by its owner): a new
`IMPORT_ENABLED` kill switch (`wrangler.toml`'s `[vars]`, default `"on"`,
currently `"off"`) skips the cmini import tick and the upstream diff tick
entirely, before any fetch. `GET /v1/meta`'s `health.diff` and
`health.import` each gain a `disabled` boolean mirroring it -- while it's
`"off"`, `health.diff.stale` is forced `false` (a deliberate, expected gap
must not read the same as a genuinely stuck job) and `disabled: true` says
why instead. Additive only; the nightly dump and prunes are unaffected.

## 1.13 — 2026-09-13

A `spark/1` magic key's rule is `{after, emit}` (`design/layout-db/
27-magic-emit.md`, saltorbit + xsznix: a rule says what the key emits after
a context, never the context again): `emit` is what the key produces after
the n-gram `after`, the lowered row is `after+key -> after+emit`, and both
fields are non-empty strings -- `after` may now be more than one code point.
The old `{after, output}` (with `output` repeating the context) is refused
by the schema (`400 invalid_payload`), never silently re-read. A row that
would rewrite its context is not a magic-key rule; it lives in the raw
`rules[]` escape hatch, where the cmini import now leaves such rows. Every
stored payload is rewritten in place by migration `0017_magic_emit.sql`
(`emit = output` minus the leading `after`; revs untouched; no re-import).
`?format=mana2/1` output is unchanged: the same rows lower from the new
shape. Same in-place format change class as 1.6 and 1.12 (`21-formats.md`
D11).

## 1.12 — 2026-09-13

`spark/1` has no `board` field any more (`design/layout-db/26-no-board.md`,
saltorbit: a record says where its keys sit, never what board it is drawn
on -- that is the reader's choice). Every stored `spark/1` payload and
every `payload` in a `?format=spark/1` response loses the key; a write
carrying one is `400 invalid_payload` (the schema's `additionalProperties:
false`); `PATCH /v1/layouts/{ref}`'s format edits are `{fingermap, magic}`
only and a body naming `board` is `400 bad_request`; `?format=mana2/1`'s
derived `board` is always the ANSI row stagger (`[0, 0.25, 0.75]`, padded
to the row count). The cmini import drops cmini's own board word. The same
class of change as 1.6: the stored format's OWN shape moving under
`21-formats.md` D11 (edited in place until the first outside adopter) plus
the one envelope field that only existed to edit it -- recorded here, with
a `WIRE_VERSION` bump, rather than as a `/v2`, on the standing "the DB is
disposable until its first outside adopter" rule. Migration `0016_no_board.sql` strips the key from every
stored row so no re-import is needed.

## 1.11 — 2026-09-13

Corrective removal: `GET /v1/meta`'s `health.clients.budget` (from 1.10) and
`health.import.deletes_budget_24h` (from 1.9) are gone. `health.clients`
is `{suspended}` only. The thresholds are deliberately not public. Both
fields had been live for under two hours with no reader.

## 1.10 — 2026-09-13

Rogue-trusted-client hardening (`db/README.md`'s "Rogue trusted client"
runbook): `GET /v1/meta`'s `health` gained `clients: {suspended, budget}`
(a list of currently-suspended clients and the destructive-write budget
that suspends them). Three new admin routes: `POST
/v1/admin/clients/{id}/suspend`, `POST /v1/admin/clients/{id}/reactivate`,
`POST /v1/admin/clients/{id}/revert`. `clients.status` (`GET
/v1/admin/clients`) gained a new value, `suspended`, alongside the existing
`active`/`revoked`. Two new error codes: `client_suspended` (403, a
suspended client's request) and `client_already_revoked` (409, a
suspend/reactivate attempt against a terminally-revoked client). No
existing field, route, or status value changed meaning.

## 1.9 — 2026-09-13

Hostile or vanished upstream defenses. `GET /v1/meta` gains
`health.import` (`stalled`, `deletes_24h`, `deletes_budget_24h`,
`deletes_planned`, `deletes_applied`, `deletes_disabled`). New admin
routes `POST /v1/admin/import/unstall` and `POST /v1/admin/import/
restore-deleted {since, limit?, dry_run?}`. New event kind
`admin.import_unstalled`. Additive.

## 1.8 — 2026-09-13

`GET /v1/changes?wait=` is honoured for every request signed on the client
lane. The `feed:wait` extra cap is still accepted in a client's `caps` but
no longer required (it is implied). Unauthenticated and bearer callers are
unchanged: `wait=` is ignored with `X-Wait-Ignored: unauthorized`. No
response shape changed.

## 1.7 — 2026-09-13

The versioning policy itself (`design/layout-db/25-api-versioning.md`):
`GET /v1/meta` gained `api: {major, minor}` (the API's own version,
distinct from a stored format's major) and `deprecations: []` (always
present, even though nothing is deprecated yet); every response, success
or error, gained the `X-AKLDB-API: <major>.<minor>` header. No existing
field, route or error code changed.

## 1.6 — 2026-09-13

`spark/1`'s own payload shape changed (`design/layout-db/23-geometry.md`,
LDB-F27..F33): `keys` moved from a char-keyed map to an ordered array with
an optional `char`; `board` moved from a `{kind, stagger, cmini}` object to
one required word; the `TB` finger was dropped from the enum; magic's
`default`/`same`/`opposite` became tagged objects instead of bare strings.
No cached `304`/edge-cached body from before this entry can keep serving
the old `spark/1` shape at an unchanged event-log head.

## 1.5 — 2026-09-13

H24 ("mods should not be able to override the like count"): the admin
like-count override added in 1.4 was removed entirely. `like_adjust`
disappears from every layout wire shape again; `like_count` is once more
exactly `COUNT(DISTINCT user_id) FROM likes`. `link` (also added in 1.4)
is unaffected.

## 1.4 — 2026-09-12

L5 moderation (`design/akldb-site/01-plan.md` §4): every layout wire shape
gained `like_adjust` (removed again in 1.5) and `link` (a moderated,
owner-submitted URL).

## 1.3 — 2026-09-11

`design/layout-db/21-formats.md`: several stored formats per layout. The
bare `rev` field was replaced by `layout_rev` plus a per-format `formats`
map; `If-Match`/`ETag` values became scoped tokens (`"layout:<n>"` /
`"<lineage>:<n>"`); `?as=` was replaced by a required `?format=`.

## 1.2 — 2026-09-10

`design/layout-db/20-spark.md` S2: `spark/1` became the stored format id
(`akl/1` renamed, same payload shape); `mana2/1` became an output-only,
derived shape.

## 1.1 — 2026-09-08

Baseline: `GET /v1/meta`, the read routes, and `WIRE_VERSION`-folded
ETag/304 caching (`design/layout-db/07-implementation-phase1.md` S6).
