# Implementation — phase 2, people write

Status: plan, round 1 (2026-09-09, drafted while phase 1's S3–S8 land;
needs the same reviewer pass 07 got before any slice starts). Part of
`00-plan.md` (§5 phase 2). Builds on phase 1's code only — every reference
to a phase-1 module is to what is on `worktree-layout-db` at S5
(`core/events.ts` is the only writer; `formats/registry.ts`;
`import/*`; `formats/{cmini,akl}/1`).

## 0. What phase 2 delivers, and what it does not

Delivers: the **user lane** (Discord bearer verified with Discord);
`GET /v1/me`; the write verbs — `POST`, `PUT`, `PATCH` (rename, fingermap,
board, magic), `DELETE`, `restore`, `transfer`, likes; `If-Match` on `rev`;
`check_name`; the **admins** table as data with the admin verbs; **rate
limits**; the format `edits` helpers that PATCH needs; the site's preview
deploy pointed at a preview DB (`06 §7` phase 2 — site work is its own
PRs, not in this doc).

Does not deliver: the client lane (bots; phase 4), webhooks/SSE (phase 5),
`mana2/1` (phase 5), the site cutover / magic migration (phase 3), an
admin UI (the changelog page is phase 5).

## 1. Before the first PR

| need | default if unanswered | blocks |
|---|---|---|
| Second admin's Discord id (`00 §6.4`) | migration `0002` seeds it; until then the `≥ 2 admins` invariant (LDB-A6) is asserted only in tests, and production keeps one row | T3 |
| Discord application for the DB's own verification calls | none needed — `/users/@me` is called with the *user's* bearer; the DB has no Discord app (02 §2.1) | — |
| A **preview DB** for the site's phase-2 UX work | a second D1 `akl-db-preview` + Worker env `preview` in `wrangler.toml` (`[env.preview]`), deployed from the branch by `db.yml`'s preview job | T7 |
| Rate-limit store | D1 table `ratelimit` (fixed-window counters); KV/DO not introduced for this | T5 |

## 2. Slices — PRs in order

Order: T1 → T2 → T3 → T4 (needs T2) → T5 (needs T2) → T6 (needs T2, T4) →
T7. T3 ∥ T4 ∥ T5.

### T1 — the user lane + `/v1/me`

