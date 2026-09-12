# Integrating with the akl layout database

**`db/docs/adoption.md` is the primary guide for building a client** — a
Discord bot, a web app, a script, or an agent — written to be followed by a
human or handed whole to an agent, and machine-checked against the live
router and the error factories (`LDB-G10`). This file is the older,
narrower integration note: it exists now for its cross-references into the
design docs (`00-plan.md`, `01-format.md`, `02-auth.md`, `03-api.md`,
`04-governance.md`) and for the generated error-code appendix (§8, checked
by `LDB-G8`) that the adoption guide's own §6 points back at as "the same
table `db/INTEGRATION.md` carries". Where a section below would otherwise
repeat the guide, it links to the guide's section instead of restating it.

Updated 2026-09-11 (20-spark.md).

A guide for a new client — a bot, a site, a script — that wants to read or
write keyboard layouts through `akl-db`, the community-owned layout database
(`design/layout-db/00-plan.md`). No prior familiarity with this repo needed:
every claim below is tied to a route, a source file, or a test.

```
production   https://akl-db.akl-58a.workers.dev   <- the one layoutdb
```

There is one layoutdb, production. The preview environment
(`akl-db-preview`) was retired on 2026-09-11: nothing reads it and it
accepts no clients. **Develop against production**, and ask before writing
there.

## 1. What this is

A Cloudflare Worker + D1 database mirroring cmini's keyboard layouts,
extended with ownership, likes and full history, open to any client that
authenticates as a Discord user (`00-plan.md` §1) — started as a one-way
import from cmini, now accepts writes directly. JSON in and out, UTF-8,
`/v1` prefix, CORS `*` on every read (writes are gated by identity, not
CORS, `03-api.md` §1).

**Several formats per layout, one stored today.** A layout can hold more
than one format (`design/layout-db/21-formats.md`, F2, 2026-09-11), each
its own row (`layout_formats`) with its own rev, independent of every
other format the layout has and of the layout's own name/owner/deletion
(`layout_rev`). `spark/1` — `akl/1` renamed, the same payload shape byte
for byte (`design/layout-db/20-spark.md` decision 1) — is the one
**stored** format today; `mana2/1` is an **output-only, derived** shape:
produced from whichever ONE stored lineage reaches it (`spark/1` today) on
a read that names it explicitly (`?format=mana2/1`), never stored — a
write naming it is `400 format_not_writable`. cmini is an import *source*,
not a format lineage: the importer converts each upstream detail to spark
on arrival, touching the layout's own fields and lineage `spark` only.
There is no `akl/1` alias, and no `?as=` query parameter at all any more
(`design/layout-db/21-formats.md` D4/D5/D12, F1/F2 — the alias was
transitional and the 2026-09-11 wipe left no row to carry it forward;
`?as=` is renamed `?format=` and made **required**, no default). `GET
.../{ref}?format=cmini/1` (or `akl/1`) answers exactly like any other
unregistered format id (404 `unknown_format`). **Every client reads and
writes `spark/1` by name, explicitly, every time.**

**Versioning and compatibility.** `/v1` changes only on a breaking change to
the record envelope (`id/name/owner/layout_rev/formats/…`) — never happened
yet. A registered format major is never removed, its schema never
tightened, its fixtures never edited (`01-format.md` §5, `LDB-F6`); an
incompatible shape is a new major (`spark/2`), not a break of `/v1` — the
adoption guide §8 covers how a client detects and migrates across one.
Every read that returns a payload **requires** `?format=<format>` — no
default; a layout that doesn't have (and can't derive) the format you
asked for is `404 format_absent`; a record whose stored content can't be
translated to the format you asked for comes back `409 { error: "held",
held: true, format, see? }` (`held()` in `src/core/errors.ts`) instead of
an error that looks like your request was wrong — the record exists, your
format just can't show it yet. Read and write `spark/1` if you have no
opinion; `GET /v1/formats` is the live registry (adoption guide §3).

## 2. Reading (no auth, ever)

