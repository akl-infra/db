# Latency analysis vs spec — V1, round 1 (2026-09-12)

Measured the same day the new architecture was deployed (layoutdb wave 1 v1fa2965c on prod `akl-db`; spark wave 2 on Fly `spark-bot`, shared-cpu-2x 2 GB). Against `design/HARD-REQUIREMENTS.md` R1–R5 and `PROPOSAL.md` §3's targets. **Round 1 caveat:** the bot verbs below were driven by the headless harness (`bot/scripts/measure-latency.mjs`, the real `bootRuntime` + `handleMessage`, no Discord gateway) **from saltorbit's laptop**, so compute ran on an M-series core and every layoutdb round trip includes ~30 ms of home-network RTT. The Fly machine's own numbers come from `/health.latency` as real Discord commands accumulate (round 2).

## 1 · Verdict

| requirement | status | evidence |
|---|---|---|
| R1 bot lookups always correct | **pass by construction, verified live** | every verb ran `ensureFresh()` first (`fresh=304` on the 21 ms path; after a write, `drained:N` in 120–157 ms); a write is folded before its ticket settles; the harness's `add → swap! → rename → like → remove` chain saw its own writes at each step. Tombstones excluded from resolvers (LDB-B114). |
| R2 every command ≈ 1 s | **pass (laptop); Fly p95 pending** | read verbs p50 20–27 ms, p95 ≤ 289 ms except `compare` p95 850 ms (one cold table load); writes 359–509 ms end to end. Cold first `view` after boot 81–90 ms. |
| R3 sorts instant, incremental, may be stale | **pass** | `rank` p50 23 ms, p95 26 ms, never computes inline; stale rows carry the pending footer; the first-boot sweep fills the default corpus first. |
| R4 site publish checks with layoutdb | **pass by construction** | read-then-PUT with scoped `If-Match`; 409 rebases locally; owned-but-uncatalogued rows render from the record (A1, I-373). Not re-measured today. |
| R5 site as close as the SPA allows | **partial** | data fetches are fast (below); edit → pointer swap is **not yet measured**: the publisher's first native-CLI pass was still running at the time of writing (see §5). |

## 2 · layoutdb API (prod `akl-db`, from the laptop, n=15)

| request | p50 | p95 | max |
|---|---|---|---|
| `GET /v1/meta` (200) | 48 ms | 94 ms | 331 ms |
| `GET /v1/meta` `If-None-Match` → 304 — the bot's per-command proof | **45 ms** | 55 ms | 56 ms |
| `GET /v1/layouts/hours?format=spark/1` | 57 ms | 63 ms | 64 ms |
| `GET /v1/layouts/hours?format=mana2/1` (derived on read) | 61 ms | 115 ms | 1057 ms (one cold isolate) |
| `GET /v1/changes?since=head` | 48 ms | 84 ms | 91 ms |
| `GET /v1/changes?…&wait=3` anonymous → immediate + `X-Wait-Ignored` | 60 ms | 66 ms | 67 ms |

Subtract ~30 ms of home RTT for Fly-to-Cloudflare numbers; the in-machine probe measured 264 ms for a cold `/v1/meta` and 102–308 ms for the R2 endpoints on first connection.

## 3 · Bot verbs (headless harness on the laptop, prod layoutdb, reps=5)

Phases: `fresh` = the `/v1/meta` check (+ drain), `compute` = wasm cells not in the store, `db` = layoutdb write round trips.

| verb | p50 | p95 | max | fresh | compute | db |
|---|---|---|---|---|---|---|
| view (cold, first after boot) | 90 | — | 90 | 25 | 29 | 0 |
| view | 21 | 23 | 23 | 21 | 0 | 0 |
| stats | 21 | 23 | 23 | 21 | 0 | 0 |
| sfbs | 27 | 219 | 219 | 22 | 0 | 0 |
| image (PNG render) | 131 | 154 | 154 | 21 | 0 | 0 |
| compare | 23 | **850** | 850 | 22 | 164 | 0 |
| view (magic layout) | 22 | 24 | 24 | 22 | 0 | 0 |
| stats (magic) | 24 | 27 | 27 | 23 | 0 | 0 |
| sfbs (magic) | 23 | 289 | 289 | 24 | 0 | 0 |
| magic | 23 | 25 | 25 | 23 | 0 | 0 |
| rank | 23 | 26 | 26 | 23 | 0 | 0 |
| add (creates a layout) | 359 | — | 359 | 29 | 31 | 295 |
| swap! | 509 | — | 509 | 157 | 35 | 266 |
| rename | 472 | — | 472 | 149 | 0 | 278 |
| like | 475 | — | 475 | 144 | 0 | 289 |
| remove | 445 | — | 445 | 119 | 0 | 283 |

Reading it: on a warm bot a lookup is the freshness check plus microseconds; `db` for a write is the fresh GET + the PUT (two round trips, ~270–295 ms from here, ≈ 200 ms from Fly); `fresh` after a write is the drain of the event the write itself produced (a detail GET). The `compare`/`sfbs` p95 spikes are one-time table loads for a corpus not yet resident; on Fly these will be larger (shared CPU) and are exactly what the boot warm-up and the table-major sweep exist to pre-empt.