**Lands:** `src/auth/discord.ts` — `resolveBearer(env, request)`:
`Authorization: Bearer <token>` → `sha256(token)` → cache table
`auth_cache (hash PK, user_id, name, ok, expires_at)` (5 min success /
60 s failure, LDB-A2) → else `GET https://discord.com/api/users/@me`
(`identify` scope) → `401 token_invalid` on Discord 401, `503
identity_unavailable` on anything else; `ctx.actor = { user_id, name,
via: "discord" }`. `src/auth/actor.ts` — `requireActor(c)` middleware; the
route table registers every non-GET route through it (LDB-A1). `GET
/v1/me` → `{ user_id, name, via, admin }`. Migration `0002_auth.sql`:
`auth_cache`, `ratelimit`, and the second admin row (or a placeholder
comment when unknown). `authors` upsert on every resolved actor (name from
Discord's `global_name ?? username`; `last_seen_at`).

| file | asserts | invariant |
|---|---|---|
| `tests/auth/discord.test.ts` (workers; Discord = injected `fetchImpl` fake) | 200 → actor; 401 → `token_invalid`; 5xx/network → `identity_unavailable`; cache: second call within 5 min makes no Discord request, a failure is not cached past 60 s, a success not past 5 min (fake clock) | **LDB-A2** |
| `tests/auth/routes.test.ts` (node) | walks Hono's route table: every non-GET route has `requireActor` in its middleware chain | **LDB-A1** |
| `tests/api/me.test.ts` (workers) | shape; `admin` true iff row in `admins` | — |

### T2 — write verbs on the record

**Lands:** `src/routes/write.ts` + `src/core/write.ts` (`validateAndWrite`:
resolve format → `validate` → `hasMagic` → `check_name` where a name
changes → `If-Match` → `appendWrite`), `src/core/names.ts` (`check_name`:
the bot's `util/layout.check_name` rules ported — ≥ 3 chars, `NAME_SET`,
no leading `_`; plus not ULID-shaped), error bodies `invalid_payload`
(from the format, with `path`), `name_taken`, `not_owner` (403), `stale`
(409, with the current record), `unsupported_for_format`, `bad_request`.

```
POST   /v1/layouts                { name, format, payload }        → 201  (kind: created)
PUT    /v1/layouts/{ref}          { format, payload }  If-Match     → 200  (kind: updated)
DELETE /v1/layouts/{ref}                              If-Match     → 200 tombstone (kind: deleted)
POST   /v1/layouts/{ref}/restore                                   → 200  (kind: restored; owner/admin; ≤ 30 days; name_taken if a live record holds the name)
POST   /v1/layouts/{ref}/transfer { to }                           → 200  (kind: transferred; `to` must have an authors row)
```

Authorization (02 §4): create → any actor; everything else →
`record.owner == actor.user_id` or admin (event `admin: true`). `owner` in
any body is ignored (LDB-A7). `If-Match: "<rev>"` mismatch → `409 stale`
with the current record; absent → overwrite. `via` = `discord`.
`Idempotency-Key` on POST: table `idempotency (key, actor, response_json,
at)`, 24 h.

| file | asserts | invariant |
|---|---|---|
| `tests/api/write.test.ts` (workers) | matrix over {POST, PUT, DELETE, restore, transfer} × {owner, other user, admin, anonymous}: the 02 §4 table exactly; every accepted write appears in `/v1/changes` with `via: discord`; PUT with a foreign `owner` in the body leaves `owner` unchanged | **LDB-A7**, LDB-P1 (route-level) |
| `tests/api/ifmatch.test.ts` (workers) | matching rev → 200 rev+1; stale → 409 with current record and NO event; two concurrent PUTs at the same rev (`Promise.all`) → exactly one 200, one 409 | **LDB-P2** |
| `tests/api/names.test.ts` (workers) | `check_name` table (every rule, both sides); imported names stay untouched by writes that don't rename; ULID-shaped name refused | LDB-P4, LDB-I5 |
| `tests/api/restore.test.ts` (workers, fake clock) | restore within 30 d → 200 with the old name and payload, rev+1; after 30 d → 404; name held by a live record → 409 name_taken; by name → 404 while deleted | **LDB-P8** (both halves) |
| `tests/api/idempotency.test.ts` | same key twice → same 201 body, one record | — |

### T3 — admins as data

**Lands:** `src/routes/admin.ts`: `POST/DELETE /v1/admin/admins`,
`GET /v1/admin/admins`, `POST /v1/admin/import/pause|resume`, force
delete/restore/transfer via the ordinary routes with `admin: true` on the
event. Removing an admin that would leave fewer than two rows → `409
last_admins`. Every admin action is an `admin.*` event (`03 §5` kinds).

| file | asserts | invariant |
|---|---|---|
| `tests/api/admin.test.ts` (workers) | non-admin → 403 on every admin route; add/remove; cannot remove below two (both orderings); pause stops the import tick (`tick()` returns `paused`); every admin action is an event with `admin: true` | **LDB-A6**, LDB-A5 (admin half) |
| `tests/tools/noconst.test.ts` (extended) | still no id literal in `src/` after T3 | LDB-G2 |

### T4 — PATCH verbs + format `edits`

**Lands:** `formats/<f>/1/edits.ts` per format — `rename` is record-level
(no format code); `setFingermap(payload, map)`, `setBoard(payload, board)`,
`setMagic(payload, magic)` (akl/1 only for board/magic; cmini/1 gets
`setFingermap` and `setBoard` via the cmini word); `PATCH /v1/layouts/{ref}`
accepting one or more of `{ name, fingermap, board, magic }`, applied in
that order, validated as a whole, one event per PATCH (`kind`: `renamed`
when only `name`, `fingermap` when only `fingermap`, else `updated`).
Unsupported for the record's format → `400 unsupported_for_format`.

| file | asserts | invariant |
|---|---|---|
| `tests/formats/edits.test.ts` (node) | property: for every fixture, `validate(setFingermap(p, fingermapOf(p))) ok` and equals `p`; a fingermap naming a char not in `keys` is refused with `path`; `setBoard` round-trips `board.cmini`; `setMagic` then `lower()` equals lowering the magic directly | **LDB-E1** (edits preserve validity and are pure) |
| `tests/api/patch.test.ts` (workers) | each verb × each format: kind, rev+1, `If-Match`; combined `{name, fingermap}` → one event `updated`; `unsupported_for_format` for `{board}` on `cmini/1` when not representable | LDB-P1, LDB-P7 |

### T5 — likes + rate limits

**Lands:** `PUT/DELETE /v1/layouts/{ref}/like` (idempotent; `qwerty`
refused with the bot's string; `like_count` and `meta.revision` move, `rev`
and `modified_at` do not); `src/core/ratelimit.ts` — fixed 10-min windows
in D1 keyed by `actor.user_id` and endpoint class (`write`: 60/10 min;
`poll`: 1/10 s per endpoint for `/v1/meta`, `/v1/changes`, list — phase 1
deferred it here), `429` with `Retry-After`.

| file | asserts | invariant |
|---|---|---|
| `tests/api/likes.test.ts` (workers) | like twice → one event, count 1; unlike twice → one event, 0; `qwerty` → 400 with the bot's text; `rev`/`modified_at` unchanged, `meta.revision` moved; `?as=cmini/1` `likes` sorted | **LDB-L1** (likes never bump rev) |
| `tests/api/ratelimit.test.ts` (workers, fake clock) | 61st write in a window → 429 + `Retry-After`; window rolls; polls limited per endpoint per actor; anonymous polls keyed by IP class | **LDB-R6** |

### T6 — conformance + registry

Extends `tests/conformance/` with every new (route, status) pair (LDB-P7/
R3 keep their enumeration property: a route without a case fails); adds
the phase-2 rows to `db/INVARIANTS.md` (A1, A2, A5, A6, A7, P2, P8 full,
E1, L1, R6); `docs/api.md` regenerated from the conformance fixtures.

### T7 — preview environment

`[env.preview]` in `wrangler.toml` (D1 `akl-db-preview`, R2
`akl-db-dumps-preview`, `IMPORT_SOURCE_URL` = upstream), `db.yml` job
`preview` on push to `worktree-layout-db`/feature branches (`wrangler
deploy --env preview`), the site's proxy (`functions/api/db/*`, `06 §3`)
reads `DB_BASE_URL` from the Pages Preview environment. **The preview DB is
the only DB the site's phase-2 work writes to.**

## 3. Invariants added (phase 2)

| id | invariant | enforced by |
|---|---|---|
| LDB-A1 | no anonymous write path | `routes.test.ts` |
| LDB-A2 | Discord cache TTLs | `discord.test.ts` |
| LDB-A5 (admin half) | every admin action is an event with `admin: true` | `admin.test.ts` |
| LDB-A6 | never fewer than two admins after bootstrap | `admin.test.ts` |
| LDB-A7 | owner only changes via transfer | `write.test.ts` |
| LDB-P2 | `If-Match` mismatch writes nothing; concurrent PUTs: one wins | `ifmatch.test.ts` |
| LDB-P8 | tombstones: unreadable by name, restorable 30 d | `restore.test.ts` |
| LDB-E1 | format edits are pure and validity-preserving | `edits.test.ts` |
| LDB-L1 | likes move `like_count`/`meta.revision` only | `likes.test.ts` |
| LDB-R6 | rate limits per actor and endpoint class, `429` + `Retry-After` | `ratelimit.test.ts` |

## 4. Open questions (reviewer + saltorbit)

1. `Idempotency-Key`: keep (phase 1 cut it) — the site's publish sheet
   retries on network drop (`06 §3.8`), so yes?
2. `restore` by an admin after 30 days — allowed (the row is still there)
   or strictly 30 days for everyone? Proposal: admin may.
3. Anonymous poll rate limiting keyed by IP: Cloudflare gives
   `cf-connecting-ip`; is a D1 counter per IP acceptable write volume
   (one row per IP per 10 s window)? Alternative: skip anonymous limits in
   phase 2, rely on the edge cache.
