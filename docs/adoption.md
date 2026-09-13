# Adopting the layout database API

A guide for a new client of `akl-db` — a Discord bot, a web app, a script,
or an AI agent building any of those — written to be followed by a human or
handed whole to an agent. Every claim below names the source file it comes
from; every request/response shown is either a real conformance fixture
(`db/tests/conformance/`, trimmed) or built directly from the same error
factory / schema the server runs, never invented. A fenced block marked
` ```json spark-payload ` is a literal `spark/1` payload, checked by
`db/tests/tools/adoption-examples.test.ts` against the real `validate()`.

```
production   https://api.akldb.org   <- the one layoutdb
```

There is one layoutdb, production. Develop against production, and ask
before writing there.

## 0. Quickstart

One short example per basic operation. `?format=` is required on every
route that returns a payload — there is no default, and omitting it is
`400 format_required`. Full mechanics for each are in the sections named
below.

**1. Read a layout** — no auth, ever (§3):

```bash
curl -s 'https://api.akldb.org/v1/layouts/io?format=spark/1'
```

**2. List / search** — no auth, ever; filters and paging in §3:

```bash
curl -s 'https://api.akldb.org/v1/layouts?format=spark/1&sort=modified_at&limit=20'
```

**3. Write as a signed-in user** — hold their Discord access token
server-side (scope `identify`), proxy the write through your backend (§1.2,
§5):

```bash
TOKEN='<discord access token>'
curl -sX POST https://api.akldb.org/v1/layouts -H "Authorization: Bearer $TOKEN" \
  -H 'X-Client-Version: my-app/1.0' \
  -d '{"name":"my-layout","format":"spark/1","payload":{"keys":[],"board":"ansi"}}'
# 201 {"id":"...", "formats":{"spark/1":{"rev":1,"..."}}, ...}; to edit later,
# read the layout for its current rev, then:
curl -sX PUT https://api.akldb.org/v1/layouts/<id> -H "Authorization: Bearer $TOKEN" \
  -H 'If-Match: "spark:<rev>"' \
  -d '{"format":"spark/1","payload":{"keys":[],"board":"ansi"}}'
```

**4. Read, then write, as a trusted client** — an Ed25519 keypair stands in
for a Discord token (§1.1, §2.1). This builds the five signed headers
exactly as the Worker verifies them, then `PUT`s the layout back unchanged
(a real edit would change `payload` first):

```js
// Node 20+ (Web Crypto is a global); no Buffer, so this runs in a Worker too.
const CLIENT_ID = "<client id>";
const CLIENT_PRIVATE_KEY = "<base64url pkcs8 private key>"; // bot/scripts/gen-key.mjs mints one
const LAYOUT = "<id-or-name>";
const ACTOR = "<discord user id>";

const b64url = (b) => btoa(String.fromCharCode(...b)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const unb64url = (s) => Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0));

async function signedFetch(method, pathWithQuery, bodyText, extraHeaders = {}) {
  const key = await crypto.subtle.importKey("pkcs8", unb64url(CLIENT_PRIVATE_KEY), { name: "Ed25519" }, false, ["sign"]);
  const bodyHash = b64url(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(bodyText ?? ""))));
  const timestamp = String(Math.floor(Date.now() / 1000));
  const nonce = b64url(crypto.getRandomValues(new Uint8Array(16)));
  const signingString = `akl-v1\n${method}\n${pathWithQuery}\n${timestamp}\n${nonce}\n${ACTOR}\n${bodyHash}`;
  const signature = b64url(new Uint8Array(await crypto.subtle.sign("Ed25519", key, new TextEncoder().encode(signingString))));
  return fetch(`https://api.akldb.org${pathWithQuery}`, {
    method,
    headers: { "X-Akl-Client": CLIENT_ID, "X-Akl-Timestamp": timestamp, "X-Akl-Nonce": nonce,
               "X-Akl-Actor": ACTOR, "X-Akl-Signature": signature, ...extraHeaders,
               ...(bodyText ? { "Content-Type": "application/json" } : {}) },
    body: bodyText,
  });
}

const current = await (await fetch(`https://api.akldb.org/v1/layouts/${LAYOUT}?format=spark/1`)).json();
const rev = current.formats["spark/1"].rev;
const body = JSON.stringify({ format: "spark/1", payload: current.payload });
const res = await signedFetch("PUT", `/v1/layouts/${LAYOUT}`, body, { "If-Match": `"spark:${rev}"` });
```

The signature itself is checked against `db/tests/vectors/client-signing.json`
(§2.1) — build your signer against that file and you know it's correct
before ever calling the live service.

**5. Regular poll** — no auth; cache the `ETag` to skip empty answers (§4):

```bash
curl -sD - -o /dev/null 'https://api.akldb.org/v1/changes?since=0&limit=100'   # note the ETag header
curl -s -o /dev/null -w '%{http_code}\n' -H 'If-None-Match: "<etag from above>"' \
  'https://api.akldb.org/v1/changes?since=0&limit=100'   # 304 once nothing changed
```

**6. Long poll** — a registered client only, signed the same way as #4; the
Worker holds the request open instead of you polling on a timer (§4):

```bash
curl -s 'https://api.akldb.org/v1/changes?since=<seq>&wait=25' \
  -H 'X-Akl-Client: <client id>' -H 'X-Akl-Timestamp: <unix seconds>' \
  -H 'X-Akl-Nonce: <16 random bytes, base64url>' -H 'X-Akl-Actor: <discord user id>' \
  -H 'X-Akl-Signature: <base64url ed25519 signature>'
