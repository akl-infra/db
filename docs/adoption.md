# Adopting the layout database API

A guide for a new client of `akl-db` — a Discord bot, a web app, a script,
or an AI agent building any of those — written to be followed by a human or
handed whole to an agent. Every claim below names the source file it comes
from; every request/response shown is either a real conformance fixture
(`db/tests/conformance/`, trimmed) or built directly from the same error
factory / schema the server runs, never invented.

```
production   https://akl-db.akl-58a.workers.dev   <- the one layoutdb
```

There is one layoutdb, production. The preview environment
(`akl-db-preview`) was retired on 2026-09-11: nothing reads it and it
accepts no clients. Develop against production, and ask before writing
there.

## 0. Quick start for agents

The fastest path to a working client: read one layout, then write one.

**Read** — no auth, ever:

```bash
curl -s https://akl-db.akl-58a.workers.dev/v1/layouts/io
```

returns the record plus its `payload` in the native `spark/1` shape
(`?as=mana2/1` for the analyzer-facing lowered shape instead — §3). A
`404 { "error": "not_found" }` means no such id/name; nothing else to handle
for a read-only client.

**Write** — every write needs an authenticated actor (§1) and, against an
*existing* record, an `If-Match` header naming the `rev` you read. The
signed (client-lane) shape, the one a Discord bot uses:

```bash
curl -sX POST https://akl-db.akl-58a.workers.dev/v1/layouts \
  -H 'X-Akl-Client: <client id>' -H 'X-Akl-Timestamp: <unix seconds>' \
  -H 'X-Akl-Nonce: <16 random bytes, base64url>' -H 'X-Akl-Actor: <discord user id>' \
  -H 'X-Akl-Signature: <base64url ed25519 signature>' \
  -H 'X-Client-Version: your-bot/1.0' \
  -d '{"name":"my-layout","format":"spark/1","payload":{"keys":{}}}'
```

The signing recipe is §2.1; the signature itself is checked against
`db/tests/vectors/client-signing.json` (§2.1) — build your signer against
that file and you know it's correct before ever calling the live service.

**Where the machine-readable pieces live**, so an agent never has to guess a
shape:

| what | where |
|---|---|
| Payload schemas (JSON Schema, draft 2020-12) | `GET /v1/formats/{name}/{N}/schema.json` — `spark/1`, `mana2/1` today |
| The full endpoint table (method, path, auth, body, statuses) | §9 below |
| The full error-code table | §6 below (generated from `db/src/core/errors.ts`, same table `db/INTEGRATION.md` carries) |
| Client-lane signing test vectors | `db/tests/vectors/client-signing.json` |
| Real request/response shapes, one file per (route, status) | `db/tests/conformance/` — every example in this guide is trimmed from one of these |
| The registry itself, machine-readable | `GET /v1/formats` (§3) |

## 1. Pick a lane

Every request ends up as one `Actor` (`src/auth/actor.ts`): `{ user_id, via,
admin, source_client }`. `user_id` is a Discord snowflake and every
authorization rule reads only that field. There are two ways to become one.

### 1.1 Client lane — a Discord bot (or any program acting for many users)

You (the bot) present *yourself* — an Ed25519 key an admin registered for
you — and *assert* which Discord user the request is for. This is right
when your program already trusts `message.author.id` (Discord delivered the
message) and cannot present that user's own token.

