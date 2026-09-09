# Integrating with the akl layout database

A guide for a new client — a bot, a site, a script — that wants to read or
write keyboard layouts through `akl-db`, the community-owned layout database
(`design/layout-db/00-plan.md`). No prior familiarity with this repo needed:
every claim below is tied to a route, a source file, or a test, and every
read example is a real `curl` against the live PREVIEW deployment, trimmed
for length.

```
production   https://akl-db.akl-58a.workers.dev
preview      https://akl-db-preview.akl-58a.workers.dev   <- develop here
```

Both run the same code (`db/README.md` § Preview environment) against
separate D1/R2 resources — there is no other staging. **Develop against
preview**, not production: write whatever you like there without asking.

## 1. What this is

A Cloudflare Worker + D1 database mirroring cmini's keyboard layouts,
extended with ownership, likes and full history, open to any client that
authenticates as a Discord user (`00-plan.md` §1) — started as a one-way
import from cmini, now accepts writes directly. JSON in and out, UTF-8,
`/v1` prefix, CORS `*` on every read (writes are gated by identity, not
CORS, `03-api.md` §1).

**Versioning and compatibility.** `/v1` changes only on a breaking change to
the record envelope (`id/name/owner/rev/…`) — never happened yet. A **format
major** (`cmini/1`, `akl/1`, `mana2/1`) is never removed, its schema never
tightened, its fixtures never edited (`01-format.md` §5, `LDB-F6`); an
incompatible shape is a new major (`akl/2`), not a break of `/v1`. Every read
that returns a payload takes `?as=<format>`; a record that can't be
translated to the format you asked for comes back `409 { error: "held",
held: true, format, see? }` (`held()` in `src/core/errors.ts`) instead of an
error that looks like your request was wrong — the record exists, your
format just can't show it yet. Read the format you write, or `akl/1` (the
default) if you have no opinion.

## 2. Reading (no auth, ever)

```bash
curl -s https://akl-db-preview.akl-58a.workers.dev/v1/meta
# {"layout_count":4176,"author_count":367,"seq":6264,"revision":"2026-09-09T22:49:08.539Z",
#  "layouts_modified_at":"2026-09-09T22:35:15Z","formats":["cmini/1","akl/1","mana2/1"],
#  "last_diff":null,"last_drill":{"at":"2026-09-09T18:45:16.367Z","ok":true}}
```

`seq` is the event log head; `revision` is that event's timestamp (likes move
it, `layouts_modified_at` they do not, `03-api.md` §2) — the one call a
poller makes on a quiet tick.

```bash
curl -s '…/v1/layouts?limit=2'
# {"items":[{"id":"01M23D5GJNN8AVAYA67357SS31","name":"-b-","owner":"782784290769207336",
#   "rev":1,"created_at":"2025-04-11T00:00:02Z","modified_at":"2026-08-31T12:45:28Z",
#   "deleted":false,"like_count":0,"has_magic":false,"format":"cmini/1"}, …],
#  "next_cursor":"WyIwMC0tLS0tLWhpZ2dzIiwiMDFNMjNENUdUQzJNRlhFWDg1WlRBUTJXTTgiXQ=="}
```

List rows carry every record field except `payload`. Params
(`src/routes/layouts.ts`, `03-api.md` §2):

| param | meaning |
|---|---|
| `owner=<id>`, `format=<f>`, `has_magic=true\|false`, `since=<iso>` (`modified_at >`) | filters |
| `liked_by=<user_id>` | composes with any filter, and with `full=1` |
| `sort=name\|modified_at\|created_at\|like_count` | default `name` asc, case-insensitive; `like_count` is desc |
| `limit=<n>` (≤ 1000, default 100), `cursor=<opaque>` | a full keyset walk visits every live record exactly once (`LDB-R4`) |
| `as=<format>` | `full=1` only — a list row never carries a payload |

`GET /v1/layouts?full=1&as=cmini/1` streams **every** live record with its
translated payload and sorted `likes` — the sync route a mirror uses (§6). A
held record here carries `held: true` and no `payload` rather than erroring
the whole response.

