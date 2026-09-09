# Authentication and authorization

Status: proposal (2026-09-08). Part of `00-plan.md`.

## 1. One identity, two lanes

Everything authorizes on a **Discord user id**. cmini already keys every
layout, author and like by it; the bot sees it on every message; akl.gg's
existing OAuth (`functions/auth/discord/`) already puts it in a session. The
question is only how a request proves *which* user it speaks for. Two lanes:

| lane | who | proves the user by | typical caller |
|---|---|---|---|
| **user** (§2) | a person, through a client they are signed into | a Discord access token the DB verifies with Discord | akl.gg, any web app |
| **client** (§3) | a registered program acting for a person it has already authenticated itself | an Ed25519 signature from a key an admin registered, plus the user id it asserts | Discord bots |

Both lanes end in the same place: `ctx.actor = { user_id, via: "discord" |
"token" | "client:<id>" }`, and every authorization rule (§4) reads only
`actor.user_id`. `via` goes to the audit log.

## 2. The user lane

### 2.1 Discord access token (primary; round 1 of #215, approved)

```
Authorization: Bearer <discord access token>
```

The DB calls `GET https://discord.com/api/users/@me` with the same header,
caches `sha256(token) → user_id` for ≤ 5 minutes (failures ≤ 60 s), maps
Discord's 401 to `401 token_invalid`, unreachable to `503 identity_unavailable`.
`identify` scope is all that is needed. No secret is shared between the DB and
any client: a token exists only because that user signed into *that* client's
Discord app. Optional per-client allowlist by `application.id`
(`/oauth2/@me`) — an admin decision, off by default.

akl.gg's side is `design/cmini-write/05-implementation-plan.md` §4.1–4.2,
unchanged except the base URL: keep the user's Discord tokens encrypted in
D1, proxy writes through Pages Functions, never hand the browser a token.

### 2.2 CLI writes — set aside