**Two false starts worth recording:** the first write runs measured *error paths* — a non-snowflake author (layoutdb refused the actor, 40 ms "Error" replies) and a gapless `add` grid (cmini's grammar refused it). The script now prints every write reply so a failed write can't pass as a fast one.

## 4 · Boot (Fly, from the deploy logs)

| phase | first deploy (empty volume) | redeploy (snapshot on volume) |
|---|---|---|
| replica | 1,624 ms (dump) | 613 ms (snapshot) |
| engine | 304 ms | 1,223 ms |
| ensureFresh | 850 ms | 649 ms |
| warm-up (default corpus, bounded 30 s) | 776 ms | 953 ms |
| **total to `client.login()`** | **3.6 s** | **3.5 s** |
| publisher index load (background) | 1.5 s, 1.8 MB | 1.8 s |

Before B6/B7 the same image never logged in (two incidents: boot awaited the eager sweep; the publisher downloaded a 2 GB base). Both are now invariants (LDB-B130..B140).

## 5 · Site path (pointer mode, from the laptop)

| fetch | size | time |
|---|---|---|
| `lines/H/current.json` (pointer, 15 s cache) | 279 B | 203 ms |
| base `layouts.json` | 1.4 MB | 147 ms |
| base `mana2/reddit.rowstag.none.json` | 5.5 MB | 281 ms |
| base `magic_rules.json` | 38 KB | 108 ms |
| overlay `layouts.json` | 1.8 MB | 255 ms |
| `db.cmini-web.pages.dev/` (HTML) | — | 108 ms |

**Edit → visible for everyone else: not measured yet, and the first pass is too slow as deployed.** The pointer moved at 19:18Z today — by the *old* Python stats service, which was still running beside the new publisher (two writers; the new publisher's CAS correctly lost 5 swaps). The old app is now scaled to zero. The new publisher's first pass is computing every layout whose content hash isn't in the published index (all 4,177: the old base carries no hashes), one layout at a time with the native CLI at nice 10. Measured: **~55 s per layout** (work dirs at 19:53:21 and 19:54:15) versus the old service's 3.5 s with `--jobs 2`, and `publishPlan` publishes only after the whole plan computes — so the first pointer swap would have come days later. Fixed (B8, deployed 20:26Z): ≤ 25 layouts per tick then publish, recent edits first, `--jobs 2` (it had silently been 1), and the wasm sweep yields to the CLI during a backlog pass. **Measured after the fix: 1.6–3.5 s per layout for all 108 cells** (first 13 layouts: 3,549 ms cold, then 1,593–1,963 ms), so the full first pass is ≈ 2.2 h and the first pointer swap lands after ≈ 50 s of compute instead of days.

## 6 · Feed wake latency (long-poll)

First measurement caught the **fallback**: the loop's first request went out before Discord login with the client ULID as its actor, layoutdb refused it, and the process polled every 2 s for life (`feed_wake_ms` p50 in the 2,048 ms bucket, max 2,759 ms, n=6 — event timestamp to fold, including the detail GET). Fixed the same hour (`BOT_USER_ID` set; the loop retries `wait=` on `clientReady` and every 10 min) and redeployed.

**Under real long-poll** (n=6 events from a write burst): p50 in the 512–1,024 ms bucket, max 1,432 ms. That is the Worker's once-a-second head check (0–1,000 ms) plus the bot's detail GET (~50 ms) plus timestamp granularity. Meets the "about 2 s" the design assumed; a 250 ms check interval in the Worker would bring it to ~300 ms for four D1 reads a second per held connection (B9 c).

## 7 · Resources (Fly, shared-cpu-2x 2 GB)

- RSS 640–700 MB at rest with the first-boot sweep running (35% of 1,968 MB); the sweep uses ~23% of one core at the default idle gap.
- The first-boot cell sweep (4,177 layouts × 39 cells in wasm, table-major) and the publisher's first CLI pass (4,177 × 108 cells) both run in the background; the bot answered within budget throughout (harness runs happened during them).

## 7b · Shared CPU: the burst budget is real

Fly's `shared-cpu` tier lends a full core in bursts and throttles to a small baseline under sustained load. Measured on the publisher's first backlog pass (2 vCPU, CLI at `--jobs 2`, wasm sweep paused):

| minute after boot | native compute per layout (108 cells) |
|---|---|
| 0–1 | 1.6–2.2 s (28 layouts) |
| 2–12 | 22–31 s, one at 251 s |

A pure-CPU probe inside the machine during that stretch ran at **1/14th** of the laptop's single-core speed (200 M vs 2.78 B loop iterations in 2 s). At the throttled rate the 4,177-layout backlog is ~1.2 days instead of ~2.2 hours, and — the part that matters for R2 — any wasm compute a command needs is slowed the same way while the publisher is busy. Steady state (single-digit edits a minute) fits inside the burst; a backlog does not.

Options, in order of preference: run the machine as `performance-1x` (dedicated core, ~$31/mo, 2 GB) at least during the first pass and any full rebuild, and decide from the `/health.latency` histogram whether to keep it; or leave `shared-cpu-2x` and accept a day-long first pass with degraded bot compute during it. This is the data the proposal said the machine decision should wait for.

## 8 · What to change (round 1)

1. Nothing blocks the requirements. Two real defects were found by measuring and fixed today: the long-poll actor before login, and the two boot hangs.
2. Machine: see §7b — recommend `performance-1x` for the backlog pass; keep or revert with round-2 data.
3. Round 2 (after the first CLI pass finishes): read `/health.latency` after a day of real commands; `feed_wake_ms` under long-poll; publisher `published overlay` timings for a plain and a magic layout; `flyctl` CPU/memory over 24 h. Then decide the machine size with data (the shared-cpu-2x is holding so far).
4. Add the harness run to CI as a nightly against prod layoutdb with `--author` = a dedicated test user, so the numbers above are tracked, not one-off.