Every route, its real trimmed request/response shapes, and the required
`?format=<format>` / `held` / `format_absent` mechanics are in the adoption
guide §3 — not repeated here. In
short: `GET /v1/meta` is the one call a poller makes on a quiet tick (`seq`
is the event-log head, `revision` that event's timestamp, `03-api.md` §2);
`GET /v1/layouts` lists records (list rows carry every field except
`payload`; params below); `GET /v1/layouts?full=1&as=<format>` streams every
live record with its translated payload and sorted `likes` — the sync route
a mirror uses (§6) — a held record there carries `held: true` and no
`payload` rather than erroring the whole response; `{ref}` in a path is an
id (ULID) or a name, case-insensitive (a ULID-shaped ref is tried as an id
first) — an unknown ref is `404 not_found` (never a 200 with an empty body),
and a tombstoned name is `404` by name, `200` by id, restorable (§4).

Params (`src/routes/layouts.ts`, `03-api.md` §2):

| param | meaning |
|---|---|
| `owner=<id>`, `format=<f>`, `has_magic=true\|false`, `since=<iso>` (`modified_at >`) | filters |
| `liked_by=<user_id>` | composes with any filter, and with `full=1` |
| `sort=name\|modified_at\|created_at\|like_count` | default `name` asc, case-insensitive; `like_count` is desc |
| `limit=<n>` (≤ 1000, default 100), `cursor=<opaque>` | a full keyset walk visits every live record exactly once (`LDB-R4`) |
| `as=<format>` | `full=1` only — a list row never carries a payload |

**ETag/304.** `/v1/meta`, `/v1/layouts` (list and `full=1`), `/v1/changes` and
`/v1/authors` carry `Cache-Control: public, max-age=10` and a strong `ETag`
(`"<seq>:<hash(query)>"`) that changes iff the event head, the wire version,
or the query does (`LDB-R1`). Author changes append no event, so
`/v1/authors` keys on the authors version instead of the seq, and `/v1/meta`
folds it in beside the seq: their tags move iff what they show does
(`LDB-R9`). A matching `If-None-Match` gets `304` after one D1 query:

```bash
etag=$(curl -sD - -o /dev/null …/v1/meta | grep -i '^etag:')
curl -s -o /dev/null -w '%{http_code}\n' -H "If-None-Match: ${etag#etag: }" …/v1/meta   # 304
```

## 3. Identity: two lanes, one Discord user id

Every request resolves to one `Actor` (`src/auth/actor.ts`): `{ user_id,
via, admin, source_client }` — every authorization rule reads only
`user_id`. `source_client` is the proven provenance every rev-bumping
write's event (and the record's own latest one) now carries as
`source: {client, version}` (decision 14 of `20-spark.md`; adoption guide
§1.3) — never a header or body field a caller controls.