```

**7. Like / unlike** — needs an authenticated actor, never an `If-Match`
(§5):

```bash
curl -sX PUT https://api.akldb.org/v1/layouts/<id>/like -H "Authorization: Bearer $TOKEN"      # 200 {"like_count":1}
curl -sX DELETE https://api.akldb.org/v1/layouts/<id>/like -H "Authorization: Bearer $TOKEN"   # 200 {"like_count":0}
```

**8. Head sequence** — the cheapest poll of all, no auth (§4):

```bash
curl -s https://api.akldb.org/v1/meta
```

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
`source: { client, version }`. `client` is **proven**, never a header or
body field you control: `` `client:<your client id>` `` on the client lane, `` `discord-app:<your
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
`owner_user_id` you'll act for by default, and the `caps` you need. `caps`
is a comma-separated set (LEDGER.md L4): exactly one SCOPE cap —
`act-as-user` to assert any Discord user id (a real multi-user bot), or
`act-as-owner-only` to assert only your own `owner_user_id` (a personal
script). Every registered client may long-poll `GET /v1/changes?wait=`
(§4); no extra cap is needed. The admin runs:

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
  https://api.akldb.org/v1/me
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

### 2.3 Becoming a trusted client

The client lane (§2.1) is for a program that already trusts its own source
of Discord identities — a bot reading `message.author.id`, an importer, any
automation — and needs to write to akldb *as that user* without ever
holding that user's own Discord token. It buys you two things a bearer
token cannot: acting for a user (or, with `act-as-user`, any user) who
never signed in to your app at all, and long-polling on `GET
/v1/changes?wait=` (§4) instead of polling on a timer.

**Registration is manual — there is no self-service sign-up** (§2.1 has the
full mechanics). To become a trusted client, reach an akldb admin with:

- an Ed25519 public key (raw 32 bytes, base64url) — the private key never
  leaves your host, ever;
- your client's name;
- your Discord application id, if you have one (`discord_app_id`, optional
  — lets an admin cross-reference your bot in Discord's own developer
  portal; it plays no part in verifying any request);
- the Discord user id of whoever maintains this client (`owner_user_id` —
  see §2.1 for what this constrains under `act-as-owner-only`);
- which scope cap you need: `act-as-user` for a real multi-user bot, or
  `act-as-owner-only` for a personal script that only ever acts for
  yourself. Long-polling comes with any registration.

[contact: ask an akldb admin — channel TBD]

The admin runs `POST /v1/admin/clients` (§2.1) and hands back your client
id (`X-Akl-Client` on every signed request from then on). Before calling
the live service, build your signer against
`db/tests/vectors/client-signing.json` (§2.1) and confirm it reproduces
every vector byte for byte — that file, not this guide's prose, is the
interop contract.

## 3. Read (no auth, ever)

```bash
GET /v1/meta
GET /v1/layouts?owner=&format=<REQUIRED>&has_magic=&since=<iso>&liked_by=&sort=&limit=&cursor=
GET /v1/layouts?full=1&format=<REQUIRED>          # every live record, streamed
GET /v1/layouts/{ref}?format=<REQUIRED>            # {ref} = id (ULID) or name, case-insensitive
GET /v1/layouts/{ref}/likes
GET /v1/layouts/{ref}/history?format=<optional filter>
GET /v1/layouts/{ref}/rev/{n}?format=<REQUIRED>
GET /v1/authors
GET /v1/authors/{user_id}
GET /v1/formats
GET /v1/formats/{name}/{N}/schema.json
```

