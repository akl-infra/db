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

## 1.29 — 2026-10-20

LDB-F48..F50, design/alts/43-skip-magic-wire.md §1: skip magic on the wire,
additive. `spark/1`'s `magic_keys[].rules[].after` may now also be a 2-item
array `[a, b]`: `a` exactly one code point, `b` one code point or `null` (the
any-middle wildcard) -- `["h", null]` with `emit: "e"` means "after `h` and
any one character, the key emits `e`". A string `after` is unchanged;
`["h", "e"]` means exactly the string `"he"` (the per-key duplicate check
treats them as equal), `["h", null]` is its own context, never equal to any
string (`"h"` and `["h", null]` coexist). `[null, "e"]`, `["h"]`,
`["h", null, "e"]`, `["he", null]` and `["h", ""]` are refused
(`invalid_payload`, path `/magic/magic_keys/i/rules/j/after`). A magic key's
`default` gains `{"kind": "skip_repeat"}` (repeats the character two back,
any middle; magic keys only -- a chiral `same`/`opposite` still takes only
`repeat`/`char`, and `GET /v1/formats/spark/1/schema.json`'s `chiralValue`
keeps its two members). The compiled rows (`compileMagic`) of such a payload
carry array `inputs`/`output` with `null` as the wildcard,
`{"inputs": ["h", null, "*"], "output": ["h", null, "e"]}`; a `skip_repeat`
key scaffolds one such row per board character (the characters a `repeat`
default scaffolds; no space row) minus its `except` and minus every `c` with
an explicit `[c, null]` rule. `?format=mana2/1` reads drop every array row (a
documented loss, like `alts`: mana2 has no wildcard and its `_` is literal);
mana2 -> spark import is unaffected. No stored payload changes meaning and no
migration is needed (no stored `after` is anything but a string); a `/v1`
reader that ignores unknown `after` shapes and `default` kinds is unaffected.
LDB-F51 (§2e): a chiral key may carry `"skip": true` (any other value is
refused): it picks `same`/`opposite` by the hand of the character two back,
and compiles to one array row `[c, null, key] -> [c, null, out]` per board
character with a hand (`out` = `c` for `{"kind":"repeat"}`, else the
literal); a chiral key without it compiles as before.

## 1.28 — 2026-10-20

LDB-WPM17: add `PUT /v1/wpm/submissions/:id/discord-message`, authenticated
as the submitter or an admin. Body `{guild_id, channel_id, message_id}` requires
17–20 decimal-digit strings; `guild_id: null` identifies a direct message.
Returns `200 {source_message_url}`. The first binding is immutable: an identical
retry succeeds, a different binding returns `409 source_message_conflict`.
Missing or unrelated submissions return `404`; responses are private/no-store.
The private URL never enters existing submission, status, feed or dump shapes.
Moderation cards gain an **Original message** link, including after a decision
or reopening. Late binding and failed Discord edits reconcile in the background.

## 1.27 — 2026-10-19

LDB-WPM16: add `GET /v1/wpm/submissions/:id`, authenticated as the submission's
typist, submitter, or an admin. Returns only
`{submission: {id, status, reason, review_version}}`; status is `pending`,
`approved`, `rejected`, or `superseded`, and reason is nullable. Anonymous reads
return `401`; unrelated users receive the same `404` as a missing submission.
Responses, including errors, use `Cache-Control: private, no-store`.
The public WPM records and change feed retain their existing privacy rules.

## 1.26 — 2026-10-19

LDB-WPM15: requested validation tightening for `POST /v1/wpm` and
`POST /v1/admin/wpm`, with unchanged response shapes. Discord proof links must
identify a readable server message authored by the typist (`actor.user_id` for
self submissions, the supplied `user_id` for admin on-behalf submissions).
Another person's message, a bot/webhook message, unreadable/unverifiable messages
and non-message Discord URLs return the existing `400 invalid_proof` before any
WPM row/event/history write or supersession. Verification uses the dedicated
akldb bot with an 800 ms request/body budget; a temporary failure asks the caller
to retry. Non-Discord proof validation and existing submissions are unchanged.

## 1.25 — 2026-10-19