- **User lane** — a person, through their own client:
  `Authorization: Bearer <discord access token>` (scope `identify` is
  enough). The DB confirms it by calling Discord's own `GET
  /oauth2/@me` with the same header and caches the answer (`resolveBearer`,
  `LDB-A2`; adoption guide §1.2, §2.2). Discord 401 → `401 token_invalid`;
  unreachable → `503 identity_unavailable`. Web apps: sign the user into
  your own Discord app, hold their token server-side, proxy writes through
  your backend — never hand a browser tab the raw token.

  ```bash
  curl -s -H 'Authorization: Bearer <token>' …/v1/me     # {"user_id":"…","name":"…","via":"discord","admin":false}
  curl -s …/v1/me   # no header -> 401 {"error":"unauthorized","message":"authentication required"}
  ```

- **Client lane** — a bot asserting a user it already trusts: a Discord bot
  already knows which user sent a message; it can't present that user's
  token, so it presents *itself* (an admin-registered Ed25519 key) and
  *asserts* the user id. **Registration is admin-only** (`POST
  /v1/admin/clients { name, pubkey, owner_user_id, caps, discord_app_id? }`,
  `02-auth.md` §3.1, `04-governance.md` §1) — no self-service sign-up; ask an
  admin (§7) for a client with your public key, an `owner_user_id`, and the
  `caps` you need: `act-as-user` (may assert any Discord user id — a real
  multi-user bot) or `act-as-owner-only` (only its own `owner_user_id` — a
  personal script). Every write is attributed to your client id on the
  public feed and changelog (`GET /admin/changelog`, both via `source.client`
  and the write's own `actor`) — a compromised key is one query to find and
  one call to revoke (`DELETE /v1/admin/clients/{id}`), effective immediately
  (`clients.status` is read every request, never cached, `LDB-A9`).

  The five-header signing recipe (`signingString` in `src/auth/client.ts`,
  `02-auth.md` §3.2), the server's ordered checks (`verifyClientRequest`),
  and working, tested JS/Python signers are all in the adoption guide §2.1
  — don't re-derive the recipe by hand; build your signer against the
  frozen vector file, `db/tests/vectors/client-signing.json` (`LDB-A4`), and
  diff. `bot/scripts/sign.mjs` wraps the JS signer as a CLI (prints `-H`
  flags for `curl`); `db/scripts/ops-call.sh` wraps that for a maintainer's
  own signed admin calls — both read `CLIENT_ID`/`CLIENT_PRIVATE_KEY` from
  the environment, never a flag.

## 4. Writing

```
POST   /v1/layouts                  { name, format, payload }                              → 201
PUT    /v1/layouts/{ref}            { format, payload }        If-Match (replace) or          → 200
                                                                 If-None-Match: * (add)
PATCH  /v1/layouts/{ref}            { name } If-Match: "layout:<n>", or                       → 200
                                     { format, fingermap?/board?/magic? } If-Match: "<lineage>:<n>"
DELETE /v1/layouts/{ref}                                    If-Match: "layout:<n>"           → 200 (tombstone)
POST   /v1/layouts/{ref}/transfer   { to }                  If-Match: "layout:<n>" or *      → 200
POST   /v1/layouts/{ref}/restore    { name? }  (owner or admin, no time limit)                → 200
PUT / DELETE /v1/layouts/{ref}/like                                                           → 200 { like_count }
```

**The scoped `If-Match` rule (`LDB-P2`/`MF-11`, `db/README.md`):** every
write to an *existing* SCOPE — `PUT`/format-`PATCH`/`DELETE`/`transfer`/
name-`PATCH` — refuses with `400 if_match_required` if `If-Match` is
absent, checked before any read or mutation. `restore` and likes take none
(no prior version to name); creation takes none either. `If-Match:
"layout:<n>"` (a layout-scope write) or `If-Match: "<lineage>:<rev>"` (a
format-scope write), or `If-Match: *` (overwrite on purpose, any scope,
stated explicitly), are the only legal values — a bare unscoped number or
the WRONG scope's token is `400 bad_request`. **Retry pattern on `409
stale`:** the error body already carries the current record (and which
scope raced) — re-read isn't even a second request — so re-apply your
change to it and resend with `If-Match` set to that scope's current rev.
**Every write should also carry `X-Client-Version`** — not enforced by the
schema, but it's what lets an operator later find every write a given
build of your client made (adoption guide §1.3, §5).

```bash
curl -sX POST …/v1/layouts -H 'X-Client-Version: my-bot/1.0' -d '{"name":"ldb-integration-doc-demo",
  "format":"spark/1","payload":{"keys":{"a":{"row":1,"col":1,"finger":"LI"}}}}' <signed>
# 201 {"id":"01M245Q4J76A4PKAP2QX02YFRJ","name":"ldb-integration-doc-demo","layout_rev":1,
#      "formats":{"spark/1":{"rev":1,"…":"…"}},"format":"spark/1","payload":{"keys":{"a": …}}}
# (the same call with "format":"akl/1" now 400s "unknown_format" -- §1: no more alias)