```bash
curl -s '…/v1/layouts/graphite?as=cmini/1' | head -c 260
# {"id":"01M23DDWHTV8V5R06HN6SX3D4A","name":"graphite","owner":"130544188818194432","rev":1,
#  "like_count":78,"has_magic":false,"format":"cmini/1","likes":["1004139554682441779", …]}
curl -s '…/v1/layouts/graphite/likes' | head -c 100
# {"user_ids":["1004139554682441779","1007355784830652507", …]}
curl -s '…/v1/layouts/graphite/history' | head -c 200   # + /rev/{n} for the payload as of any rev
# [{"seq":2080,"rev":1,"at":"2026-09-09T15:43:48.794Z","actor":"system:cmini-import",
#   "via":"import:cmini","kind":"imported","admin":false}, …]
curl -s '…/v1/authors/130544188818194432'
# {"user_id":"130544188818194432","name":"stronglytyped","layout_count":35,"liked_count":23}
curl -s '…/v1/formats' | head -c 220   # + /v1/formats/{name}/{N}/schema.json per format
# [{"id":"cmini/1","owner":"DB","description":"…","can_translate_to":["akl/1","mana2/1"]}, …]
```

`{ref}` in a path is an id (ULID) or a name, case-insensitive — a ULID-shaped
ref is tried as an id first. An unknown ref → `404 not_found` (never a 200
with an empty body); a tombstoned name is `404` by name, `200` by id,
restorable (§4).

**ETag/304.** `/v1/meta`, `/v1/layouts` (list and `full=1`), `/v1/changes` and
`/v1/authors` carry `Cache-Control: public, max-age=10` and a strong `ETag`
(`"<seq>:<hash(query)>"`) that changes iff the event head or the query does
(`LDB-R1`); a matching `If-None-Match` gets `304` after one indexed read:

```bash
etag=$(curl -sD - -o /dev/null …/v1/meta | grep -i '^etag:')
curl -s -o /dev/null -w '%{http_code}\n' -H "If-None-Match: ${etag#etag: }" …/v1/meta   # 304
```

## 3. Identity: two lanes, one Discord user id

Every request ends up as `{ user_id, via }` (`02-auth.md` §1); every
authorization rule reads only `user_id`.

### 3.a — a person, through their own client: `Authorization: Bearer <discord access token>`

The DB calls `GET https://discord.com/api/users/@me` with the same header
(scope `identify` is enough) and caches `sha256(token) → user_id` for ≤ 5 min
on success, ≤ 60s on a Discord 401 — 5xx/429/network are never cached, and
the token itself is never stored, only its hash (`resolveBearer`, `LDB-A2`).
Discord 401 → `401 token_invalid`; unreachable → `503 identity_unavailable`.
Web apps: sign the user into your own Discord app, hold their token
server-side, proxy writes through your backend — never hand a browser tab
the raw token.

```bash
curl -s -H 'Authorization: Bearer <token>' …/v1/me     # {"user_id":"…","name":"…","via":"discord","admin":false}
curl -s …/v1/me   # no header -> 401 {"error":"unauthorized","message":"authentication required"}
```

### 3.b Client lane — a bot asserting a user it already trusts

A Discord bot already knows which user sent a message; it can't present that
user's token, so it presents *itself* (an admin-registered Ed25519 key) and
*asserts* the user id. **Registration is admin-only** (`POST
/v1/admin/clients { name, pubkey, owner_user_id, caps, discord_app_id? }`,
`02-auth.md` §3.1, `04-governance.md` §1) — no self-service sign-up; ask an
admin (§7) for a client with your public key, an `owner_user_id`, and the
`caps` you need: `act-as-user` (may assert any Discord user id — a real
multi-user bot) or `act-as-owner-only` (only its own `owner_user_id` — a
personal script). Every write is logged `via: "client:<id>"` on the public
feed and changelog (`GET /admin/changelog`) — a compromised key is one query
to find and one call to revoke (`DELETE /v1/admin/clients/{id}`), effective
immediately (`clients.status` is read every request, never cached,
`LDB-A9`).

**Signing a request** — five headers, one string
(`signingString` in `src/auth/client.ts`, `02-auth.md` §3.2):

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