LDB-MD20: comments and WPM gain admin `POST /v1/admin/{comment|wpm}-queue/:id/reopen`
and `GET /v1/admin/{comment|wpm}-queue/:id/history`. Submission and queue rows carry
`review_version` (initially zero). Approve/reject accept this optional expected
version, defaulting to zero for existing clients. Reopening requires the expected
`status` and `review_version`, returns the item to pending, and appends a public
`comment_reopened` or `wpm_reopened` event containing only the submission ID.
A stale cycle or ineligible reopen returns `409 review_conflict`. The private
history records decisions and reopens, including moderator reasons; public dumps
exclude it. Reopening an approval withdraws that public comment/WPM record and
cancels outstanding rejection DMs. Previously delivered messages are unchanged.

## 1.24 — 2026-10-19

LDB-CMT17, docs/decisions/29-layout-comments.md: add public `GET
/v1/comment-counts`, a sparse bulk count of approved comments with non-null
bodies on live layouts. It includes layout ids and names, never comment text
or author data, and uses the shared public ETag/cache.

## 1.23 — 2026-10-19

LDB-CMT2, docs/decisions/29-layout-comments.md: behaviour change to a released
route (no shape change). **No short circuit for mods** (saltorbit): a
submission by an admin goes through the moderation queue like anyone's, on
every queue. (WPM) `POST /v1/wpm` is now always `202 {submission}` pending; the
`201` admin instant-approve of 1.21 is gone, while `POST /v1/admin/wpm`
(an explicit entry for someone else) is unchanged. (Links) `PUT /v1/layouts/{ref}/link`
is now always `202 {submission}` pending, for an admin too; the `200 {link}`
approved-at-once reply of an admin's own `PUT` is gone (approve, reject and
`DELETE` are unchanged). (Comments) Every comment goes through the moderation queue,
admins included: `PUT /v1/layouts/{ref}/comment` is now always `202
{submission}` with `status: "pending"`; the `201` admin instant-approve path
of 1.22 is gone. An admin approves their own comment in the Inbox like any
other, and it is announced to the mod channel like anyone's. Nothing else
changes; `WIRE_VERSION` is bumped to 23 so a cached `201` shape or edge-cached
listing cannot outlive the behaviour it described.

## 1.22 — 2026-10-18

