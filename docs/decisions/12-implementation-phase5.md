# Implementation — phase 5, open it up

Status: plan, round 1 (2026-09-09, drafted while phase 2/3/4 slices land;
needs a reviewer pass before any slice starts). Part of `00-plan.md` (§5
phase 5). Builds on phases 1–2 in `db/` (events log, feed, admins, the
two auth lanes) and on `08-infrastructure.md` §2's penciled-in follow-ups.

## 0. What phase 5 delivers

Webhooks and the SSE stream (`03 §5`); `mana2/1` as a registered format
(`01 §4`); the public changelog page (`03 §7`); the daily diff as a Worker
cron and the rehost drill as a Fly schedule (`08 §2` items 1–2); the repo
split (`04 §5`, `08 §2` item 3) with `@akl/layout-formats` and `@akl/core`
as packages; the layout-dates backfill (`06 Q1`). Not here: a hostname
(saltorbit registers a domain in the `akl` account — `08 §2` item 4), the
`!cmini` transition, any prod flip.

## 1. Slices

Order: X1 → X2 (independent of X1) → X3 → X4 → X5 → X6 ⚠ → X7 ⚠.

### X1 — webhooks + the SSE stream

**Lands (db/):** migration `0004_webhooks.sql` (`webhooks {id PK,
owner_user_id, url, secret_hash, kinds, owner_filter, status, failures,
last_delivered_seq, created_at}`, `webhook_deliveries {webhook_id, seq,
attempt, status, at, PK(webhook_id, seq, attempt)}`); routes `POST/GET
/v1/webhooks`, `DELETE /v1/webhooks/{id}` (actor-owned; admins see all);
delivery: after every accepted write the route enqueues (`ctx.waitUntil`) a
POST of the event JSON with `X-Akl-Signature: hmac-sha256(secret,
timestamp + "." + body)` and `X-Akl-Timestamp`; retries 3× (10 s / 1 min /
10 min) via a `*/1 * * * *` cron that drains `webhook_deliveries` rows in
`pending` state whose `next_at` passed (Workers have no delayed queues on
the free tier — the cron IS the retry scheduler); after 3 failures the
subscription is `failing`, after 7 days of failures `disabled`. `GET
/v1/changes/stream?since=` → `text/event-stream`, one `event` per feed
item, heartbeat every 25 s, closes after 5 min (the client reconnects with
its cursor — Workers' request lifetime bound), backed by polling the feed
every 2 s inside the handler (no push infrastructure needed; LDB-P3's
"feed is truth" is literal here).

| file | asserts | invariant |
|---|---|---|
| `tests/api/webhooks.test.ts` | CRUD × owner/other/admin; a write delivers exactly one signed POST to a fake receiver (`fetchImpl`); signature verifies; a 500 receiver → `pending` row with `next_at` = +10 s; the cron delivers it; three failures → `failing`; a subscriber sees `failing` in `GET /v1/webhooks`; `kinds`/`owner_filter` filter deliveries | **LDB-H1** (every accepted write produces exactly one delivery attempt per matching subscription) |
| `tests/api/stream.test.ts` | events appended during an open stream arrive in order with `id:` = seq; `since` exclusive; heartbeat lines; the stream closes at the bound and a reconnect from `Last-Event-ID` resumes with no gap or duplicate | **LDB-H2** |
| `tests/events/feed.test.ts` (extended) | a follower's state from webhooks alone vs from the feed alone is identical after drops/reorders (fake receiver drops 30 %) | LDB-P3 |

### X2 — `mana2/1`

**Lands (db/formats/mana2/1/):** schema for the mana2 `.jsonc` layout
object (`layout.fingers/thumbs` strings, `board {isRowStaggered,
rowOrColumnStagger}`, `fingermap` strings, `magic.rules[]`), a JSONC parser
(comments + trailing commas stripped before JSON), `validate`, `lower`
(rules as given, `type: "raw"`), `to["akl/1"]` / `from["akl/1"]` per `01
§6.3` (row strings → keys with column gaps → absolute cols; digits ↔ finger
letters; thumbs; `skip` ↔ `free`; `board` mapping), fixtures from
`vendor/mana2/data/layouts/*.jsonc` (frozen), `OWNERS` = Zak (or the
maintainers as a mirror, `04 Q3`). Registry + `/v1/formats` entry.

| file | asserts | invariant |
|---|---|---|
| `tests/formats/mana2.test.ts` | every vendored mana2 layout validates; `akl → mana2 → akl` identity on keys/fingermap/board/rules; `mana2 → akl → mana2` reproduces the mana2 object modulo comments and key order; goldens frozen | LDB-F5 (mana2 pair), F6, F7 |

### X3 — the changelog page

`GET /admin/changelog` (public, read-only HTML rendered from the feed;
`?since=`, `?layout=`, `?actor=`; 100 events per page; the site's
`/admin/cmini-log` retires at W6 (`06 §6`)). Served through the same
ETag/cache as the feed; rendered into the nightly dump as
`changelog.html` (`03 §5`).

### X4 — the diff as a Worker cron, the drill as a Fly schedule

`wrangler.toml` gains `0 4 * * *`; `src/import/diff.ts` is already
Node-and-Worker neutral (S8) — the cron runs it against upstream with
`fetch`, stores `import_state.cmini.last_diff = {at, differences,
aliasCount, summary}`, and `/v1/meta` gains `last_diff: {at, ok}`. `db.yml`'s
daily diff step is deleted once the cron has been green for 7 days (a
`ciwiring` row asserts the step is gone after that date). The rehost drill:
`bot/`-style Dockerfile under `db/drill/` running `npm run rehost --
--dump <latest>` + the conformance suite, `fly machine run … --schedule
daily` (saltorbit's Fly account), posting `{at, ok}` to a new admin-only `POST
/v1/admin/drill` that `/v1/meta` surfaces as `last_drill`.

### X5 — packages and the repo split (prep)

`db/formats` builds as `@akl/layout-formats` (tsup, ESM + d.ts, no
runtime deps beyond ajv); `web/src/core` as `@akl/core`; `bot/` and the
site switch from path imports to the packages (`05 §1`, `06 §5`); archlint
rule updated; `LICENSE` (MIT) in `db/` and `bot/`; `db/CODEOWNERS` from
each format's `OWNERS`; a `scripts/split-db.sh` that `git subtree split`s
`db/` (and `bot/`) into new repos with history — **dry-run only in this
phase**; saltorbit runs it (⚠) and creates the org.

### X6 — ⚠ the split, the org, the domain

saltorbit: create the GitHub org, push the split repos, move `db.yml`/`bot.yml`
there with the same secrets, add the second org owner; register the domain
in the `akl` Cloudflare account and attach it as a Workers custom domain
(`08 §2` item 4); `vars.DB_BASE_URL` on the site → the hostname.

### X7 — ⚠ layout-dates backfill

`06 Q1`: one-off SQL migration on the production DB from
`data/layout-dates.json` (`created_at` for records whose cmini
`created_at` is the 2026-08-20 import stamp), auditable, no API surface.
saltorbit runs it after W6.

## 2. Invariants added (phase 5)

LDB-H1, LDB-H2 (webhooks/stream), LDB-F5/F6/F7 rows for `mana2/1`, a
`ciwiring` row for the retired daily step, `LDB-M1` (the meta `last_diff`
/ `last_drill` fields are never older than 48 h in production — asserted
by the site's meta-watch as a stall signal).

## 3. Open questions

1. Webhook retry via a 1-minute cron vs Cloudflare Queues (paid): cron.
2. `mana2/1` owner (`04 Q3`).
3. The stream's 5-minute bound — fine for the bot (reconnects) and mana?