DB-minted personal tokens (a *Create API token* button in akl.gg's
Settings, `Authorization: Bearer akl_v1_…`) were proposed here and **set
aside** in the round-1 review (saltorbit, 2026-09-08: "this doesn't feel
right"). Round 1 has no CLI write path. The remaining options are §7 Q2.

### 2.3 `GET /v1/me`

Returns `{ user_id, name, via, admin: bool }` for any authenticated request.
Ships first; proves the chain with no write risk.

## 3. The client lane — bots

A Discord bot authenticates its *users* already: Discord delivered the
message, `message.author.id` is trustworthy inside the bot. What the bot
cannot do is present a token for that user. So the bot presents **itself**,
and asserts the user.

This is the pattern round 1 of #215 rejected for the *cmini* API (its rows A
and D: the API takes someone's word for the user). It is acceptable here for
one reason: **the trust decision is explicit and revocable** — an admin
registers this specific key, sees every write it makes attributed to it, and
can pull it. It is the same trust the cmini bot has always had over its own
file store, made visible.

### 3.1 Registration

```
clients: { id, name, pubkey (Ed25519, base64), owner_user_id, caps, status, created_at, revoked_at }
caps:    "act-as-user"        may assert any user id
         "act-as-owner-only"  may assert only owner_user_id (a personal script)
```

Registered by an admin (`POST /v1/admin/clients` with the bot maintainer's
public key, `04 §1`). The private key never leaves the bot's host. Rotation =
register the new key, revoke the old.

### 3.2 Signing a request

```
X-Akl-Client:    <client id>
X-Akl-Timestamp: <unix seconds>
X-Akl-Nonce:     <16 random bytes, base64url>
X-Akl-Actor:     <discord user id the request acts for>
X-Akl-Signature: base64url( Ed25519_sign( sk, signing_string ) )

signing_string = "akl-v1\n" + METHOD + "\n" + PATH_WITH_QUERY + "\n"
               + TIMESTAMP + "\n" + NONCE + "\n" + ACTOR + "\n"
               + base64url( sha256( body bytes, or empty ) )
```

Server: client exists and `status = active`; `|now − timestamp| ≤ 300 s`;
nonce unseen for that client in the last 10 min (D1 table, pruned);
signature verifies under the registered key (Web Crypto `Ed25519`, available
in Workers); `caps` permit the asserted actor. Then `ctx.actor = { user_id:
ACTOR, via: "client:<id>" }`.

Deliberately our own five-line scheme rather than RFC 9421: the RFC's
component negotiation is for general HTTP; here both sides are ours and the
shape is fixed. **Interop is enforced by test vectors** — `db/tests/vectors/
client-signing.json` holds (key, request, expected signature) triples that
the Worker verifies and the bot's Python client must reproduce (`05 §4`).

### 3.3 What a compromised bot key can do, and what bounds it

Everything its `caps` allow, as any user — the confused-deputy cost, accepted.
Bounds: every write carries `via: client:<id>` in the event log and the
admin changelog, so a rogue key's writes are one query to list and one to
revert (events keep `before`); per-client rate limits (default 60 writes /
10 min); revocation is immediate (no token to expire); `act-as-owner-only`
for anything that is not a real multi-user bot. A bot must also be a real
Discord application: registration records its Discord application id and an
admin can verify it (`/oauth2/applications/@me` with the bot token) — a
human step at registration, not a runtime check.

## 4. Authorization rules (identical to the bot's today)

| action | allowed when |
|---|---|
| create | any authenticated actor; `owner = actor.user_id` |
| edit (PUT/PATCH keys, board, magic, link) · rename · delete | `record.owner == actor.user_id`, or actor is admin (logged `admin: true`) |
| transfer (`assign`) | `record.owner == actor.user_id`; target must be a user the DB has seen (has an author row or has authenticated once), or admin |
| like / unlike | any authenticated actor; idempotent; refused on `qwerty` as the bot does; refused on own layout? — **no** (cmini allows it; keep) |
| set fingermap | as edit |
| admin verbs (§5) | `actor.user_id ∈ admins` |
| read | everyone, no auth; the record shows `owner` (a public Discord id, as cmini does) |

Rate limits are per resolved `user_id` (all akl.gg traffic shares an egress
IP), and per client id additionally on the client lane.

## 5. Admins

A D1 table, not a constant (the site's `ADMIN_DISCORD_IDS` in `session.mjs`
is the thing this replaces for the DB): `admins { user_id, added_by,
added_at, note }`. Admin verbs: register/revoke clients; add/remove admins
(cannot remove the last two — LDB-A6); force-transfer; delete or restore any
record; pause the cmini import. All of them are events in the same log
(`03 §5`), visible on the public changelog with `admin: true`.

Bootstrap: migration `0001` inserts the first two admins from the runbook
(`04 §1`), so the table is never a one-row table in production.

## 6. Invariants

| id | invariant | enforced by |
|---|---|---|
| LDB-A1 | No write is accepted without `ctx.actor.user_id`; there is no anonymous write path, including admin routes. | route table test: every non-GET handler is wrapped by `requireActor` |
| LDB-A2 | The Discord token cache never serves a failure longer than 60 s or a success longer than 5 min. | unit test with a fake clock |
| LDB-A3 | *(reserved — personal tokens set aside, §2.2)* | — |
| LDB-A4 | Client-lane signatures: the verifier accepts every vector in `client-signing.json` and rejects each single-field mutation (method, path, timestamp ± 301 s, replayed nonce, body, actor, key). | generated matrix over the vectors |
| LDB-A5 | Every accepted write's event carries `via` and, on the client lane, the client id; a revoked client's requests are refused from the revocation onward. | API test |
| LDB-A6 | The admins table never has fewer than two active rows after bootstrap. | write-path check + test |
| LDB-A7 | Owner checks read `record.owner` and `actor.user_id` and nothing else — no name matching, no client-supplied owner field on edits (`owner` in a PUT body is ignored, `transfer` is the only way to change it). | property test: PUT with a foreign `owner` leaves it unchanged |

## 7. Open questions (auth)

1. `act-as-user` for the one bot on day 1; do we want per-client allowed
   guild ids too (a bot only acting for users in the AKL server)? Cheap to
   add later; **not** on day 1.
2. **How does mana write as its user?** Personal tokens are out. Left:
   (a) a Discord device-flow login inside mana (mana registers a Discord
   application; the token it gets is then the ordinary §2.1 bearer — zero
   DB-side code); (b) publish only through akl.gg (mana hands the site a
   draft, #218's `cb <layout>`, and the person presses Publish there);
   (c) nothing in round 1. Proposal: (b) now, (a) if mana's author wants it.
3. Should the DB run its own Discord OAuth too (for its own admin page)?
   Proposal: no; admin actions are API calls made through akl.gg's own
   session (its proxy forwards the admin's Discord bearer, §2.1), and the
   changelog is a public read-only page. Fewer secrets.