LDB-CMT1..LDB-CMT13, docs/decisions/29-layout-comments.md: layout comments.
One plain-text comment per user per layout, every write moderated, and only
approved text public. New routes: `PUT /v1/layouts/{ref}/comment` (`{body}` →
`202 {submission}` queued, or `201` for an admin's own, approved at once),
`DELETE /v1/layouts/{ref}/comment` (`204`, immediate, erases the text for
good), `GET /v1/me/comments` (the caller's own slots across layouts, private,
capped at 500), `PUT`/`DELETE /v1/layouts/{ref}/comments/{author_id}/like` (`204`,
idempotent likes on a user's comment slot; `400 own_comment`), `GET /v1/layouts/{ref}/comment` (the caller's own `{live, pending,
decision}`, never cached), `GET /v1/layouts/{ref}/comments` (public;
`{comments: [{id, user_id, name, body, approved_at, edited, likes, is_author, liked?}]}`,
the layout owner's comment first, then most liked first (`?sort=newest` for newest first; any other value `400`), anonymous ETag/304, `liked` and `private, no-store` only with
credentials),
`GET /v1/admin/comment-queue?status=` (default `pending`; rows carry
`live_body`), `POST /v1/admin/comment-queue/{id}/approve` and `.../reject
{reason?}`, and `POST /v1/admin/comments/{id}/remove {reason?}` (the text is kept, private to
its author and mods like a rejected one; the author's own read returns it in
`decision.body`, and only their `DELETE` erases it). `body` is a
string of 1..2000 Unicode code points after trimming and line-ending
normalization (`400 invalid_comment`). Seven new event kinds,
`comment_submitted`, `comment_approved`, `comment_rejected`,
`comment_removed`, `comment_deleted`, `comment_liked` and `comment_unliked`,
none of which ever carries comment text or a reason; readers that ignore unknown kinds are unaffected, and
`kinds=` accepts the new names. The public dump gains a `layout_comments`
array holding only `approved` rows and a `comment_likes` array (both absent
from older dumps; restore reads them as empty). No existing field, route or stored value changes meaning, and
`migrations/0023_layout_comments.sql` only adds a table and indexes.

## 1.21 — 2026-10-18

LDB-WPM1..LDB-WPM10, docs/decisions/28-wpm-records.md: WPM (typing-speed)
records per layout. A user submits their best speed on a layout with a proof
link; it goes through the same moderation queue pattern as `link`
submissions, and only approved records are public. New routes:
`POST /v1/wpm` (`{layout, wpm, proof}` → `202 {submission}` queued, or
`201` for an admin's own speed, approved at once), `GET /v1/wpm?layout=&user=`
(public; `{records: [...]}`, one row per (layout, user): that user's top
approved speed), `POST /v1/admin/wpm` (`{user_id, layout, wpm, proof}` →
`201`, an admin's entry on someone else's behalf, approved at once),
`GET /v1/admin/wpm-queue?status=` (default `pending`),
`POST /v1/admin/wpm-queue/{id}/approve` and `.../reject {reason?}`. `wpm` is
an integer 1..1000; `proof` is an absolute `http(s)` URL with a host, at
most 512 characters; refusals are `400 invalid_wpm` / `400 invalid_proof`.
Three new event kinds, `wpm_submitted` (carries only `submission_id`: no
speed or proof while pending), `wpm_approved` (`layout_id`, `user_id`,
`wpm`, `proof`) and `wpm_rejected` (carries only `submission_id`; the reason stays in the admin queue); readers that ignore unknown kinds are
unaffected, and `kinds=` accepts the new names. The public dump gains a
`wpm_submissions` array holding only `approved` rows (absent from older dumps; restore reads it as empty).
`GET /v1/admin/link-queue` rows gain `layout_name` and `submitter_name` (null
when the submitter has no author row), additively, so a moderator reads names
rather than ids. No existing field, route or stored value changes meaning, and
`migrations/0022_wpm_submissions.sql` only adds a table and indexes.

## 1.20 — 2026-10-18

LDB-MD13, privacy exception to the additive-only rule: a mod-queue submission
that is not approved is private to admins, so the public event feed
(`GET /v1/changes`, `GET /admin/changelog`) no longer shows its content.
`link_submitted` and `link_rejected` events keep every other field but their
`detail` is now `{submission_id}` only: the pending `url` and a rejection's
`reason` are removed, for events written before this change too (redacted on
read; nothing stored is rewritten). Admins read both from
`GET /v1/admin/link-queue`. Nothing a client could rely on as approved data
changes: `link_approved`/`link_cleared` and the record's `link` field are
untouched. The public dump follows the same rule: its `link_submissions`
array holds only `approved` rows and its `events` carry the redacted detail,
so a rehost restores everything public and loses the non-approved queue.

## 1.19 — 2026-09-30

LDB-F44..F47, design/alts/07-format.md (round 4, slice D): `spark/1` gains
two additive optional top-level fields, `alts` (per-ngram alternate
fingerings) and `combos` (two-key chords), both absent when empty, same
convention `magic`'s own sub-arrays use. `formats["spark/1"]` gains
`has_alts`/`has_combos` beside `has_magic`; `GET /v1/layouts` gains
`?has_alts=`/`?has_combos=` list filters mirroring `?has_magic=` exactly
(including the ETag query); `PATCH /v1/layouts/{ref}` gains edit verbs
`alts`/`combos` (whole-array replacement, same shape as `magic`).
`?format=mana2/1` reads: `fromSpark` emits mana2's own `combos:
[{inputs: [a + b], output}]` from a spark two-key combo -- the two keys
concatenated into one two-rune chord string, mana2's own `inputs` being an
array of alternative chords, never one array element per key (never for
`alts`, which has no mana2 idiom); `toSpark` (mana2 -> spark import
direction) lifts a mana2 combo whose `inputs` is exactly one string of
exactly two layout keys, held otherwise (more than one alternative chord,
or a chord naming other than two keys). The cmini adapter no longer drops
`combos` on import. No existing field, route or stored payload changes
meaning, and `migrations/0020_alts_combos.sql` only adds columns
(backfilled to a no-op for every row stored before this slice).

**Shape of `alts`, as of 2026-10-02 (this minor has not shipped, so it is
rewritten in place rather than given its own heading, the same posture a
stored format's own major takes "until the first outside adopter",
`21-formats.md` D11 / `22-spark-spec.md` §0):** `alts` is an array with one
entry per ngram, `{ngram, fingers}`. `ngram` is an ARRAY of 2 or 3 items,
each a string of exactly one code point or `null` (the wildcard, any key;
allowed only as the middle item of a 3-item ngram; a literal `"_"` is just
the underscore character). Every non-null item must be a character on the
layout. `fingers` is an array of the same length of `spark/1` finger codes
(the `key.finger` enum): the finger that types that position's character in
this alt, `null` at exactly the ngram's wildcard position (the string `"_"`
is no longer accepted). A code equal to the key's own finger means no move,
and an alt where nothing moves is valid (a fingermap edit cannot invalidate
stored alts). Example: `{"ngram": ["a", null, "c"], "fingers": ["LI", null,
"RM"]}`. No two entries share an `ngram` (element-wise). Unknown properties
are refused. akldb deliberately does not refuse an alt naming a
one-character combo's output key (the analyzers do). The earlier shapes
(per-key `key`/`finger`/`when`/`except`/`guard`, then the string `ngram`
with `_` wildcard) never shipped and have no compatibility path. `GET
/v1/formats/spark/1/schema.json` reflects the new `alt` `$def`; the
envelope's `has_alts`, the `?has_alts=` filter and the PATCH `alts` verb are
unchanged. `?format=mana2/1` still never emits `alts`. A record without
`alts` is unaffected.

## 1.18 — 2026-09-29

LDB-F43: `#333` closed -- a space (`" "`, U+0020) is now accepted as an
ordinary `spark/1` `keys[].char` value (position, duplicates and magic
references all follow the same rules any other char follows); `validate()`
no longer refuses it. No payload shape change. `mana2/1`'s `space` token
now round-trips losslessly to a real spark `" "` key and back, both
directions (`?format=mana2/1` reads and mana2 imports alike). Newly
accepted values only -- additive.

## 1.16 — 2026-09-28

LDB-I28: new admin route `POST /v1/admin/relabel-magic-thumbs`
(`{dry_run, relabeled_layouts, relabeled_keys, layouts}`) -- a one-off,
idempotent, paginate-to-completion pass that corrects the 18 catalog
layouts imported from cmini before `docs/decisions/23-geometry.md` §4.6a
existed: a magic key (`@`/`*`) stored at row >= 3 under a placeholder
non-thumb finger is relabelled to the thumb it actually is, as an
`imported` rev bump. `?dry_run=1` (or `{"dry_run": true}`) returns the
same shape without writing. Same admin-only, no-"paused"-gate shape as
`POST /v1/admin/magic-seed`. Additive.

## 1.17 — 2026-09-21

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

## 1.15 — 2026-09-26

REMOVAL, not additive -- done in place under `/v1`, on the same "no
consumer" basis the webhooks/SSE removal used (LEDGER.md L4;
`design/layout-db/25-api-versioning.md`'s own audit finding 8 and its
"Policy" section both name this as the legitimate exception: proving no
client used a route). The cmini importer is gone for good -- pine's own
upstream (`https://clemenpine.com/layoutapi/v3`) has been permanently
dead since 2026-09-15 (LDB-I27, 1.14), the one-time import it ran finished
long before that, and nothing but this repo's own akldb.org admin console
ever called any of the routes below (never akl.gg, never the bot, never
any outside adopter -- `21-formats.md` D11's own "until the first outside
adopter" framing). Removed: `POST /v1/admin/import/pause`, `POST
/v1/admin/import/resume`, `POST /v1/admin/import/tick`, `POST
/v1/admin/import/unstall`, `POST /v1/admin/import/restore-deleted`, `POST
/v1/admin/diff/tick`, `GET /v1/admin/health`; error codes `import_paused`,
`import_running`. Unchanged, no shape change: `GET /v1/meta`'s
`last_diff`/`health.diff`/`health.import` stay on the wire exactly as
1.14 left them, now unconditionally `disabled: true` (a literal, not a
live `IMPORT_ENABLED` switch, which no longer exists) -- byte-identical to
what `IMPORT_ENABLED=off` already produced. Every layout's `upstream`
field stays, frozen at whatever value it last held. Every
`admin.import_*`/`admin.diff_*` event kind stays valid, queryable
history -- nothing emits them any more. `POST /v1/admin/nightly/tick`,
`POST /v1/admin/dump`, `POST /v1/admin/magic-seed` and every admin-admins/
admin-clients route are unaffected.

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