`METHOD` upper-cased; `PATH_WITH_QUERY` exactly as sent (no canonicalisation,
no origin); an absent body hashes as zero bytes. Checks, in order
(`verifyClientRequest`), each throwing before the route runs:

| check | failure |
|---|---|
| 5 headers present and shaped right (nonce/sig decode, actor is a 17-20-digit id) | `401 bad_signature` |
| client id known | `401 unknown_client` |
| `client.status == "active"` | `401 client_revoked` |
| `\|now − timestamp\| ≤ 300s` | `401 stale_timestamp` (`skew` in body) |
| Ed25519 signature verifies under the registered key | `401 bad_signature` |
| nonce unseen for this client in 10 min (a D1 INSERT's own PK) | `401 replay` |
| `act-as-owner-only` ⇒ `X-Akl-Actor == owner_user_id` | `403 actor_not_allowed` |

(every 401 above also carries `WWW-Authenticate: Bearer`). **Interop is a
frozen vector file**, `db/tests/vectors/client-signing.json` — (key,
request, expected signature) triples every signer below reproduces byte for
byte (`LDB-A4`).

**JS signer** (Web Crypto only — Node, a Worker, or a browser unchanged;
trimmed from the bot's real, tested `bot/src/client/sign.ts`):

```js
function b64url(bytes) {
  let bin = ''; for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function unb64url(s) {
  const pad = s.length % 4 === 0 ? '' : '='.repeat(4 - (s.length % 4));
  return Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/') + pad), (c) => c.charCodeAt(0));
}
async function importClientKey(pkcs8B64url) {        // CLIENT_PRIVATE_KEY's shape
  return crypto.subtle.importKey('pkcs8', unb64url(pkcs8B64url), { name: 'Ed25519' }, false, ['sign']);
}
async function signRequest(key, clientId, actor, method, pathWithQuery, bodyBytes) {
  const timestamp = String(Math.floor(Date.now() / 1000));
  const nonce = b64url(crypto.getRandomValues(new Uint8Array(16)));
  const hash = b64url(new Uint8Array(await crypto.subtle.digest('SHA-256', bodyBytes ?? new Uint8Array(0))));
  const msg = `akl-v1\n${method.toUpperCase()}\n${pathWithQuery}\n${timestamp}\n${nonce}\n${actor}\n${hash}`;
  const sig = await crypto.subtle.sign('Ed25519', key, new TextEncoder().encode(msg));
  return { 'X-Akl-Client': clientId, 'X-Akl-Timestamp': timestamp, 'X-Akl-Nonce': nonce,
           'X-Akl-Actor': actor, 'X-Akl-Signature': b64url(new Uint8Array(sig)) };
}
```

Proven against every vector, by the real module this is trimmed from:
`cd bot && npx vitest run tests/client/sign.test.ts` → `Test Files 1 passed
(1)  Tests 2 passed (2)`.

**Python signer** (`scripts/akl_client_signing.py` — pure stdlib, its own
small Ed25519 so no third-party crypto dependency is needed):
`sign_headers(method, path_with_query, actor, client_id, seed, body_bytes)`
returns the same five headers; `load_seed_from_env(var)` reads
`CLIENT_PRIVATE_KEY`-shaped base64url PKCS8 from the environment (never
argv). Proven against every vector: `python3 -m unittest
scripts.tests.test_client_signing -v` → `test_every_vector_signing_string_
and_signature ... ok`, `test_public_key_matches_every_key ... ok` (4 tests,
OK).

`bot/scripts/sign.mjs` wraps the JS signer as a CLI (prints `-H` flags for
`curl`); `db/scripts/ops-call.sh` wraps that for a maintainer's own signed
admin calls. Both read `CLIENT_ID`/`CLIENT_PRIVATE_KEY` from the
environment, never a flag.

## 4. Writing

```
POST   /v1/layouts                  { name, format, payload }                → 201
PUT    /v1/layouts/{ref}            { format, payload }             If-Match → 200
PATCH  /v1/layouts/{ref}            { name? , fingermap? , board? , magic? } If-Match → 200
DELETE /v1/layouts/{ref}                                             If-Match → 200 (tombstone)
POST   /v1/layouts/{ref}/transfer   { to }                           If-Match → 200
POST   /v1/layouts/{ref}/restore    (owner or admin, ≤ 30 days)                → 200
PUT / DELETE /v1/layouts/{ref}/like                                            → 200 { like_count }
```

**The `If-Match` rule (`LDB-P2`, `db/README.md`):** every write to an
*existing* record — `PUT`/`PATCH`/`DELETE`/`transfer` — refuses with `400
if_match_required` if `If-Match` is absent, checked before any read or
mutation. `restore` and likes take none (no prior version to name); creation
takes none either. `If-Match: "<rev>"` (quoted or bare) or `If-Match: *`
(overwrite on purpose, stated explicitly) are the only legal values;
anything else is `400 bad_request`. **Retry pattern on `409 stale`:** the
error body already carries the current record — re-read isn't even a second
request — so re-apply your change to it and resend with `If-Match` set to
*its* `rev`.

```bash
curl -sX POST …/v1/layouts -d '{"name":"ldb-integration-doc-demo","format":"akl/1",
  "payload":{"keys":{"a":{"row":1,"col":1,"finger":"LI"}}}}' <signed>
# 201 {"id":"01M245Q4J76A4PKAP2QX02YFRJ","rev":1,"format":"akl/1","payload":{"keys":{"a": …}}}

curl -sX PATCH …/v1/layouts/01M245…YFRJ -H 'If-Match: "1"' -d '{"fingermap":{"a":"LM"}}' <signed>
# 200 { …, "rev":2, "payload":{"keys":{"a":{"col":1,"finger":"LM","row":1}}} }

curl -sX PATCH …/v1/layouts/01M245…YFRJ -H 'If-Match: "1"' -d '{"fingermap":{"a":"LI"}}' <signed>  # replayed
# 409 {"error":"stale","rev":2,"record":{ …,"rev":2 },
#      "last_write":{"seq":6259,"actor":"999999999999999999","via":"client:01M245NRV…","kind":"fingermap"}}

curl -sX PATCH …/v1/layouts/01M245…YFRJ -H 'If-Match: "2"' -d '{"fingermap":{"a":"LI"}}' <signed>  # retry
# 200 { …, "rev":3 }

curl -sX PUT …/v1/layouts/01M245…YFRJ/like <signed>                    # 200 {"like_count":1}
curl -sX DELETE …/v1/layouts/01M245…YFRJ -H 'If-Match: "3"' <signed>   # 200 {"deleted":true,"rev":4}
curl -sX POST …/v1/layouts/01M245…YFRJ/restore <signed>                # 200 {"deleted":false,"rev":5}
```

This exact sequence ran live against PREVIEW while writing this guide;
`db/tests/conformance/layouts-write/` freezes the same shapes as CI
fixtures (`patch-409-stale.json`, `patch-200-renamed.json`, etc.).

**Other write errors:**

- `409 name_taken` — names are unique case-insensitively; `holder: { id,
  owner }` says whether it's your own record under a different id or a
  stranger's. `curl -sX POST …/v1/layouts -d '{"name":"graphite", …}' <signed>`
  → `409 {"error":"name_taken","holder":{"id":"01M23DDW…","owner":"130544188818194432"}}`
- `400 magic_collision` — two lowered rows fire on the same trigger (an idiom
  vs an idiom, or vs a raw `rules[]` entry, `01-format.md` §3 "D4"); `from`
  names both sources, `hint` (when one side is a scaffold row) suggests the
  `except` fix. Live proof (adaptive swap `t:[h,e]` vs a raw `th→te` rule):
  `400 {"error":"magic_collision","inputs":"th","from":["adaptive_swaps[0]","rules[0]"],"path":"/magic/rules/0"}`
- `400 invalid_payload` — the format's own `validate()` refused it, with a
  JSON-pointer `path`. Check locally, same function the server runs (or
  `import { validate } from '@akl/layout-formats/akl/1'` from JS):
  `echo '{"keys":{"a":{"row":9,"col":1,"finger":"LI"}}}' | node
  db/scripts/validate-akl1-payload.mjs` →
  `{"ok":false,"error":{"error":"invalid_payload","message":"payload/keys/a/row must be <= 4","path":"/keys/a/row"}}`.
- **Rate limits** (`LDB-R6`/`R7`): 60 writes/10 min per actor, plus —
  client lane only — 300/10 min per client id. `429 rate_limited` carries
  `Retry-After` (seconds) and `scope` (`"actor"`/`"client"`, naming which
  counter tripped): `{"error":"rate_limited","limit":60,"window_seconds":600,"retry_after":600,"scope":"actor"}`

## 5. Staying in sync

**The change feed is ground truth**; everything else is a shortcut around
polling it. `since` is exclusive (`since=0` = everything); pass back `next`
as your next `since`. Every write appends exactly one event (`03-api.md`
§5); `rev`-bumping kinds (`created`/`updated`/`renamed`/`fingermap`/
`transferred`/`deleted`/`restored`/`imported`/`upstream_deleted`) carry
`before`/`after`; `liked`/`unliked` move only `like_count`;
`upstream_changed`/`import_conflict` are informational. `kinds=` filters to
a comma list.

```bash
curl -s '…/v1/changes?since=6260&limit=3'
# {"next":6263,"items":[{"seq":6261,"kind":"liked","layout_id":"01M245…","rev":null, …},
#                        {"seq":6262,"kind":"deleted", …,"before":{ …,"rev":3},"after":{ …,"rev":4}}, …]}
```

**SSE** (`GET /v1/changes/stream?since=&kinds=`) is the same feed pushed
instead of polled — needs the Workers Paid plan (`STREAM_MAX_MS=0` on Free
answers `503 stream_unavailable` instead). Reconnect with `Last-Event-ID:
<cursor>` (what `EventSource` sends automatically, overriding `?since=`); a
`: ping` comment arrives every 25s idle; the stream closes with `event:
close` + `data: {"next":<cursor>}` after `STREAM_MAX_MS` (default 5 min) —
reconnect with that cursor for no gap or duplicate.

```bash
curl -N '…/v1/changes/stream?since=6260&kinds=liked,deleted,restored'
# id: 6261
# event: liked
# data: {"actor":"999999999999999999", …,"kind":"liked","seq":6261, …}
```

**Webhooks** — up to 5/user (`POST /v1/webhooks { url, secret, kinds?,
owner_filter? }`; `url` must be `https://`, not an IP literal; `secret`
16-256 chars): `curl -sX POST …/v1/webhooks -d '{"url":"https://example.com/
akl-webhook","secret":"a-throwaway-demo-secret-1234","kinds":["created",
"updated"]}' <signed>` → `201 {"id":"01M24609AR7068V4228CKJHGYZ",
"owner_user_id":"…","status":"active","cursor":6265, …}`.

Each POST carries the full event JSON plus `X-Akl-Webhook-Id`, `X-Akl-Seq`,
`X-Akl-Timestamp`, and `X-Akl-Signature: v1=<hex hmac-sha256(secret,
\`${timestamp}.${body}\`)>`. **Receiver contract:** verify the HMAC (strip
`v1=` first), reject anything > 300s old. A `seq` may arrive twice (the
after-write nudge and the cron drain can overlap) — treat any `seq` ≤ your
highest applied as a no-op; delivery is **at-least-once and in order per
hook**, never required for correctness (`LDB-P3`) — a gap means poll
`/v1/changes?since=` to fill it. A non-2xx (or > 10s) stops that hook's
batch and schedules a retry at 1 min / 10 min / 1 h; 3 consecutive failures
→ `"failing"` (still retried hourly); failing past 7 days → `"disabled"`
(no further attempts, visible via `GET /v1/webhooks`).

**The nightly dump** (`GET /v1/dump/latest.json`, 03:00 UTC) is the full
state — every table, the **whole** event log, not a tail:
`curl -s …/v1/dump/latest.json` → `{"date":"2026-09-09",
"key":"dump-2026-09-09.json.gz","url":"/v1/dump/dump-2026-09-09.json.gz",
"sha256":"baf8c25e…","bytes":1240439,"layout_count":4176,"seq":6213}`.
**Fold-after-dump** (the pattern the site's own mirror uses, `13-ledger.md`):
load the dump, then `GET /v1/changes?since=<dump's seq>` to catch up — never
re-fetch the whole corpus over the API. **Verify-then-serve:** if you cache
`/v1/meta` yourself, `GET` it with `If-None-Match: "<your cached etag>"` — a
`304` proves your cache is still current for free (one indexed read).

## 6. Recipes

- **A bot answering `!view <name>`.** No durable cache beyond your own
  `changes` cursor. `GET /v1/layouts/{name}?as=<your format>`; `404` → "no
  such layout"; render `payload`. Keep a local cache warm by following
  `/v1/changes/stream` (or polling `since=`), applying `before`/`after`.
- **Mirroring the whole DB.** `GET /v1/dump/latest.json` → fetch+gunzip the
  named object → load `records`/`likes`/`authors`/`events` → remember its
  `seq` → `GET /v1/changes?since=<seq>` in a loop, applying each event's
  `after` (or `like_count` deltas) to converge to the live head, then keep
  following the feed or the stream.
- **Publishing from a web app.** Discord OAuth the user server-side (never
  the browser), hold their token, proxy `POST`/`PATCH`/`PUT` through your
  backend with `Authorization: Bearer <their token>` — user lane, no client
  registration. Validate client-side first with `@akl/layout-formats` so a
  malformed submit never round-trips just to bounce.

## 7. Governance & etiquette

Imports from cmini keep following upstream until a person writes the record
here (`via` on its latest rev-bumping event flips away from
`"import:cmini"` — "forked" is derived, never a stored flag, `01-format.md`
§1). Admins (a D1 table, never a code constant, `LDB-G2`) can register/
revoke clients, add/remove other admins (never below 2, `LDB-A6`),
force-transfer or delete/restore any record, and pause the cmini import —
every admin action is a public event (`admin: true`) on the same feed and
changelog everyone else's writes are on. **To register a client**, reach an
admin with your public key and the `owner_user_id`/`caps` you need (§3.b) —
there's no other path. **Etiquette:** read the API, don't scrape the site's
HTML for what `/v1/layouts` already serves; respect `Retry-After` on a
`429` rather than retrying immediately; prefer webhooks or the stream over
tight polling once you're past prototyping.

## 8. Error-code appendix

Generated from `src/core/errors.ts`'s own `ApiError` factories
(`db/scripts/gen-error-table.mjs`) — `db/tests/tools/error-table.test.ts`
(`LDB-G8`) fails the build if this table drifts from that source, so it is
never hand-edited. Two more codes exist in the *format* layer
(`db/formats/*/1/index.ts`), not here: `invalid_payload` (any format's
`validate()`) and `magic_collision` (`akl/1` only) — both always `400`,
shown with real examples in §4.

<!-- BEGIN GENERATED ERROR TABLE (db/scripts/gen-error-table.mjs) -->
| status | error | message | thrown by |
|---|---|---|---|
| 400 | `bad_request` | *(caller-supplied -- this function's own `message` parameter)* | `badRequest(message, param)` |
| 400 | `unknown_format` | unknown format '${format}' | `unknownFormat(format, known)` |
| 404 | `not_found` | *(caller-supplied -- this function's own `message` parameter)* | `notFound(message, ref)` |
| 409 | `name_taken` | name '${name}' is already taken | `nameTaken(name, holder)` |
| 409 | `held` | record cannot be translated to '${format}' | `held(format, see)` |
| 500 | `internal` | internal error | `internal()` |
| 401 | `unauthorized` | authentication required | `unauthorized()` |
| 401 | `token_invalid` | the bearer token is invalid or expired | `tokenInvalid()` |
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
<!-- END GENERATED ERROR TABLE -->

Every route × status/code above has a frozen request/response fixture under
`db/tests/conformance/` (`LDB-R3`: a changed fixture is a documented API
change) — read the one for your case for an exact body shape. `client_revoked`
above was hit live while writing this guide, once the demo client used for
§4 was revoked at the end of the proof run.