curl -sX PATCH …/v1/layouts/01M245…YFRJ -H 'If-Match: "spark:1"' -d '{"format":"spark/1","fingermap":{"a":"LM"}}' <signed>
# 200 { …, "format":"spark/1", "payload":{"keys":{"a":{"col":1,"finger":"LM","row":1}}} }

curl -sX PATCH …/v1/layouts/01M245…YFRJ -H 'If-Match: "spark:1"' -d '{"format":"spark/1","fingermap":{"a":"LI"}}' <signed>  # replayed
# 409 {"error":"stale","scope":"spark","rev":2,"record":{ …,"formats":{"spark/1":{"rev":2}} },
#      "last_write":{"seq":6259,"actor":"999999999999999999","via":"client:01M245NRV…","kind":"fingermap"}}

curl -sX PATCH …/v1/layouts/01M245…YFRJ -H 'If-Match: "spark:2"' -d '{"format":"spark/1","fingermap":{"a":"LI"}}' <signed>  # retry
# 200 { …, "formats":{"spark/1":{"rev":3}} }

curl -sX PUT …/v1/layouts/01M245…YFRJ/like <signed>                              # 200 {"like_count":1}
curl -sX DELETE …/v1/layouts/01M245…YFRJ -H 'If-Match: "layout:1"' <signed>      # 200 {"deleted":true,"layout_rev":2}
curl -sX POST …/v1/layouts/01M245…YFRJ/restore <signed>                          # 200 {"deleted":false,"layout_rev":3}
```

`db/tests/conformance/layouts-write/` freezes the current shapes as CI
fixtures (`patch-409-stale.json`, `patch-200-renamed.json`, etc.) — read
those for a byte-exact, machine-verified body rather than this hand-typed
sequence.

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
  `import { validate } from '@akl/layout-formats/spark/1'` from JS — there
  is no `./akl/1` or `./cmini/1` package subpath any more, `21-formats.md`
  D12):
  `echo '{"keys":{"a":{"row":9,"col":1,"finger":"LI"}}}' | node
  db/scripts/validate-akl1-payload.mjs` →
  `{"ok":false,"error":{"error":"invalid_payload","message":"payload/keys/a/row must be <= 4","path":"/keys/a/row"}}`
  (the script's own name is unchanged; it validates against `spark/1`'s
  schema).
- `400 format_not_writable` / `409 format_behind` — `mana2/1` can never be
  written (it's produced on read only), and a blind `PUT` in an older major
  that has genuinely outgrown it is refused rather than silently losing
  content (adoption guide §5, §8).
- **Rate limits** (`LDB-R6`/`R7`): 1000 writes/10 min per actor, plus —
  client lane only — 5000/10 min per client id. `429 rate_limited` carries
  `Retry-After` (seconds) and `scope` (`"actor"`/`"client"`, naming which
  counter tripped): `{"error":"rate_limited","limit":1000,"window_seconds":600,"retry_after":600,"scope":"actor"}`

## 5. Staying in sync

**The change feed is ground truth**; everything else is a shortcut around
polling it. `since` is exclusive (`since=0` = everything); pass back `next`
as your next `since`. A write appends one event per scope it touches (two
for a create or an import) — each event's own `format` field says which:
`null` for a layout-scope kind (`created`/`renamed`/`transferred`/
`deleted`/`restored`/`upstream_deleted`), a format id for a format-scope
one (`format_added`/`updated`/`fingermap`/`imported`) — carrying
`before`/`after` (scope-shaped: layout fields, or that one format's own)
plus per-event `source`; `liked`/`unliked` move only `like_count`;
`upstream_changed`/`import_conflict`/`admin.*` are informational. `kinds=`
filters to a comma list. Every layout also carries a top-level `upstream`
field — **transitional**, tied to the one-time cmini import, layout-level
(a write to lineage `spark` or the layout itself moves it; any other
format never does); don't build client behavior on it (adoption guide §4,
`20-spark.md` decision 16).

```bash
curl -s '…/v1/changes?since=6260&limit=3'
# {"next":6263,"items":[{"seq":6261,"kind":"liked","layout_id":"01M245…","format":null,"rev":null, …},
#                        {"seq":6262,"kind":"deleted","format":null, …,"before":{"scope":"layout", …,"layout_rev":3},"after":{"scope":"layout", …,"layout_rev":4}}, …]}
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
`v1=` first), reject anything > 300s old. Delivery is **at-least-once, in
order, and never concurrent per hook** (`LDB-H6`'s lease keeps the
after-write nudge and the cron drain — which overlap routinely — from ever
both posting to the same hook at once), never required for correctness
(`LDB-P3`) — a gap means poll `/v1/changes?since=` to fill it. A `seq` may
arrive twice only after an outage on this end (a drain that dies mid-batch
leaves the hook's lease held until it expires; the next drain re-delivers
from the last committed cursor, possibly repeating the dead drain's own
last, already-landed POST) — dedupe by `X-Akl-Seq`, treating any `seq` ≤
your highest applied as a no-op. A non-2xx (or > 10s) stops that hook's
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
  `changes` cursor. `GET /v1/layouts/{name}?format=<your format>`; `404` →
  "no such layout" (or `format_absent` if the layout exists but never
  stored that format); render `payload`. Keep a local cache warm by following
  `/v1/changes/stream` (or polling `since=`), applying `before`/`after`.
