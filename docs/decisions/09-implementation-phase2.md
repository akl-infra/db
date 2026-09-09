# Implementation — phase 2, people write

Status: plan, round 2 (2026-09-09; round-1 text reviewed against the
phase-1 code on `worktree-layout-db` at S5 and rewritten as closed briefs).
Part of `00-plan.md` (§5 phase 2). Written like `07`: every slice names its
files, signatures, bodies, error bodies, tests and the `LDB-*` ids those
tests enforce, so a strong-but-literal coding agent can land it from this
document alone. Every reference to a phase-1 module is to what is on the
branch: `core/events.ts` (`appendWrite`/`appendInfo`/`appendLike`/`feed`,
the `Write`/`Info`/`Like`/`Event` types), `core/records.ts`
(`byRef`/`readById`/`readByName`/`RecordRow`), `core/errors.ts`
(`ApiError`, `ErrBody`), `formats/registry.ts` (`get`/`list`/`translate`,
`FormatModule`), `formats/{cmini,akl}/1`.

## 0. What phase 2 delivers, and what it does not

Delivers: the **user lane** (a Discord bearer verified with Discord) and
`GET /v1/me`; the write verbs — `POST`, `PUT`, `PATCH` (rename, fingermap,
board, magic), `DELETE`, `restore`, `transfer` — and likes; `If-Match` on
`rev` with a real concurrency guarantee; `check_name`; **admins** as data
with the admin verbs; a **write** rate limit; the format `edits` slot that
PATCH needs; the conformance cases for all of it; a preview deployment for
the site's phase-2 UX work (`06 §3`, `§7` — the site's own PRs are not in
this doc).

Does not deliver: the client lane (bots; phase 4), webhooks/SSE (phase 5),
`mana2/1` (phase 5), the site cutover / magic migration (phase 3), an admin
UI (the changelog page is phase 5), `Idempotency-Key` (cut, §7), poll rate
limiting (cut, §7), a generated `docs/api.md` (cut, §7).

Decisions carried in from the round-1 review and not reopened here: Discord
bearer verified via `/users/@me` is the only lane; no personal tokens; no
client lane; admins are a D1 table with ≥ 2 rows; `rev` + `If-Match`; likes
don't bump `rev`; no `link` on the record; `appendWrite` stays the only
writer; `check_name` applies to `POST`/rename only.

### 0.1 Facts about the phase-1 code phase 2 builds on (read 2026-09-09)

Every brief below cites this table.

| fact | value | consequence |
|---|---|---|
| `Write` type | `{ kind, layoutId?, name, owner, created_at?, modified_at, format, payload, actor, via, admin?, detail?, deleted?, hasMagic? }`; `appendWrite` returns `{ record, seq }`; throws `nameTaken` (an `ApiError`) on a live-name clash, a plain `Error` on an unknown `layoutId` | every phase-2 verb is a `Write` — no new writer, no new column |
| `appendWrite`'s `layouts` statement | `INSERT OR REPLACE INTO layouts …` | **defect under concurrency:** `OR REPLACE` resolves *every* UNIQUE conflict by deleting the other row, so two `POST`s racing on one name (both pass the pre-check `SELECT`) end with the second silently deleting the first's `layouts` row (events + revs orphaned; P1/P4 broken). Phase 1 never races (one cron); phase 2 does. T2 fixes it (§2.3) |
| `layout_revs` PK | `(layout_id, rev)` | two writes at the same `rev` cannot both commit — the second batch fails on this insert and rolls back. This, not the `If-Match` pre-check, is what makes "exactly one wins" true (§2.3) |
| `db.batch()` | one transaction; a failing statement rolls back the whole batch, including `sqlite_sequence` | a lost race appends no event and leaves `seq` gapless |
| `appendLike` | pre-checks `likes`, then `UPDATE layouts SET like_count = ?` (absolute) | two users liking at once lose one count; the same user twice at once hits the `likes` PK and throws. T5 fixes both (§3 T5) |
| `app.onError` | renders `ApiError` with status cast `400 \| 404 \| 409 \| 500` | T1 widens the union (401, 403, 429, 503) |
| `FormatModule` | `id schema validate lower to from hasMagic` — no `edits` | T4 adds the optional `edits` export (§2.6); the registry passes it through |
| `authors` | seeded by the import (`applyAuthors`, no events); `first_seen_at`/`last_seen_at` | T1 upserts a row per resolved actor |
| `admins` | one row (`0001`): saltorbit | T1's migration seeds the second (or a placeholder comment); A6 is checked on `DELETE` only |
| `import_state.cmini.paused` | `'1'` → `tick()` returns `{quiet: true}` before any request | T3's pause/resume writes exactly this key |
| tests | pool-workers 0.22: `SELF.fetch`, `env` from `cloudflare:test`, per-file storage isolation, no `fetchMock` (inject `fetchImpl`), crons via the exported `scheduled()` | every workers test below follows `tests/api/meta.test.ts`'s shape |
| bot `NAME_SET` (`a5b0fe35^:vendor/cmini-analyzer/util/consts.py`) | `string.ascii_letters + string.digits + " _-'():~"` | §2.4 — the **space** is in the set but unreachable (the bot splits args on whitespace; 0.1 measured no name with a space) and is excluded here |
| bot `check_name` strings (`util/layout.py`) | `names cannot start with an underscore` · `names must be at least 3 characters long` · ``names cannot contain `<c>` `` (first offending char) | reproduced verbatim (LDB-P7) |
| bot `like` refusal (`cmds/like.py`) | `You can't like Qwerty :yellow_circle:` on `ll.name == 'QWERTY'` | reproduced verbatim on the record named `qwerty` (case-insensitive) |
| upstream names vs `NAME_SET` | 0.1 measured `. ; < >` in live names; none are in `NAME_SET` | confirms LDB-I5: a rename *to* such a name is refused, an imported one is kept |
| Discord `GET /users/@me` | `{ id, username, global_name (nullable), … }`; 401 on a bad/expired token; 429 with `Retry-After` under its per-route bucket | §2.2's cache is what bounds our calls to ≤ 1 per user per 5 min |
| Workers rate-limit binding | per-colo, "permissive", period ∈ {10, 60} s, no miniflare support documented | not used (§2.5) |

## 1. Before the first PR

