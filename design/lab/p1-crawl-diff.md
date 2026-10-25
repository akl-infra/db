# P1 crawler diff: origin/main vs aws-port

Run 2026-10-25 with `scripts/lab/p1-crawl-diff.mjs`. It is the byte-identical proof for P1
(design/aws-port.md §9) before the storage-port refactor ships to production akldb.

**Result: identical.** Over 78,296 request pairs, no status, contract header or body byte differs,
and all 30 tables are identical afterwards.

| Run | Data | Request pairs | Response diffs | Tables differing | Wall time |
|---|---|---|---|---|---|
| public dump | `dump-2026-10-25.json.gz` (4,787 layouts, 14,403 events, seq 48,906) | 74,122 | 0 | 0 / 30 | 190 s |
| fixture | `tests/fixtures/seed-upstream-100.dump.json` (100 layouts, seq 539) | 4,174 | 0 | 0 / 30 | 11 s |
| negative control | the fixture run, with two differences planted in the head tree | 4,174 | 1,113 | 0 / 30 | 11 s |

The two commits compared:
- base: `origin/main` = `5f6bf7c`;
- head: `aws-port` = `7e54544`, all six P1 agents plus the phase-end cleanup.

The JSON reports are in `p1-crawl-diff/`.

## What the tool does

1. Checks both commits out into temporary worktrees (sharing one `node_modules`; the tool refuses
   if the two `package-lock.json` differ).
2. Seeds one local D1: all 35 migrations, then the dump restored via `restoreSql`, plus a lab
   client (Ed25519, `act-as-user,feed:wait`), a lab admin and a lab author.
3. Copies that database byte for byte for each side and runs `wrangler dev --local` for each.
4. Makes both sides deterministic. Each side runs behind a lab-only entry module (written only
   into the temporary checkouts) that freezes `Date`/`Date.now()` to the request's `x-lab-now`
   and reseeds `crypto.getRandomValues`/`randomUUID` from `x-lab-seed`. The same request
   therefore yields the same ULIDs, nonces and timestamps on both sides.
   - Client-lane requests are signed by the tool. Ed25519 signatures are deterministic.
   - Bearer-lane requests go to a local fake Discord (`/api/oauth2/@me`).
5. Sends every request to both sides and compares:
   - the status;
   - the contract headers (`ETag`, `Cache-Control`, `Content-Type`, `X-AKLDB-API`,
     `X-Wait-Ignored`, `Retry-After`, `Deprecation`, `Sunset`, `Location`, `Content-Length`,
     `WWW-Authenticate`);
   - the body bytes.

   Every response carrying an ETag is re-requested with `If-None-Match`.
6. Stops both Workers and compares every table row by row in rowid order, from each side's SQLite.

Run it with:

```
node scripts/lab/p1-crawl-diff.mjs --base origin/main --head aws-port --dump <dump.json[.gz]|fixture>
```

It exits 0 only when both sides are identical.

## Coverage (public-dump run)

| Family | Requests | Statuses |
|---|---|---|
| layout detail (`spark/1`, `mana2/1`, no format, unknown format, missing id/name) | 14,967 | 200: 9,974, 400: 4,989, 404: 4 |
| layout by name (as stored, and upper-cased: NOCASE) | 9,274 | 200 |
| layout history (all, `format=spark/1`) | 9,974 | 200 |
| layout likes | 4,987 | 200 |
| layout rev (1, latest, latest+1, and `mana2/1`) | 19,548 | 200: 9,774, 400: 4,987, 404: 4,787 |
| layout comments (per live layout) | 9,274 | 200 / 304 |
| list: 4 sorts × 2 formats × 16 filters × 2 page sizes, every cursor chain to the end | 4,416 | 200 / 304 |
| list errors | 14 | 400 (+ the bare `/v1/layouts`) |
| `full=1` (both formats, `liked_by`) | 16 | 200 / 304 |
| changes from 0 to head (plain, 6 kind sets, 20 layouts, 3 actors), errors, signed `wait=1` | 316 | 200 / 304 / 400 / 404 |
| changelog | 8 | 200 / 304 |
| meta, formats, schemas | 12 | 200 / 304 / 404 |
| authors (list both orders, every author, unknown) | 460 | 200 / 304 / 404 |
| WPM (all, per layout, per user) | 244 | 200 / 304 |
| comment counts and per-layout lists | 508 | 200 / 304 |
| dump endpoints (before and after a written dump) | 12 | 200 / 302 / 404 |
| scripted signed writes | 91 | see below |

**The writes,** 86 steps in order:
- **Identity:** `/v1/me` on both lanes.
- **Create:** a plain create, a name clash, a bad name, an unknown format.
- **Idempotency key:** first use, replay, mismatch.
- **Edits:** PUT replace, stale, missing `If-Match`, not the owner; PATCH fingermap; mixed PATCH;
  rename.
- **Likes:** like, repeat, a bearer-lane like, unlike, repeat unlike.
- **Ownership:** transfer, transfer to an unknown user, delete, read the tombstone, restore,
  restore when not deleted.
- **Name reclaim:** a tombstoned name reclaimed with its likes (LDB-P9).
- **Link:** submit, queue, approve, clear, then a second submit and reject.
- **WPM:** submit, receipt, receipt read by another user, queue, approve, reopen, reject, history,
  on-behalf submission, records.
- **Comments:** submit, approve, like, like own, list, own, mine, edit, reject, remove, reopen,
  unlike, delete own, counts.
- **Moderation and admin:** ban, a write while banned, unban, author rename, admin add and
  remove, the client list, a non-admin refusal.
- **Jobs:** a dump write followed by the dump reads, a nightly tick.
- **Auth refusals:** an unsigned write, a bad signature.
- **Long-poll:** a signed long-poll.

65 of them succeed (2xx); the rest are the intended refusals. Their statuses are in
`report-public-dump.json` under `writes`.

## The negative control

To show the tool can tell the two sides apart, I planted two differences in the head checkout:
`Cache-Control: max-age=11` on the layout routes, and `like_count + 1` on one layout. On the
fixture, the tool then reported 1,113 response diffs, starting with
`header cache-control: "public, max-age=10" vs "public, max-age=11"`, and exited non-zero.
Neither plant touches stored rows, so the table check correctly stayed at 0 differing. The
table comparison itself is not vacuous: it compares full JSON row dumps, e.g. 297 KB of
`events` and 39 KB of `layouts` on the fixture.

## Expected differences: none observed

Agent D listed three possible differences: a bound `LIMIT`, a bound result string, and one
timestamp per operation.
- The first two did not change a single byte.
- The third is invisible by construction under a frozen clock. Under a real clock, a request
  whose statements used to call `now()` separately can now carry one instant. That is not a
  wire-shape change, and the 48 h production watch covers it.

## Not covered by this run

- **The Discord interactions endpoint, modqueue notifications and DM delivery.** Their
  configuration is unset locally, so both sides take the same "feature off" path. Unit and
  integration suites cover them on both sides (tests/auth).
- **The cron trigger itself.** The nightly job is exercised through `POST /v1/admin/nightly/tick`
  instead.
- **Rate-limit 429 thresholds and auth-cache expiry.**
- **Concurrent races.** Requests are serial per pair, and the GET crawl is concurrent only
  across read-only requests.
- **Edge behaviour.** Cloudflare compression and weak ETags happen outside the Worker; the
  refactor does not touch them.
