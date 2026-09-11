# The API

Status: proposal (2026-09-08). Part of `00-plan.md`. Base URL: the DB's own
domain (name pending, `00 §6.2`), path prefix `/v1`. JSON in and out, UTF-8,
`Content-Type: application/json`. CORS `*` on reads; writes are same-rules
(bearer or signed, so CORS is not a gate).

**Amended 2026-09-11 (20-spark.md S7).** The one-stored-format redesign
landed (S1–S3b so far; S4–S6 land alongside or shortly after this note —
see `20-spark.md` §7 for exactly what shipped and any deviation from the
plan below). What changed for this document: the wire `format` field is
now the record's **native** stored format everywhere, with one relabelling
exception for the transitional `akl/1` alias (§1); every record carries a
top-level `upstream` field, folded from the cmini-import events and
transitional for as long as that import runs (§5, decision 5/16); every
rev-bumping event carries a proven `source` (§5, decision 14); a new
`migrated` event kind lands stored records on `spark/1` (§5, decision 10,
`19-upcast.md`); two new error codes (`format_not_writable`,
`invalid_client_version`, §1); restore has no time limit and an optional
`{name}` (§3, decision 8/9); `GET /v1/formats` gained `role`/`aliases`
(§2); `WIRE_VERSION` folds into every ETag (§5); `POST
/v1/admin/migrate/tick` is new (§7).

## 1. Conventions

- **Refs.** `{ref}` in a path is a record id (`01J…`) or a name (case-
  insensitive). A ref matching the ULID shape
  (`^[0-7][0-9A-HJKMNP-TV-Z]{25}$`, case-insensitive) is looked up as an id
  first, then as a name; any other ref is a name. `check_name` (§3) refuses
  ULID-shaped names, so a new record can never be ambiguous; an imported
  name of that shape (none exist, 07 §0.1) would be reachable by id only.
- **Formats.** Every read that returns a payload accepts `?as=<format>`
  (`01 §4`). Default `spark/1`.
  `409 { error: "held", held: true, format: "<native>", see: … }` when the
  translation is not possible (`01 §5`). In a `full=1` list a held record
  appears as its record fields plus `held: true, format`, without `payload`.
  **Amended:** the wire `format` field is the record's **native** stored
  format everywhere — list rows, `full=1`, a detail read, `/rev/{n}`, a
  write response, events' `before`/`after`, `/v1/changes` and webhooks, the
  dump. The one exception (decision 12, refined in review): a response to
  a request that named the transitional `akl/1` alias — `?as=akl/1` on a
  detail read, `/rev/{n}` and `full=1`; the write response and the `409
  stale` body of a write whose body said `format: "akl/1"` — carries
  `format: "akl/1"` instead (the deployed bot branches on it, `apply.ts`,
  `magic/source.ts`, `commands/magic.ts`). `?as=cmini/1` is **not**
  relabelled: it is an adapter projection (`toCmini`), not the same
  format, so its response still names the native `spark/1`.
  `?format=akl/1` on the list filter resolves to `spark/1` the same way.
- **List rows** carry the record minus `payload` (§2). (A `?fields=`
  trimmer was in round 1 and is cut: nothing left on a row is heavy.)
- **Errors.** `{ error: "<snake_code>", message: "<human text>", …details }`.
  The `message` is what a bot prints and what the site shows verbatim — write
  them in the bot's voice (`missing gap before column …`). Phase 1's full
  table is `07 §6 S6`, regenerated at `db/INTEGRATION.md`; the redesign adds
  `format_not_writable` (§3) and `invalid_client_version` (below).
- **Client version.** Every non-`GET`/`HEAD`/`OPTIONS` request may carry
  `X-Client-Version: <string>` (decision 14): ≤ 64 chars of
  `[A-Za-z0-9._+/:-]`, validated once in the actor middleware; anything
  longer or out of that charset is `400 invalid_client_version`. Absent →
  `null`. It is declared by the client and stored as sent — it never
  influences `Actor.source_client` (§5) — and exists so a rollback-by-
  source admin tool (a follow-up, not in this round) can find every write
  a given client build made.
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
    layouts_modified_at, authors_modified_at, authors_version,
    formats: ["spark/1", "mana2/1", …] }
