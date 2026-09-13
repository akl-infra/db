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