**What it proves**: that the request really came from your registered key
(replay- and forgery-resistant, `src/auth/client.ts`'s `verifyClientRequest`)
and, if your registration's `caps` is `act-as-owner-only`, that the asserted
actor is your own `owner_user_id` — nothing about whether that Discord user
actually sent you anything; that trust is yours to keep, and every write you
make is permanently attributed to your client id on the public feed and
changelog (`GET /admin/changelog`) so a compromised key is one query to spot
and one call to revoke (§2.1).

### 1.2 User lane — a web app, or a personal script run as yourself

The person signs into Discord through *your* application (OAuth `identify`
scope is enough) and you hold their access token server-side; every request
carries `Authorization: Bearer <that token>`. Right for a browser-facing
app: proxy writes through your backend, never hand a browser tab the raw
token.

**What it proves**: that a real Discord user, right now, holds a token your
Discord application issued — the DB confirms this by calling Discord's own
`GET /oauth2/@me` with the same header and caching the answer
(`src/auth/discord.ts`, ≤ 5 min on success, ≤ 60 s on a Discord 401).

### 1.3 Every edit records its source client

Every rev-bumping write's event — and the record's own latest one — carries
`source: { client, version }` (`03-api.md` §5, decision 14 of
`20-spark.md`). `client` is **proven**, never a header or body field you
control: `` `client:<your client id>` `` on the client lane, `` `discord-app:<your
Discord application id>` `` on the user lane (from `GET /oauth2/@me`'s
`application.id`, not anything you assert). `version` is exactly what you
declare in `X-Client-Version` on every non-`GET`/`HEAD`/`OPTIONS` request —
≤ 64 characters of `[A-Za-z0-9._+/:-]`, or `null` if you send none; a
longer or out-of-charset value is `400 invalid_client_version`. It never
influences `client` — it exists so an operator can later find every write a
given build of your client made, which is the whole point of sending a real
one (a build id, a semver tag, anything that changes when you ship).

## 2. Register

### 2.1 Client lane: registration and the signing recipe

**Registration is admin-only** — there is no self-service sign-up. Reach an
admin with your Ed25519 public key (raw 32 bytes, base64url), the
`owner_user_id` you'll act for by default, and the `caps` you need
(`act-as-user` to assert any Discord user id — a real multi-user bot; or
`act-as-owner-only` to assert only your own `owner_user_id` — a personal
script). The admin runs:

```bash
POST /v1/admin/clients
{ "name": "my-bot", "pubkey": "<base64url 32-byte Ed25519 public key>",
  "owner_user_id": "<your discord user id>", "caps": "act-as-user" }
```

Real response shape (`db/tests/conformance/admin-clients/post-201.json`,
trimmed):

```json
{ "id": "01ARZ3NDEKTSV4RRFFQ69G5FAV", "name": "my-bot",
  "pubkey": "KsG4a3kPQ2f74uSL0Ra4QRWDq84lNtJ63mhZ9OLNU1c",
  "owner_user_id": "800000000000000020", "caps": "act-as-user",
  "discord_app_id": null, "status": "active",
  "created_at": "2026-06-20T00:00:00.000Z", "revoked_at": null }
```

`id` is your **client id** — the value you send back as `X-Akl-Client` on
every signed request. The private key never leaves your host; rotation is
"register a new key, revoke the old" (`DELETE /v1/admin/clients/{id}`,
effective immediately — `clients.status` is read fresh on every request,
never cached).

**Signing a request** — five headers, one string
(`signingString` in `db/src/auth/client.ts`):

```
X-Akl-Client:    <client id>
X-Akl-Timestamp: <unix seconds>
X-Akl-Nonce:     <16 random bytes, base64url>
X-Akl-Actor:     <the Discord user id this request acts for>
X-Akl-Signature: base64url( Ed25519_sign( sk, signing_string ) )

signing_string = "akl-v1\n" + METHOD + "\n" + PATH_WITH_QUERY + "\n"
               + TIMESTAMP + "\n" + NONCE + "\n" + ACTOR + "\n"
               + base64url( sha256( body bytes, or empty ) )
```

`METHOD` upper-cased; `PATH_WITH_QUERY` exactly as sent, no
canonicalisation; an absent body hashes as zero bytes. `X-Client-Version`
(§1.3) is sent alongside these five but takes no part in the signature.

The server's checks, in order, each throwing before the route ever runs
(`verifyClientRequest`):

| step | failure |
|---|---|
| the 5 headers are present and shaped right (nonce/signature decode, actor is a 17-20-digit id) | `401 bad_signature` |
| the client id is known | `401 unknown_client` |
| `clients.status == "active"` | `401 client_revoked` |
| `\|now − timestamp\| <= 300s` | `401 stale_timestamp` (`skew` in the body) |
| the Ed25519 signature verifies under the registered key | `401 bad_signature` |
| the nonce is unseen for this client in the last 10 minutes (a D1 INSERT's own primary key) | `401 replay` |
| `act-as-owner-only` ⇒ `X-Akl-Actor == owner_user_id` | `403 actor_not_allowed` |

(every `401` above also carries `WWW-Authenticate: Bearer`.)

**Interop is a frozen vector file**: `db/tests/vectors/client-signing.json`
holds thirteen `(key, request, expected signing_string, expected signature)`
tuples every signer — the Worker's own verifier, the bot's TS client, a
brand-new one you write — must reproduce byte for byte. One real vector
(the key's seed is also in the file, so you can sign it yourself and diff):

```json
{
  "name": "post-layouts-body",
  "client_id": "01ARZ3NDEKTSV4RRFFQ69G5FAV",
  "method": "POST", "path": "/v1/layouts",
  "timestamp": "1788000000", "nonce": "vyB9xATKxJgAYDeVXMPxrA",
  "actor": "184412255822020608",
  "body": "{\"name\":\"test-layout\",\"format\":\"akl/1\",\"payload\":{\"keys\":{}}}",
  "signing_string": "akl-v1\nPOST\n/v1/layouts\n1788000000\nvyB9xATKxJgAYDeVXMPxrA\n184412255822020608\n0vt-bo2cbitFAdlT6qDD1irLrvi5HZ_5ruFRTPF2fmM",
  "signature_b64url": "WibgcXRcJee4dyEHQXnTd0M8f0H3BRUsSAzhCkX5LRO2ye3_tAJzQonA-1Jq0HGwRI4SmE2QNzSrXEhRa9K1BQ"
}
```

The vector's own seed key is `db/tests/vectors/client-signing.json`'s
`keys[0]`: `seed_hex` (raw Ed25519 private seed) and `pkcs8_b64url` (the same
key, PKCS8-wrapped — what Web Crypto's `crypto.subtle.importKey('pkcs8', …)`
takes). `bot/src/client/sign.ts` and `bot/src/client/http.ts` are a real,
tested implementation of this whole recipe worth reading end to end — a
Web-Crypto-only signer (Node, a Worker, or a browser, unchanged) that:

1. builds `signingString(method, pathWithQuery, timestamp, nonce, actor,
   bodyHashB64url)` exactly as above;
2. sends it plus `X-Client-Version` (`clientVersionFor(cfg)`, keyed on the
   bot's own build id) on every request, never `Authorization` (the two
   lanes are mutually exclusive — sending both is `400 bad_request`);
3. sends `If-Match` whenever the caller supplies one, quoted exactly;
4. on a request timeout, returns a synthetic `{status: 0, error: "timeout"}`
   rather than throwing, so a caller's generic error-body handling covers it
   for free (`bot/src/client/http.ts`'s own header comment has the full
   reasoning, including the operator-alerting hooks around it — not part of
   the protocol itself, but a good model for a production client).

### 2.2 User lane: Discord OAuth

Register your own Discord application, request the `identify` scope, and
hold the resulting access token server-side. No registration with `akl-db`
itself is needed — any Discord access token with `identify` works the
moment you send it:

```bash
curl -s -H 'Authorization: Bearer <discord access token>' \
  https://akl-db.akl-58a.workers.dev/v1/me
# {"user_id":"800000000000000001","name":"conformance-owner","via":"discord","admin":false}
```

No header, or a token Discord rejects:

```json
// no Authorization header
{"error":"unauthorized","message":"authentication required"}
// Discord itself says the token is invalid/expired
{"error":"token_invalid","message":"the bearer token is invalid or expired"}
```

`GET /v1/me` is the cheapest way to prove your whole auth chain works before
writing anything.

## 3. Read (no auth, ever)

```bash
GET /v1/meta
GET /v1/layouts?owner=&format=&has_magic=&since=<iso>&liked_by=&sort=&limit=&cursor=&as=
GET /v1/layouts?full=1&as=<format>          # every live record, streamed
GET /v1/layouts/{ref}?as=<format>            # {ref} = id (ULID) or name, case-insensitive
GET /v1/layouts/{ref}/likes
GET /v1/layouts/{ref}/history
GET /v1/layouts/{ref}/rev/{n}?as=<format>
GET /v1/authors
GET /v1/authors/{user_id}
GET /v1/formats
GET /v1/formats/{name}/{N}/schema.json
```

Every route that returns a payload takes `?as=<format>` — the format id to
translate the stored payload into. Two are registered today:

- **`spark/1`** (the default) — the one *stored* shape: cmini's `keys` map,
  board geometry, and an authoring shape for magic rules that keeps intent
  (`magic_keys`/`chiral_keys`/`adaptive_swaps`), not flattened rows.
- **`mana2/1`** — the **lowered, analyzer-facing** form: a mana2 `.jsonc`
  layout object (`layout.fingers`/`thumbs` row strings, `board`, flat
  `magic.rules[]`). Produced from `spark/1` on read, never stored (§7's
  "For format authors" has the mechanics); it is what an analyzer or emulator
  reads.

Real detail response (`db/tests/conformance/layouts-detail/200.json`,
trimmed):

```json
{
  "id": "01ARZ3NDEKTSV4RRFFQ69G5FAV", "name": "io",
  "owner": "761732338744557568", "rev": 1,
  "created_at": "2022-12-07T23:24:35Z", "modified_at": "2022-12-07T23:24:35Z",
  "deleted": false, "like_count": 15, "has_magic": false,
  "format": "spark/1",
  "upstream": { "source": "cmini", "id": "io", "state": "following" },
  "source": { "client": "system:cmini-import", "version": null },
  "likes": ["184412255822020608", "…"],
  "payload": { "keys": { "a": { "row": 1, "col": 6, "finger": "RI" }, "…": "…" },
               "board": { "kind": "ortho", "cmini": "ortho" },
               "x": { "cmini": { "tag": "cmini", "blame": "cmini" } } }
}
```

**A record whose format cannot be translated to the one you asked for** is
`held`, not an error about your request — the record exists, your format
just cannot show it yet:

```json
409 { "error": "held", "held": true, "message": "record cannot be translated to 'mana2/1'",
      "format": "mana2/1", "see": "spark/1" }
```

`?full=1&as=<format>` streams every live record; a held one there carries
`held: true` and its record fields, no `payload`, instead of erroring the
whole response. `GET /v1/formats` is the registry itself, machine-readable
(`db/tests/conformance/formats-list/200.json`, trimmed):

```json
[
  { "id": "spark/1", "owner": "DB (+ akl.gg)", "role": "stored",
    "lineage": "spark", "major": 1, "latest": true,
    "aliases": [], "can_translate_to": ["mana2/1"] },
  { "id": "mana2/1", "owner": "…", "role": "output",
    "lineage": "mana2", "major": 1, "latest": true,
    "aliases": [], "can_translate_to": [] }
]
```

`role` tells you whether a write may store this format (`"stored"`) or only
ever appears on read (`"output"`, §5). `lineage`/`major`/`latest` are what a
client checks to detect a new major without parsing the id string itself
(§8). `aliases` names every transitional alias whose target is this format
— always `[]` today; kept on the wire shape for a future one, not currently
in use (see below). `can_translate_to` is the full reachable set.
`GET /v1/formats/{name}/{N}/schema.json` serves the literal JSON Schema
(draft 2020-12) a payload must satisfy — validate client-side against it
before ever sending a write, the same schema the server itself runs
(`db/scripts/validate-akl1-payload.mjs` is a Node CLI shim over the exact
same `validate()`; the script's own name is historical, it validates
against `spark/1`'s current schema).

**No more `akl/1` alias.** `spark/1` is `akl/1` renamed — same payload
shape, byte for byte (`design/layout-db/20-spark.md` decision 1). `akl/1`
worked as a transitional alias while the bot, the preview site and
publish-ux moved to `spark/1`'s own name; `21-formats.md` D12 deleted the
alias mechanism entirely once every client had (2026-09-11). `?as=akl/1`
and `format: "akl/1"` now answer/refuse exactly like any other unregistered
format id (`400`/`404 unknown_format`, per §3's error table) — there is no
relabeling, and `format` in every response is always the record's native
`spark/1`. **Every client reads and writes `spark/1` by name.**

**`history` and `rev/{n}` carry `source` too** — per-event provenance, not
just per-record (`db/tests/conformance/layouts-history/200.json`, trimmed):

```json
[ { "seq": 258, "rev": 1, "at": "2026-06-01T00:00:00.000Z",
    "actor": "system:cmini-import", "via": "import:cmini", "kind": "imported",
    "admin": false, "source": { "client": "system:cmini-import", "version": null } },
  { "seq": 259, "rev": null, "kind": "liked", "…": "…" } ]
```

## 4. Stay current

**The change feed is ground truth** — a poll, a dump, a webhook are all
shortcuts around it, never a second source of truth.

```
GET /v1/changes?since=<seq>&limit=<≤1000>&kinds=created,updated,…&layout=&actor=
→ { next: <seq>, items: [event…] }
```

`since` is exclusive (`since=0` = everything); pass `next` back as your next
`since`. Real page (`db/tests/conformance/changes/200.json`, trimmed):

```json
{ "next": 3, "items": [
  { "seq": 1, "at": "2026-06-01T00:00:00.000Z", "kind": "imported",
    "layout_id": "01ARZ3NDEKTSV4RRFFQ69G5FAV", "name": "00------higgs",
    "owner": "621924065581465611", "rev": 1, "actor": "system:cmini-import",
    "via": "import:cmini", "admin": false,
    "detail": { "source": "cmini", "upstream_id": "00------higgs" },
    "before": null,
    "after": { "id": "01ARZ3NDEKTSV4RRFFQ69G5FAV", "name": "00------higgs",
               "rev": 1, "format": "spark/1", "has_magic": false,
               "upstream": { "id": "00------higgs", "source": "cmini", "state": "following" },
               "source": { "client": "system:cmini-import", "version": null }, "…": "…" },
    "source": { "client": "system:cmini-import", "version": null } } ] }
```

**Folding events**, per `kind`: a **rev-bumping** kind (`created`,
`updated`, `renamed`, `fingermap`, `transferred`, `deleted`, `restored`,
`imported`, `upstream_deleted`, `migrated`) sets your local copy of the
record to `after` plus the payload for that `rev` (read via `/rev/{n}` if
you keep payloads, or just re-`GET` the record — `after` alone is enough to
know *that* it changed); `liked`/`unliked` move only `like_count` by ±1;
everything else (`upstream_changed`, `import_conflict`, `admin.*`) is
informational and changes nothing in your local copy.

**`migrated` needs no special handling beyond the fold above** — it is the
one-time record migration onto `spark/1` (§8), and it is rev-bumping like
any other write: apply `after` and move on. A client that special-cases it
to skip a re-fetch (the deployed bot does exactly this, `bot/src/cache/
feed.ts`, LDB-B49) is an optimization, not a requirement — `after` already
carries everything `applyEvent` needs.

**SSE**: `GET /v1/changes/stream?since=&kinds=` is the same feed pushed
instead of polled (needs the Workers Paid plan; `503 stream_unavailable`
otherwise). Reconnect with `Last-Event-ID: <cursor>` (what `EventSource`
sends automatically); a `: ping` comment arrives every 25s idle; the stream
closes with `event: close` / `data: {"next":<cursor>}` after `STREAM_MAX_MS`
(default 5 min) — reconnect with that cursor for no gap or duplicate.

**Webhooks** — `POST /v1/webhooks { url, secret, kinds?, owner_filter? }`,
up to 5 per user. Real response
(`db/tests/conformance/webhooks/post-201.json`, trimmed):

```json
{ "id": "01ARZ3NDEKTSV4RRFFQ69G5FAV", "owner_user_id": "830000000000000001",
  "url": "https://receiver.example/hook", "kinds": null, "status": "active",
  "cursor": 483, "failures": 0, "failing_since": null, "created_at": "…" }
```

Each POST carries the event JSON, `X-Akl-Webhook-Id`, `X-Akl-Seq`,
`X-Akl-Timestamp`, `X-Akl-Signature: v1=<hex hmac-sha256(secret,
`${timestamp}.${body}`)>`. Verify the HMAC, reject anything over 300s old.
Delivery is at-least-once, in order, and never concurrent per hook (a lease
keeps the after-write nudge and the cron drain — which overlap routinely —
from ever both posting to the same hook at once, LDB-H6); it is still
**never required for correctness**, a gap means poll `/v1/changes?since=`
to fill it. A `seq` may arrive twice only after an outage on this end (a
drain that dies mid-batch leaves the hook's lease held until it expires;
the next drain re-delivers from the last committed cursor, possibly
repeating the dead drain's own last, already-landed POST) — dedupe by
`X-Akl-Seq`, treating any `seq` ≤ your highest applied as a no-op. Non-2xx
(or >10s) schedules a retry at 1 min / 10 min / 1 h; 3 consecutive failures
→ `"failing"` (still retried hourly); failing past 7 days → `"disabled"`.

**The nightly dump** (`GET /v1/dump/latest.json`, written 03:00 UTC) is the
full state — every table, the **whole** event log, not a tail:

```json
{ "date": "2026-06-01", "key": "dump-2026-06-01.json.gz",
  "url": "/v1/dump/dump-2026-06-01.json.gz", "sha256": "…",
  "bytes": 1240439, "layout_count": 4176, "seq": 6213 }
```

**Per-major dump files** (decision 10 of `20-spark.md`, LDB-D6) — one per
registered *stored* major, at `GET /v1/dump/latest.<lineage>-<N>.json` (plus
a `.sha256` sidecar) — exist for exactly the case in §8: fetching every
record's payload as of a specific major without needing every client to
walk the chain itself. With only `spark/1` stored today this is
`latest.spark-1.json`; a hypothetical `spark/2` would add
`latest.spark-2.json` alongside it, never replacing it.

**`upstream` is transitional — do not build on it.** Every record carries a
top-level `upstream: {source: "cmini", id, state: "following" | "forked"} |
null` field, folded from the cmini-import events. It answers exactly one
question — "does the importer still own this record's keys and board" — for
exactly as long as the one-time cmini import keeps running
(`design/layout-db/20-spark.md` decision 16). There is no general
layout-from-layout fork concept here, no re-follow, and nothing outside the
importer, the daily upstream diff, and the one-time record migration reads
it for any decision. When the import is retired the field, its rule, and
every invariant that mentions it (`LDB-I13`/`I14`/`P5`/`P11`'s upstream
half) are removed in one migration (`20-spark.md` §6b) — a client that
keyed any behavior on `upstream.state` today has that behavior silently stop
meaning anything the day that lands. Fold it into your local copy if you
like (it costs nothing extra — it's already on every record and event), but
don't gate a feature on it.

**Fold-after-dump**: load the dump, then `GET /v1/changes?since=<dump's
seq>` to catch up — never re-fetch the whole corpus over the API once you
have a dump.

## 5. Write

```
POST   /v1/layouts                  { name, format, payload }               → 201
PUT    /v1/layouts/{ref}            { format, payload }             If-Match → 200
PATCH  /v1/layouts/{ref}            { name?, fingermap?, board?, magic? }  If-Match → 200
DELETE /v1/layouts/{ref}                                             If-Match → 200 (tombstone)
POST   /v1/layouts/{ref}/transfer   { to }                           If-Match → 200
POST   /v1/layouts/{ref}/restore    { name? }  (owner or admin, no time limit)  → 200
PUT / DELETE /v1/layouts/{ref}/like                                            → 200 { like_count }
```

**Every write carries `X-Client-Version`** (§1.3) — not required by the
schema, but every example below sends one, and you should too.

**`spark/1` payloads.** `payload.keys` maps a one-code-point char to
`{row, col, finger}` (finger ∈ `LP LR LM LI RI RM RR RP LT RT TB`); `free`
is a list of the same shape for board positions that exist but hold no
character; `board` names the geometry (`{kind: "rowstag"|"colstag"|"ortho",
stagger?, cmini?}`); `magic` is optional and carries **intent**
(`magic_keys`/`chiral_keys`/`adaptive_swaps`, plus a raw `rules[]` escape
hatch) — never the flattened rows an analyzer reads (that's what
`?as=mana2/1` is for, §3/§7). Full shape and every validation rule:
`design/layout-db/01-format.md` §2/§2.1; the schema itself:
`GET /v1/formats/spark/1/schema.json`.

**Creating** (real fixture, `db/tests/conformance/layouts-write/post-201.json`):

```bash
curl -sX POST …/v1/layouts -H 'X-Client-Version: my-bot/1.0' <signed-or-bearer> -d '
{"name":"my-layout","format":"spark/1","payload":{"keys":{}}}'
# 201 {"id":"01ARZ3ND…","name":"my-layout","owner":"800000000000000001","rev":1,
#      "created_at":"…","modified_at":"…","deleted":false,"like_count":0,"has_magic":false,
#      "format":"spark/1","upstream":null,
#      "source":{"client":"discord-app:app-default","version":null},
#      "payload":{"keys":{}}}
```

**`If-Match` and `409 stale`.** Every write against an *existing* record —
`PUT`/`PATCH`/`DELETE`/`transfer` — **must** carry `If-Match: "<rev>"` (the
rev you last read; quoted or bare) or `If-Match: *` (overwrite on purpose,
stated explicitly). Absent → `400 if_match_required`, checked before any
read or mutation. A mismatch is `409 stale` with the **winning** record
already in the body — no second request needed, just re-apply your change
to it and resend with its `rev`:

```json
409 { "error": "stale", "message": "record is at rev 2, not the version you edited",
      "rev": 2,
      "record": { "id": "01ARZ3ND…", "rev": 2, "format": "spark/1", "…": "…" },
      "last_write": { "seq": 439, "at": "…", "actor": "800000000000000001",
                       "via": "discord", "kind": "updated", "admin": false } }
```

(`format` is always the record's native `spark/1` — there is no relabeling
any more, §3.)

**PATCH verbs** apply, in one event, in the order `name, fingermap, board,
magic` — one or more of them in a single body:

```bash
curl -sX PATCH …/v1/layouts/01ARZ3ND… -H 'If-Match: "1"' <signed> \
  -d '{"fingermap":{"a":"LM"}}'
# 200 {"…","rev":2,"payload":{"keys":{"a":{"col":1,"finger":"LM","row":1}}}}
```

A body of exactly `{name}` writes a `renamed` event; exactly `{fingermap}` a
`fingermap` event; anything else (including any *combination*) an `updated`
event with `detail.fields` naming which keys changed. Every record patches
as `spark/1` — a legacy-stored record (still possible during the alias
window, §3) is converted first, whatever the PATCH names, so
`unsupported_for_format` never actually fires against a live record today.

**`format_behind`** (only matters once a format grows a second major, §8):
a `PUT` naming an older major of the record's own lineage is refused with
`409 format_behind` when the record, as currently stored, could never have
been read whole in that older major — the same fact a `GET
?as=<older-major>` would answer `held` for. The body shape is the same as
`held` (`format_behind` is `held` from the *writer's* side):

```json
409 { "error": "format_behind", "held": true, "format": "spark/1", "see": "spark/2", "rev": 7,
      "message": "this record uses spark/2 features that spark/1 cannot show; write it as spark/2, or PATCH the field you mean to change" }
```

With only `spark/1` registered today this cannot fire — it is documented
here for the day it can (§8).

**`format_not_writable`** — a write naming a registered format whose
`role` is `"output"` (`mana2/1` today: produced on read only, never
stored):

```json
400 { "error": "format_not_writable", "format": "mana2/1",
      "message": "format 'mana2/1' cannot be written (it is produced on read only)" }
```

**Restore** — `POST /v1/layouts/{ref}/restore`, owner or admin, no time
limit (tombstones are never pruned). The body is optional: absent, `{}`, or
`{name}`; anything else is `400 bad_request`. Without `name`, restoring
under the tombstone's own (possibly reclaimed) name is `409 name_taken` with
`holder` exactly as any other name clash; with a *different* `name`, the
new name goes through the same `check_name` rules as a fresh `POST`.

```bash
curl -sX POST …/v1/layouts/01ARZ3ND…/restore <signed>       # no body
curl -sX POST …/v1/layouts/01ARZ3ND…/restore <signed> -d '{"name":"my-layout-v2"}'
```

Real success (`db/tests/conformance/layouts-write/restore-200.json`,
trimmed): `200 {"…","deleted":false,"rev":3}`.

**Likes** — idempotent, never bump `rev`/`modified_at`, always return the
current count:

```bash
curl -sX PUT …/v1/layouts/01ARZ3ND…/like <signed>      # 200 {"like_count":1}
curl -sX DELETE …/v1/layouts/01ARZ3ND…/like <signed>    # 200 {"like_count":0}
```

## 6. Limits and errors

**Rate limits**: 1000 writes / 10 minutes per actor, counted per attempt
whether or not the write is accepted; on the client lane, an additional 5000
/ 10 minutes per client id (a bound on top of the per-actor one, not a
replacement for it — a busy multi-user bot legitimately needs it wider than
one person's own budget). `429 rate_limited` carries `Retry-After` (seconds)
and `scope` (`"actor"` or `"client"`, naming which counter tripped).

**The full error table**, generated from `src/core/errors.ts`'s own
`ApiError` factories exactly as `db/INTEGRATION.md`'s own appendix is
(`db/scripts/gen-error-table.mjs`; `db/tests/tools/docs-site.test.ts`'s
`LDB-G10` fails the build if this table drifts from that source, so treat
it as generated, not hand-edited):

| status | error | message | thrown by |
|---|---|---|---|
| 400 | `bad_request` | *(caller-supplied -- this function's own `message` parameter)* | `badRequest(message, param)` |
| 400 | `unknown_format` | unknown format '${format}' | `unknownFormat(format, known)` |
| 400 | `format_not_writable` | format '${format}' cannot be written (it is produced on read only) | `formatNotWritable(format)` |
| 404 | `not_found` | *(caller-supplied -- this function's own `message` parameter)* | `notFound(message, ref)` |
| 409 | `name_taken` | name '${name}' is already taken | `nameTaken(name, holder)` |
| 409 | `held` | record cannot be translated to '${format}' | `held(format, see)` |
| 409 | `format_behind` | this record uses ${see} features that ${format} cannot show; write it as ${see}, or PATCH the field you mean to change | `formatBehind(format, see, rev)` |
| 500 | `internal` | internal error | `internal()` |
| 401 | `unauthorized` | authentication required | `unauthorized()` |
| 401 | `token_invalid` | *(caller-supplied -- this function's own `message` parameter)* | `tokenInvalid(message)` |
| 400 | `invalid_client_version` | invalid 'X-Client-Version' header '${raw}' (expected <= 64 chars of [A-Za-z0-9._+/:-]) | `invalidClientVersion(raw)` |
| 503 | `identity_unavailable` | could not verify identity with Discord | `identityUnavailable(retryAfter)` |
| 403 | `not_owner` | you don't own a layout named '${name}' | `notOwner(name, owner)` |
| 403 | `not_admin` | admin only | `notAdmin()` |
| 400 | `invalid_name` | *(caller-supplied -- this function's own `message` parameter)* | `invalidName(name, message)` |
| 400 | `if_match_required` | an 'If-Match' header naming the record's current rev is required | `ifMatchRequired()` |
| 409 | `stale` | record is at rev ${record.rev}, not the version you edited | `stale(record, lastWrite)` |
| 409 | `last_admins` | removing this admin would leave fewer than 2 admins | `lastAdmins(count)` |
| 400 | `unsupported_for_format` | '${verb}' is not supported for format '${format}' | `unsupportedForFormat(format, verb)` |
| 401 | `bad_signature` | the client signature is missing or invalid | `badSignature()` |
| 401 | `unknown_client` | unknown client | `unknownClient()` |
| 401 | `client_revoked` | this client has been revoked | `clientRevoked()` |
| 401 | `stale_timestamp` | request timestamp is outside the accepted window | `staleTimestamp(skew)` |
| 401 | `replay` | nonce already used | `replay()` |
| 403 | `actor_not_allowed` | this client may not act as this user | `actorNotAllowed(actor, owner)` |
| 409 | `too_many_webhooks` | at most ${limit} webhooks per user | `tooManyWebhooks(limit)` |
| 503 | `stream_unavailable` | the change stream is not available on this deployment | `streamUnavailable()` |
| 409 | `import_paused` | the cmini import is paused (POST /v1/admin/import/resume first) | `importPaused()` |
| 429 | `rate_limited` | rate limit exceeded: ${limit} writes per ${windowSeconds}s | `rateLimited(limit, windowSeconds, retryAfter, scope)` |

**Two more codes exist in the *format* layer**, not in the table above
because they come from a format module's own `validate()`, not one of
`errors.ts`'s factories — both always `400`:

- `invalid_payload` — the format's `validate()` refused the payload, with a
  JSON-pointer `path` naming exactly where
  (`db/tests/conformance/layouts-write/patch-400-invalid_payload.json`):
  `{"error":"invalid_payload","message":"fingermap names a char not in this layout's keys: \"z\"","path":"/keys/z"}`.
- `magic_collision` — two lowered magic rows fire on the same trigger; `from`
  names both sources, `hint` (when one side is a scaffold row) suggests the
  `except` fix (`design/layout-db/01-format.md` §3 "D4").

Every route × status pair above has a frozen conformance fixture under
`db/tests/conformance/` — read the one for your exact case for a byte-exact
body shape.

## 7. For format authors

`spark/1` is not the only shape this service can ever hold — a new format,
or a new major of `spark/1` itself, is a normal (reviewed) addition, not a
rewrite. The contract every registered `FormatModule` satisfies
(`db/formats/registry.ts`):

### Every stored format exports

- `id`: the format's own id, `"<name>/<major>"` (e.g. `"spark/1"`).
- `owner`: a plain string — who reviews changes here (shown at `GET
  /v1/formats`).
- `description`: a plain string, shown at `GET /v1/formats` too.
- `schema`: the JSON Schema (draft 2020-12) object served at `GET
  /v1/formats/{name}/{N}/schema.json`.
- `role`: `"stored"` (a write may store this format) or `"output"`
  (produced on read only; a write naming it is `400 format_not_writable`).
- `validate(p)`: pure, never throws — `{ok: true}` or `{ok: false, error}`.
- `to`: `Record<string, (p) => Payload | Held>` — cross-lineage
  translations reachable *from* this format (e.g. `spark/1`'s own
  `to["mana2/1"]`); the registry's `translate()`/`path()` dispatch through
  this map plus the chain (below).
- `from`: `Record<string, (p) => Payload>` — declared for symmetry with `to`
  and checked by `chainViolations` (neither map may name the module's own
  lineage), but not itself dispatched by the registry's read path today —
  translation only ever runs *into* a format via that format's own `to`,
  never out of one via `from`.
- `hasMagic(p)`: pure, `boolean`.

`edits` (PATCH helpers: `setFingermap?`, `setBoard?`, `setMagic?`) is the
one contract member that is optional at major 1 (unused there — spark/1's
own `edits` is exported anyway, but a stub major-1 module may omit it, `db/
tests/formats/stub-lineage.ts`'s `T1`) and required from major 2 onward,
alongside `up`/`down` — the three below.

### Additionally, for a major > 1 of an existing lineage

- `up(p)`: `<lineage>/<N-1> -> <lineage>/<N>`. Never held — a stored
  record's payload always fits its lineage's later majors, by construction.
- `down(p)`: `<lineage>/<N> -> <lineage>/<N-1> | Held`. **Down is held or
  lossless** — held whenever *anything* would be lost going down a major,
  never a silent, documented-lossy projection the way a *cross-lineage*
  translation (`to`/`from`) may be. The round-trip properties a chain must
  satisfy: `down(p)` is held or `up(down(p)) === p` (down is honest); for a
  fixture `q` at `N-1`, `up(q)` never holds, always validates at `N`, and
  `down(up(q)) === q` (up is injective).
- `edits`: required, not optional, once major > 1 (the PATCH pipeline needs
  somewhere to apply a `board`/`magic`/`fingermap` edit against the stored
  major).

`chainViolations(mod)` (`db/formats/registry.ts`) is the one runtime check
of all of this: for `major(mod.id) > 1`, the previous major of the same
lineage must already be registered and `up`/`down`/`edits` must all be
present; `to`/`from` may never name the module's own lineage, at any major.
`db/tests/formats/chain.test.ts` proves both directions — every real
registered module (`spark/1`, `mana2/1`, each major 1 today) has zero
violations, **and** a deliberately-broken stub lineage
(`db/tests/formats/stub-lineage.ts`'s `t/1 -> t/2 -> t/3`, missing `up`,
missing `down`, missing `edits`, a lineage gap, a self-lineage edge) is
caught by name for each broken piece — the same fixtures this guide's own
`LDB-G10` test reads to keep this checklist honest (§9's own note).

### Adding a new format

A registered format is one directory:

```
db/formats/<name>/<major>/
  schema.json      JSON Schema for the payload (draft 2020-12)
  index.ts         exports the FormatModule contract above
  fixtures/        frozen: NNN-<name>.json (+ .lowered.json goldens, + .<to-format>.json per declared translation)
  OWNERS           GitHub handles who review changes here
  README.md        what this format is for, what it cannot express
```

Wiring: add the module to the `REGISTRY` array in `db/formats/registry.ts`
— that one array is the whole registration; `GET /v1/formats`, the write
path's `resolveFormat`, and the package's `exports` map
(`db/tests/tools/package.test.ts`, `LDB-G7`) all derive from it, so nothing
else needs to learn the new id by name. Tests that must pass before it
merges: every fixture validates and round-trips through its own
`.lowered.json` golden (`LDB-F1`/`F2`); every declared translation
reproduces its frozen `.<to>.json` golden (`LDB-F7`); once merged, the
format is frozen — no schema tightening, no fixture edits, ever
(`LDB-F6`). A stored format that carries magic needs its own compile step
(spark's own `compileMagic`) named and tested the same way spark's is
(`LDB-F2`); one that reaches major 2 needs the chain contract above
(`LDB-F18`/`F19`).

### Adding a new major of an existing format

Same directory shape, one major up (`db/formats/<name>/<N>/`), plus `up`/
`down`/`edits` as above. The previous major's directory is never touched —
its fixtures are frozen (`LDB-F6`) and its `up`/`down` steps are what every
older-stored record chains *through*, not around. Once the new major is
registered:

- the nightly dump gains a new per-major file,
  `latest.<name>-<N>.json` (+`.sha256`), alongside the older major's own —
  never replacing it (`LDB-D6`, §4 above).
- a `PUT` naming the older major is chained up to the new latest
  automatically (`detail.written_as` records what was actually sent), or
  refused `409 format_behind` first if the record's current content could
  never have been read whole in that older major (§5).

### Lowering to `mana2/1`

`spark/1`'s `to["mana2/1"]` (named export `fromSpark`,
`db/formats/mana2/1/translate.ts`) is what `?as=mana2/1` and the analyzer
pipeline both call. **It must never hold for a valid `spark/1` payload**
(`LDB-F17`) — the held cases documented on `mana2/1`'s own README are all in
the *other* direction (`mana2/1 -> spark/1`, a tap-hold token, a directional
token, more than five keys on one thumb, a non-empty `combos`, a rowstag
stagger mismatch): mana2's own vocabulary is a strict subset of what
`spark/1` can express on the way down, never a lossy write target on the way
up. What may genuinely be *absent* on the mana2 side without holding: an
empty layout emits a single empty-string `fingers` row (mana2's own schema
requires ≥ 1); `magic` intent is flattened to `magic.rules[]` (the idiom is
gone, the rows are not — this is the whole point of "lowering", §3 above).
Test it against the real mana2 loader, not a re-implementation of its rules:
`scripts/check-convert-parity.mjs` runs the site's own compiled engine
(`swapengine.convertLayout`) over every fixture and freezes a snapshot
(`tests/fixtures/mana2-convert/`); `mana2-convert-parity.test.ts` then
compares this format's own `to["mana2/1"]` against that snapshot with no
wasm needed at test time. `mana2.test.ts` round-trips every vendored mana2
file and every hand-written fixture through `mana2/1 -> spark/1 -> mana2/1`
under `normalizeMana2()` (LDB-F5's mana2 half), and separately proves the
`spark/1 -> mana2/1 -> spark/1` direction (LDB-F12 checks the DB's own
converter against the site's real wasm-compiled engine, not a duplicate
implementation).

## 8. For clients moving to a new major

**Detecting a new major**: `GET /v1/formats` carries `lineage`, `major`, and
`latest` per registered format (§3) — a client that keeps `spark/1` pinned
sees `latest: false` the day a `spark/2` registers and `spark/1` no longer
is. The other signal is reactive: a `PUT` you send in your pinned major
starts coming back `409 format_behind` the moment the record you're editing
has grown content the older major cannot show (§5).

**What keeps working while you migrate**: reads via `?as=<your old major>`
keep answering exactly what they always did, until the record's content
genuinely outgrows that major (then `held`, same as any cross-format
translation gap, §3); writes in the old major keep being accepted — they
are chained up to the new latest transparently, with
`detail.written_as` on the event naming what you actually sent, so your
existing write path needs no code change to keep functioning, only an
eventual read-side upgrade. `held`/`format_behind` are the same signal
from two sides of one fact: "the record's real content can no longer be
shown whole in your major" — treat either as "read (and, for a write, write)
the newer major for this one record" rather than a hard failure.

**The switch, once you're ready**: start reading `?as=<new major>` (or drop
`?as=` entirely if the new major is now the default), start sending
`format: "<new major>"` on writes, and drop your old `?as=`/`format=` calls
once nothing you talk to still needs the old shape. There is no server-side
flag to flip — the chain (§7) makes both majors simultaneously readable for
as long as you need.

**Testing it**: the per-major dump files (§4) let you fetch every record's
payload as of a specific major directly, without walking `?as=` one id at a
time — compare your new-major reader against `latest.<lineage>-<old
N>.json` and `latest.<lineage>-<new N>.json` side by side. Before any real
second major exists, the stub lineage `db/tests/formats/stub-lineage.ts`'s
`t/1 -> t/2 -> t/3` (exercised by `db/tests/formats/chain.test.ts`) is the
concrete worked example of everything in this section — every property
above (`format_behind`, chained writes, `written_as`, held-vs-lossless
`down`) is proven there today, against fixtures, well before `spark/1`
itself ever needs a second major.

## 9. The endpoint table

One row per public route, method and path exactly as the router defines
them (`db/src/index.ts` + `db/src/routes/*.ts`; a `:param` segment is a
path parameter, not literal text). `auth`: `none` (no header needed),
`user` (Discord bearer or client lane, §1), `client` (client lane only —
none of today's routes require this), `admin` (either lane, but the
resolved actor must be an admin). This table is machine-checked against the
live router (`db/tests/tools/docs-site.test.ts`'s `LDB-G10`) — it cannot
silently drift from what `db/src/index.ts` actually registers.

| METHOD | PATH | auth | body | success | errors |
|---|---|---|---|---|---|
| GET | `/v1/meta` | none | — | 200 | — |
| GET | `/v1/me` | none (401 if unauthenticated) | — | 200 | `unauthorized`, `token_invalid`, lane errors |
| GET | `/v1/layouts` | none | — | 200 | `bad_request` |
| GET | `/v1/layouts/:ref` | none | — | 200 | `unknown_format`, `held`, `not_found` |
| GET | `/v1/layouts/:ref/likes` | none | — | 200 | `not_found` |
| GET | `/v1/layouts/:ref/history` | none | — | 200 | `not_found` |
| GET | `/v1/layouts/:ref/rev/:n` | none | — | 200 | `bad_request`, `unknown_format`, `held`, `not_found` |
| POST | `/v1/layouts` | user | `{name, format, payload}` | 201 | `bad_request`, `invalid_name`, `unknown_format`, `format_not_writable`, `invalid_payload`, `magic_collision`, `name_taken`, lane errors |
| PUT | `/v1/layouts/:ref` | user | `{format, payload}` + `If-Match` | 200 | `if_match_required`, `bad_request`, `unknown_format`, `format_not_writable`, `format_behind`, `invalid_payload`, `magic_collision`, `not_owner`, `not_found`, `stale`, lane errors |
| PATCH | `/v1/layouts/:ref` | user | one or more of `{name, fingermap, board, magic}` + `If-Match` | 200 | `if_match_required`, `invalid_name`, `invalid_payload`, `unsupported_for_format`, `not_owner`, `not_found`, `name_taken`, `stale`, lane errors |
| DELETE | `/v1/layouts/:ref` | user | — + `If-Match` | 200 | `if_match_required`, `bad_request`, `not_owner`, `not_found`, `stale`, lane errors |
| POST | `/v1/layouts/:ref/restore` | user | `{name?}` (optional) | 200 | `bad_request`, `invalid_name`, `not_owner`, `not_found`, `name_taken`, lane errors |
| POST | `/v1/layouts/:ref/transfer` | user | `{to}` + `If-Match` | 200 | `if_match_required`, `bad_request`, `not_owner`, `not_found`, lane errors |
| PUT | `/v1/layouts/:ref/like` | user | — | 200 | `not_found`, lane errors |
| DELETE | `/v1/layouts/:ref/like` | user | — | 200 | `not_found`, lane errors |
| GET | `/v1/authors` | none | — | 200 | `bad_request` |
| GET | `/v1/authors/:user_id` | none | — | 200 | `not_found` |
| GET | `/v1/formats` | none | — | 200 | — |
| GET | `/v1/formats/:name/:major/schema.json` | none | — | 200 | `not_found` |
| GET | `/v1/changes` | none | — | 200 | `bad_request`, `not_found` |
| GET | `/v1/changes/stream` | none | — | 200 (SSE) | `stream_unavailable`, `bad_request`, `not_found` |
| GET | `/admin/changelog` | none | — | 200 (HTML) | `bad_request`, `not_found` |
| GET | `/v1/dump` | none | — | 302 | `not_found` |
| GET | `/v1/dump/latest.json` | none | — | 200 | `not_found` |
| GET | `/v1/dump/monthly/:key` | none | — | 200 | `not_found` |
| GET | `/v1/dump/:key` | none | — | 200 | `not_found` |
| POST | `/v1/webhooks` | user | `{url, secret, kinds?, owner_filter?}` | 201 | `bad_request`, `too_many_webhooks`, lane errors |
| GET | `/v1/webhooks` | user (`admin` with `?all=1`) | — | 200 | `not_admin`, lane errors |
| DELETE | `/v1/webhooks/:id` | user | — | 200 | `not_found`, lane errors |
| GET | `/v1/admin/admins` | admin | — | 200 | `not_admin`, lane errors |
| POST | `/v1/admin/admins` | admin | `{user_id, note?}` | 200/201 | `bad_request`, `not_admin`, lane errors |
| DELETE | `/v1/admin/admins/:user_id` | admin | — | 200 | `not_admin`, `last_admins`, lane errors |
| POST | `/v1/admin/import/pause` | admin | — | 200 | `not_admin`, lane errors |
| POST | `/v1/admin/import/resume` | admin | — | 200 | `not_admin`, lane errors |
| POST | `/v1/admin/import/tick` | admin | — | 200 | `not_admin`, `import_paused`, lane errors |
| POST | `/v1/admin/diff/tick` | admin | — | 200 | `not_admin`, lane errors |
| POST | `/v1/admin/nightly/tick` | admin | — | 200 | `not_admin`, lane errors |
| POST | `/v1/admin/clients` | admin | `{name, pubkey, owner_user_id, caps, discord_app_id?}` | 201 | `bad_request`, `not_admin`, lane errors |
| DELETE | `/v1/admin/clients/:id` | admin | — | 200 | `not_admin`, `not_found`, lane errors |
| GET | `/v1/admin/clients` | admin | — | 200 | `not_admin`, lane errors |
| POST | `/v1/admin/drill` | admin | `{ok, detail?}` | 200 | `bad_request`, `not_admin`, lane errors |
| GET | `/v1/admin/health` | admin | — | 200 | `not_admin`, lane errors |

"lane errors" (every `user`/`admin`/`client` row) means whichever lane you
used: the user lane can answer `unauthorized`/`token_invalid`/
`identity_unavailable`; the client lane can answer `bad_signature`/
`unknown_client`/`client_revoked`/`stale_timestamp`/`replay`/
`actor_not_allowed`; either lane can answer `rate_limited`. §6's table has
every one of them with its exact body shape.
