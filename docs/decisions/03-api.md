# The API

Status: proposal (2026-09-08). Part of `00-plan.md`. Base URL: the DB's own
domain (name pending, `00 §6.2`), path prefix `/v1`. JSON in and out, UTF-8,
`Content-Type: application/json`. CORS `*` on reads; writes are same-rules
(bearer or signed, so CORS is not a gate).

## 1. Conventions

- **Refs.** `{ref}` in a path is a record id (`01J…`) or a name (case-
  insensitive). Ambiguity is impossible: ids are 26 chars of Crockford base32
  and names may not be.
- **Formats.** Every read that returns a payload accepts `?as=<format>`
  (`01 §4`). Default `akl/1`. `?as=core/1` returns only the core projection.
  `409 { held: true, format: "<native>", see: … }` when the translation is
  not possible (`01 §5`).
- **Fields.** `?fields=id,name,owner,rev,core` trims list responses; default
  list rows carry the record minus `payload` and `core`.
- **Errors.** `{ error: "<snake_code>", message: "<human text>", …details }`.
  The `message` is what a bot prints and what the site shows verbatim — write
  them in the bot's voice (`missing gap before column …`).
- **Concurrency.** Every write that changes a record accepts `If-Match:
  "<rev>"`. Mismatch → `409 { error: "stale", rev, record }` with the current
  record in the body so a client can rebase. Absent `If-Match` = overwrite on
  purpose (the site sends it always; the bot never does — bot users edit by
  typing, there is no draft to be stale).
- **Idempotency.** `POST /v1/layouts` accepts `Idempotency-Key`; a repeat
  within 24 h returns the original response.
- **Versioning.** `/v1` changes only on a breaking change to the record
  envelope (`01 §5`). New endpoints and new optional fields are not breaking.
- **Rate limits.** Per actor: 60 writes / 10 min; reads unlimited within
  Cloudflare's sanity. `429` carries `Retry-After`.

## 2. Reads (no auth)

```
GET /v1/meta
→ { layout_count, author_count, seq, revision: "<iso of last event>",
    layouts_modified_at, authors_modified_at, formats: ["akl/1", …] }
```
The one call a poller makes on a quiet tick (meta-watch, `06 §1`). `seq` is
the event log head.

```
GET /v1/layouts?owner=&format=&has_magic=&since=<iso>&sort=&limit=&cursor=&as=
→ { items: [record…], next_cursor }
GET /v1/layouts?full=1&as=cmini/1        one response with every payload (the weekly full sync)
GET /v1/layouts/{ref}?as=               → record with payload (+ core)
GET /v1/layouts/{ref}/likes             → { user_ids: [...] }
GET /v1/layouts/{ref}/history           → [{ rev, event_id, at, actor, via, kind }]
GET /v1/layouts/{ref}/rev/{n}?as=       → the record as of rev n (from the event log)
GET /v1/authors                         → { "<name>": "<user_id>" }   (cmini's shape)
GET /v1/authors/{user_id}               → { user_id, name, layout_count, liked_count }
GET /v1/formats                         → registry: [{ id, owner, description, can_translate_to: [...] }]
GET /v1/formats/{name}/{N}/schema.json
```

### 2.1 No compatibility facade