```
The one call a poller makes on a quiet tick (meta-watch, `06 §1`). `seq` is
the event log head; `revision` is the `at` of that event (likes move it,
`layouts_modified_at` they do not); `layout_count` counts live records.
`authors_version` moves on every change to the author set or to an author's
name, which appends no event, and never on sign-in bookkeeping;
`authors_modified_at` is when the latest such change was written
(`LDB-R2`/`LDB-R9`).

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
GET /v1/authors?by=id                   → { "<user_id>": "<name>" }   (lossless: two ids may share a name)
GET /v1/authors/{user_id}               → { user_id, name, layout_count, liked_count }
GET /v1/formats                         → registry: [{ id, owner, description, role, aliases: [...], can_translate_to: [...] }]
GET /v1/formats/{name}/{N}/schema.json
```

`GET /v1/formats` (amended, decision 12/S1): `role` is `"stored"` or
`"output"` (`01 §4`); `aliases` lists every transitional alias whose
target is this format (`["akl/1"]` on `spark/1` today); `can_translate_to`
is the reachable set — the format's own `to[...]` targets plus every alias
reachable from it (so `spark/1` advertises `mana2/1`, `akl/1`, `cmini/1`).

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
                                        { board }                (spark/1 board shape, `01 §2`)
                                        { magic }                (spark/1 magic shape, `01 §2`)
DELETE /v1/layouts/{ref}              If-Match                                 → 200 tombstone record
POST   /v1/layouts/{ref}/transfer     { to: "<user_id>" }  If-Match            → 200 record
POST   /v1/layouts/{ref}/restore      (owner or admin; no time limit)          → 200 record
PUT    /v1/layouts/{ref}/like                                                  → 200 { like_count }
DELETE /v1/layouts/{ref}/like                                                  → 200 { like_count }
```

Semantics:

- `POST`: `name` checked (`check_name` rules, the bot's `util/layout.py`:
  ≥ 3 chars, its `NAME_SET` charset, no leading `_`; plus: not ULID-shaped
  (§1); unique case-insensitively → `409 name_taken`); `format` must resolve
  through the registry to a `"stored"`-role module (§1) — `mana2/1` is
  `400 format_not_writable`, anything unregistered (including `cmini/1`) is
  `400 unknown_format`; payload validated (`01 §2.1`); `owner = actor`;
  `rev = 1`. A write in a registered but non-latest major of a lineage is
  upcast through the chain and stored at latest (`01 §5`, `19-upcast.md`,
  S5) — with only `spark/1` registered this never fires yet. `check_name`
  applies to `POST` and `rename` only — **imported names are stored
  verbatim** (`io` is 2 chars, `AdNW` keeps its case; LDB-I5). Its
  charset is the bot's `NAME_SET` minus the space, its messages the bot's
  own, plus a 64-char cap (`09 §2.4`, LDB-N1). `409 name_taken` carries
  `holder: { id, owner }` so a client can tell its own record from a
  stranger's (`06 §2.2`).
- `PUT`: whole payload replaced; `rev + 1`. **Amended (LDB-F16, S2):**
  every accepted write — `PUT` included — is stored as `spark/1`. Naming
  `format: "akl/1"` in the body stores the same bytes under `spark/1`
  (the alias, `01 §4`); naming `mana2/1` is `400 format_not_writable`;
  naming `cmini/1` or anything unregistered is `400 unknown_format`. A
  `PUT` against a record still stored in a legacy format (`akl/1`/
  `cmini/1`, before the S4 migration converts it) carries that record's
  payload forward through `storedAsSpark`, not verbatim, with `has_magic`
  recomputed.
- `PATCH` verbs are what the bot's small commands map to (`05 §2`).
  **Amended (S2):** every record is patched as `spark/1` now — a legacy-
  stored record is converted through `storedAsSpark` first, whatever the
  PATCH names, so `fingermap`/`board`/`magic` all apply through `spark/1`'s
  own `edits` (`setFingermap`, `setBoard`, `setMagic`) and
  `unsupported_for_format` is effectively unreachable in phase 1 (kept for
  a future format that omits an `edits` entry). Verbs in one body apply in
  the order `name, fingermap, board, magic`, validated as a whole, **one
  event**: `renamed` for `{name}` alone, `fingermap` for `{fingermap}`
  alone, else `updated` with `detail.fields`. **Amended (decision 6):** a
  magic-only `PATCH`/`PUT` used to leave `modified_at` untouched and never
  count toward "follows upstream" (LDB-I12); it now forks like any other
  write and bumps `modified_at` — see §5 and `17-magic-ownership.md`.
  `rename` frees the old name immediately (the tombstone rule: names are
  released only by delete or rename — LDB-P4).
- `swap!/cycle!/angle!/unangle!/mirror!` are **client-side** transformations
  followed by a `PUT` — the bot's TS port of cmini's `modify()` bodies
  (`10 §5`, the Python quoted as the spec) computes them and writes the
  result. The DB does not grow verbs whose meaning is an analyzer's.
- `DELETE` writes a tombstone (`deleted: true`, `rev + 1`, payload carried
  forward through `storedAsSpark`, `has_magic` recomputed); the name is
  free; the record stays readable by id and restorable **by id, with no
  time limit** (decision 8: was 30 days for the owner; tombstones were
  never pruned, so there was no storage pressure the window protected
  against), by its owner or any time by an admin (logged `admin: true`);
  a live holder of the name → `409 name_taken`.
- `transfer`: owner or admin; `to` must have an `authors` row (an author or
  anyone who has signed in once) and differ from the current owner.
- `restore` (amended, decision 8/9, refined in review): owner or admin, no
  time limit, no `If-Match` (a tombstone has one possible next state). The
  body is optional — absent, `{}`, or `{name}`; any other shape is `400
  bad_request`. Without `name`, restoring under the tombstone's own
  (possibly reclaimed) live name answers `409 name_taken` with `holder`
  exactly as any other name clash. With a *different* `name`, it goes
  through `check_name` (LDB-N1 amended) and the event is `restored` with
  `detail: {renamed_from}`; both records keep their own likes, and a
  restore frees no name (LDB-P4 untouched). The payload is carried
  forward through `storedAsSpark`, `has_magic` recomputed.
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
        | "deleted" | "restored" | "imported" | "upstream_deleted" | "migrated"  // rev-bumping
        | "liked" | "unliked"                                              // like_count only
        | "upstream_changed" | "import_conflict"                           // informational
        | "admin.client_registered" | "admin.client_revoked" | "admin.added" | "admin.removed",
  "layout_id": "01J…", "name": "hours", "owner": "…",
  "rev": 7 | null,                                     // the record's rev after this event; null = no bump
  "actor": "<user id>" | "system:cmini-import" | "system:migration",
  "via": "discord" | "client:<id>" | "import:cmini" | "name_inherited" | "migration",
  "admin": false,
  "source": { "client": "discord-app:<app id>" | "client:<id>" | "system:cmini-import" | "system:migration" | "legacy:<via>",
              "version": "<X-Client-Version>" | null },        // every event since 0005 (decision 14); pre-0005 events synthesize "legacy:<via>"
  "detail": { … } | null,                             // imported: {source, upstream_id, shadowed?}; upstream_changed: upstream's cmini/1 detail; migrated: {from, to: "spark/1", upstream_state}; liked (inherited): {from: <tombstone id>}
  "before": { …record minus payload, incl. upstream, source… } | null,   // payloads by rev via /rev/{n}
  "after":  { …record minus payload, incl. upstream, source… } | null }
```

