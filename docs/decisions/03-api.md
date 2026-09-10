# The API

Status: proposal (2026-09-08). Part of `00-plan.md`. Base URL: the DB's own
domain (name pending, `00 §6.2`), path prefix `/v1`. JSON in and out, UTF-8,
`Content-Type: application/json`. CORS `*` on reads; writes are same-rules
(bearer or signed, so CORS is not a gate).

## 1. Conventions

- **Refs.** `{ref}` in a path is a record id (`01J…`) or a name (case-
  insensitive). A ref matching the ULID shape
  (`^[0-7][0-9A-HJKMNP-TV-Z]{25}$`, case-insensitive) is looked up as an id
  first, then as a name; any other ref is a name. `check_name` (§3) refuses
  ULID-shaped names, so a new record can never be ambiguous; an imported
  name of that shape (none exist, 07 §0.1) would be reachable by id only.
- **Formats.** Every read that returns a payload accepts `?as=<format>`
  (`01 §4`). Default `akl/1`.
  `409 { error: "held", held: true, format: "<native>", see: … }` when the
  translation is not possible (`01 §5`). In a `full=1` list a held record
  appears as its record fields plus `held: true, format`, without `payload`.
- **List rows** carry the record minus `payload` (§2). (A `?fields=`
  trimmer was in round 1 and is cut: nothing left on a row is heavy.)
- **Errors.** `{ error: "<snake_code>", message: "<human text>", …details }`.
  The `message` is what a bot prints and what the site shows verbatim — write
  them in the bot's voice (`missing gap before column …`). Phase 1's full
  table is `07 §6 S6`.
