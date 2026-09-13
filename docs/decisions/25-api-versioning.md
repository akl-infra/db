# 25 — API versioning: audit and policy

*2026-09-13 · branch `ldb-arch-review` · scope: `db/`'s HTTP API only (the
layout-db Worker, `/v1/*` and `/admin/changelog`) — not the site
(`web/`, `functions/`) or the bot's own internal shapes, which are
CLIENTS of this API and read only.*

saltorbit, 2026-09-13: "it's great that the format is well versioned, but we
need to make sure the akldb api itself is well versioned too." This is a
distinct concern from `design/layout-db/21-formats.md`/`22-spark-spec.md`
(a stored **format**'s own major, e.g. `spark/1`) and from
`24-spark-wire-review.md` finding 8 (how a *format*'s major should be
bumped, resolved there as "golden identity" — same-major iff every fixture's
lowered/mana2 golden stays byte-identical). This doc covers the **envelope
and route surface every response of any format rides in**: `/v1` itself,
`GET /v1/meta`, the error vocabulary, `Idempotency-Key`, and everything a
third-party client (a bot, a site, a script) depends on that isn't a
record's own payload.

## Audit

### 1. What "version" means today, layer by layer

| layer | what it is | who bumps it, when | where a client can see it | can a client detect a change at runtime? |
|---|---|---|---|---|
| URL prefix `/v1` | the whole service's compatibility promise | never bumped (no `/v2` exists) | the URL itself | trivially yes (it's the path) — but nothing distinguishes "no `/v2` exists" from "a `/v2` exists and you're not using it" |
| `WIRE_VERSION` (`src/core/etag.ts`, before this slice) | an integer, folded into every polled route's ETag hash (`/v1/meta`, `/v1/layouts`, `/v1/changes`, `/v1/authors`) so a pre-deploy cached body/304 can't keep serving an old shape at an unchanged event-log head | bumped by hand, in the SAME PR as a wire-shape change, with a dated code comment naming what changed (a real, honest changelog — see §2 below) | **nowhere.** Never in a header, never in `/v1/meta`'s body. A client sees only that its ETag stopped matching (a forced cache miss); it has no way to read the number itself | no — a client can tell "the cached shape might be stale" but not "the shape changed" vs. "the event log moved", and never *what changed* or *to what* |
| a stored **format**'s own major (`spark/1`, `mana2/1`) | one payload shape's own version, independent per lineage | a new major registers alongside the old one (`up`/`down`, `21-formats.md`/`22-spark-spec.md`); until the first outside adopter, edited in place (D11) | `GET /v1/formats` (`major`, `latest`, `can_translate_to`); `409 format_behind` reactively | **yes**, and well — this is the one layer that already had a real answer before this slice (adoption.md §8, "For clients moving to a new major") |
| event schema (`schema: 3`-style patch versioning) | N/A to this API | — | — | not applicable: grepped `db/src`, `functions/` for a `schema`/`schema_version` field on an event or a D1 patch row and found none live. The site's old stat-patch overlay (`stat_patches`/`layout_patches`, `design/layout-db/review/PROPOSAL.md` §2.3's delete list) is the closest match to what the brief's "`schema: 3` patches" describes, and it is site-side (`cb-magic`), out of `db/`'s boundary, and already slated for deletion — not part of `/v1`'s own contract. Nothing here to version further |
| dump format (`GET /v1/dump/latest.json`) | the nightly full-state snapshot | implicitly, whenever the `layouts`/`layout_formats`/`events` schema changes (a D1 migration) | `layout_count`, `seq`, `sha256`, `bytes` in the pointer object; no shape version at all | no — a client that fetches a dump gets whatever shape the CURRENT restore code produces; nothing in the pointer says which shape version it is. (Low risk in practice: the dump's shape has moved in lockstep with the same migrations that changed the live routes, and `tests/rehost.test.ts` proves restore round-trips the CURRENT shape — but a client caching an OLD dump across a deploy has no signal) |
| `Idempotency-Key` (LDB-K1..K7) | a 24h replay/mismatch mechanism, not a version at all | — | `Idempotency-Replayed: true` header on a replay | n/a — mentioned here only because it's the other header-based mechanism a client already relies on; it never carries or implies an API version |
| error codes (`src/core/errors.ts`) | a flat, stable vocabulary | a new factory function, additive by construction (LDB-G8 keeps `db/INTEGRATION.md`'s appendix generated from it) | the `error` field of every 4xx/5xx body | yes, already well-covered — adding a NEW code is safe by definition (a client that doesn't recognize a code still has `status` + `message`); the audit found no case of a code's MEANING changing under an unchanged name |

**The gap, in one sentence:** every layer above has *some* notion of its
own version except the one that actually gates whether `/v1`'s promise
(additive-only) is being kept — there was no public counter for "has the
`/v1` envelope changed", no way for a client to ask for it, and no test
that would fail if a change violated the promise.

### 2. `WIRE_VERSION`'s comment trail — the API's real changelog, previously invisible

`src/core/etag.ts`'s `WIRE_VERSION` constant already had exactly what a
minor-version changelog needs — a bump, a date (via cross-reference to the
design doc that caused it), and a one-sentence description — but it existed
only as a code comment nobody outside this repo could ever read, and the
number itself never left the server (folded into a hash, never surfaced).
Reconstructed from `git log -p db/src/core/etag.ts` and the comment text
itself:

| `WIRE_VERSION` | when | what changed | visible to a client? |
|---|---|---|---|
| 1 | 2026-09-08 (`b03293591`) | baseline: read routes, ETag/304 | no |
| 2 | 2026-09-10 (`63af35465`) | `spark/1` becomes the stored format id | no |
| 3 | 2026-09-11 (`d521239c3`) | several formats per layout; `layout_rev` replaces the bare `rev`; scoped `If-Match` | no |
| 4 | 2026-09-12 (`e19c07b41`) | moderation: every layout gains `like_adjust`/`link` | no |
| 5 | 2026-09-13 (`daf06b447`) | H24: `like_adjust` REMOVED (a field that existed for one day) | no |
| 6 | 2026-09-13 (`ac57dd053`) | `23-geometry.md`: `spark/1`'s OWN payload shape changed (`keys` map → ordered array, `board` object → one word, `TB` dropped, magic sentinels tagged) | no |
| 7 | 2026-09-13 (this slice) | `GET /v1/meta` gains `api`/`deprecations`; every response gains `X-AKLDB-API` | **yes, from here on** |

Two things stand out:

- **Bump 4 → 5 reverted a wire-shape change one day after it shipped**
  (`like_adjust` added by `c5bdee269` 2026-09-12, removed by `daf06b447`
  2026-09-13 — "mods should not be able to override the like count"). A
  client that read `like_adjust` for that one day had zero signal that the
  field existed, was meaningful, or was about to vanish. This is exactly
  the scenario a public minor + changelog is for, even for a field that
  lived less than 24 hours.
- **`ed749558e` (2026-09-12) deleted `POST /v1/webhooks`, `GET
  /v1/changes/stream`, and the per-major dump files (`latest.<name>-<N>.json`)
  outright** — a real route/mechanism REMOVAL, done in place under `/v1`,
  with **no `WIRE_VERSION` bump at all** (removing a route isn't a *body
  shape* change the ETag hash needs to invalidate, so nothing in the
  existing mechanism was built to notice it). Per this doc's own policy
  (§ below), a removal is exactly the case that must NOT happen in place —
  it should have been impossible to land without either (a) proving no
  client used it (LEDGER.md L4 asserts this: "no consumer"), which is a
  legitimate reason to remove something with zero deprecation notice, or
  (b) a stated exception. The audit found no test that would have caught
  this either way; `tests/contract/contract.test.ts`'s new golden (below)
  would flag ANY future route removal, forcing the same judgment call to
  be made explicitly instead of silently.

### 3. Doc drift: `db/INTEGRATION.md` still describes the deleted routes

`db/INTEGRATION.md` (the non-code-checked doc — `db/README.md` calls it
"the older integration note") §5 still documents `GET
/v1/changes/stream` (SSE, with `Last-Event-ID` resume) and `POST
/v1/webhooks` (HMAC delivery, retry/backoff/disabled) as live routes,
**one day after `ed749558e` deleted both** (`db/src/routes/` has no
`webhooks.ts` or `stream.ts`; confirmed by `ls`/`grep` against the live
router). `db/docs/adoption.md` — the code-checked guide (`LDB-G10`) — got
this right: its §4 was updated the same day to describe the long-poll
replacement and says so explicitly ("replaces the retired SSE stream and
webhooks"). `db/docs/adoption.md` §7/§8 also references "the per-major
dump files" (`latest.<lineage>-<N>.json`) as the mechanism for testing a
format-major migration — also deleted by the same commit
(`buildLatestMajorFiles`, LDB-D6's retirement note in `db/INVARIANTS.md`)
— and `LDB-G10`'s own machine checks (route table, error table, the
format-author checklist) don't reach that prose, so it drifted silently
too. **This is finding 8 (`24-spark-wire-review.md`) one level up, in
plain doc text rather than code**: a shape/mechanism can disappear with
nothing automated to notice a *sentence* describing it went stale. Not
fixed in this slice beyond a pointer (§ "Docs" below) — `INTEGRATION.md`'s
webhooks/SSE section is out of this slice's versioning scope, but is
flagged here because it is live evidence for exactly the gap this doc
exists to close.

### 4. What a third-party client can and cannot detect today

| signal | detectable how | what it tells a client |
|---|---|---|
| a route disappearing | a `404`/routing failure on next call | "something broke", not "this was deprecated on schedule" |
| a field disappearing | its own code breaking (`undefined` where a value was expected) | nothing proactive; failure is the notification |
| a field's MEANING changing under an unchanged name (finding 8's own example: `finger: "LT"` at col 7, re-anchored-by-column → a real left thumb) | **nothing.** No schema diff, no version bump exists for this class of change at the ENVELOPE level (the format-level version, `spark/1`'s own major, is exactly what finding 8 was about; the API envelope had no equivalent at all) | nothing, ever, until behavior downstream is visibly wrong |
| a format major changing | `GET /v1/formats`'s `latest`/`major`; reactively, `409 format_behind` | who's affected, concretely — this layer already worked |
| the event log moving | `/v1/meta`'s `seq`, `/v1/changes` | freshness, not shape |
| the wire shape changing (any route) | **nothing, until this slice.** `WIRE_VERSION` existed but was never surfaced | nothing |

Both first-party clients confirm this by their own code: `bot/src/cache/
fresh.ts`'s `ensureFresh()` reads `/v1/meta`'s `ETag`/`seq`/
`authors_version` for freshness and nothing else; `db/site/src/api.ts`'s
`request()` wrapper only inspects `res.ok`/`status`/`error`/`message` on
failure. Neither reads (nor, before this slice, could have read) any
version signal — both are exposed to exactly the "silent shape change"
class of risk finding 8 warned about, one layer up from where it was
raised.

## Policy

**One coherent scheme, the recommended baseline, adopted with no
deviation except where stated:**

**(a) `/v1` is additive-only.** New optional fields, new routes, new enum
values only where the docs already say a client must tolerate an unknown
one (`adoption.md` §7, added by `24-spark-wire-review.md` finding 7's own
resolution: "readers ignore unknown fields; a client that doesn't
understand every field uses `PATCH`, never `PUT`"). Any removal, rename,
or meaning change under an unchanged shape is a **new major, `/v2`,
registered beside `/v1`** — never edited in place. No `/v2` exists yet;
nothing in this slice builds one. `24-spark-wire-review.md` finding 8's
own resolution (golden-identity same-major rule) stays the FORMAT-level
version's rule; this is the stricter, ENVELOPE-level version of the same
idea, applied one layer up.

**(b) Every response carries `X-AKLDB-API: <major>.<minor>`, and `/v1/meta`
exposes the same numbers plus a deprecation list.** Header name
`X-AKLDB-API` (not a generic `X-API-Version`) so a client juggling several
APIs never confuses whose version it just read. `minor` is **literally
`WIRE_VERSION`** (`src/core/etag.ts`), re-exported by the new
`src/core/version.ts` as `API_MINOR` — deliberately not a second,
independently-bumped counter: `WIRE_VERSION` already has to move on every
`/v1` wire-shape change (its whole reason to exist, §2 above), so giving
the public minor its OWN counter would create two numbers that could
disagree the very first time someone bumped one and forgot the other. One
file, one constant, two names. `GET /v1/meta` gains:

```json
"api": { "major": 1, "minor": 7 },
"deprecations": []
```

No `formats: {...}` sub-map inside `api` (a deliberate, stated deviation
from the brief's suggested shape): `GET /v1/formats` already carries each
format's `lineage`/`major`/`latest`/`can_translate_to`, code-checked
(`LDB-F18`/`F19`); a second copy inside `/v1/meta` would be a second
source that could disagree with the first for no benefit — a client
wanting format-major info already has the right endpoint.

**(c) A machine-readable route+shape golden fails a change to any `/v1`
response shape until the minor is bumped and the changelog line is added.**
`db/tests/contract/route-table.golden.json`, generated from
`db/tests/conformance/manifest.ts`'s `CASES` (already the API's real
contract, `LDB-R3`) joined against `db/docs/adoption.md`'s own endpoint
table for the auth lane. Each row is `{id, method, route, auth, status,
shape}`, where `shape` is a **structural fingerprint** (field names and
JSON types, never literal values — `db/tests/contract/shape.ts`) so a
routine fixture value update (a different count, a different id) is
invisible to it and only a real field/type change trips it.
`tests/contract/contract.test.ts`'s `[LDB-V4]` case diffs live against
committed and fails with a message distinguishing the two real cases: an
**addition** ("bump `WIRE_VERSION`, add a `CHANGELOG-API.md` line,
regenerate the golden") vs. a **removal/type change** ("this is breaking;
design a `/v2` instead"). Verified empirically during this slice
(mutation-tested against a real fixture edit, see the report) —
both messages fire correctly and the mechanism recovers cleanly.

**(d) `db/CHANGELOG-API.md`, one line per minor.** `[LDB-V5]` keeps it in
lockstep with `WIRE_VERSION`/`API_MINOR`: the newest heading must equal
the live minor, and every minor from 1 up to the current one needs exactly
one entry (no gap, no duplicate). Entries 1.1–1.6 are reconstructed
retroactively from §2's table above; 1.7 is this slice's own change,
recorded under the policy it introduces rather than exempted from it.

**(e) Deprecation: `Deprecation`/`Sunset` headers, 90 days minimum
notice.** `core/version.ts`'s `DEPRECATIONS` registry (empty today — audit
found nothing currently in a deprecation window) + `deprecationHeadersFor`,
wired into the same global response middleware as (b). A future entry
needs: a `route` (`"METHOD /path"`, matched against the exact registered
pattern), `since`/`sunset` ISO dates at least `MIN_DEPRECATION_NOTICE_DAYS`
(90) apart, and a `message`. `[LDB-V7]` enforces the notice-period rule
against whatever is actually registered (vacuously true today, real the
day an entry lands) and proves the header mechanism itself against a
synthetic entry (not a live route, since none is deprecated). **90 days**
chosen as a round, generous number for a service with, per
`db/INTEGRATION.md`/`adoption.md`, a small, known client set (the bot, the
site, the akldb.org site) and no outside adopters yet (`21-formats.md`
D11's own "until the first outside adopter" framing) — cheap now to be
generous; revisit downward only once real outside adopters make 90 days
costly.

### Why `WIRE_VERSION` alone, not a separate `API_MINOR` literal

Considered and rejected: a hand-maintained `API_MINOR` constant bumped
alongside `WIRE_VERSION` by convention. Rejected because "by convention"
is exactly what already failed silently for six bumps (§2's table) — two
counters that are SUPPOSED to move together but aren't the same variable
will eventually disagree, and disagreeing quietly is worse than not
existing (a client would trust a stale minor). Re-exporting the same
constant makes the two structurally identical, and `[LDB-V1]` pins that
identity so a future edit can't quietly split them apart again.

## Enforcement — invariant ids `LDB-V1`..`LDB-V7`

Registered in `db/INVARIANTS.md` (checked against `origin/ldb-arch-review`
before landing — no collision found, `LDB-V*` was unused).

| id | claim | test |
|---|---|---|
| LDB-V1 | `API_MINOR` is `WIRE_VERSION` itself, not a second counter; `API_MAJOR` is the literal `1` | `tests/contract/contract.test.ts` |
| LDB-V2 | every `/v1` response, success or error, over the full conformance `CASES` matrix (~350+ (route,status) pairs), carries `X-AKLDB-API` | `tests/api/conformance.test.ts` (via `tests/api/support.ts`), also exercised by the rehost replay |
| LDB-V3 | `GET /v1/meta`'s `api`/`deprecations` fields match the live constants and the response header | `tests/api/meta.test.ts` |
| LDB-V4 | the route-table golden vs. live diff, with a message telling the developer exactly what to do | `tests/contract/contract.test.ts` |
| LDB-V5 | `db/CHANGELOG-API.md` has one entry per minor, gapless, newest = live | `tests/contract/contract.test.ts` |
| LDB-V6 | the site-sync fixture (`db-responses/meta.json`) and the golden's declared `/v1/meta` shape agree | `tests/contract/contract.test.ts` |
| LDB-V7 | deprecation headers + minimum notice period | `tests/contract/contract.test.ts` |

**What (iv) does NOT cover, and why.** `db/tests/fixtures/db-responses/`
has five files; `[LDB-V6]` only checks `meta.json` against the golden.
The other four (`authors.json`, `detail.json`, `likes.json`,
`layouts-list.json`, `layouts-full-cmini1.json`) are the akl.gg site's own
`DbSource`-POST-PROCESSED shapes — a name-keyed map with `likes` merged in
from a separate call, a bare unwrapped `items` array, `{user_ids: [...]}`
instead of the route's own likes shape — not literal copies of any live
route's top-level body. Diffing those against a route's declared wire
shape would fail for a reason that has nothing to do with `/v1` drifting;
building a correct per-fixture "unwrap, then compare" rule for each of the
four is real, doable work not attempted in this slice (see the report's
"could not verify" list). `meta.json` is the one fixture that IS a literal
top-level copy, so it is the one this slice's mechanism actually covers
correctly.

## Docs

- `db/README.md`: one line under "Formats" pointing at this doc (done).
- `db/INTEGRATION.md`: a new "Versioning" section (done, see the file) —
  states the header/`/v1/meta` contract and cross-references this doc; the
  existing "Versioning and compatibility" paragraph in §1 is left in place
  (it already states the right rule in prose — additive-only, format
  majors chain — this slice makes it enforced, not wrong).
- `db/docs/adoption.md`: **not edited** (sign-off required, per the task's
  own rule and `db/README.md`'s "the primary, code-checked adoption
  guide" — an edit here needs the same care as any `LDB-G10`-checked
  content). Proposed text below, for the lead to place (likely a new §1.4
  or folded into the existing §0 "quick start" machine-readable table).

### Proposed `adoption.md` text (verbatim, for sign-off — not applied)

> ### 1.4 The API's own version
>
> Every response carries `X-AKLDB-API: <major>.<minor>` — the HTTP API's
> own version, distinct from a stored FORMAT's own major (`spark/1`,
> `GET /v1/formats` — §3). `GET /v1/meta` carries the same numbers under
> `api: {major, minor}`, plus `deprecations: []` (a list of `{route,
> since, sunset, message}` — always present, even empty).
>
> `/v1`'s major never changes without a `/v2` registering beside it — a
> pinned `/v1` integration never breaks in place. The minor increments on
> every additive change (a new optional field, a new route, a new
> tolerated enum value); `db/CHANGELOG-API.md` has one dated line per
> minor. A client that only reads fields it knows about, and never
> assumes a payload contains ONLY the fields it expects (§7's reader
> obligations), needs nothing from this section to keep working — the
> version numbers are for debugging ("which server build answered this")
> and for noticing a real breaking change coming, via a future `/v2`, well
> before you'd hit one by surprise.
>
> A route entry may also carry `Deprecation: <date>` and `Sunset: <date>`
> headers (RFC 8594-style) — at least 90 days apart. Nothing carries them
> today; if a route ever does, stop building against it before its
> `Sunset` date.

## What I could not fully verify

- **The exact chronological order of the `WIRE_VERSION` 4→5→6 bumps**
  (§2's table): `git log`'s commit timestamps for `e19c07b41` (3→4,
  Sep-12 22:18), `ac57dd053` (5→6, Sep-12 23:17) and `daf06b447` (4→5,
  Sep-13 00:11) are not strictly monotonic with the VALUES they set,
  which almost certainly reflects a rebase (this branch's own history is
  not append-only) rather than the real authorship order. The table above
  states the DATES as committed and the bump DIRECTION (which is
  unambiguous from the diffs themselves), not a claim about wall-clock
  authorship order.
- **A full per-fixture unwrapping rule for `authors.json`/`detail.json`/
  `likes.json`/`layouts-list.json`/`layouts-full-cmini1.json`** against
  the golden (enforcement (iv)'s fuller version) — scoped out, see above.
- **Whether `db/INTEGRATION.md`'s webhooks/SSE section should be rewritten
  or deleted outright** — flagged as live evidence for this doc's own
  argument, but rewriting it is a content decision (does the doc get
  trimmed to point at `adoption.md` entirely, or kept with a correction?)
  outside a versioning slice's remit; not touched beyond the new
  "Versioning" section this slice adds alongside it.