A `/compat/cmini/v3/*` front door mirroring cmini's paths was proposed and
**dropped** in the round-1 review. `?as=cmini/1` already yields cmini's
payload shape; consumers (akl.gg's sync, emulayout) read `/v1/layouts?full=1&as=cmini/1`
and `/v1/layouts/{name}?as=cmini/1`. The D12 mirror diff compares those
against upstream (LDB-P5).

## 3. Writes (user or client lane, `02`)

```
POST   /v1/layouts                    { name, format, payload, link? }        → 201 record
PUT    /v1/layouts/{ref}              { format, payload, link? }  If-Match     → 200 record
PATCH  /v1/layouts/{ref}              one or more of:                          → 200 record
                                        { name }                 rename
                                        { link }  / { link: null }  link / unlink
                                        { fingermap: { "<char>": "<finger>", … } }
                                        { board }                (akl/1 records only)
                                        { magic }                (akl/1 records only)
DELETE /v1/layouts/{ref}              If-Match                                 → 200 tombstone record
POST   /v1/layouts/{ref}/transfer     { to: "<user_id>" }                      → 200 record
POST   /v1/layouts/{ref}/restore      (owner or admin; within 30 days)         → 200 record
PUT    /v1/layouts/{ref}/like                                                  → 200 { like_count }
DELETE /v1/layouts/{ref}/like                                                  → 200 { like_count }
```

Semantics:

- `POST`: `name` checked (`check_name` rules: ≥ 3 chars, allowed charset, no
  leading `_`, unique case-insensitively → `409 name_taken`); `format` must be
  registered; payload validated (`01 §2.1`); `owner = actor`; `rev = 1`.
- `PUT`: whole payload replaced; `rev + 1`. `format` may change (an author
  moving their layout from `cmini/1` to `akl/1`).
- `PATCH` verbs are what the bot's small commands map to (`05 §2`); each is
  applied to the payload through the format's own helpers (`setFingermap`,
  `setBoard`, …) so a `cmini/1` record gets a cmini-shaped edit and an `akl/1`
  record an akl-shaped one. A verb the format cannot apply → `400
  unsupported_for_format`. `rename` frees the old name immediately (the
  tombstone rule: names are released only by delete or rename — LDB-P4).
- `swap!/cycle!/angle!/unangle!/mirror!` are **client-side** transformations
  followed by a `PUT` — the bot computes them exactly as it does today
  (`cmds/swap.py` etc.) and writes the result. The DB does not grow verbs
  whose meaning is an analyzer's.
- `DELETE` writes a tombstone (`deleted: true`, `rev + 1`); the name is free;
  the record stays readable by id and restorable for 30 days by owner/admin.
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
  "kind": "created" | "updated" | "renamed" | "linked" | "fingermap" | "transferred"
        | "deleted" | "restored" | "liked" | "unliked"
        | "imported" | "import_conflict" | "upstream_changed" | "upstream_deleted"
        | "admin.client_registered" | "admin.client_revoked" | "admin.added" | "admin.removed",
  "layout_id": "01J…", "name": "hours", "owner": "…", "rev": 7,
  "actor": "…", "via": "client:cmini-bot", "admin": false,
  "before": { …record minus payload… } | null,        // payloads by rev via /rev/{n}
  "after":  { …record minus payload… } | null }
```

```
GET /v1/changes?since=<seq>&limit=<≤1000>&kinds=created,updated,…
→ { next: <seq>, items: [event…] }
```

Served from `since=0` forever (a follower bootstraps from the feed alone;
the nightly dump is faster). Followers keep one cursor.

**Cost of polling** (saltorbit, round-1 review: "won't that be bad for my
server?"). Workers paid plan = 10 M requests/month for $5; one client
polling `/v1/meta` every 30 s = ~86 k/month, each a single indexed D1 read
(5 M reads/day allowance). Twenty pollers ≈ 1.7 % of the request budget. So
polling is affordable but not free, and the design keeps it small:
`/v1/meta`, `/v1/layouts` (list) and `/v1/changes` are served with
`Cache-Control: public, max-age=10` through the Worker's cache API (a quiet
poll usually never touches D1) and honour `If-None-Match` → `304`; per-client
polling is rate-limited to one request per 10 s per endpoint; and every
long-running client is steered to webhooks or the stream (§5 below), which
cost one request per real change instead of one per tick. The changelog
page (§7) is served through the same cache and is also rendered into the
nightly dump as a static file.

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
GET /v1/dump                 → 302 to today's dump (R2): dump-YYYY-MM-DD.json.gz
GET /v1/dump/latest.json     → { date, url, sha256, layout_count, seq }
```