- **Mirroring the whole DB.** `GET /v1/dump/latest.json` → fetch+gunzip the
  named object → load `records`/`likes`/`authors`/`events` → remember its
  `seq` → `GET /v1/changes?since=<seq>` in a loop, applying each rev-bumping
  event's own `after` to converge to the live head. `like_count` is NOT
  part of any event's `after` (a writer's own pre-read of it can go stale,
  and a mirror reading it off an event would see a wrong, frozen count the
  moment a like/unlike lands after) — keep your own running tally purely
  from `liked`/`unliked` events instead, the same way `foldLayout` does.
- **Publishing from a web app.** Discord OAuth the user server-side (never
  the browser), hold their token, proxy `POST`/`PATCH`/`PUT` through your
  backend with `Authorization: Bearer <their token>` — user lane, no client
  registration. Validate client-side first with `@akl/layout-formats` so a
  malformed submit never round-trips just to bounce.

## 7. Governance & etiquette

Imports from cmini keep a record's stored `upstream.state` at `"following"`
until a person writes it — any rev-bumping user write forks it (decision 6
of `20-spark.md`; magic edits included, since the old magic-only exemption
is retired). `upstream` is a stored field folded from events
(`core/upstream.ts`'s `nextUpstream`), not derived from `via` — and it is
**transitional**: it exists only while the one-time cmini import runs, and
is removed once that import is retired (`20-spark.md` §6b; adoption guide
§4). Admins (a D1 table, never a code constant, `LDB-G2`) can register/
revoke clients, add/remove other admins (never below 2, `LDB-A6`),
force-transfer or delete/restore any record, and pause the cmini import —
every admin action is a public event (`admin: true`) on the same feed and
changelog everyone else's writes are on. **To register a client**, reach an
admin with your public key and the `owner_user_id`/`caps` you need (§3
above) — there's no other path. **Etiquette:** read the API, don't scrape the site's
HTML for what `/v1/layouts` already serves; respect `Retry-After` on a
`429` rather than retrying immediately; prefer webhooks or the stream over
tight polling once you're past prototyping.

## 8. Error-code appendix

Generated from `src/core/errors.ts`'s own `ApiError` factories
(`db/scripts/gen-error-table.mjs`) — `db/tests/tools/error-table.test.ts`
(`LDB-G8`) fails the build if this table drifts from that source, so it is
never hand-edited. Two more codes exist in the *format* layer (a stored
format's own `validate()`, e.g. `db/formats/spark/1/index.ts`), not here:
`invalid_payload` (any stored format's `validate()`) and `magic_collision`
(a `spark/1` payload's lowered magic rows) — both always `400`, shown with
real examples in §4.

<!-- BEGIN GENERATED ERROR TABLE (db/scripts/gen-error-table.mjs) -->
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
