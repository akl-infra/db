# Latency analysis vs spec — V1, round 1 (2026-09-12)

Measured the same day the new architecture was deployed (layoutdb wave 1 v1fa2965c on prod `akl-db`; spark wave 2 on Fly `spark-bot`, shared-cpu-2x 2 GB). Against `design/HARD-REQUIREMENTS.md` R1–R5 and `PROPOSAL.md` §3's targets. **Round 1 caveat:** the bot verbs below were driven by the headless harness (`bot/scripts/measure-latency.mjs`, the real `bootRuntime` + `handleMessage`, no Discord gateway) **from saltorbit's laptop**, so compute ran on an M-series core and every layoutdb round trip includes ~30 ms of home-network RTT. The Fly machine's own numbers come from `/health.latency` as real Discord commands accumulate (round 2).

## 1 · Verdict

| requirement | status | evidence |
|---|---|---|
| R1 bot lookups always correct | **pass by construction, verified live** | every verb ran `ensureFresh()` first (`fresh=304` on the 21 ms path; after a write, `drained:N` in 120–157 ms); a write is folded before its ticket settles; the harness's `add → swap! → rename → like → remove` chain saw its own writes at each step. Tombstones excluded from resolvers (LDB-B114). |
| R2 every command ≈ 1 s | **pass (laptop); Fly p95 pending** | read verbs p50 20–27 ms, p95 ≤ 289 ms except `compare` p95 850 ms (one cold table load); writes 359–509 ms end to end. Cold first `view` after boot 81–90 ms. |
| R3 sorts instant, incremental, may be stale | **pass** | `rank` p50 23 ms, p95 26 ms, never computes inline; stale rows carry the pending footer; the first-boot sweep fills the default corpus first. |
| R4 site publish checks with layoutdb | **pass by construction** | read-then-PUT with scoped `If-Match`; 409 rebases locally; owned-but-uncatalogued rows render from the record (A1, I-373). Not re-measured today. |
| R5 site as close as the SPA allows | **pass in steady state, degraded during a backlog** | data fetches ≤ 280 ms; publisher live end to end; edit → pointer 15.6 min while the throttled first pass runs (expected < 1 min once the backlog is gone; the site's 60 s poll then dominates). See §5, §7b. |

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

**Publisher end to end is live** (21:27Z): tick 1 computed 25 layouts in 160 s on the throttled shared CPU, wrote overlay `20260912T212636Z-b6c470763054`, swapped the pointer (`db_seq` 23965) and passed the smoke test. **Edit → visible for everyone else (during the throttled backlog pass):** a layout created at 21:29:26Z (`seq` 23967) had to wait for the in-flight tick to finish and then ride the next one; with the shared CPU throttled a 25-layout tick takes ~10 min, so the expected number here is 10–20 min — **measured: the pointer swapped at 21:45:02Z, 15 min 36 s after the write** (tick 2 of the backlog: the in-flight tick had to finish, then the edit rode the next one at the throttled 25-layouts-per-~12-min rate). That is the backlog case, not the steady state: with no backlog the path is debounce 5 s + one native compute 2–4 s + upload and pointer swap, which the tick log puts at well under a minute. The site's 60 s pointer poll is then the dominant term. The pointer moved at 19:18Z today — by the *old* Python stats service, which was still running beside the new publisher (two writers; the new publisher's CAS correctly lost 5 swaps). The old app is now scaled to zero. The new publisher's first pass is computing every layout whose content hash isn't in the published index (all 4,177: the old base carries no hashes), one layout at a time with the native CLI at nice 10. Measured: **~55 s per layout** (work dirs at 19:53:21 and 19:54:15) versus the old service's 3.5 s with `--jobs 2`, and `publishPlan` publishes only after the whole plan computes — so the first pointer swap would have come days later. Fixed (B8, deployed 20:26Z): ≤ 25 layouts per tick then publish, recent edits first, `--jobs 2` (it had silently been 1), and the wasm sweep yields to the CLI during a backlog pass. **Measured after the fix: 1.6–3.5 s per layout for all 108 cells** (first 13 layouts: 3,549 ms cold, then 1,593–1,963 ms), so the full first pass is ≈ 2.2 h and the first pointer swap lands after ≈ 50 s of compute instead of days.

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

A pure-CPU probe inside the machine during that stretch ran at **1/14th** of the laptop's single-core speed (200 M vs 2.78 B loop iterations in 2 s); the same probe right after a restart, with fresh burst credit, ran at 2.20 B — **11× faster than the throttled state**, 79% of the laptop. At the throttled rate the 4,177-layout backlog is ~1.2 days instead of ~2.2 hours, and — the part that matters for R2 — any wasm compute a command needs is slowed the same way while the publisher is busy. Steady state (single-digit edits a minute) fits inside the burst; a backlog does not.