Nightly (03:00 UTC) job writes `{ meta, records: [full records with payloads],
likes, authors, admins, clients (public keys only), events_tail: last 10k }`.
Kept 90 days in R2 and forever as a monthly. **The rehost drill (`04 §3`)
restores from this file.**

## 7. Admin

```
POST   /v1/admin/clients          { name, pubkey, owner_user_id, caps, discord_app_id }
DELETE /v1/admin/clients/{id}
GET    /v1/admin/clients
POST   /v1/admin/admins           { user_id, note }
DELETE /v1/admin/admins/{user_id}
POST   /v1/admin/import/pause · /resume
GET    /admin/changelog           HTML, public, read-only: the event feed rendered (the site's /admin/cmini-log, moved here)
```

## 8. Storage (D1)

```
layouts        id PK, name UNIQUE COLLATE NOCASE, owner, rev, created_at, modified_at,
               deleted, link, format, payload_json, core_json (cache of ?as=core/1), like_count
               -- no origin_* columns: provenance is the events table (01 §1)
layout_revs    (layout_id, rev) PK, event_seq, payload_json, format      -- for /rev/{n}; compacted to
                                                                          -- every rev ≤ 100 per record, then monthly
likes          (layout_id, user_id) PK, at
authors        user_id PK, name, first_seen_at, last_seen_at              -- names from Discord at auth; cmini import seeds
events         seq PK AUTOINCREMENT, at, kind, layout_id, actor, via, admin, before_json, after_json
clients        id PK, name, pubkey, owner_user_id, caps, discord_app_id, status, created_at, revoked_at
nonces         (client_id, nonce) PK, at                                  -- pruned > 10 min
admins         user_id PK, added_by, added_at, note
webhooks       id PK, owner_user_id, url, secret_hash, kinds, status, failures, created_at
import_state   key PK, value                                             -- cmini cursor, paused flag
import_map     upstream_id PK, layout_id                                 -- cmini id → record id (the import's join key; not on the record)
```

Write budget: D1's 100k rows/day cap (memory: D1 write budget) is far above
this workload (one record + one event + one rev per write), and the import is
diff-only (`06 §2`).

## 9. Invariants

| id | invariant | enforced by |
|---|---|---|
| LDB-P1 | Every accepted write appends exactly one event and bumps `rev` by exactly one (likes: zero); the record is the fold of its events. | property test: random write sequences, replay from events equals the stored record |
| LDB-P2 | `If-Match` mismatch is refused with the current record and writes nothing. | API test + concurrent-PUT race test (two PUTs at the same rev: exactly one wins) |
| LDB-P3 | Webhook delivery never affects stored state; a follower's view from the feed alone equals a follower's view from feed + webhooks. | test with a dropping/reordering fake receiver |
| LDB-P4 | A name is released only by delete or rename; a held or forked record keeps its name. | API matrix |
| LDB-P5 | Every record still following upstream (`06 §2`), read `?as=cmini/1`, is byte-identical to upstream's copy (after key-order canonicalisation). | D12 diff in CI |
| LDB-P6 | `/v1/changes` serves from `since=0` after any compaction; compaction touches `layout_revs` only. | test: compact, then replay |
| LDB-P7 | Every error response carries `error` and `message`; every `message` in the bot's verb set matches the bot's own string for that case. | table test from `05 §2` |
| LDB-P8 | Deleted records are restorable for 30 days and unreadable by name from the moment of deletion. | API test with fake clock |

## 10. Open questions (API)

1. `PATCH { board }` on `cmini/1` records: allow (map to the cmini word) or
   `unsupported_for_format`? Proposal: allow when representable.
2. Keep `like` on own layout allowed (cmini does)? Proposal: yes, parity.
3. `history` visibility of `before` payloads for deleted records — public?
   Proposal: yes; cmini's data was always public.
