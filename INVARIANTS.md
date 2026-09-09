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
| LDB-A2 | The Discord cache serves a success ≤ 5 min and a 401 ≤ 60 s; 5xx/429/network are never cached; the token is never stored | `tests/auth/discord.test.ts`, `tests/api/me.test.ts` |
| LDB-A4 | Client-lane signatures (02 §3.2, 10 C1): every vector in `tests/vectors/client-signing.json` is accepted; each single-field mutation (method, path, query, timestamp ±301s, replayed nonce, body, actor, signature, key) is refused with the named 401; every malformed/missing header collapses to `bad_signature` | `tests/auth/client.test.ts`, `tests/tools/vectors.test.ts` |
| LDB-A5 | Every accepted write's event carries `via` (the actor's own lane -- 10 C1 widens this from the literal `"discord"` to `client:<id>` on the client lane); every admin action is an event with `admin = 1`; the admin client routes (register/revoke/list) follow the same admin-only, event-logged pattern, never leaking the pubkey into `detail` | `tests/api/admin.test.ts`, `tests/api/write.test.ts`, `tests/api/clients.test.ts` |
| LDB-A6 | The admins table never has fewer than two active rows after bootstrap (the count check and the delete are one statement, so two concurrent removes at three rows can't both commit) | `tests/api/admin.test.ts` |
| LDB-A7 | Owner changes only via `transfer`; a write body naming `owner` (or any field outside the verb's schema) is refused | `tests/api/bodies.test.ts`, `tests/api/write.test.ts`, `tests/api/transfer.test.ts` |
| LDB-A8 | A client-lane nonce is accepted once: the `nonces` PK insert is the replay check, run only after the signature verifies; rows are pruned after 900s | `tests/auth/client.test.ts` |
| LDB-A9 | A revoked client's requests are refused from the revocation onward -- `clients.status` is read on every request, never cached | `tests/auth/client.test.ts`, `tests/api/clients.test.ts` |
| LDB-C1 | `db.yml`'s shape (test job on PR/push under `db/**`; deploy needs test, main+push only, migrations before deploy; daily job runs rehost + diff; actions pinned) is asserted from the parsed YAML | `tests/tools/ciwiring.test.ts` |
| LDB-C2 | `canonical()` is key-order-invariant and lossless | `tests/core/canonical.test.ts` |
| LDB-C3 | `[env.preview]` redeclares every top-level binding and var with the preview resource names; no top-level binding is missing from it | `tests/tools/wrangler-envs.test.ts` |
| LDB-C4 | The diff cron (`0 4 * * *`) reads our side from D1 directly and never fetches its own origin; it is one invocation, bounded by ⌈records/500⌉ pages | `tests/import/difftick.test.ts` |
| LDB-D1 | The nightly dump is complete (every table, the whole event log), its `latest.json` sha256 matches the object served, and the monthly copy is written on the 1st (and only the 1st) | `tests/api/dump.test.ts`, `tests/rehost.test.ts` |
| LDB-E1 | Format edits are pure, identity on their own projection, and validity-preserving | `tests/formats/edits.test.ts` |
| LDB-F1 | Every stored payload validates against its format's frozen schema; a write that does not is refused with the failing path | `tests/formats/goldens.test.ts`, `tests/formats/mutations.test.ts` |
| LDB-F2 | `lower()` is deterministic across versions | `tests/formats/goldens.test.ts` (`.lowered.json` goldens) |
| LDB-F3 | Intent is never lowered on store | `tests/formats/intent.test.ts` |
| LDB-F4 | Lowering collisions are refused with both sources named | `tests/formats/collisions.test.ts`, `tests/formats/mutations.test.ts` |
| LDB-F5 | `cmini/1 → akl/1 → cmini/1` is identity on the projection, for every fixture and (P5) the live set; `mana2/1 → akl/1 → mana2/1` is identity (modulo row whitespace + unused fingermap padding) for every vendored fixture; `akl/1 → mana2/1 → akl/1` is identity minus mana2's documented losses (magic idiom structure, `TB`, non-`x.mana2` `x`, an akl-native `ortho` board, non-contiguous columns) for every akl/1 fixture | `tests/formats/roundtrip.test.ts`, `tests/formats/mana2.test.ts`, `tests/api/list.test.ts`, S8 |
| LDB-F6 | Merged format majors are immutable | `tests/formats/frozen.test.ts` |
| LDB-F7 | Every format has ≥ 1 fixture and a frozen golden per declared translation | `tests/formats/goldens.test.ts`, `tests/formats/mana2.test.ts` (X2: 74 vendored mana2/1 fixtures + `d5.jsonc`'s documented exclusion) |
| LDB-F8 | `liftRules(lower(m)) == (m, [])` for every valid idiom set; `lower(lift(rows)) ≡ rows` for every typed row set; leftovers are exactly the rows that fail their tag's invariant | `tests/formats/lift.test.ts` |
| LDB-F9 | A held record keeps name/owner/rev and reads as its own format | `tests/api/held.test.ts` |
| LDB-F10 | `x` survives same-format round trips; only `x.cmini` survives `to["cmini/1"]` | `tests/formats/x.test.ts`, `tests/formats/roundtrip.test.ts` |
| LDB-F11 | Every live upstream detail (snapshot) validates as `cmini/1` and `hasMagic` matches upstream's `has_magic` | `tests/formats/cmini-envelope.test.ts` |
| LDB-F12 | The DB's `akl/1 → mana2/1` grid and thumb strings equal the site's real `bridgecore.ConvertLayout` wasm output for every `cmini/1` fixture (modulo trailing `skip`s and the fingermap digit under a `skip` cell) | `tests/formats/mana2-convert-parity.test.ts` against the frozen `tests/fixtures/mana2-convert/*.json` snapshot (`scripts/check-convert-parity.mjs` records/re-verifies it from the live wasm) |
| LDB-F13 | The set of vendored `mana2/1` layouts held for `akl/1` is enumerated with reasons; a new held vendored file fails until listed | `tests/formats/mana2.test.ts` |
| LDB-G1 | Restorable from a public dump + the public repo | `tests/rehost.test.ts` (daily job: against the real deployed dump) |
| LDB-G2 | No admin id is a constant in code (the migration seed is data) | `tests/tools/noconst.test.ts` |
| LDB-G4 | Every binding/var the Worker reads is in the runbook table | `tests/tools/runbook.test.ts` |
| LDB-G5 | Nothing imports across the `db/` boundary in either direction | `tests/tools/boundary.test.ts` |
| LDB-H1 | Webhook delivery is at-least-once and in order per hook: every matching event past a hook's cursor is POSTed with a valid signature before the cursor passes it; the cursor is advanced only by compare-and-set | `tests/api/webhooks.test.ts` |
| LDB-H2 | The stream is the feed: the frames of any stream, and of any chain of streams reconnected by `Last-Event-ID`, are exactly `/v1/changes`' items past the original `since`, in order, no gap, no duplicate; every stream closes at the bound with `next` | `tests/api/stream.test.ts` |
| LDB-H3 | The changelog page shows exactly the feed's events for its parameters, with every interpolated value HTML-escaped | `tests/api/changelog.test.ts` |
| LDB-H4 | A webhook secret never leaves the `webhooks` table: no response body, no event, no dump carries it | `tests/api/webhooks.test.ts` (scans), `tests/api/dump.test.ts` (`webhooks: []`) |
| LDB-H5 | A drain with nothing to deliver writes zero D1 rows; a delivered batch writes exactly one `webhooks` row per hook | `tests/api/webhooks.test.ts` (statement counter) |
| LDB-I1 | The import is idempotent: the same upstream state twice appends zero events | `tests/import/tick.test.ts` |
| LDB-I2 | The import never overwrites a record that does not follow upstream | `tests/import/cases.test.ts` |
| LDB-I2a | "Follows upstream" ⇔ the record's latest rev-bumping event has `via = import:cmini` | `tests/events/follows.test.ts`, `tests/api/restore.test.ts` |
| LDB-I3 | Tombstoning more than `max(5, 5%)` of live records in one tick stalls the import instead | `tests/import/plan.test.ts` |
| LDB-I4 | Every import event carries `via = import:cmini` and `actor = system:cmini-import` (likes: the liking user) | `tests/import/cases.test.ts` |
| LDB-I5 | Imported names are stored verbatim (case kept, `check_name` not applied) and are unique case-insensitively | `tests/import/cases.test.ts` |
| LDB-I6 | A list shorter than half the live record count stalls the whole tick | `tests/import/plan.test.ts` |
| LDB-I7 | A tick whose `/meta` token is unchanged makes no further request and writes nothing | `tests/import/tick.test.ts` |
| LDB-I8 | Every upstream request carries the UA; 404 is never retried; other failures are retried 3x | `tests/import/upstream.test.ts` |
| LDB-I9 | Upstream JSON is parsed only through `core/safejson.ts`: Go's `\u003c`/`\u003e`/`\u0026` escapes are rewritten to literals before `JSON.parse` (a reproduced V8 bug decodes escaped object keys non-deterministically on the ~5 MB `?full=1` body, in Node and in workerd), an escaped backslash is never touched, and the parse is checked against a second parse | `tests/core/safejson.test.ts`; `tests/import/upstream.test.ts` |
| LDB-L1 | Likes move `like_count`, `likes` and `meta.revision`/`seq` only -- never `rev`, `modified_at` or `layouts_modified_at`; concurrent likes are counted exactly | `tests/api/likes.test.ts` |
| LDB-M1 | `/v1/meta.last_diff` and `.last_drill` are `{at, ok}` written on every run including failures; `/v1/meta`'s ETag folds both `at`s in so a poller can never get stuck on a stale 304 | `tests/import/difftick.test.ts`, `tests/api/admin.test.ts` |
| LDB-N1 | `check_name` is the bot's rule set with the bot's strings (`NAME_SET` minus the space), plus the 64-char cap and the ULID-shape refusal, applied to `POST` and rename only | `tests/api/names.test.ts`, `tests/api/patch.test.ts` |
| LDB-P1 | Every write appends exactly one rev-bumping event and one `layout_revs` row; the record equals the fold of its events; `seq` is gapless | `tests/events/fold.test.ts`, `tests/events/races.test.ts`, `tests/tools/onlywriter.test.ts` |
| LDB-P2 | An `If-Match` mismatch writes nothing and returns the current record; two writes at one `rev` → exactly one commits, the other gets `stale` with the winner's record; the guard is `layout_revs`' PK inside the batch | `tests/api/ifmatch.test.ts`, `tests/events/fold.test.ts` |
| LDB-P3 | A follower's state built from webhook deliveries alone (with drops, reordering and duplicates) equals its state built from the feed alone | `tests/events/feed.test.ts` |
| LDB-P4 | A name is released only by delete or rename | `tests/events/names.test.ts`, `tests/events/races.test.ts`, `tests/api/refs.test.ts`, `tests/api/names.test.ts`, `tests/api/patch.test.ts` |
| LDB-P5 | Every following record read `?as=cmini/1` equals upstream on the projection (likes sorted) | `tests/upstream-diff.test.ts` (daily, live), `tests/import/diff-unit.test.ts` (unit half, over `upstream-100`) |
| LDB-P6 | `/v1/changes` serves from `since=0`, including after a restore | `tests/events/feed.test.ts`, `tests/rehost.test.ts` |
| LDB-P7 | Every error response carries `error` and `message`; every (route, status) pair has a conformance case | `tests/api/conformance.test.ts` |
| LDB-P8 | A tombstone is unreadable by name from the moment of deletion (phase 1) and restorable by id for 30 days by its owner, any time by an admin, keeping name/format/payload/history (phase 2) | `tests/api/refs.test.ts`, `tests/api/restore.test.ts` |
| LDB-R1 | Polled routes carry `Cache-Control` + strong `ETag` and answer `304` to a matching `If-None-Match`; the ETag changes iff the event head or the query changes | `tests/api/etag.test.ts` |
| LDB-R2 | `/v1/meta` counts and `seq`/`revision` equal the tables | `tests/api/meta.test.ts` |
| LDB-R3 | The conformance fixtures are the API contract; changing one is a documented API change | `tests/api/conformance.test.ts` (+ review) |
| LDB-R4 | Every `sort` × `limit` cursor walk visits every live record exactly once | `tests/api/list.test.ts` |
| LDB-R5 | `/rev/{n}` reproduces the payload stored at rev `n` for every n | `tests/api/history.test.ts` |
| LDB-R6 | Writes are limited to 60 per 10-minute window per actor, counted per attempt, `429` + `Retry-After`; reads are never counted | `tests/api/ratelimit.test.ts` |
| LDB-R7 | Client-lane writes are limited to 300/10min per client, on top of the 60/10min per-actor limit that applies to every lane; a 429 names which counter tripped (`scope`) | `tests/api/ratelimit.test.ts` |
| LDB-R8 | `GET /v1/layouts?liked_by=<user_id>` equals a filter over `likes`, composable with every other filter/sort, and rides on `?full=1` | `tests/api/list.test.ts` |
| LDB-S1a | `db/tests/fixtures/db-responses/` (site-side sync fixture, design/layout-db/11-implementation-phase3.md §1 W1) equals the live `/v1/meta`, `/v1/layouts`, `/v1/layouts?full=1&as=cmini/1`, per-name `/v1/layouts/{name}?as=cmini/1`, `/v1/layouts/{name}/likes` and `/v1/authors` routes over the standard upstream-100 seed | `tests/api/fixture-export.test.ts` |
| LDB-T1 | Every registry id has a tagged test and every tag has a registry row | `tests/tools/invariants.test.ts` |
| LDB-W1 | Every write route is resolve → authorize → check → `appendWrite`; no file under `src/routes/` prepares a D1 statement | `tests/tools/routes-noprepare.test.ts` |