Options, in order of preference: run the machine as `performance-1x` (dedicated core, ~$31/mo, 2 GB) at least during the first pass and any full rebuild, and decide from the `/health.latency` histogram whether to keep it; or leave `shared-cpu-2x` and accept a day-long first pass with degraded bot compute during it. This is the data the proposal said the machine decision should wait for.

## 8 · What to change (round 1)

1. Nothing blocks the requirements. Two real defects were found by measuring and fixed today: the long-poll actor before login, and the two boot hangs.
2. Machine: see §7b — recommend `performance-1x` for the backlog pass; keep or revert with round-2 data.
3. Round 2 (after the first CLI pass finishes): read `/health.latency` after a day of real commands; `feed_wake_ms` under long-poll; publisher `published overlay` timings for a plain and a magic layout; `flyctl` CPU/memory over 24 h. Then decide the machine size with data (the shared-cpu-2x is holding so far).
4. Add the harness run to CI as a nightly against prod layoutdb with `--author` = a dedicated test user, so the numbers above are tracked, not one-off.

## 9 · Round 2, interim (2026-09-13 00:40–01:30Z, `spark-bot` resized to performance-1x 2 GB at 00:41Z)

**Publisher throughput on performance-1x**: 25 layouts per tick every ~4 min (ticks 7/8/9 at 01:09/01:13/01:17Z). Per-layout native compute is a flat 3.2–3.5 s (single-threaded; `--jobs 2` buys nothing on 1 vCPU), so 25 computes ≈ 83 s; the remaining ~150 s per tick is publish work (last compute → overlay stamp ≈ 36 s; overlay stamp → tick logged ≈ 94 s: uploads, pointer CAS, smoke, history). Backlog 3,948 at 01:17Z → **≈ 10.5 h** for the first pass (not the 2–3 h round 1 predicted from the unthrottled 1.6 s/layout sample). performance-2x would roughly halve the compute half only.

**Feed long-poll timeouts are event-loop stalls, not layoutdb**: three signed `GET /v1/changes?since=<head>&wait=25` from the laptop returned in 25.41–25.45 s each (ttfb = total; body 25 B); with `since=<head-1>` the same GET returned in 190–620 ms. Yet the bot aborted the same request at its 32 s bound with reported elapsed 33.9 s (performance-1x) and 34–53 s (shared-cpu-2x, throttled). A timer firing 2–20 s late means the Node main thread was blocked that long — the publisher's synchronous overlay work (row derivation, table merge, multi-MB `JSON.stringify`) runs on the bot's thread. **This is an R2 risk**: a command arriving during such a stretch waits it out. B10 quiets the alert (45 s bound, no DM) but does not remove the stall; B11 adds a `loop_lag_ms` histogram + per-tick phase timings to `/health` so round 2 can measure the stalls directly; B12 (proposed) moves the overlay JSON work off the main thread (worker_threads) or chunks it.

**Feed wake** (`/health.feed_wake_ms`, n=9 since the resize): p50 2,048 ms bucket, p95 8,192 ms bucket, max 6,354 ms — worse than round 1's ≈ 1 s, consistent with the stalls above.

**Per-verb command histogram**: still empty (no Discord commands since the 00:41Z restart). Round 2 proper waits on real usage or a Fly-side headless run (`bot/scripts/measure-latency.mjs` via `fly ssh console`).

**Health-field staleness found**: `/health.publisher.last_run_at` and `publisher_last_tick_at` read 00:41Z while ticks completed at 01:09–01:17Z (set once per multi-tick pass, not per tick) → B11.

### 9b · Loop-lag histogram, first read (v42, B11 live, performance-1x, 01:56–02:13Z)