**A layout can hold several formats at once** (`spark/1` today; a future
`lw/1` for layouts.wiki, §7's own worked example). `formats` on every
layout response lists every format it actually has stored — id, rev,
timestamps, `has_magic`, `source` — but returns no `payload` there; to read
a payload you name exactly which format with `?format=<format id>`. **This
is required everywhere a payload is returned — there is no default**
(`400 format_required` without one; `/history` is the one deliberate
exception, an optional filter, absent meaning "every event"). Two formats
are registered today:

- **`spark/1`** — the one *stored* shape: cmini's `keys` map, board
  geometry, and an authoring shape for magic rules that keeps intent
  (`magic_keys`/`chiral_keys`/`adaptive_swaps`), not flattened rows.
- **`mana2/1`** — an **output-only, derived** shape: a mana2 `.jsonc`
  layout object (`layout.fingers`/`thumbs` row strings, `board`, flat
  `magic.rules[]`). Never stored — derived from whichever ONE stored
  format is registered to reach it (`spark/1` today; §7's "For format
  authors" has the mechanics) on every read that asks for it explicitly.
  Never written (`400 format_not_writable`, §5).

Real detail response (`db/tests/conformance/layouts-detail/200.json`,
trimmed, `?format=spark/1`):

```json
{
  "id": "01ARZ3NDEKTSV4RRFFQ69G5FAV", "name": "io",
  "owner": "761732338744557568", "layout_rev": 1,
  "created_at": "2022-12-07T23:24:35Z", "modified_at": "2022-12-07T23:24:35Z",
  "deleted": false, "like_count": 15,
  "upstream": { "source": "cmini", "id": "io", "state": "following" },
  "formats": {
    "spark/1": { "rev": 1, "created_at": "2022-12-07T23:24:35Z",
                 "modified_at": "2022-12-07T23:24:35Z", "has_magic": false,
                 "source": { "client": "system:cmini-import", "version": null } }
  },
  "format": "spark/1",
  "payload": { "keys": { "a": { "row": 1, "col": 6, "finger": "RI" }, "…": "…" },
               "board": { "kind": "ortho", "cmini": "ortho" } },
  "likes": ["184412255822020608", "…"]
}
```

`layout_rev` moves on a layout-level write (rename, transfer, delete,
restore); each entry under `formats` moves on a write to THAT format only
(§5's `If-Match` scopes on exactly this split). There is no single top-level
`rev` any more — a layout can have several independently-versioned formats.

**Asking for `mana2/1`** derives it on the fly (never writes, never caches)
and names its source:

```json
{ "…layout fields…", "formats": { "spark/1": { "…": "…" } },
  "format": "mana2/1", "derived_from": "spark/1",
  "payload": { "layout": { "fingers": ["…"], "…": "…" } } }
```

`derived_from` is present only when the format you asked for isn't one the
layout actually stores. **A layout that doesn't have (and can't derive) the
format you asked for** is `404 format_absent` — not `held`; `held` is a
narrower, same-lineage case (a format that lineage COULD show but this
particular record's content is too new for, §8):

```json
404 { "error": "format_absent", "format": "lw/1",
      "message": "this layout has no 'lw/1' format" }
409 { "error": "held", "held": true, "message": "record cannot be translated to 'spark/1'",
      "format": "spark/1", "see": "spark/2" }
```

`?full=1&format=<format>` streams every live record; a held one there
carries `held: true` and its record fields, no `payload`, instead of
erroring the whole response. `GET /v1/formats` is the registry itself,
machine-readable (`db/tests/conformance/formats-list/200.json`, trimmed):

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
in use (see below). `can_translate_to` is the full reachable set — for an
output format this is always exactly the empty set (nothing translates OUT
of a derived format); **each output format is itself reachable from exactly
one stored lineage** (`spark/1` -> `mana2/1` today) — a second stored
lineage wanting to reach the same output format needs a way to name which
one you mean, not designed yet, so it can't happen silently. `GET
/v1/formats/{name}/{N}/schema.json` serves the literal JSON Schema (draft
2020-12) a payload must satisfy — validate client-side against it before
ever sending a write, the same schema the server itself runs
(`db/scripts/validate-akl1-payload.mjs` is a Node CLI shim over the exact
same `validate()`; the script's own name is historical, it validates
against `spark/1`'s current schema).

**No more `akl/1` alias, no more `?as=`.** `spark/1` is `akl/1` renamed —
same payload shape, byte for byte (`design/layout-db/20-spark.md` decision
1). `akl/1` worked as a transitional alias while the bot, the preview site
and publish-ux moved to `spark/1`'s own name; `21-formats.md` D5/D12
deleted the alias mechanism entirely once every client had (2026-09-11).
`format=akl/1` (query or body) now answers/refuses exactly like any other
unregistered format id (`400`/`404 unknown_format`, §6's error table).
`21-formats.md` D4 additionally renamed the query parameter itself: `?as=`
is gone, `?format=` is the one name everywhere, and it is now **required**
(§3 above) rather than defaulting to `spark/1` — there is no relabeling,
and `format` in a response always equals exactly what you asked for (the
layout's own stored data if it has that format, `derived_from` naming the
real source if it doesn't and the format is derivable, or `404
format_absent` if neither). **Every client reads and writes `spark/1` by
name, explicitly, every time.**

**`history` and `rev/{n}` carry `source` too** — per-event provenance, not
just per-record (`db/tests/conformance/layouts-history/200.json`, trimmed).
`format` on an event names which scope it touched: `null` for a
layout-level event (`rev` is then that write's `layout_rev`), or a format
id for a format-scope event (`rev` is then that format's own rev):

```json
[ { "seq": 258, "format": "spark/1", "rev": 1, "at": "2026-06-01T00:00:00.000Z",
    "actor": "system:cmini-import", "via": "import:cmini", "kind": "format_added",
    "admin": false, "source": { "client": "system:cmini-import", "version": null } },
  { "seq": 259, "format": null, "rev": null, "kind": "liked", "…": "…" } ]
```

## 4. Stay current

**The change feed is ground truth** — a poll or a dump are shortcuts around
it, never a second source of truth.

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
    "owner": "621924065581465611", "format": null, "rev": 1,
    "actor": "system:cmini-import", "via": "import:cmini", "admin": false,
    "detail": { "source": "cmini", "upstream_id": "00------higgs" },
    "before": null,
    "after": { "scope": "layout", "id": "01ARZ3NDEKTSV4RRFFQ69G5FAV",
               "name": "00------higgs", "layout_rev": 1,
               "upstream": { "id": "00------higgs", "source": "cmini", "state": "following" },
               "source": { "client": "system:cmini-import", "version": null }, "…": "…" },
    "source": { "client": "system:cmini-import", "version": null } },
  { "seq": 2, "at": "2026-06-01T00:00:00.000Z", "kind": "imported",
    "layout_id": "01ARZ3NDEKTSV4RRFFQ69G5FAV", "name": "00------higgs",
    "owner": "621924065581465611", "format": "spark/1", "rev": 1,
    "actor": "system:cmini-import", "via": "import:cmini", "admin": false,
    "before": null,
    "after": { "scope": "format", "layout_id": "01ARZ3NDEKTSV4RRFFQ69G5FAV",
               "lineage": "spark", "format": "spark/1", "rev": 1, "has_magic": false,
               "source": { "client": "system:cmini-import", "version": null }, "…": "…" },
    "source": { "client": "system:cmini-import", "version": null } } ] }
```

**Folding events**: `format` on a rev-bumping event says which scope it
touched — `null` is layout-level (bumps `layout_rev`; `after` is
`{scope: "layout", …}` — name/owner/deletion/`upstream`, no payload), a
format id is that format's own scope (bumps that format's `rev`; `after` is
`{scope: "format", …}` — that ONE format's rev/timestamps/`has_magic`/
payload-implying fields, never another format's). A new layout always appends TWO events in the same batch, one per scope —
`created` (layout) + `format_added` (format) for a client's `POST
/v1/layouts`, or `imported` on both scopes for one the cmini import
creates — apply both to build the full local copy of a brand-new layout. Read the payload for a given rev via
`/rev/{n}?format=<that format>` if you keep payloads, or just re-`GET` the
record with `?format=` — `after` alone is enough to know *that* something
changed and on which scope. `liked`/`unliked` move only `like_count` by ±1
(layout-scope, no rev bump) -- `like_count` is never part of any event's
own `after` either (a writer's own read of it can go stale; keep your own
running tally from `liked`/`unliked` events alone if you mirror it, the
same way `foldLayout` does server-side); everything else
(`upstream_changed`, `import_conflict`, `import_error`, `admin.*`) is
informational and changes nothing in your local copy.

**Long-poll** (LEDGER.md L4; replaces the retired SSE stream and webhooks):
`GET /v1/changes?since=<seq>&wait=<seconds>` — when `wait` is present, the
Worker holds the request open, checking the event head about once a
second, and answers with the normal `/v1/changes` page as soon as `since`
is exceeded or `wait` elapses (whichever first; `wait` is clamped to 25s).
`wait` is honoured for any request signed on the client lane (§2 above) —
every registered client, no extra cap; any
other caller naming `wait` gets the immediate, unheld answer, plus a
response header `X-Wait-Ignored: unauthorized` (never an error). A held
request still counts against your client's normal rate limit (§4). Poll
`since=` without `wait` (the default, unauthenticated behavior) for the
same immediate, `Cache-Control`-able page every other client gets.

**The nightly dump** (`GET /v1/dump/latest.json`, written 03:00 UTC) is the
full state — every table (including `layout_formats`, one row per format a
layout stores), the **whole** event log, not a tail:

```json
{ "date": "2026-06-01", "key": "dump-2026-06-01.json.gz",
  "url": "/v1/dump/dump-2026-06-01.json.gz", "sha256": "…",
  "bytes": 1240439, "layout_count": 4176, "seq": 6213 }
```

`seq` is a **floor, never a ceiling**: the dump reads `meta` (and its
`seq`) strictly before any table, so every table may carry a write or two
past that `seq` but never one *behind* it — booting from the dump then
draining `/v1/changes?since=<seq>` always reaches exactly the live state,
with no gap.

**`upstream` is transitional — do not build on it.** Every record carries a
top-level `upstream: {source: "cmini", id, state: "following" | "forked"} |
null` field, folded from the cmini-import events. It answers exactly one
question — "does the importer still own this record's keys and board" — for
exactly as long as the one-time cmini import keeps running
(`design/layout-db/20-spark.md` decision 16). There is no general
layout-from-layout fork concept here, no re-follow, and nothing outside the
importer and the daily upstream diff reads it for any decision. **Follow
state is layout-level**: a write to the layout itself, or to lineage
`spark` specifically, forks it (user write) or keeps it following (import
write); a write to any OTHER format (`lw/1`, say) never touches `upstream`
at all. When the import is retired the field, its rule, and
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
POST   /v1/layouts                  { name, format, payload }                      → 201
PUT    /v1/layouts/{ref}            { format, payload }        If-Match (replace)   → 200
                                                                 If-None-Match: * (add) → 200
PATCH  /v1/layouts/{ref}            { name } If-Match: "layout:<n>"                 → 200
                                     { format, fingermap?/board?/magic? } If-Match: "<lineage>:<n>" → 200
DELETE /v1/layouts/{ref}                                    If-Match: "layout:<n>" → 200 (tombstone)
POST   /v1/layouts/{ref}/transfer   { to }                  If-Match: "layout:<n>" or * → 200
POST   /v1/layouts/{ref}/restore    { name? }  (owner or admin, no time limit)      → 200
PUT / DELETE /v1/layouts/{ref}/like                                                 → 200 { like_count }
```

**Every write carries `X-Client-Version`** (§1.3) — not required by the
schema, but every example below sends one, and you should too.

**Two independent scopes per layout** (§3): a **layout-scope** write
(rename, transfer, delete, restore) touches name/owner/deletion and nothing
else; a **format-scope** write (`PUT`, or a `PATCH` naming `format`) touches
exactly ONE format's payload/rev/`has_magic` and nothing else — including no
OTHER format the layout has, and no layout-level field. Each scope has its
own `If-Match` token (§below) and its own rev; a create is the one write
that touches both scopes at once, in a single request.

**`spark/1` payloads.** `payload.keys` maps a one-code-point char to
`{row, col, finger}` (finger ∈ `LP LR LM LI RI RM RR RP LT RT TB`); `free`
is a list of the same shape for board positions that exist but hold no
character; `board` names the geometry (`{kind: "rowstag"|"colstag"|"ortho",
stagger?, cmini?}`); `magic` is optional and carries **intent**
(`magic_keys`/`chiral_keys`/`adaptive_swaps`, plus a raw `rules[]` escape
hatch) — never the flattened rows an analyzer reads (that's what
`?format=mana2/1` is for, §3/§7). Full shape and every validation rule:
`design/layout-db/01-format.md` §2/§2.1; the schema itself:
`GET /v1/formats/spark/1/schema.json`.

**Creating** — one request, two events (layout + format, §4), one response
carrying both (real fixture,
`db/tests/conformance/layouts-write/post-201.json`, shape updated for
several-formats-per-layout):

```bash
curl -sX POST …/v1/layouts -H 'X-Client-Version: my-bot/1.0' <signed-or-bearer> -d '
{"name":"my-layout","format":"spark/1","payload":{"keys":{}}}'
# 201 {"id":"01ARZ3ND…","name":"my-layout","owner":"800000000000000001","layout_rev":1,
#      "created_at":"…","modified_at":"…","deleted":false,"like_count":0,"upstream":null,
#      "formats":{"spark/1":{"rev":1,"created_at":"…","modified_at":"…","has_magic":false,
#                             "source":{"client":"discord-app:app-default","version":null}}},
#      "format":"spark/1","payload":{"keys":{}}}
```

**Scoped `If-Match` and `409 stale`.** Every write against an *existing*
record's SPECIFIC scope — `PUT`/format-`PATCH`/`DELETE`/`transfer`/name-`PATCH`
— **must** carry `If-Match` naming that scope's own token: `"layout:<n>"`
for a layout-scope write, `"<lineage>:<rev>"` (e.g. `"spark:7"`) for a
format-scope write — or `If-Match: *` (overwrite on purpose, stated
explicitly, any scope). A bare unscoped number, or the WRONG scope's token,
is `400 bad_request` — checked before any read. Absent entirely →
`400 if_match_required`. A same-scope mismatch is `409 stale` with the
**winning** record already in the body, naming which scope raced — no
second request needed, just re-apply your change to it and resend with its
current rev:

```json
409 { "error": "stale", "scope": "spark", "message": "'spark' is at rev 2, not the version you edited",
      "rev": 2,
      "record": { "id": "01ARZ3ND…", "layout_rev": 1,
                   "formats": { "spark/1": { "rev": 2, "…": "…" } }, "…": "…" },
      "last_write": { "seq": 439, "at": "…", "actor": "800000000000000001",
                       "via": "discord", "kind": "updated", "admin": false } }
```

A write to one scope never races a write to the OTHER scope of the same
layout — both land (§4's model, `MF-6`).

**`PUT` also ADDS a format the layout doesn't have yet**: send
`If-None-Match: *` instead of `If-Match` to add lineage `body.format` names,
refused `409 format_exists` if the layout already has that lineage. With
`If-Match` instead, `PUT` REPLACES that format's own payload wholesale
(same scoped-token rules as any other format-scope write); `404
format_absent` if the layout doesn't have that lineage yet (use
`If-None-Match: *` instead to add it).

```json
409 { "error": "format_exists", "format": "spark/1",
      "message": "this layout already has a 'spark/1' format" }
```

**`PATCH` is either `{name}` (layout scope) or `{format, …edits}` (that
format's scope) — never both at once**, one event, one or more edits
applied in the order `fingermap, board, magic`:

```bash
curl -sX PATCH …/v1/layouts/01ARZ3ND… -H 'If-Match: "spark:1"' <signed> \
  -d '{"format":"spark/1","fingermap":{"a":"LM"}}'
# 200 {"…","format":"spark/1","payload":{"keys":{"a":{"col":1,"finger":"LM","row":1}}}}
```

A `{name}` body writes a `renamed` event (layout scope, `If-Match:
"layout:<n>"`); a `{format, fingermap}` body a `fingermap` event; anything
else naming `format` (including several edits at once) an `updated` event
with `detail.fields` naming which keys changed. **`{name, format}` (or any
mix of a rename with a format edit) in one body is `400 mixed_patch`** —
they're different scopes with different `If-Match` tokens, so one request
can never mean both:

```json
400 { "error": "mixed_patch", "message": "a PATCH may change the layout's name, or one format's payload, never both at once" }
```

An edit key (`fingermap`/`board`/`magic`) with no `format` named is `400
format_required`; a body with neither `name` nor any edit key at all is
`400 bad_request`.

**`format_behind`** (only matters once a format grows a second major, §8):
a `PUT` naming an older major of that lineage's own is refused with `409
format_behind` when the format, as currently stored, could never have been
read whole in that older major — the same fact a `GET
?format=<older-major>` would answer `held` for. The body shape is the same
as `held` (`format_behind` is `held` from the *writer's* side):

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
limit (tombstones are never pruned), layout-scope only (every format the
layout had is simply untouched — restore/delete never touch
`layout_formats` at all). The body is optional: absent, `{}`, or `{name}`;
anything else is `400 bad_request`. Without `name`, restoring under the
tombstone's own (possibly reclaimed) name is `409 name_taken` with `holder`
exactly as any other name clash; with a *different* `name`, the new name
goes through the same `check_name` rules as a fresh `POST`.

```bash
curl -sX POST …/v1/layouts/01ARZ3ND…/restore <signed>       # no body
curl -sX POST …/v1/layouts/01ARZ3ND…/restore <signed> -d '{"name":"my-layout-v2"}'
```

Real success (`db/tests/conformance/layouts-write/restore-200.json`,
trimmed): `200 {"…","deleted":false,"layout_rev":3}`.

**Likes** — need no `If-Match` (they never bump `layout_rev`/`modified_at`/a
format's own `rev`/`modified_at`, and never fail or are failed by an edit to
the same layout). A repeat like, or an unlike with nothing to undo, is no
longer a silent no-op: it fails loudly and changes nothing, so a client
always knows whether its own request was the one that changed the count:

```bash
curl -sX PUT …/v1/layouts/01ARZ3ND…/like <signed>      # 200 {"like_count":1}
curl -sX PUT …/v1/layouts/01ARZ3ND…/like <signed>      # 409 already_liked (unchanged)
curl -sX DELETE …/v1/layouts/01ARZ3ND…/like <signed>    # 200 {"like_count":0}
curl -sX DELETE …/v1/layouts/01ARZ3ND…/like <signed>    # 409 not_liked (unchanged)
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
| 400 | `format_required` | a 'format' parameter is required | `formatRequired()` |
| 404 | `format_absent` | this layout has no '${format}' format | `formatAbsent(format)` |
| 409 | `format_exists` | this layout already has a '${format}' format | `formatExists(format)` |
| 400 | `mixed_patch` | a PATCH may change the layout's name, or one format's payload, never both at once | `mixedPatch()` |
| 409 | `already_liked` | you've already liked this layout | `alreadyLiked()` |
| 409 | `not_liked` | you haven't liked this layout | `notLiked()` |
| 401 | `unauthorized` | authentication required | `unauthorized()` |
| 401 | `token_invalid` | *(caller-supplied -- this function's own `message` parameter)* | `tokenInvalid(message)` |
| 400 | `invalid_client_version` | invalid 'X-Client-Version' header '${raw}' (expected <= 64 chars of [A-Za-z0-9._+/:-]) | `invalidClientVersion(raw)` |
| 503 | `identity_unavailable` | could not verify identity with Discord | `identityUnavailable(retryAfter)` |
| 403 | `not_owner` | you don't own a layout named '${name}' | `notOwner(name, owner)` |
| 403 | `not_admin` | admin only | `notAdmin()` |
| 400 | `invalid_name` | *(caller-supplied -- this function's own `message` parameter)* | `invalidName(name, message)` |
| 400 | `if_match_required` | an 'If-Match' header naming the record's current rev is required | `ifMatchRequired()` |
| 409 | `stale` | '${scope}' is at rev ${rev}, not the version you edited | `stale(scope, rev, record, lastWrite)` |
| 409 | `last_admins` | removing this admin would leave fewer than 2 admins | `lastAdmins(count)` |
| 400 | `unsupported_for_format` | '${verb}' is not supported for format '${format}' | `unsupportedForFormat(format, verb)` |
| 401 | `bad_signature` | the client signature is missing or invalid | `badSignature()` |
| 401 | `unknown_client` | unknown client | `unknownClient()` |
| 401 | `client_revoked` | this client has been revoked | `clientRevoked()` |
| 401 | `stale_timestamp` | request timestamp is outside the accepted window | `staleTimestamp(skew)` |
| 401 | `replay` | nonce already used | `replay()` |
| 403 | `actor_not_allowed` | this client may not act as this user | `actorNotAllowed(actor, owner)` |
| 409 | `import_paused` | the cmini import is paused (POST /v1/admin/import/resume first) | `importPaused()` |
| 422 | `idempotency_mismatch` | this 'Idempotency-Key' was already used for a different request | `idempotencyMismatch()` |
| 409 | `idempotency_in_progress` | a request with this 'Idempotency-Key' is already being processed | `idempotencyInProgress()` |
| 409 | `import_running` | an import tick is already running (it holds the cmini.running lock) | `importRunning()` |
| 403 | `banned` | this account is banned from writing | `banned()` |
| 409 | `cannot_ban_admin` | an admin cannot be banned | `cannotBanAdmin()` |
| 400 | `invalid_link` | *(caller-supplied -- this function's own `message` parameter)* | `invalidLink(message)` |
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
`db/formats/mana2/1/translate.ts`) is what `?format=mana2/1` and the
analyzer pipeline both call. **It must never hold for a valid `spark/1` payload**
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

### Adding a SECOND stored format alongside spark

A layout can hold several stored formats at once (§3, e.g. a future
`lw/1` for layouts.wiki) — this is a normal addition too, following the
same directory/registry shape above with `role: "stored"`. Two rules keep
derivation unambiguous when more than one stored lineage exists (§4 of
`design/layout-db/21-formats.md`, `MF-10`):

- **Each output format (`mana2/1`) is reachable from exactly one stored
  lineage.** If your new format also wants to reach `mana2/1`, that edge
  can't just be added alongside spark's — two stored lineages both
  claiming the same output edge is a hidden default (which one does a
  bare `?format=mana2/1` mean?) and is refused at the registry level
  (`reachingLineages()` reports both, `outputSourceLineage()` refuses to
  pick one). Reaching `mana2/1` from a second lineage needs an explicit way
  to name the source (a `from=` parameter, not designed yet) — until then,
  a second stored format simply doesn't register a `to["mana2/1"]` edge at
  all.
- **Stored formats are never derived from each other on read.** An edge
  FROM your new format TO `spark/1` (or vice versa), if you write one, is a
  package function your own clients call themselves (`@akl/layout-formats`)
  — layoutdb's `GET …?format=spark/1` always means "this layout's own
  `spark/1` row", never something translated over from another lineage.
  `?format=<your format>` on a layout that never wrote it is `404
  format_absent`, not a silent derivation.

## 8. For clients moving to a new major

**Detecting a new major**: `GET /v1/formats` carries `lineage`, `major`, and
`latest` per registered format (§3) — a client that keeps `spark/1` pinned
sees `latest: false` the day a `spark/2` registers and `spark/1` no longer
is. The other signal is reactive: a `PUT` you send in your pinned major
starts coming back `409 format_behind` the moment the record you're editing
has grown content the older major cannot show (§5).

**What keeps working while you migrate**: reads via `?format=<your old
major>` keep answering exactly what they always did, until the record's
content genuinely outgrows that major (then `held`, same as any
cross-format translation gap, §3); writes in the old major keep being
accepted — they are chained up to the new latest transparently, with
`detail.written_as` on the event naming what you actually sent, so your
existing write path needs no code change to keep functioning, only an
eventual read-side upgrade. `held`/`format_behind` are the same signal
from two sides of one fact: "the record's real content can no longer be
shown whole in your major" — treat either as "read (and, for a write, write)
the newer major for this one record" rather than a hard failure.

**The switch, once you're ready**: start reading `?format=<new major>` and
sending `format: "<new major>"` on writes, and drop your old
`?format=<old major>` calls once nothing you talk to still needs the old
shape (`?format=` is always required, §3 — there is no "default major" to
fall back to by omitting it). There is no server-side flag to flip — the
chain (§7) makes both majors simultaneously readable for as long as you
need.

**Testing it**: the per-major dump files (§4) let you fetch every record's
payload as of a specific major directly, without walking `?format=` one id
at a time — compare your new-major reader against `latest.<lineage>-<old
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
| GET | `/v1/layouts` | none | — | 200 | `format_required`, `unknown_format`, `format_absent`, `bad_request` |
| GET | `/v1/layouts/:ref` | none | — | 200 | `format_required`, `unknown_format`, `format_absent`, `held`, `not_found` |
| GET | `/v1/layouts/:ref/likes` | none | — | 200 | `not_found` |
| GET | `/v1/layouts/:ref/history` | none | — | 200 | `not_found` |
| GET | `/v1/layouts/:ref/rev/:n` | none | — | 200 | `format_required`, `unknown_format`, `bad_request`, `held`, `not_found` |
| POST | `/v1/layouts` | user | `{name, format, payload}` | 201 | `bad_request`, `invalid_name`, `unknown_format`, `format_not_writable`, `invalid_payload`, `magic_collision`, `name_taken`, lane errors |
| PUT | `/v1/layouts/:ref` | user | `{format, payload}` + `If-Match` (replace) or `If-None-Match: *` (add) | 200 | `if_match_required`, `bad_request`, `unknown_format`, `format_not_writable`, `format_behind`, `format_absent`, `format_exists`, `invalid_payload`, `magic_collision`, `not_owner`, `not_found`, `stale`, lane errors |
| PATCH | `/v1/layouts/:ref` | user | `{name}` (layout scope) or `{format, fingermap?, board?, magic?}` (that format's scope) + `If-Match` | 200 | `if_match_required`, `bad_request`, `mixed_patch`, `format_required`, `invalid_name`, `invalid_payload`, `unsupported_for_format`, `not_owner`, `not_found`, `name_taken`, `stale`, lane errors |
| DELETE | `/v1/layouts/:ref` | user | — + `If-Match: "layout:<n>"` | 200 | `if_match_required`, `bad_request`, `not_owner`, `not_found`, `stale`, lane errors |
| POST | `/v1/layouts/:ref/restore` | user | `{name?}` (optional) | 200 | `bad_request`, `invalid_name`, `not_owner`, `not_found`, `name_taken`, lane errors |
| POST | `/v1/layouts/:ref/transfer` | user | `{to}` + `If-Match` | 200 | `if_match_required`, `bad_request`, `not_owner`, `not_found`, lane errors |
| PUT | `/v1/layouts/:ref/like` | user | — | 200 | `not_found`, `bad_request`, `already_liked`, lane errors |
| DELETE | `/v1/layouts/:ref/like` | user | — | 200 | `not_found`, `not_liked`, lane errors |
| GET | `/v1/layouts/:ref/link` | user (owner or admin) | — | 200 | `not_found`, `not_owner`, lane errors |
| PUT | `/v1/layouts/:ref/link` | user (owner or admin) | `{url}` | 200 (admin: approved) / 202 (owner: queued) | `bad_request`, `invalid_link`, `not_owner`, `not_found`, lane errors |
| DELETE | `/v1/layouts/:ref/link` | user (owner or admin) | — | 200 | `not_owner`, `not_found`, lane errors |
| GET | `/v1/authors` | none | — | 200 | `bad_request` |
| GET | `/v1/authors/:user_id` | none | — | 200 | `not_found` |
| GET | `/v1/formats` | none | — | 200 | — |
| GET | `/v1/formats/:name/:major/schema.json` | none | — | 200 | `not_found` |
| GET | `/v1/changes` | none (`wait=` needs a registered client) | — | 200 | `bad_request`, `not_found` |
| GET | `/admin/changelog` | none | — | 200 (HTML) | `bad_request`, `not_found` |
| GET | `/v1/dump` | none | — | 302 | `not_found` |
| GET | `/v1/dump/latest.json` | none | — | 200 | `not_found` |
| GET | `/v1/dump/monthly/:key` | none | — | 200 | `not_found` |
| GET | `/v1/dump/:key` | none | — | 200 | `not_found` |
| GET | `/v1/admin/admins` | admin | — | 200 | `not_admin`, lane errors |
| POST | `/v1/admin/admins` | admin | `{user_id, note?}` | 200/201 | `bad_request`, `not_admin`, lane errors |
| DELETE | `/v1/admin/admins/:user_id` | admin | — | 200 | `not_admin`, `last_admins`, lane errors |
| POST | `/v1/admin/import/pause` | admin | — | 200 | `not_admin`, lane errors |
| POST | `/v1/admin/import/resume` | admin | — | 200 | `not_admin`, lane errors |
| POST | `/v1/admin/import/tick` | admin | — | 200 | `not_admin`, `import_paused`, lane errors |
| POST | `/v1/admin/diff/tick` | admin | — | 200 | `not_admin`, lane errors |
| POST | `/v1/admin/nightly/tick` | admin | — | 200 | `not_admin`, lane errors |
| POST | `/v1/admin/dump` | admin | — | 200 (`{seq, layout_count, written_at}`) | `not_admin`, lane errors |
| POST | `/v1/admin/magic-seed` | admin | `{ref, magic}` | 200 (`{id, name, rev, has_magic, upstream}`) — a SYSTEM write (`system:magic-seed` / `seed:aklgg`) that never forks the record (23-geometry.md §10.1) | `bad_request`, `not_admin`, `not_found`, `invalid_payload`, `magic_collision`, lane errors |
| POST | `/v1/admin/clients` | admin | `{name, pubkey, owner_user_id, caps, discord_app_id?}` | 201 | `bad_request`, `not_admin`, lane errors |
| DELETE | `/v1/admin/clients/:id` | admin | — | 200 | `not_admin`, `not_found`, lane errors |
| GET | `/v1/admin/clients` | admin | — | 200 | `not_admin`, lane errors |
| GET | `/v1/admin/health` | admin | — | 200 | `not_admin`, lane errors |
| GET | `/v1/admin/bans` | admin | — | 200 | `not_admin`, lane errors |
| PUT | `/v1/admin/bans/:user_id` | admin | `{reason?}` | 200/201 | `not_admin`, `cannot_ban_admin`, lane errors |
| DELETE | `/v1/admin/bans/:user_id` | admin | — | 200 | `not_admin`, `not_found`, lane errors |
| PUT | `/v1/admin/authors/:user_id` | admin | `{name}` | 200 | `bad_request`, `not_admin`, `not_found`, lane errors |
| GET | `/v1/admin/link-queue` | admin | — | 200 | `bad_request`, `not_admin`, lane errors |
| POST | `/v1/admin/link-queue/:id/approve` | admin | — | 200 | `not_admin`, `not_found`, lane errors |
| POST | `/v1/admin/link-queue/:id/reject` | admin | `{reason?}` | 200 | `bad_request`, `not_admin`, `not_found`, lane errors |

"lane errors" (every `user`/`admin`/`client` row) means whichever lane you
used: the user lane can answer `unauthorized`/`token_invalid`/
`identity_unavailable`; the client lane can answer `bad_signature`/
`unknown_client`/`client_revoked`/`stale_timestamp`/`replay`/
`actor_not_allowed`; either lane can answer `rate_limited`. §6's table has
every one of them with its exact body shape.

## 10. Moderation

An admin (`GET /v1/me`'s `admin: true`) can ban a user, override an
author's display name, and decide a submitted `link`. Every action here
appends an event (`admin: true`), so it shows up in
`/v1/changes`/`/admin/changelog` like any other write. There is
deliberately no way for an admin to move a layout's `like_count` — see
"No like-count override" below.

**Bans** (`GET/PUT/DELETE /v1/admin/bans[/:user_id]`): a banned user's
non-safe request (any method other than GET/HEAD/OPTIONS, likes included)
is refused with `403 banned`; reads are never refused. An admin can never
be banned — `PUT` on a current admin is `409 cannot_ban_admin`. `GET
/v1/me` always reports the caller's own `banned` (and `admin`) fresh,
never cached.

**No like-count override** (H24, 2026-09-13): `like_count` is always
exactly `COUNT(DISTINCT user_id) FROM likes` for the layout — an earlier
admin "overwrite likes" route (`PUT /v1/admin/layouts/:ref/likes`) was
removed entirely so mods can never move it and every like is always tied
to the user who made it. `PUT/DELETE /v1/layouts/:ref/like` are the only
writers of `like_count`.

**Author name override** (`PUT /v1/admin/authors/:user_id`, body
`{name}`): sets the one name `/v1/authors` shows for that Discord id and
marks it sticky — neither a later sign-in nor the cmini import will
rename it again. There is no "clear override" route; an admin sets it
again to change it.

**`link`** (`PUT/DELETE/GET /v1/layouts/:ref/link`, body `{url}` for
`PUT`): the layout's owner submits a URL (must be `https:`, no embedded
credentials, ≤ 2048 characters, or `400 invalid_link`); an admin's own
`PUT` is approved immediately, an owner's is queued (`202`, one pending
submission per layout — a fresh submission supersedes an older pending
one). `GET /v1/admin/link-queue?status=` (default `pending`) lists
submissions; `POST .../approve` or `.../reject` (body `{reason?}`)
decides one. Only an *approved* link ever appears on a public wire
(`layoutToWire`'s `link` field) — a pending, rejected or superseded URL
is visible only to the owner/admin (`GET .../link`) and the admin queue.