| need | default if unanswered | blocks |
|---|---|---|
| Second admin's Discord id (`00 §6.4`) | `0002` ships with a `-- TODO second admin` comment; A6 is asserted in tests against a seeded pair; production keeps one row until the id arrives (a follow-up migration `0003_admin2.sql`, data only) | nothing (T3 is testable without it) |
| Preview D1 + R2 | `wrangler d1 create akl-db-preview`, `wrangler r2 bucket create akl-db-dumps-preview` in the community account; ids into `[env.preview]` (§3 T7) | T7 |
| Site Pages Preview env var | `DB_BASE_URL = https://akl-db-preview.<account>.workers.dev` (site PR, not here) | site phase-2 work |

## 2. Cross-cutting contracts (every slice obeys these)

### 2.1 The actor, and the complete phase-2 error vocabulary

`src/auth/actor.ts`:

```ts
export interface Actor { user_id: string; name: string; via: "discord"; admin: boolean }
```

Hono's context carries it as `c.get("actor")` (`Variables: { actor: Actor }`).
`resolveActor(env, request, deps)` (§3 T1) is the only producer. Two
middlewares in `src/index.ts`, registered before any route:

```ts
app.use("/v1/*", requireActorOnWrites);   // method ∉ {GET, HEAD, OPTIONS} → resolveActor or 401
app.get("/v1/me", …);                      // calls resolveActor itself (the one GET that needs it)
```

Errors (`core/errors.ts` grows these constructors; every body has `error`
and `message`, 03 §1):