`/health.loop_lag_ms` since boot: p50 20 ms (the histogram's resolution floor), p95 80, p99 85, **max 111,132 ms**. 12 stalls over 1 s in 17 min, all inside publisher phases:

| phase (per tick) | wall time | stalls > 1 s |
|---|---|---|
| compute (25 layouts, child process) | 119 s | 1.0–1.6 s each, ~8 per tick — parsing the CLI's JSON result on the main thread |
| derive-rows (python) | 0.3 s | — |
| merge-overlay | 46 s | (below the 1 s threshold individually; B12 moves it off-thread) |
| upload | 48 s | 1.2 s |
| smoke | 151 s | **111 s** (one per tick) |

Whole tick: 364 s. **The 111 s stall is the smoke test's tombstone-leak check**: a tombstones × files loop that re-parsed every multi-MB overlay table once per tombstoned id. Fixed as LDB-B180 (one parse per table, `setImmediate` yield between files; commit 5bdf9216b, deployed with B13). Until B12 lands, the remaining per-tick blocking is the one-parse-per-table smoke pass plus the merge-overlay stringify/parse (tens of seconds spread over many files, each individually under a second or two).

**Verdict for R2 during the backlog pass**: FAIL before the LDB-B180 fix — a command arriving in the 111 s window every ~6 min waited it out. After the fix the worst single block should be a few seconds (to be re-measured); B12 (worker thread) is what brings it under the 1 s target.

## 10 · Round 2: bot verbs ON the Fly machine (v43, performance-1x, publisher backlog running, reps=5)

`bot/scripts/measure-latency.mjs` via `fly ssh console` (B13): the real headless runtime booted beside the live bot (1.7 s, 4,179 records), same code path as a Discord command minus the gateway hop (add ≈ 50–150 ms each way for Discord itself). Numbers in ms.

| verb | p50 | p95 | max | fresh | compute | note |
|---|---|---|---|---|---|---|
| view (cold, first after boot) | 137 | — | 137 | 69 | 0 | |
| view | 70 | 108 | 108 | 76 | 0 | |
| stats | 71 | 76 | 76 | 69 | 0 | |
| sfbs | 79 | 325 | 325 | 68 | 0 | |
| image (PNG) | 428 | 489 | 489 | 66 | 0 | render on 1 vCPU |
| compare | 75 | **3,069** | 3,069 | 74 | 595 | one rep computed a missing cell set: 595 ms wasm + ≈ 2.4 s waiting |
| view (magic) | 67 | 70 | 70 | 65 | 0 | |
| stats (magic) | 70 | 74 | 74 | 71 | 0 | |
| sfbs (magic) | 70 | **1,031** | 1,031 | 69 | 0 | one slow rep, no compute — CPU contention |
| magic | 74 | 106 | 106 | 76 | 0 | |
| rank | 70 | 78 | 78 | 69 | 0 | instant (row tables) |

**Reading it.** The floor is the `/v1/meta` freshness check: 65–76 ms from Fly `iad` to the Worker (vs 21 ms from the laptop — the edge the machine reaches is slower; still fine). Every verb's p50 is under 80 ms except `image` (428 ms). **The p95 outliers are CPU contention, not code**: the machine has ONE performance vCPU and the publisher's native CLI child runs at 100 % of it for ~120 s of every ~6 min tick, so any command that needs CPU (a wasm compute for `compare`, PNG rendering, a big sfbs list) can take 2–3× longer while a compute is in flight, and the 1–1.5 s `compute`-phase stalls (§9b) land on top. Two cheap fixes, either is enough: (a) spawn the CLI child at lower OS priority (`os.setPriority(child.pid, 15)` — the bot always wins the CPU), (b) run `performance-2x` during backlog passes so the child has its own core. Recommend (a) now (B15) and (b) only for future full passes.

**R2 verdict (Fly-side, during the backlog)**: PASS at p50 for every verb; FAIL at p95 for `compare` (3.1 s) and `sfbs` on a magic layout (1.0 s) while the publisher computes. Expected PASS at steady state (no CLI child running) — to be confirmed after the pass finishes. **R1/R3/R4 unchanged (pass).**

**Caveats.** Three deploys tonight (v42 01:56Z, v43 02:24Z) each restarted the machine mid-tick and cost the publisher its in-flight tick (each is ≈ 6 min of work); the pointer did not advance between 01:59:52Z and 02:24Z. Deploy between ticks or accept the loss — the publisher recovers on its own (LDB-B142). The edit→pointer measurement started at 01:59:51Z is confounded by those restarts; re-run once the machine has been up for a full tick.

**Edit → visible during the backlog (round 2)**: layout created 01:59:51Z, in the published overlay at 02:19:49Z → **≈ 20 min**, confounded by the v42 deploy restart at 02:14Z that discarded the in-flight tick (each tick ≈ 6 min; without the restart this would have been the 02:06 or 02:12 tick, ≈ 6–12 min). Steady-state expectation (no backlog: a one-layout tick = 3 s compute + the fixed merge/upload/smoke overhead) ≈ 2–3 min today; B12 + B16 are what bring it toward the < 1 min target in PROPOSAL.md §3. Note for reading the pointer from a laptop: the public origin serves `current.json` with a short edge cache — send `Cache-Control: no-store` or you read a stale pointer (I did, once).

**After LDB-B180 (v43, first full tick, 02:35–02:41Z)**: smoke phase 151 s → **39 s**, the 111 s stall is gone; worst stall now **2.3 s** (8 stalls per tick, all 1.0–2.3 s: seven in `compute` = parsing the CLI's result JSON on the main thread, one in `upload`). Loop lag since boot p95 80 / p99 97 / max 2,487 ms. Per tick: compute 203 s, derive-rows 0.4 s, merge-overlay 45 s, upload 48 s, smoke 39 s = 335 s. Remaining blocking work is what B12 moves off-thread (merge-overlay, smoke parse, the per-layout CLI-result parse); B16 then cuts the compute phase itself.