Three classes, and the fold is uniform (`07 §6 S4`): a **rev-bumping**
event sets the record to `after` ⊕ the payload stored for that rev
(`upstream_deleted` on a following record is the tombstoning event, rev + 1;
`migrated` — new, decision 10/S4 — moves a legacy-stored record's payload
to `spark/1` with no other field changed, `modified_at` included);
`liked`/`unliked` move `like_count` by ±1 and nothing else; an
**informational** event changes nothing (`upstream_deleted` on a
non-following record is informational, `rev: null`).

**Amended (decision 5, S3a): `upstream` is a stored, top-level record
field** — `{source: "cmini", id, state: "following" | "forked"} | null` —
not derived by a live query the way "follows upstream" was in round 1.
It is still a **fold of this log**: `nextUpstream(prior, kind, via)` is
the one rule every writer uses (`core/upstream.ts`) — an import-system
write (`via: "import:cmini"`, including the rev-bumping
`upstream_deleted` tombstone and strip) sets/keeps `following`; every
other rev-bumping *user* write (`PUT`, `PATCH` — magic included, decision
6 — rename, fingermap, transfer, delete, restore) sets `forked` once
`prior` is non-null; a `migrated` event never changes it; `null` stays
`null`. A record written before the field existed (or restored from a
pre-0005 dump) reads its **legacy** value instead: the latest rev-bumping
event's `via`, walking back past every historical event still marked
`detail.magic_only: true` (`LDB-I2a`/`I12`, narrowed by S2/S3a to
*exactly* this fallback — no new write ever sets that marker again, since
decision 6 forks every magic edit like any other write) and past every
`migrated` event. `upstream` (and its following/forked states) is
**transitional** for the life of the cmini import (decision 16): once
that import is retired, the field, this rule, and `LDB-I13/I14/P5/P11`'s
upstream half retire with it (`20-spark.md` §6b).

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
(`"<seq>:<hash(query)>"`). **Amended (LDB-R1, S2):** the hash also folds
in a `WIRE_VERSION` constant (currently `2`), so a deploy that changes
what a given `(seq, query)` serves — a relabel rule, a shape change — also
changes every ETag; without it a pre-deploy `If-None-Match` (or an
edge-cached body) at an unchanged head `seq` would keep serving the old
shape. `If-None-Match` matching → `304` after one
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
POST   /v1/admin/migrate/tick     { dry_run, after?, limit? ≤ 100 }   → MigrateReport (below)
GET    /admin/changelog           HTML, public, read-only: the event feed rendered (the site's /admin/cmini-log, moved here)
```

`POST /v1/admin/migrate/tick` (new, decision 11/S4, LDB-P12): operator-
driven, **not** a cron (c7's request) — one batch of the record
migration off legacy stored formats onto `spark/1`, admin-only, logged
`admin.migrate_ticked` (same shape as the other admin ticks, LDB-A5
amended). Not gated on the import pause (every write carries `expectRev`,
LDB-P14, so migration and import writes interleave safely). Paired with
`scripts/migrate_records_to_spark.py --dry-run` which pages it and prints
a report, same style as `migrate_magic_rules_to_db.py`.

```jsonc
→ { selected, converted, by_from: {"cmini/1": n, "akl/1": n, "spark/1": n},
    deleted, upstream: {following, forked, null}, legacy_magic_only_following,
    invalid: [{id, name, format, path, message}], raced, next_after }
```

Selection: `format != 'spark/1'` (legacy `cmini/1`/`akl/1`, live and
deleted) **or** a record a write already stored as `spark/1` between the
0005 deploy and this run whose `upstream` is still null (the backfill
arm) — ordered by id, `id > after`, up to `limit` (default and max 100:
roughly 7 D1 round trips per record, well under Workers Paid's 1 000
queries/invocation). Per record: convert through `storedAsSpark`,
validate as spark (a failure is skipped and listed in `invalid`, never
written — the record keeps reading through `LDB-F21`); a computed
`hasMagic` that disagrees with the stored `has_magic` is treated the same
way; otherwise `appendWrite` a `migrated` event with `expectRev:
record.rev` (a losing race is counted `raced` and re-selected next call,
never retried in place). `legacy_magic_only_following` counts records
whose *true* latest rev-bumping event (not the legacy-rule's own skip) is
`magic_only` — the 67 records seeded in M2 (decision 7, flagged
deliberately: they come out `following` only because the legacy rule
walks back past that marker, which is correct per the legacy definition
but worth surfacing). `dry_run`: identical selection/conversion/
validation, zero D1 writes, `raced` always 0. A quiet tick (nothing
selected) writes nothing.

## 8. Storage (D1)

```
layouts        id PK, name UNIQUE COLLATE NOCASE, owner, rev, created_at, modified_at,
               deleted, format, payload_json, like_count, has_magic       -- no link column (00 §6: cut)
               -- no origin_* columns: provenance is the events table (01 §1)
               -- 0005_spark.sql (S3a/S3s): upstream_source, upstream_id, upstream_state  -- NULL together or set together (decision 5)
               --                            source_client, source_version                -- decision 14
layout_revs    (layout_id, rev) PK, event_seq, payload_json, format      -- for /rev/{n}; every rev kept
                                                                          -- (compaction was cut, 07 §12)
                                                                          -- format here is the LEGACY value forever -- history is not rewritten (LDB-F21)
likes          (layout_id, user_id) PK, at
authors        user_id PK, name, first_seen_at, last_seen_at              -- names from Discord at auth; cmini import seeds
               -- 0006: name_source 'import'|'user'|'client' -- one stable name per id; a user-lane name is never overwritten by the import (LDB-I15..I17)
events         seq PK AUTOINCREMENT, at, kind, layout_id, actor, via, admin, before_json, after_json
               -- 0005_spark.sql (S3s): source_client, source_version   -- decision 14; NULL on any event written before this column existed
clients        id PK, name, pubkey, owner_user_id, caps, discord_app_id, status, created_at, revoked_at
nonces         (client_id, nonce) PK, at                                  -- pruned > 10 min
admins         user_id PK, added_by, added_at, note
webhooks       id PK, owner_user_id, url, secret_hash, kinds, status, failures, created_at
import_state   key PK, value                                             -- cmini.meta_token · cmini.last_full · cmini.paused · cmini.stalled · cmini.last_tick
import_map     upstream_id PK, layout_id UNIQUE                          -- cmini id (= lowercase name) → record id; not on the record
auth_cache     -- 0005_spark.sql (S3s): gains app_id TEXT NULL beside user_id -- a cached row without it (written before 0005) is a miss (LDB-A2 amended)
```

`upstream`/`source` are transitional/permanent respectively at the column
level too: `upstream_*` retires with the cmini import (decision 16,
`20-spark.md` §6b — a later migration drops the columns); `source_*`
does not (decision 14 has no sunset). Neither column set is backfilled by
SQL — the S4 migration and the read-side fallbacks (`upstreamOf`,
`sourceOfEvent`) are what converge/synthesize a value for a pre-0005 row.

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
| LDB-P5 | **Amended (S3b):** every record whose `upstream.state` is `following`, read `?as=cmini/1`, equals upstream's copy on the `cminiDetail` projection (magic and likes excluded on both sides). A name-matched record that is `forked` or has `upstream: null` is reported `divergent`, never a diff failure — following status comes from the field, never from an event `via` walk. | the daily D12 diff (`07 §6 S8`) |
| LDB-P6 | `/v1/changes` serves from `since=0` always, including from a rehosted database; `layout_revs` is never compacted in phase 1. | feed test + the rehost test |
| LDB-P7 | Every error response carries `error` and `message`; every (route, status) pair has a conformance fixture. Phase-4 clause (`10 §1` D6): for every (verb, error code) the bot's parity table names, the **bot** renders cmini's own string; the DB's `message` is what the bot prints for any error the table does not name — cmini had three different not-owner strings, so no single `message` can be "the bot's string". | conformance suite (`07 §6 S6`); `bot/tests/parity-write.test.ts` (`10` V4) |
| LDB-P8 | **Amended (decision 8/9, S2):** deleted records are unreadable by name from the moment of deletion and restorable **by id, with no time limit**, by their owner or any time by an admin, keeping name/format/payload/history; restoring under a live, reclaimed name needs an explicit `{name}` or gets `409 name_taken` with `holder`. | `tests/api/refs.test.ts`, `tests/api/restore.test.ts` |
| LDB-N1 | **Amended:** `check_name` is the bot's rule set with the bot's strings (`NAME_SET` minus the space), plus the 64-char cap and the ULID-shape refusal, applied to `POST`, rename, and restore's optional `name`. | `tests/api/names.test.ts`, `tests/api/patch.test.ts`, `tests/api/restore.test.ts` (`09 §2.4`) |
| LDB-W1 | Every write route is resolve → authorize → check → `appendWrite`; no file under `src/routes/` prepares a D1 statement. | `tests/tools/routes-noprepare.test.ts` |
| LDB-E1 | Format `edits` are pure, identity on their own projection and validity-preserving. | `tests/formats/edits.test.ts` (generated over the registry × fixtures) |
| LDB-L1 | Likes move `like_count`, `likes` and `meta.revision`/`seq` only — never `rev`, `modified_at` or `layouts_modified_at`; concurrent likes are counted exactly. | `tests/api/likes.test.ts` |
| LDB-R6 | Writes are limited to 60 per 10-minute window per actor, counted per attempt, `429` + `Retry-After`; reads are never counted. | `tests/api/ratelimit.test.ts` |
| LDB-R1 | **Amended (S2):** polled routes carry `Cache-Control` + a strong `ETag` and answer `304` to a matching `If-None-Match`; the ETag changes iff the event head, the query, or `WIRE_VERSION` changes. | matrix over routes × header states; `etag.test.ts` |
| LDB-R2 | `/v1/meta`'s counts, `seq` and `revision` equal the tables. | API test after a fixture import |
| LDB-R3 | The conformance fixtures are the API contract: a changed fixture is a documented API change. | conformance suite + review |
| LDB-R4 | Every `sort` × `limit` cursor walk of `/v1/layouts` visits every live record exactly once, in order. | property test |
| LDB-F16 | One stored format (S2, S3b import, S4 migrate): every accepted write stores `spark/<latest>` — delete/restore/transfer/`upstream_deleted`/strip of a legacy-stored record included; a write whose format resolves to an `"output"` role is `400 format_not_writable`; an unregistered format (`cmini/1` included) is `400 unknown_format`. | registry matrix × every write verb × stored format ∈ {spark/1, akl/1, cmini/1} |
| LDB-F20 | Aliases (S1 registry half, S2 API half): every alias is in one table; `akl/1` writes store `spark/1` byte-identical; the wire `format` is native except a response to a request naming `akl/1` (read `?as=`, write body, `409 stale`); `?as=cmini/1` = `toCmini`, labelled native; `cmini/1` writes refused. | alias matrix: route × alias × {read, write, stale} |
| LDB-F21 | Legacy stored rows read as spark (S1/S2): a `layouts`/`layout_revs` row stored `akl/1`/`cmini/1` reads on every route exactly as its `storedAsSpark` twin; `storedAsSpark` is the only converter of a stored legacy payload. | matrix: legacy format × read route |
| LDB-I13 | The cmini adapter is exact (S3b): for a following record, `fromCmini(upstream)` equals its payload minus `magic`; every live upstream detail's `fromCmini` validates as spark. | `cmini-envelope.test.ts` over upstream-100; the daily diff |
| LDB-I14 | Upstream write rule, one function `nextUpstream` (S3a/S3b): import writes → `following`; every user rev-bumping write → `forked` when prior is non-null; `migrated` leaves it unchanged; the importer never writes `forked` (guarded by `expectRev`, P14); `null` stays `null`. | matrix: event kind × prior {null, following, forked} × import_map {yes, no} |
| LDB-P11 | `upstream` is a fold (S3a): the row equals the latest rev-bumping event's `after.upstream`; replay from events reproduces it; a restore of a pre-0005 dump yields NULL and `upstreamOf` then equals the legacy rule. | replay property test; restore test |
| LDB-P12 | Record migration (S4): after ticks to quiescence no record's stored format ≠ `spark/<latest>` except those reported `invalid`; one `migrated` event per converted record; a dry run writes zero rows. | fake-clock suite over a seeded mixed store |
| LDB-P14 | A write with `expectRev` (S3a) commits only if the record is still at that rev — closes the race where a system writer's stale re-read would clobber a concurrent user write. | property: random interleavings of {import, strip, migrate} × {user write} |
| LDB-P15 | Every rev-bumping event written after 0005 (S3s) carries `source.client` derived from the authenticated identity or the system writer, never from a header or body; `source.version` is the validated `X-Client-Version` or null; the record's `source` equals its latest rev-bumping event's; pre-0005 events read `legacy:<via>`. | lane × verb × header matrix; spoof matrix; replay property |
| LDB-A2 | **Amended (S3s):** the Discord cache also keys the token's application id from `/oauth2/@me`; a cached row without it is a miss. | `tests/auth/discord.test.ts` |
| LDB-A5 | **Amended (S4):** `POST /v1/admin/migrate/tick` calls the same `migrateTick()` and is event-logged as `admin.migrate_ticked`. | `admin.test.ts` |
| LDB-I2a / I12 | **Narrowed, not deleted (S3a):** their text is now the definition of `legacyFollows` (magic-only and `migrated` events skipped), used only by `upstreamOf`'s legacy fallback and by S4's initial-state computation. No new write ever sets `detail.magic_only` again (decision 6: a magic edit forks like any other write); the 67 records seeded before this landed still depend on the rule. | `follows.test.ts` |
| LDB-R5 | `/rev/{n}` reproduces the payload stored at rev `n` for every `n`. | API test over every seed record |

The chain's own invariants (`F18` chain contract, `F19` path composition,
`P13` older-major write, `D6` per-major dumps) are `19-upcast.md` §8,
implemented in S5 — not yet landed as of this writing; see
`20-spark.md` §4/§7 for status.

## 10. Open questions (API)

1. *(resolved, `09 §6.9`; moot since S2: every record is patched as
   `spark/1` now, `01 §4`, so `PATCH { board }` on a legacy-stored record
   applies through `spark/1`'s own `setBoard` after `storedAsSpark`, same
   as any other record.)*
2. Keep `like` on own layout allowed (cmini does)? Proposal: yes, parity.
3. `history` visibility of `before` payloads for deleted records — public?
   Proposal: yes; cmini's data was always public.