| status | `error` | extra fields | when |
|---|---|---|---|
| 400 | `bad_request` | `param` | body not an object / fails the route's body schema (unknown key, missing key, wrong type — `param` is the JSON pointer); `If-Match` unparsable; `to` unknown or equal to the current owner; restore of a live record |
| 400 | `invalid_payload` | `path` (+ the format's own details) | the format's `validate` refused — the body is the format's `ValidationResult.error` verbatim |
| 400 | `invalid_name` | `name` | `check_name` refused; `message` is the bot's string (§2.4) |
| 400 | `unsupported_for_format` | `format`, `verb` | PATCH verb the record's format has no `edits` entry for, or its edit returned an error for this payload |
| 400 | `unknown_format` | `format`, `known` | (phase 1) `format` in a POST/PUT body not registered |
| 401 | `unauthorized` | — | no `Authorization` header or not `Bearer <token>`; response also carries `WWW-Authenticate: Bearer` |
| 401 | `token_invalid` | — | Discord answered 401 (cached ≤ 60 s); `WWW-Authenticate: Bearer error="invalid_token"` |
| 403 | `not_owner` | `owner` | `record.owner ≠ actor.user_id` and not admin; `message` = `you don't own a layout named '<name>'` (the bot's voice, `05 §2.1`) |
| 403 | `not_admin` | — | `/v1/admin/*` by a non-admin |
| 404 | `not_found` | `ref` | (phase 1) no live record by that ref — and: restore past 30 days by a non-admin; a tombstone addressed by name |
| 409 | `name_taken` | `name`, `holder: { id, owner }` | `POST`/rename/restore into a live name. `holder` is what `06 §2.2` needs ("whirl is yours, update it instead") |
| 409 | `stale` | `rev`, `record`, `last_write: { seq, at, actor, via, kind, admin }` | `If-Match` ≠ current `rev`, or a concurrent write won the race (§2.3). `record` is the current record with payload; `last_write` is its latest rev-bumping event — what `06 §2.6`'s footer prints ("2 h ago, via the bot") |
| 409 | `last_admins` | `count` | removing an admin would leave < 2 rows |
| 429 | `rate_limited` | `limit`, `window_seconds`, `retry_after` | §2.5; header `Retry-After: <seconds>` |
| 503 | `identity_unavailable` | — | Discord unreachable / 5xx / 429; `Retry-After` copied from Discord when it sent one; never cached |

### 2.2 Bearer verification and its cache

`src/auth/discord.ts` — `resolveBearer(db, now, token, fetchImpl)`:

1. `hash = hex(sha256(token))`; `SELECT user_id, name, ok, expires_at FROM auth_cache WHERE token_hash = ?`; a row with `expires_at > now` answers: `ok = 1` → the actor; `ok = 0` → `401 token_invalid`. No Discord call.
2. Else `GET https://discord.com/api/users/@me` with `Authorization: Bearer <token>`, `User-Agent: akl-db/1.0`, a 5 s `AbortSignal.timeout`. `200 {id, username, global_name}` → upsert `auth_cache (token_hash, user_id, name, ok = 1, expires_at = now + 300 s)` and `authors (user_id, name = global_name ?? username, first_seen_at, last_seen_at)` in one batch; `401` → `auth_cache … ok = 0, expires_at = now + 60 s` (name/user_id NULL), then `401 token_invalid`; `429`/`5xx`/network/timeout/non-JSON → `503 identity_unavailable` with Discord's `Retry-After` copied when present, **nothing cached**.
3. `admin = EXISTS (SELECT 1 FROM admins WHERE user_id = ?)` — one read per authenticated request, so `/v1/me` and every authorization check read the same value.

Cost: one D1 read per authenticated request plus one write per (token, 5 min).
The nightly cron (`0 3 * * *`, S7's dispatch) runs `DELETE FROM auth_cache
WHERE expires_at < ?`. A token is never stored — only its hash, only for
the cache window. `fetchImpl` is injected exactly as the import's is
(`FetchImpl` from `import/upstream.ts`, reused), so tests fake Discord with a
plain function and never touch the network.

### 2.3 `If-Match`, and how "exactly one wins" actually holds

`src/core/ifmatch.ts` — `parseIfMatch(header: string | null): { kind: "absent" } | { kind: "any" } | { kind: "rev", rev: number }`:
`"3"` (quoted, RFC 7232 strong form — what the site sends) and bare `3`
both parse to `rev: 3`; `*` → `any`; `W/"3"`, a list, or anything else →
`400 bad_request param If-Match`. Absent and `*` both mean *overwrite on
purpose* (`03 §1`, `06 §2.6`). Every 2xx response that returns a record
carries `ETag: "<rev>"` so a client can chain writes without re-reading.

The guarantee LDB-P2 makes is two-layered, and the brief says which layer
does what:

1. **Pre-check** (`core/write.ts`): the record is read; `ifMatch.rev ≠
   record.rev` → `409 stale` with that record. This is the common path
   (the site's draft is behind) and costs no write.
2. **The guard** (`core/events.ts`, unchanged from phase 1): the batch's
   `INSERT INTO layout_revs (layout_id, rev)` hits the PK when another
   write committed `rev + 1` between the read and the batch; the whole
   batch rolls back (0.1). `appendWrite` catches the D1 error whose message
   matches `UNIQUE constraint failed: layout_revs.layout_id, layout_revs.rev`
   and throws `RevConflict`; `core/write.ts` re-reads the record and answers
   `409 stale` with the *winner's* record. This is why an overwrite (`absent`/`*`)
   can still get a 409: overwrite means "ignore my stale rev", not "ignore a
   write that landed this millisecond" — the client simply retries.

Same mechanism for names: T2 changes `appendWrite`'s `layouts` statement to

```sql
INSERT INTO layouts (…) VALUES (…)
ON CONFLICT(id) DO UPDATE SET name = excluded.name, owner = excluded.owner, rev = excluded.rev,
  modified_at = excluded.modified_at, deleted = excluded.deleted, format = excluded.format,
  payload_json = excluded.payload_json, like_count = excluded.like_count, has_magic = excluded.has_magic
```

so a conflict on `layouts_name_live` (two `POST`s racing on one name, or a
rename racing a create) is a `UNIQUE constraint failed: layouts.name` error
— the batch rolls back, `appendWrite` maps it to `nameTaken`, nothing is
deleted. The pre-check `SELECT` stays (it produces the `holder` field).
`tests/tools/onlywriter.test.ts`'s pattern gains `ON CONFLICT` so the
boundary test keeps matching the new statement.

### 2.4 `check_name` (`src/core/names.ts`)

`checkName(name: string): { ok: true } | { ok: false; message: string }`,
the bot's `util/layout.check_name` ported rule for rule, in the bot's
order, plus two rules of ours after it:

| # | rule | `message` (verbatim) |
|---|---|---|
| 1 | first char is `_` | `names cannot start with an underscore` |
| 2 | length < 3 | `names must be at least 3 characters long` |
| 3 | a char ∉ `NAME_SET′` | ``names cannot contain `<c>` `` — `<c>` is the first offending char in string order (the bot's `set` order is unspecified; ours is deterministic and the test pins it) |
| 4 | length > 64 | `names must be at most 64 characters long` (ours; no bot rule — 0.1 measured ≤ 65 upstream, this caps new writes only) |
| 5 | matches `^[0-7][0-9A-HJKMNP-TV-Z]{25}$` case-insensitively | `names cannot look like a layout id` (ours; `03 §1`) |

`NAME_SET′` = `A–Z a–z 0–9 _ - ' ( ) : ~` — the bot's set **minus the
space** (0.1). Rules 1–3 first so a bot user sees the bot's own message for
the bot's own cases. Applied by `POST` and `PATCH {name}` only; `restore`
keeps the tombstone's literal name without checking it (it was valid or
imported); imported names are never checked (LDB-I5). Uniqueness is not
`check_name`'s job — it is `appendWrite`'s (`name_taken`).

### 2.5 The write rate limit (`src/core/ratelimit.ts`)

Writes only, per resolved `user_id`, fixed 10-minute windows, 60 per
window (`03 §1`), counted on **every attempt** (accepted or refused —
after `requireActor`, before body parsing, so a flood costs one D1
statement and nothing else). One atomic statement:

```sql
INSERT INTO ratelimit (key, window_start, n) VALUES (?1, ?2, 1)
ON CONFLICT(key) DO UPDATE SET
  n = CASE WHEN window_start = excluded.window_start THEN n + 1 ELSE 1 END,
  window_start = excluded.window_start
RETURNING n, window_start
```

`key = 'write:' || user_id`, `window_start = floor(epochSeconds(now) / 600) * 600`.
`n > 60` → `429 rate_limited { limit: 60, window_seconds: 600, retry_after: window_start + 600 − now }`
with `Retry-After`. Likes count as writes. Admin routes count as writes.
The nightly cron deletes rows with `window_start < now − 1200`. Cost: one D1
write per write attempt — proportional to the work it protects, which is
the property poll limiting in D1 lacks (§7). The Workers rate-limit binding
is not used: per-colo and permissive by design (0.1), and there is no way
to drive it under pool-workers; a fixed-window row in the same database is
exact, testable with the fixed clock, and rehost-portable.

### 2.6 The write pipeline (`src/core/write.ts`) and strict bodies

Every verb is one function with the same spine — **resolve → authorize →
check → `appendWrite`** — and `src/routes/write.ts` is glue only: parse,
call, `c.json(toWire(record), status, { ETag })`. No route file touches D1
(`tests/tools/routes-noprepare.test.ts`, LDB-W1).

```ts
loadForWrite(db, ref, actor, opts: { allowDeleted: boolean }): Promise<{ record: RecordRow; admin: boolean }>
  // byRef; a tombstone is reachable only by id and only when allowDeleted (restore); not found → 404 not_found;
  // record.owner ≠ actor.user_id → admin ? { admin: true } : throw 403 not_owner
requireRev(record, ifMatch): void                 // 409 stale (pre-check, §2.3)
validatePayload(format, payload): { module, hasMagic }   // 400 unknown_format | 400 invalid_payload
createLayout(env, now, actor, body: { name; format; payload })                          → kind created
replaceLayout(env, now, actor, ref, body: { format; payload }, ifMatch)                 → kind updated
patchLayout(env, now, actor, ref, body: PatchBody, ifMatch)                             → kind renamed | fingermap | updated  (T4)
deleteLayout(env, now, actor, ref, ifMatch)                                             → kind deleted   (deleted: true, payload kept)
restoreLayout(env, now, actor, ref)                                                     → kind restored  (deleted: false)
transferLayout(env, now, actor, ref, body: { to })                                      → kind transferred
```

Every `Write` built here has `actor: actor.user_id`, `via: "discord"`,
`admin: <true iff the owner check passed only because the actor is admin>`,
`modified_at: now()`, `hasMagic` from the format. The error mapping for
D1 constraint failures (§2.3) lives in `appendWrite`/`appendLike`, not
here.

Bodies are validated by a JSON Schema per route (`src/routes/schemas.ts`,
ajv as in phase 1, `additionalProperties: false`, `required` exact). A
body carrying `owner` — or `id`, `rev`, `created_at`, anything that is not
in the verb's schema — is `400 bad_request` with `param: "/owner"`. This is
how LDB-A7 is enforced: the owner field is not "ignored", it is refused,
so a client that thinks it can set it finds out. `transfer` is the only
route whose schema names a user id.

## 3. Slices — PRs in order

Order: T1 → T2 → {T3, T4, T5} (parallel; each needs T2) → T6 → T7. Every
slice's PR adds its rows to `db/INVARIANTS.md`, tags each enforcing test's
title with the id (`[LDB-A1]`), extends `tests/api/conformance.test.ts`'s
enumeration with its (route, status) pairs (§4 — T6 is the sweep that
proves none are missing) and passes `npm test` + `db.yml`. **T2 needs S6**
(`routes/layouts.ts`, `byRef`, `toWire`, `app.onError`); T1 needs only S1.

### T1 — the user lane, `/v1/me`, migration `0002`

**Lands:** `src/auth/{discord,actor}.ts` (§2.1–2.2), `GET /v1/me`,
`migrations/0002_phase2.sql`, `core/errors.ts` +`unauthorized tokenInvalid
identityUnavailable notOwner notAdmin`, the `onError` status union widened,
`Bindings` +`DISCORD_API_URL` (var, default `https://discord.com/api`; tests
point it at nothing — `fetchImpl` is injected — but the runbook table
needs the row, LDB-G4), the nightly `auth_cache` prune in `scheduled()`,
`tests/auth/**/*.test.ts` added to the `workers` project's `include` in
`vitest.config.ts` (the only config change phase 2 makes; `tests/tools`
is already in `node`).

```sql
-- migrations/0002_phase2.sql
CREATE TABLE auth_cache (
  token_hash TEXT PRIMARY KEY,       -- hex sha256 of the bearer; the token itself is never stored
  user_id    TEXT,                   -- NULL on a cached failure
  name       TEXT,
  ok         INTEGER NOT NULL,       -- 1 = Discord said 200 (5 min); 0 = Discord said 401 (60 s)
  expires_at TEXT NOT NULL
);
CREATE INDEX auth_cache_expires ON auth_cache(expires_at);

CREATE TABLE ratelimit (
  key          TEXT PRIMARY KEY,     -- 'write:<user_id>'
  window_start INTEGER NOT NULL,     -- epoch seconds, floor(now/600)*600
  n            INTEGER NOT NULL
);

-- Second admin (00 §6.4). Data, not code (LDB-G2).
-- TODO(saltorbit): INSERT INTO admins VALUES ('<discord id>', '184412255822020608', '<iso>', 'bootstrap: <name>');
```

`GET /v1/me` → `200 { user_id, name, via: "discord", admin }`; every 401/503
of §2.1 applies. `resolveActor(env, request, deps: { fetchImpl, now })`
= header parse → `resolveBearer` → `Actor`.

| file (project) | asserts | invariant |
|---|---|---|
| `tests/auth/discord.test.ts` (workers; Discord = a `FakeDiscord` class with a request log, injected as `fetchImpl`) | matrix over Discord's answer × cache state: `200` → actor, one Discord request, `authors` row upserted (name = `global_name`, falls back to `username` when null; `last_seen_at` = clock); second call inside 300 s → no request; at 300 s + 1 → one request; `401` → `token_invalid`, second call inside 60 s → no request, at 61 s → one request; `429 Retry-After: 7` → `503` with `Retry-After: 7` and **no** cache row; `500`, thrown fetch, timeout, non-JSON body → `503`, no cache row; two different tokens for one user → two cache rows, one `authors` row; the token string never appears in any table (`SELECT` every column of `auth_cache` and `authors`) | **LDB-A2** |
| `tests/auth/routes.test.ts` (workers) | enumerates `app.routes` (exported from `src/index.ts` for tests) and for **every** entry whose method ∉ {GET, HEAD, OPTIONS}, substitutes `01ARZ3NDEKTSV4RRFFQ69G5FAV` for `:ref`-style params and sends it with (a) no header → `401 unauthorized` + `WWW-Authenticate: Bearer`, (b) `Authorization: Basic x` → `401 unauthorized`, (c) a bearer Discord rejects → `401 token_invalid`; the test fails if `app.routes` has zero write routes (guards against the enumeration going empty). Black-box: the middleware's presence is proved by behaviour, not by inspecting Hono internals | **LDB-A1** |
| `tests/api/me.test.ts` (workers) | body shape; `admin: true` iff a row in `admins` (seed a second row in the test, then `DELETE` it, re-check); `via` is `discord`; 401/503 bodies match §2.1 | LDB-A2 (the `admin` read is one query — asserted via a D1 statement counter proxy on `env.DB`) |
| `tests/tools/runbook.test.ts` (S7's; extended — or, if T1 lands first, T1 adds the README row and S7's test finds it) | `DISCORD_API_URL` in the README table | LDB-G4 |
| `tests/import/tick.test.ts` (extended) | the nightly cron deletes expired `auth_cache` rows and keeps live ones | — |

**DoD:** green; `curl -H "Authorization: Bearer <a real Discord token>" localhost:8787/v1/me` answers with saltorbit's id; `admins` row count unchanged in production.

### T2 — write verbs on the record

**Lands:** `src/core/{write,names,ifmatch}.ts` (§2.3–2.6), `src/routes/{write,schemas}.ts`, the `appendWrite` change (§2.3: `ON CONFLICT(id) DO UPDATE`, D1-error mapping to `nameTaken`/`RevConflict`), `core/errors.ts` +`invalidName nameTaken(holder) stale(record, lastWrite) unsupportedForFormat`, `ETag` on 2xx record responses.

```
POST   /v1/layouts                  { name, format, payload }            → 201 record   kind created    rev 1, created_at = modified_at = now
PUT    /v1/layouts/{ref}            { format, payload }        If-Match  → 200 record   kind updated    name/owner/created_at kept; format may change
DELETE /v1/layouts/{ref}                                       If-Match  → 200 record   kind deleted    deleted: true, payload/format/name kept, modified_at = now
POST   /v1/layouts/{ref}/restore                                         → 200 record   kind restored   {ref} must be the id (a tombstone has no live name)
POST   /v1/layouts/{ref}/transfer   { to }                               → 200 record   kind transferred
```

Rules, exactly:

- `POST`: schema → `check_name` (`400 invalid_name`) → `validatePayload` → `appendWrite` (its pre-check → `409 name_taken` with `holder` from `readByName`).
- `PUT`: `loadForWrite` → `requireRev` → `validatePayload` (the **new** format validates) → `appendWrite` with `name/owner/created_at` from the current record.
- `DELETE`: `loadForWrite` → `requireRev` → `appendWrite({ deleted: true, …current })`.
- `restore`: `loadForWrite(allowDeleted: true)`; the record must be `deleted` (`400 bad_request param ref`, message `'<name>' is not deleted`); `now − record.modified_at ≤ 30 d` unless admin (else `404 not_found`); `appendWrite({ kind: "restored", deleted: false, …the tombstone's name/format/payload })` — a live holder of the name → `409 name_taken`. No `If-Match` (a tombstone has one possible next state). A restore by the owner of an `upstream_deleted` tombstone is allowed and, carrying `via: discord`, stops the record following upstream (LDB-I2a) — the import will not re-delete it.
- `transfer`: `loadForWrite` (owner or admin; **no `If-Match`** — ownership has no draft to be stale); `to` must be a 17–20-digit string with an `authors` row (`400 bad_request param to`, message `unknown user '<to>'`) and ≠ current owner (`already the owner`); `appendWrite({ kind: "transferred", owner: to, …current })`.
- Authorization is `02 §4`: create → any actor; the rest → owner or admin (`admin: true` on the event only when the actor is not the owner).

| file (workers) | asserts | invariant |
|---|---|---|
| `tests/api/write.test.ts` | **generated matrix** over verb ∈ {POST, PUT, DELETE, restore, transfer} × actor ∈ {owner, other user, admin (non-owner), anonymous} × format ∈ {cmini/1, akl/1}: the expected status per `02 §4` (POST: 201 for any actor; PUT/DELETE/restore/transfer: 200 owner, 403 `not_owner` other, 200 admin with the event's `admin = 1`, 401 anonymous), and for every 2xx: exactly one new event with `kind`, `via: discord`, `actor`, `rev + 1` (POST: 1), `before`/`after` equal to the records before/after, `layout_revs` row present, `has_magic` = `hasMagic(payload)`, `ETag: "<rev>"`; for every non-2xx: zero new events and the `layouts` row byte-equal (`canonical`) to before | **LDB-A7** (via strict bodies), LDB-P1 (route-level), LDB-A5 (`via`) |
| `tests/api/bodies.test.ts` | for every write route × every key ∉ its schema (incl. `owner`, `id`, `rev`, `created_at`, `like_count`) → `400 bad_request` with `param` naming it; missing required key → 400; `payload` not an object → 400; non-JSON body → 400; `Content-Type` absent but body valid JSON → accepted (the site's proxy forwards whatever it got) | **LDB-A7** |
| `tests/api/ifmatch.test.ts` | matrix over header ∈ {absent, `*`, `"<rev>"`, `<rev>`, `"<rev−1>"`, `"<rev+1>"`, `W/"<rev>"`, `"a"`} × verb ∈ {PUT, DELETE}: 200/200/200/200/409/409/400/400; the 409 body has `rev`, `record` (with payload) and `last_write` equal to the record's latest rev-bumping event; **race:** `Promise.all` of two PUTs at the same rev with different payloads → exactly one 200 and one 409 `stale` whose `record` equals the 200's; the `layouts` row equals the fold; exactly one new event; `seq` gapless; same with both `If-Match` absent (overwrite still loses a race, §2.3) | **LDB-P2** |
| `tests/api/names.test.ts` | table over `check_name` (each rule × a passing and a failing name; the exact `message`; rule order: `_ab` says underscore not length); rule 3's first-offender determinism (`a.b;c` → `` `.` ``); `POST` with an existing name in any case → `409 name_taken` with `holder`; **race:** two `POST`s with one name → one 201, one 409; afterwards one `layouts` row, its events fold, no orphan `layout_revs` (P4's "release only by delete or rename" — the OR REPLACE defect would have deleted a record here); imported names outside `NAME_SET′` (`AdNW`, `io`, the apostrophe name, a `.` name seeded via `appendWrite`) survive a PUT untouched | **LDB-N1**, LDB-P4, LDB-I5 |
| `tests/api/restore.test.ts` (stepping clock) | delete → by name 404, by id 200 `deleted: true` → restore at +29 d 23 h → 200, same name/payload/format, `rev + 1`, live by name; at +30 d + 1 s → 404 for the owner, 200 for an admin (`admin: 1`); restore of a live record → 400; a live record took the name meanwhile → 409 `name_taken` with `holder`; restore by name → 404; owner restores an `upstream_deleted` tombstone → 200 and `followsUpstream` is now false | **LDB-P8** (both halves) |
| `tests/api/transfer.test.ts` | `to` unknown → 400; `to` = owner → 400; `to` known → 200, `owner` moved, event `transferred` with `before.owner`/`after.owner`; the new owner can PUT, the old gets 403; admin transfers a stranger's record (`admin: 1`) | LDB-A7 |
| `tests/events/fold.test.ts` (extended) | the property now also mixes `Promise.all` pairs of writes on one slot; after every run the fold still equals the row (the guard's rollback is what makes this hold) | LDB-P1 |

**DoD:** green; `onlywriter.test.ts` still names only `events.ts`; `npm run dev` + a real bearer: `POST` → 201, `PUT` with the returned `ETag` → 200, again with the old one → 409.

### T3 — admins as data

**Lands:** `src/routes/admin.ts`, `src/core/admins.ts` (`isAdmin`, `add`, `remove`), `InfoKind` +`admin.added admin.removed admin.import_paused admin.import_resumed` (recorded with `appendInfo`-shaped rows whose `layout_id` is NULL — `events.ts` grows `appendAdmin(db, now, { kind, actor, detail })`, the third informational writer, `rev NULL`, `admin = 1`).

```
GET    /v1/admin/admins                       → 200 [{ user_id, added_by, added_at, note }]
POST   /v1/admin/admins    { user_id, note? }  → 201 the row            event admin.added    detail { user_id, note }
DELETE /v1/admin/admins/{user_id}             → 200 { removed: user_id } event admin.removed  detail { user_id }; 409 last_admins when COUNT(*) ≤ 2
POST   /v1/admin/import/pause                 → 200 { paused: true }    event admin.import_paused;  import_state.cmini.paused = '1'
POST   /v1/admin/import/resume                → 200 { paused: false }   event admin.import_resumed; key deleted
```

All under `requireActorOnWrites` (the `GET` calls `resolveActor` itself and
requires `admin`); non-admin → `403 not_admin`. Adding an existing admin →
`200` idempotent, no event. `user_id` must be 17–20 digits. Force
delete/restore/transfer need no admin route — the ordinary verbs already
pass an admin with `admin: 1` (T2). The A6 check is `DELETE … WHERE user_id
= ? AND (SELECT COUNT(*) FROM admins) > 2` in the same batch as the event,
with `changes = 0` → `409 last_admins` (no TOCTOU: the count and the
delete are one statement).

| file (workers) | asserts | invariant |
|---|---|---|
| `tests/api/admin.test.ts` | every admin route × {anonymous 401, user 403, admin 200/201}; add → row + event `admin.added` (`admin = 1`, `actor`, `rev NULL`, `layout_id NULL`); add twice → idempotent; remove with 3 rows → 200; remove with 2 rows → 409 `last_admins` in **both** orderings (remove self, remove the other); **race:** `Promise.all` of two removes at 3 rows → one 200, one 409; pause → `tick()` returns `{quiet: true}` and made no upstream request (FakeUpstream log empty); resume → the next tick runs; every admin event appears in `/v1/changes?kinds=admin.added,…` | **LDB-A6**, **LDB-A5** (admin half) |
| `tests/tools/noconst.test.ts` | unchanged; still no id literal under `src/` after T3 | LDB-G2 |
| `tests/events/feed.test.ts` (extended) | admin events (NULL `layout_id`) round-trip through `feed()`/`rowToEvent` | LDB-P6 |

**DoD:** green; on preview (T7) saltorbit adds the second admin through the route, not SQL, and the changelog (`/v1/changes?kinds=admin.added`) shows it.

### T4 — `PATCH` verbs and the format `edits` slot

**Lands:** `FormatModule.edits?` in `formats/registry.ts`, `formats/cmini/1/edits.ts` and `formats/akl/1/edits.ts` (re-exported from each `index.ts` as `edits`), `patchLayout` in `core/write.ts`, `PATCH /v1/layouts/{ref}`.

```ts
// registry.ts — the optional slot 07 §10 reserved
export type EditResult = Payload | { error: ErrBody };            // error → 400 unsupported_for_format (verb named) unless error.error === "invalid_payload"
export interface FormatEdits {
  setFingermap?(p: Payload, map: Record<string, string>): EditResult;   // char → finger; chars must exist in p.keys (else invalid_payload, path /keys/<c>); partial maps allowed
  setBoard?(p: Payload, board: unknown): EditResult;                    // board is an akl/1 `board` object (01 §2) — the API's one board vocabulary
  setMagic?(p: Payload, magic: unknown): EditResult;                    // magic is an akl/1 `magic` object
}
export interface FormatModule { …; edits?: FormatEdits }
```

Pure: never mutate the input (structured-clone first), never throw, and
the result must satisfy the format's own `validate` (the pipeline re-runs
it — an edit that produces an invalid payload is a format bug the test
catches). Per format:

| verb | `cmini/1` | `akl/1` |
|---|---|---|
| `fingermap` | `keys[c].finger = map[c]` | same |
| `board` | `board = board.cmini ?? derive(board)` where `derive` is `to["cmini/1"]`'s rule (01 §6.2); a colstag board without a `cmini` word → error (`unsupported_for_format`) | `board = board` (validated as a whole) |
| `magic` | not provided → `400 unsupported_for_format` (03 §3: akl/1 only; a cmini/1 owner moves to akl/1 with a PUT first) | `magic = magic` |
| `name` | record-level, no format code | — |

`PATCH /v1/layouts/{ref}` body: one or more of `{ name, fingermap, board,
magic }` (schema: at least one key, no others), `If-Match` honoured,
applied in that order to a clone of the payload, validated once at the
end, **one event**: `kind = renamed` when the body is exactly `{name}`,
`fingermap` when exactly `{fingermap}`, else `updated` with `detail:
{ fields: [<body keys in order>] }`. `name` goes through `check_name`
and may differ from the current name only by case (still `renamed`; the
`appendWrite` self-exclusion allows it). A verb the format lacks →
`400 unsupported_for_format { format, verb }` and nothing applied.

| file | asserts | invariant |
|---|---|---|
| `tests/formats/edits.test.ts` (node; generated from the registry × its fixtures) | for every format with `edits` and every fixture `p`: **identity** — `setFingermap(p, fingermapOf(p))` deep-equals `p`; **purity** — `p` deep-equals its pre-call clone after every edit; **validity** — every edit that returns a payload returns one `validate` accepts; **fingermap**: a map naming a char ∉ `keys` → `{error: {error: "invalid_payload", path: "/keys/<c>"}}`, a bad finger word → the format's own `validate` error at `/keys/<c>/finger`, a partial map changes exactly the named chars; **board** (cmini/1): every akl fixture's `board` → the same word `to["cmini/1"]` produces; `900-colstag` (no `cmini` word) → error; **magic** (akl/1): `lower(setMagic(p, m))` deep-equals `lower({…p, magic: m})`; property (fast-check over random fingermaps drawn from `keys` × the finger enum): `setFingermap` then `fingermapOf` is the map | **LDB-E1** |
| `tests/api/patch.test.ts` (workers) | matrix over verb ∈ {name, fingermap, board, magic} × format: status (200 or 400 `unsupported_for_format` for magic on cmini/1 and colstag-board on cmini/1), `kind`, `rev + 1`, the payload's changed field, `If-Match` stale → 409; combined `{name, fingermap}` → one event `updated` with `detail.fields = ["name","fingermap"]`; `{}` → 400; an unknown key → 400; rename to a taken name → 409 `name_taken` with `holder`; rename frees the old name in the same request (a `POST` with it immediately after → 201); rename by case only → 200 `renamed`; invalid name → 400 `invalid_name` with the bot's message; a failing later verb leaves the earlier ones unapplied (one batch or nothing) | LDB-P1, LDB-P4, LDB-N1, LDB-P7 |

**DoD:** green; the bot's `!rename` / `!setfingermap` are one `PATCH` each (`05 §2.1`).

### T5 — likes and the write rate limit

**Lands:** `PUT/DELETE /v1/layouts/{ref}/like`, the `appendLike` fixes (0.1: `UPDATE layouts SET like_count = like_count + 1 / − 1`; a `UNIQUE constraint failed: likes.…` from a same-user race is caught and answered as the idempotent no-op with the current count), `src/core/ratelimit.ts` (§2.5), `rateLimitWrites` middleware between `requireActorOnWrites` and the routes, the nightly `ratelimit` prune.

```
PUT    /v1/layouts/{ref}/like    → 200 { like_count }   event liked   (via discord, actor = user)   no event when already liked
DELETE /v1/layouts/{ref}/like    → 200 { like_count }   event unliked                              no event when not liked
```

Any actor, own layout included (`03 §10` Q2: parity). `qwerty` (the record
whose name is `qwerty` case-insensitively) → `400 bad_request { param:
"ref" }` with `message: "You can't like Qwerty :yellow_circle:"` (0.1,
verbatim — the bot prints `message`). A tombstone → 404. No `If-Match`
(likes have no `rev`).

| file (workers) | asserts | invariant |
|---|---|---|
| `tests/api/likes.test.ts` | like → 200 `{like_count: 1}`, one `liked` event (`rev NULL`, `via discord`, `actor`), `likes` row; like again → 200, **no** event; unlike ×2 → one `unliked`, 0; `rev`, `modified_at`, `layouts_modified_at` unchanged across all of it, `/v1/meta.revision` and `seq` moved (**LDB-L1**); `?as=cmini/1` `likes` sorted; `qwerty` → 400 with the exact string (seeded by `appendWrite`, name `QWERTY`); tombstone → 404; anonymous → 401; **races:** `Promise.all` of 5 different users liking → `like_count = 5` and 5 rows (the relative UPDATE); the same user twice at once → one event, count 1, both 200; the fold equals the row after every case | **LDB-L1**, LDB-P1 |
| `tests/api/ratelimit.test.ts` (fixed clock, advanced by hand) | 60 writes in a window → all pass; the 61st → 429 `rate_limited` with `Retry-After` = seconds to the window edge and the body fields; a refused-for-other-reasons write (400) still counts; at `window_start + 600` the counter is 1 again; two actors have independent counters; a `GET` never counts (the `ratelimit` table has no row for a read-only actor); likes and admin routes count; the nightly cron deletes rows older than two windows | **LDB-R6** |

**DoD:** green; `onlywriter.test.ts` unchanged (the relative UPDATE is still in `events.ts`).

### T6 — conformance sweep and the registry

**Lands:** every (route, status) pair of §4 as a case under
`tests/conformance/<route>/<case>.json`; the enumeration in
`tests/api/conformance.test.ts` (S6) extended to derive the expected pairs
from `app.routes` × the error table (§2.1 + S6's) × a per-route "applies"
map kept **in the test**; the phase-2 rows in `db/INVARIANTS.md`; `02`/`03`'s
invariant tables back-filled (§5).

| file | asserts | invariant |
|---|---|---|
| `tests/api/conformance.test.ts` (extended) | seeds `upstream-100` at the fixed clock plus one deleted record, one admin pair, one `qwerty`; for every case: request (with `Authorization` resolved through a `FakeDiscord` whose tokens are named in the fixture, e.g. `"bearer": "owner-of-graphite"`) → status, listed headers (`ETag`, `WWW-Authenticate`, `Retry-After`), body deep-equal after `canonical` (ids and `at` normalised by the seed's fixed clock and a deterministic `ulid` seed — the test monkeypatches `ulidx`'s `ulid` via an injected `newId` on `appendWrite`); a (route, status) pair in §4 with no case fails; a case for a pair not in §4 fails | **LDB-P7**, **LDB-R3** |
| `tests/tools/invariants.test.ts` | unchanged — fails until every §5 id has a tagged test | LDB-T1 |

**DoD:** `tests/conformance/` has ≥ 1 case per pair in §4; `INVARIANTS.md` lists every §5 id; `design/INVARIANTS.md`'s pointer entry unchanged.

### T7 — the preview environment

**Lands:** `[env.preview]` in `wrangler.toml` (Wrangler environments do
**not** inherit `d1_databases`, `r2_buckets` or `vars` — every binding is
redeclared under `[env.preview]` with the same binding names: `DB` →
`akl-db-preview`, `DUMPS` → `akl-db-dumps-preview`, `IMPORT_SOURCE_URL` =
upstream so preview has real data, the same crons); the Worker name is
`akl-db-preview` → `https://akl-db-preview.<account>.workers.dev`; `db.yml`
job `preview` (`needs: test`, `if: github.event_name == 'push' &&
github.ref == 'refs/heads/worktree-layout-db'`, steps `wrangler d1
migrations apply akl-db-preview --env preview --remote` then `wrangler
deploy --env preview`); README runbook rows for both. **The preview DB is
the only DB the site's phase-2 work writes to**; production stays
read-only-by-humans until phase 3 (no site proxy points at it).

| file | asserts | invariant |
|---|---|---|
| `tests/tools/ciwiring.test.ts` (extended) | `preview` job: `needs: test`, the exact `if`, migrations before deploy, `--env preview` on both; the `deploy` job's `if` is unchanged (main only) | LDB-C1 |
| `tests/tools/runbook.test.ts` (extended) | every `[env.*]` section declares the same binding names and `vars` keys as the top level (a binding present in one and not the other fails); each env's D1/R2 names appear in the README table | LDB-G4 |

**DoD:** `GET https://akl-db-preview.<account>.workers.dev/v1/meta` answers with `layout_count` = upstream's; `/v1/me` with saltorbit's token; the site's Pages Preview `DB_BASE_URL` points at it (site PR).

## 4. Conformance enumeration (route × status) — the T6 sweep

Phase-1 routes keep S6's pairs. Phase 2 adds exactly these; `T6` fails on a
missing or extra pair. `A` = 401 `unauthorized` + 401 `token_invalid` + 503
`identity_unavailable` (every authenticated route has all three).

| route | 2xx | errors |
|---|---|---|
| `GET /v1/me` | 200 | A |
| `POST /v1/layouts` | 201 | A, 400 `bad_request`, 400 `invalid_name`, 400 `invalid_payload`, 400 `unknown_format`, 409 `name_taken`, 429 |
| `PUT /v1/layouts/{ref}` | 200 | A, 400 `bad_request` (body, `If-Match`), 400 `invalid_payload`, 400 `unknown_format`, 403 `not_owner`, 404, 409 `stale`, 429 |
| `PATCH /v1/layouts/{ref}` | 200 (`renamed`, `fingermap`, `updated` — three cases) | A, 400 `bad_request`, 400 `invalid_name`, 400 `invalid_payload`, 400 `unsupported_for_format`, 403, 404, 409 `name_taken`, 409 `stale`, 429 |
| `DELETE /v1/layouts/{ref}` | 200 | A, 400 `bad_request` (`If-Match`), 403, 404, 409 `stale`, 429 |
| `POST /v1/layouts/{ref}/restore` | 200 | A, 400 `bad_request` (live record), 403, 404 (unknown; by name; past 30 d), 409 `name_taken`, 429 |
| `POST /v1/layouts/{ref}/transfer` | 200 | A, 400 `bad_request` (`to`), 403, 404, 429 |
| `PUT /v1/layouts/{ref}/like` · `DELETE …/like` | 200 (changed) · 200 (no-op) | A, 400 `bad_request` (qwerty), 404, 429 |
| `GET /v1/admin/admins` | 200 | A, 403 `not_admin` |
| `POST /v1/admin/admins` | 201 · 200 (idempotent) | A, 400, 403, 429 |
| `DELETE /v1/admin/admins/{user_id}` | 200 | A, 403, 404, 409 `last_admins`, 429 |
| `POST /v1/admin/import/pause` · `/resume` | 200 | A, 403, 429 |

## 5. Invariants added (phase 2) — rows for `db/INVARIANTS.md`

Ids from `02`/`03` keep their numbers; new ones are `LDB-N1`, `LDB-W1`,
`LDB-E1`, `LDB-L1`, `LDB-R6`, back-filled into those docs' tables.

| id | invariant | enforced by |
|---|---|---|
| LDB-A1 | No write is accepted without a resolved actor; every non-GET route answers 401 to an anonymous request (enumerated from the router) | `tests/auth/routes.test.ts` |
| LDB-A2 | The Discord cache serves a success ≤ 5 min and a 401 ≤ 60 s; 5xx/429/network are never cached; the token is never stored | `tests/auth/discord.test.ts` |
| LDB-A5 (admin half) | Every accepted write's event carries `via`; every admin action is an event with `admin = 1` | `tests/api/write.test.ts`, `tests/api/admin.test.ts` |
| LDB-A6 | The admins table never drops below two rows after bootstrap (count and delete are one statement) | `tests/api/admin.test.ts` |
| LDB-A7 | Owner changes only via `transfer`; a write body naming `owner` (or any field outside the verb's schema) is refused | `tests/api/bodies.test.ts`, `tests/api/write.test.ts`, `tests/api/transfer.test.ts` |
| LDB-P2 | An `If-Match` mismatch writes nothing and returns the current record; two writes at one `rev` → exactly one commits, the other gets `stale` with the winner's record; the guard is `layout_revs`' PK inside the batch | `tests/api/ifmatch.test.ts`, `tests/events/fold.test.ts` |
| LDB-P4 (phase-2 half) | A name race yields one record and never deletes another (`ON CONFLICT(id)`, not `OR REPLACE`) | `tests/api/names.test.ts` |
| LDB-P8 (full) | A tombstone is unreadable by name from deletion and restorable by id for 30 days by its owner (any time by an admin), keeping name, format, payload and history | `tests/api/restore.test.ts` |
| LDB-N1 | `check_name` is the bot's rule set with the bot's strings, plus the length cap and the ULID-shape refusal, applied to `POST` and rename only | `tests/api/names.test.ts`, `tests/api/patch.test.ts` |
| LDB-W1 | Every write route is resolve → authorize → check → `appendWrite`; no file under `src/routes/` prepares a D1 statement | `tests/tools/routes-noprepare.test.ts` (grep: no `.prepare(`/`.batch(` under `src/routes/`) |
| LDB-E1 | Format edits are pure, identity on their own projection, and validity-preserving | `tests/formats/edits.test.ts` |
| LDB-L1 | Likes move `like_count`, `likes` and `meta.revision`/`seq` only — never `rev`, `modified_at` or `layouts_modified_at`; concurrent likes are counted exactly | `tests/api/likes.test.ts` |
| LDB-R6 | Writes are limited to 60 per 10-minute window per actor, counted per attempt, with `429` + `Retry-After`; reads are never counted | `tests/api/ratelimit.test.ts` |

## 6. Decisions taken in this round (ledger; flip any of them)

1. **`Idempotency-Key` cut.** Name uniqueness is the natural idempotency
   guard for `POST`: a retried create hits `409 name_taken` whose `holder`
   is the caller's own record, which is exactly the recovery `06 §3.8`'s
   "boot re-check by name/id" performs. `PUT`/`PATCH`/`DELETE` are already
   idempotent by `rev`. `03 §1`'s sentence is removed.
2. **Poll rate limiting cut from phase 2; no anonymous limits.** A D1
   counter per poll turns every cheap 304 (one indexed read) into a write,
   and a per-IP row is a write-amplification lever anyone can pull. The
   ETag/304 path plus `Cache-Control` is the phase-2 poll defence; the
   zone-level rate-limiting rule (a WAF rule, zero code) arrives with the
   hostname (`00 §6.2`). `03 §5`'s "one request per 10 s per endpoint"
   moves to that.
3. **Write limit in D1, one atomic statement, counted per attempt** (§2.5).
4. **`owner` in a body is refused (400), not ignored** — strict per-route
   schemas (§2.6). `02 §6` A7's enforcement line is reworded.
5. **`stale` carries `last_write`; `name_taken` carries `holder`** — the
   two fields the approved site UX needs and `03` did not promise.
6. **`check_name` charset excludes the space; max length 64** (§2.4).
7. **Restore after 30 days: admin may, owner may not** (`404` for the
   owner — the row is still there for the admin lane).
8. **`transfer` has no `If-Match`**; `to` must have an `authors` row (an
   author or someone who has signed in once — T1's upsert makes sign-in
   sufficient).
9. **`PATCH {board}` on `cmini/1` is allowed when a cmini word is present or derivable** (`03 §10` Q1 → allow); `{magic}` on `cmini/1` stays unsupported.
10. **`ETag: "<rev>"` on write responses**, not on `GET /v1/layouts/{ref}`
    (whose body carries `rev`; a conditional-GET contract on the detail is
    not needed by anyone yet).
11. **The concurrency guard is documented as the `layout_revs` PK inside
    the batch**, and the `OR REPLACE` defect is fixed in T2 rather than
    worked around at the route.
12. **Migration `0002` ships as one file** for the phase (auth cache, rate
    limit, admin seed); the second admin, when known, is `0003` — data only.

## 7. Cut from the round-1 draft (and why)

- **`Idempotency-Key` + `idempotency` table** — §6.1.
- **Poll rate limits in D1, per-IP counters** — §6.2.
- **`docs/api.md` regenerated from fixtures** — nothing in phase 1 builds
  `docs/`; the conformance fixtures *are* the reference (LDB-R3). A
  rendered page is phase 5 with the changelog.
- **`routes.test.ts` "walks Hono's middleware chain"** — replaced by a
  black-box enumeration (T1): Hono's internals are not a contract.
- **Preview job "on feature branches"** — one named branch; `ciwiring`
  asserts the exact `if`. A preview per branch needs a D1 per branch.
- **`edits` as a separate `formats/<f>/1/edits.ts` contract** — kept as a
  file, but exposed through the one `FormatModule` export the registry
  already reads (`edits?`), so the registry contract stays the single
  place a format is described.

## 8. Open questions for saltorbit

1. The second admin's Discord id (`0003`; nothing blocks on it).
2. §6.7 — restore past 30 days: admin-only as written, or nobody?
3. §6.6 — the 64-char cap on new names: fine, or none (the bot has none)?
4. §6.2 — poll limits deferred to the hostname's WAF rule: agreed, or do
   you want a code-level limit on `workers.dev` regardless?