- **Concurrency.** Every write that changes a record's payload or name
  accepts `If-Match: "<rev>"` (quoted or bare; `*` = any). Mismatch → `409
  { error: "stale", rev, record, last_write: { seq, at, actor, via, kind,
  admin } }` with the current record so a client can rebase and say who
  changed it. A write against an existing record — `PUT`, `PATCH`,
  `DELETE`, `transfer` — must name the version it saw: absent `If-Match`
  is refused with `400 if_match_required` (saltorbit, 2026-09-09, LDB-P2;
  `core/ifmatch.ts`'s `requireIfMatch`, called before any read). `*` is
  still "overwrite on purpose", but the client has to say so explicitly.
  The site always sends the rev it holds; the bot fetches the record fresh
  and sends that rev on every mutating verb (`bot/src/commands/shared.ts`'s
  `writeWithFreshRecord`, 2026-09-09) — an overwrite can still get a `409`
  when another write lands between read and commit; the guard is the
  `layout_revs` PK inside the batch (`09 §2.3`). Every 2xx that returns a
  record carries `ETag: "<rev>"`. `restore` and likes take no `If-Match`
  (no prior draft to be stale against); neither does `POST /v1/layouts`.
- **Idempotency.** No `Idempotency-Key` (cut, `09 §6`): `POST` is guarded by
  name uniqueness — a retried create gets `409 name_taken` whose `holder`
  is the caller's own record; the other verbs are idempotent by `rev`.
- **Versioning.** `/v1` changes only on a breaking change to the record
  envelope (`01 §5`). New endpoints and new optional fields are not breaking.
- **Rate limits.** Per actor: 60 writes / 10 min, counted per attempt in a
  fixed window (`09 §2.5`); on the client lane additionally 300 / 10 min
  per client (`10` C1, D8 — the 429 body's `scope` names which); reads are
  never counted. `429 rate_limited` carries `Retry-After`.

## 2. Reads (no auth)

```
GET /v1/meta
→ { layout_count, author_count, seq, revision: "<iso of last event>",
    layouts_modified_at, authors_modified_at, formats: ["akl/1", …] }
```
The one call a poller makes on a quiet tick (meta-watch, `06 §1`). `seq` is
the event log head; `revision` is the `at` of that event (likes move it,
`layouts_modified_at` they do not); `layout_count` counts live records.

```
GET /v1/layouts?owner=&format=&has_magic=&since=<iso>&sort=&limit=&cursor=&as=
→ { items: [record minus payload…], next_cursor }
     sort: name (default, asc, case-insensitive) | modified_at | created_at | like_count (desc)
     limit ≤ 1000 (default 100); cursor is opaque (keyset); since = modified_at > iso; tombstones excluded
GET /v1/layouts?full=1&as=cmini/1        one streamed response with every live record and its payload
                                        (the site's sync); every row carries `likes` (sorted); held records carry `held: true`, no payload
GET /v1/layouts/{ref}?as=               → record with payload + `likes` (sorted user ids; a tombstone: 404 by name, 200 by id)
GET /v1/layouts/{ref}/likes             → { user_ids: [sorted ascending] }
GET /v1/layouts/{ref}/history           → [{ seq, rev, at, actor, via, kind, admin }]   oldest first
GET /v1/layouts/{ref}/rev/{n}?as=       → the record as of rev n (layout_revs ⊕ the write event's `after`)
GET /v1/authors                         → { "<name>": "<user_id>" }   (cmini's shape)
GET /v1/authors/{user_id}               → { user_id, name, layout_count, liked_count }
GET /v1/formats                         → registry: [{ id, owner, description, can_translate_to: [...] }]
GET /v1/formats/{name}/{N}/schema.json
```

Likes are always emitted sorted by user id — in `/likes`, in `?as=cmini/1`
and in the dump — never in insertion order; the D12 diff sorts upstream's
list the same way. `liked_by=<user_id>` on the list (also on `full=1`) lands
with `10` C1 (LDB-R8). The bot's own `likes` verb reads its local cache
(LDB-B3); the filter is for every other client.

### 2.1 No compatibility facade

A `/compat/cmini/v3/*` front door mirroring cmini's paths was proposed and
**dropped** in the round-1 review. `?as=cmini/1` already yields cmini's
payload shape; consumers (akl.gg's sync, emulayout) read `/v1/layouts?full=1&as=cmini/1`
and `/v1/layouts/{name}?as=cmini/1`. The D12 mirror diff compares those
against upstream (LDB-P5).

## 3. Writes (user or client lane, `02`)

```
POST   /v1/layouts                    { name, format, payload }               → 201 record
PUT    /v1/layouts/{ref}              { format, payload }  If-Match            → 200 record
PATCH  /v1/layouts/{ref}              one or more of:                          → 200 record
                                        { name }                 rename
                                        { fingermap: { "<char>": "<finger>", … } }
                                        { board }                (akl/1 board shape; cmini/1 when a cmini word applies)
                                        { magic }                (akl/1 records only)
DELETE /v1/layouts/{ref}              If-Match                                 → 200 tombstone record
POST   /v1/layouts/{ref}/transfer     { to: "<user_id>" }  If-Match            → 200 record
POST   /v1/layouts/{ref}/restore      (owner or admin; within 30 days)         → 200 record
PUT    /v1/layouts/{ref}/like                                                  → 200 { like_count }
DELETE /v1/layouts/{ref}/like                                                  → 200 { like_count }
```

Semantics:

- `POST`: `name` checked (`check_name` rules, the bot's `util/layout.py`:
  ≥ 3 chars, its `NAME_SET` charset, no leading `_`; plus: not ULID-shaped
  (§1); unique case-insensitively → `409 name_taken`); `format` must be
  registered; payload validated (`01 §2.1`); `owner = actor`; `rev = 1`.
  `check_name` applies to `POST` and `rename` only — **imported names are
  stored verbatim** (`io` is 2 chars, `AdNW` keeps its case; LDB-I5). Its
  charset is the bot's `NAME_SET` minus the space, its messages the bot's
  own, plus a 64-char cap (`09 §2.4`, LDB-N1). `409 name_taken` carries
  `holder: { id, owner }` so a client can tell its own record from a
  stranger's (`06 §2.2`).
- `PUT`: whole payload replaced; `rev + 1`. `format` may change (an author
  moving their layout from `cmini/1` to `akl/1`).
- `PATCH` verbs are what the bot's small commands map to (`05 §2`); each is
  applied to the payload through the format's own helpers (`setFingermap`,
  `setBoard`, …) so a `cmini/1` record gets a cmini-shaped edit and an `akl/1`
  record an akl-shaped one (`09 §3 T4`: `board` and `magic` bodies are
  `akl/1` shapes; `cmini/1` accepts `board` when a cmini word is present or
  derivable, never `magic`). A verb the format cannot apply → `400
  unsupported_for_format`. Verbs in one body apply in the order `name,
  fingermap, board, magic`, validated as a whole, **one event**: `renamed`
  for `{name}` alone, `fingermap` for `{fingermap}` alone, else `updated`
  with `detail.fields`. `rename` frees the old name immediately (the
  tombstone rule: names are released only by delete or rename — LDB-P4).
- `swap!/cycle!/angle!/unangle!/mirror!` are **client-side** transformations
  followed by a `PUT` — the bot's TS port of cmini's `modify()` bodies
  (`10 §5`, the Python quoted as the spec) computes them and writes the
  result. The DB does not grow verbs whose meaning is an analyzer's.
- `DELETE` writes a tombstone (`deleted: true`, `rev + 1`, payload kept);
  the name is free; the record stays readable by id and restorable **by id**
  for 30 days by its owner (any time by an admin, logged `admin: true`);
  a live holder of the name → `409 name_taken`.
- `transfer`: owner or admin; `to` must have an `authors` row (an author or
  anyone who has signed in once) and differ from the current owner.
- Likes: idempotent; do not bump `rev` or `modified_at`; do bump
  `like_count` and `meta.revision`; refused on `qwerty`.

## 4. Auth and account

```
GET    /v1/me
```

(Personal-token endpoints removed with `02 §2.2`.)

## 5. Events, feed, webhooks

Every accepted write appends one event:

```jsonc
{ "seq": 18841, "at": "2026-09-08T19:40:11Z",
  "kind": "created" | "updated" | "renamed" | "fingermap" | "transferred"
        | "deleted" | "restored" | "imported" | "upstream_deleted"          // rev-bumping
        | "liked" | "unliked"                                              // like_count only
        | "upstream_changed" | "import_conflict"                           // informational
        | "admin.client_registered" | "admin.client_revoked" | "admin.added" | "admin.removed",
  "layout_id": "01J…", "name": "hours", "owner": "…",
  "rev": 7 | null,                                     // the record's rev after this event; null = no bump
  "actor": "<user id>" | "system:cmini-import", "via": "discord" | "client:<id>" | "import:cmini" | "name_inherited",
  "admin": false,
  "detail": { … } | null,                             // imported: {source, upstream_id, shadowed?}; upstream_changed: upstream's cmini/1 detail; updated (magic-only): {fields: ["magic"], magic_only: true}; liked (inherited): {from: <tombstone id>}
  "before": { …record minus payload… } | null,        // payloads by rev via /rev/{n}
  "after":  { …record minus payload… } | null }
```

Three classes, and the fold is uniform (`07 §6 S4`): a **rev-bumping**
event sets the record to `after` ⊕ the payload stored for that rev
(`upstream_deleted` on a following record is the tombstoning event, rev + 1);
`liked`/`unliked` move `like_count` by ±1 and nothing else; an
**informational** event changes nothing (`upstream_deleted` on a
non-following record is informational, `rev: null`). "Follows upstream"
(`06 §2`) is read off this log: the record's latest rev-bumping event has
`via = "import:cmini"` — MAGIC-ONLY rev-bumping events skipped when finding
that latest one (`LDB-I12`, `design/layout-db/18-command-decisions.md` §2
item 1): a `PATCH`/`PUT` whose payload changes ONLY `magic` marks its
`updated` event `detail.magic_only: true` (a `PATCH {magic}` on a `cmini/1`
record lifts it to `akl/1` first, losslessly, since cmini/1 has no magic
idiom of its own) so it never forks a following record from upstream.

A `liked` event's `via` is normally the liking user's own lane
(`discord`/`client:<id>`); `"name_inherited"` (`LDB-P9`,
`design/layout-db/18-command-decisions.md` §2 D1) is the one exception —
`POST /v1/layouts` on a name a tombstone currently holds copies that
tombstone's likes onto the new record as `liked` events in this shape,
`detail: {from: <tombstone id>}` naming the source record; the tombstone
keeps its own likes/history untouched and stays restorable.

Cmini's magic is never akl.gg's (`17-magic-ownership.md`, M1): an imported
payload never carries `magic` (dropped from upstream's detail before it's
ever stored, so `has_magic` on a fresh import is always false), and an
import write that DOES touch a record carries that record's own `magic`
forward untouched — upstream's is simply never in the picture, and the
change-detection/D12-diff projection compares both sides with `magic`
excluded so neither side's magic is ever mistaken for a difference.
`POST /v1/admin/import/strip-cmini-magic` (§7) is the one-time cleanup for
records imported before this landed.

```
GET /v1/changes?since=<seq>&limit=<≤1000>&kinds=created,updated,…
→ { next: <seq>, items: [event…] }
```

`since` is exclusive (`seq > since`); the first event is `seq = 1`, so
`since=0` is "everything"; `next` is the last `seq` returned (pass it back
as `since`). Served from `since=0` forever, including after a rehost (the
dump carries the whole log, §6). Followers keep one cursor.

**Cost of polling** (saltorbit, round-1 review: "won't that be bad for my
server?"). Workers paid plan = 10 M requests/month for $5; one client
polling `/v1/meta` every 30 s = ~86 k/month, each a single indexed D1 read
(5 M reads/day allowance). Twenty pollers ≈ 1.7 % of the request budget. So
polling is affordable but not free, and the design keeps it small:
`/v1/meta`, `/v1/layouts` (list and `full=1`), `/v1/changes` and
`/v1/authors` carry `Cache-Control: public, max-age=10` and a strong
`ETag` derived from the event head and the query
(`"<seq>:<hash(query)>"`); `If-None-Match` matching → `304` after one
indexed D1 read (`MAX(seq)`), no other query. The Worker's cache API
(`caches.default`) sits in front of that best-effort — **it is inert on
`*.workers.dev`**, so the edge-cache half only engages once the service has
a hostname (`00 §6.2`); the ETag half works everywhere. Per-client poll
limiting is **not** done in code (`09 §6`: a D1 counter per poll turns
every cheap 304 into a write) — it is a zone-level rate-limiting rule once
the service has a hostname; every long-running client is steered to webhooks
or the stream (below), which cost one request per real change instead of
one per tick. The changelog page (§7) is served through the same cache
and is also rendered into the nightly dump as a static file.

```
POST   /v1/webhooks     { url, secret, kinds?, owner_filter? }   (auth; owned by the actor)
GET    /v1/webhooks · DELETE /v1/webhooks/{id}
```

On each event the Worker POSTs the event JSON with `X-Akl-Signature:
hmac-sha256(secret, timestamp + "." + body)` and `X-Akl-Timestamp`. Retries:
3, backing off 10 s / 1 min / 10 min, then the subscription is marked
`failing` and the feed is the recovery (D8: a gap in `seq` means poll). No
delivery is ever required for correctness (LDB-P3). A subscriber that stays
failing for 7 days is disabled and its owner sees it in `GET /v1/webhooks`.

Long-running clients that cannot receive webhooks (a bot behind NAT) use
`GET /v1/changes/stream?since=` — SSE, same events, same cursor.

## 6. Dumps

```
GET /v1/dump                       → 302 to /v1/dump/dump-YYYY-MM-DD.json.gz (today's)
GET /v1/dump/latest.json           → { date, key, url, sha256, bytes, layout_count, seq }
GET /v1/dump/dump-YYYY-MM-DD.json.gz   the object, streamed from R2 by the Worker (no public bucket)
```

Nightly (03:00 UTC) job writes `{ version, date, meta, records: [full
records with payloads], layout_revs, likes, authors, admins, clients
(public keys only), events: <the whole log>, import_state, import_map }`.
The **whole** event log, not a tail: a rehosted service must still serve
`/v1/changes?since=0` (LDB-P6); at this write rate the log is a few MB a
year. Kept 90 days in R2 (a lifecycle rule on the `dump-` prefix) and
forever as `monthly/dump-YYYY-MM.json.gz`. **The rehost drill (`04 §4`)
restores from this file, and CI restores from it daily (LDB-G1).**

## 7. Admin

```
POST   /v1/admin/clients          { name, pubkey, owner_user_id, caps, discord_app_id }
DELETE /v1/admin/clients/{id}
GET    /v1/admin/clients
POST   /v1/admin/admins           { user_id, note }
DELETE /v1/admin/admins/{user_id}
POST   /v1/admin/import/pause · /resume
POST   /v1/admin/import/strip-cmini-magic   { }  → { stripped: n }   (M1: the one-time cmini-magic cleanup, §5)
GET    /admin/changelog           HTML, public, read-only: the event feed rendered (the site's /admin/cmini-log, moved here)
```

## 8. Storage (D1)

```
layouts        id PK, name UNIQUE COLLATE NOCASE, owner, rev, created_at, modified_at,
               deleted, format, payload_json, like_count, has_magic       -- no link column (00 §6: cut)
               -- no origin_* columns: provenance is the events table (01 §1)
layout_revs    (layout_id, rev) PK, event_seq, payload_json, format      -- for /rev/{n}; every rev kept
                                                                          -- (compaction was cut, 07 §12)
likes          (layout_id, user_id) PK, at
authors        user_id PK, name, first_seen_at, last_seen_at              -- names from Discord at auth; cmini import seeds
events         seq PK AUTOINCREMENT, at, kind, layout_id, actor, via, admin, before_json, after_json
clients        id PK, name, pubkey, owner_user_id, caps, discord_app_id, status, created_at, revoked_at
nonces         (client_id, nonce) PK, at                                  -- pruned > 10 min
admins         user_id PK, added_by, added_at, note
webhooks       id PK, owner_user_id, url, secret_hash, kinds, status, failures, created_at
import_state   key PK, value                                             -- cmini.meta_token · cmini.last_full · cmini.paused · cmini.stalled · cmini.last_tick
import_map     upstream_id PK, layout_id UNIQUE                          -- cmini id (= lowercase name) → record id; not on the record
```

Write budget: D1's 100k rows/day free-tier cap (memory: D1 write budget)
is far above this workload — the initial import is ≈ 19 k rows once
(`07 §4`), a write is one record + one event + one rev — and the import is
diff-only (`06 §2`). Every write is one `batch()` (one transaction).

## 9. Invariants

| id | invariant | enforced by |
|---|---|---|
| LDB-P1 | Every accepted write appends exactly one rev-bumping event and one `layout_revs` row and bumps `rev` by exactly one (likes and informational events: zero, `rev: null`); the record is the fold of its events; `seq` is gapless from 1. | property test: random write sequences, replay from events equals the stored record (`07 §6 S4`) |
| LDB-P2 | `If-Match` mismatch is refused with the current record and writes nothing; two writes at one `rev` → exactly one commits, the other gets `stale` with the winner's record (the guard is `layout_revs`' PK inside the batch). | `tests/api/ifmatch.test.ts` (matrix + `Promise.all` race), `tests/events/fold.test.ts` (`09 §3 T2`) |
| LDB-P3 | Webhook delivery never affects stored state; a follower's view from the feed alone equals a follower's view from feed + webhooks. | test with a dropping/reordering fake receiver — phase 5 |
| LDB-P4 | A name is released only by delete or rename; a held or forked record keeps its name. | API matrix |
| LDB-P5 | Every record still following upstream (`06 §2`), read `?as=cmini/1`, equals upstream's copy on the `cminiDetail` projection (`canonical()`, likes sorted). | the daily D12 diff (`07 §6 S8`) |
| LDB-P6 | `/v1/changes` serves from `since=0` always, including from a rehosted database; `layout_revs` is never compacted in phase 1. | feed test + the rehost test |
| LDB-P7 | Every error response carries `error` and `message`; every (route, status) pair has a conformance fixture. Phase-4 clause (`10 §1` D6): for every (verb, error code) the bot's parity table names, the **bot** renders cmini's own string; the DB's `message` is what the bot prints for any error the table does not name — cmini had three different not-owner strings, so no single `message` can be "the bot's string". | conformance suite (`07 §6 S6`); `bot/tests/parity-write.test.ts` (`10` V4) |
| LDB-P8 | Deleted records are unreadable by name from the moment of deletion (phase 1) and restorable by id for 30 days by their owner, any time by an admin, keeping name/format/payload/history (phase 2). | `tests/api/refs.test.ts`, `tests/api/restore.test.ts` (fake clock) |
| LDB-N1 | `check_name` is the bot's rule set with the bot's strings (`NAME_SET` minus the space), plus the 64-char cap and the ULID-shape refusal, applied to `POST` and rename only. | `tests/api/names.test.ts`, `tests/api/patch.test.ts` (`09 §2.4`) |
| LDB-W1 | Every write route is resolve → authorize → check → `appendWrite`; no file under `src/routes/` prepares a D1 statement. | `tests/tools/routes-noprepare.test.ts` |
| LDB-E1 | Format `edits` are pure, identity on their own projection and validity-preserving. | `tests/formats/edits.test.ts` (generated over the registry × fixtures) |
| LDB-L1 | Likes move `like_count`, `likes` and `meta.revision`/`seq` only — never `rev`, `modified_at` or `layouts_modified_at`; concurrent likes are counted exactly. | `tests/api/likes.test.ts` |
| LDB-R6 | Writes are limited to 60 per 10-minute window per actor, counted per attempt, `429` + `Retry-After`; reads are never counted. | `tests/api/ratelimit.test.ts` |
| LDB-R1 | Polled routes carry `Cache-Control` + a strong `ETag` and answer `304` to a matching `If-None-Match`; the ETag changes iff the event head or the query changes. | matrix over routes × header states |
| LDB-R2 | `/v1/meta`'s counts, `seq` and `revision` equal the tables. | API test after a fixture import |
| LDB-R3 | The conformance fixtures are the API contract: a changed fixture is a documented API change. | conformance suite + review |
| LDB-R4 | Every `sort` × `limit` cursor walk of `/v1/layouts` visits every live record exactly once, in order. | property test |
| LDB-R5 | `/rev/{n}` reproduces the payload stored at rev `n` for every `n`. | API test over every seed record |

## 10. Open questions (API)

1. *(resolved, `09 §6.9`: allow when a cmini word is present or derivable.)* `PATCH { board }` on `cmini/1` records: allow (map to the cmini word) or
   `unsupported_for_format`? Proposal: allow when representable.
2. Keep `like` on own layout allowed (cmini does)? Proposal: yes, parity.
3. `history` visibility of `before` payloads for deleted records — public?
   Proposal: yes; cmini's data was always public.
