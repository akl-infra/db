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

**After B12 (v45, first full tick 02:41–02:45Z, performance-1x)**: **0 stalls over 1 s**; loop lag since boot p50 20 / p95 26 / p99 49 / **max 473 ms**. Tick 254 s: compute 147 s, derive-rows 0.2 s, merge-overlay 23 s (was 46: now awaited on the worker thread), upload 47 s, smoke 37 s. RSS 705 MB (the worker thread adds ≈ 150 MB). **R2 during a publish: the main thread no longer blocks for more than half a second** — the remaining latency risk is CPU contention with the CLI child (now at nice 10, B15) on the single core, to be re-measured with the per-verb harness after B14/B16 deploy. Incident 3 (v44's wrong worker path, ≈ 1 h of failed ticks) sits between these two readings.

## 11 · Round 2: REAL Discord commands (spark-tester bot → production spark, v47, 03:33–03:36Z)

`bot/scripts/e2e.mjs` (`E2E_ALLOW_PRODUCTION=1`, prefix `!sp`) posted the 49-command default scenario into the test server; the live bot's own `/health.latency` recorded each command (`total` = handler start → reply posted to Discord, so it INCLUDES the Discord REST round trip, unlike §10's harness). Conditions: a publisher tick was in progress the whole time (compute 180 s, merge-overlay 33 s, upload 129 s — R2 slowed by the concurrent rebuild machine's uploads), AND the throwaway rebuild was running in the same app (separate machine, shared bucket).

| verb | total ms | of which fresh / compute | verb | total ms | fresh / compute |
|---|---|---|---|---|---|
| image (×2) | **5,971 / 5,279** | render 5,158 / 4,840 | view | 1,167 | 496 / 372 |
| inrolls | 4,040 | 62 / 0 | history | 1,136 | 142 / 0 |
| unlike | 2,561 | 148 / 0 | spacegrams (×3) | 1,087 | 70 / 0 |
| unangle | 2,198 | 72 / 0 | fingers | 1,011 | 294 / 388 |
| rename | 1,948 | 424 / 0 | outrolls | 954 | 350 / 0 |
| setfingermap | 1,809 | 425 / 0 | sfbs | 822 | 69 / 0 |
| compare | 1,777 | 113 / 0 | magic | 790 | 399 / 0 |
| rank | 1,654 | 72 / 0 | help (no work at all) | **507** | 0 / 0 |
| like / add / swap! / remove | 1,531 / 1,522 / 1,517 / 1,353 | db writes | stats / list / likes | 413 / 352 / 276 | |
| cycle / random | 1,211 / 1,207 | compute ≈ 50 | 20 other read verbs | 290–640 | |

Tester-side Discord round trip (message posted → reply seen): p50 751 ms, p95 4,254 ms, max 6,146 ms, 49/49 answered.

**Reading it.** `help` does nothing and still took 507 ms: that is the Discord reply POST from the machine under load — the floor every verb pays on top of §10's 70 ms handler numbers. The verbs over 1 s are not the handler either (fresh/compute columns are small): they are **CPU starvation on the single performance vCPU**. B12 moved the merge/hash work to a worker THREAD, which on a 1-vCPU machine still competes with the main thread for the same core; the CLI child is at nice 10 but the worker thread is not, and R2 uploads (129 s this tick) keep the worker busy. `image` is the extreme case: a 430 ms PNG render (§10) became 4.8–5.2 s.

**R2 verdict, live, during a backlog pass on 1 vCPU: FAIL** — 19 of 49 over 1 s, 2 over 5 s. Two fixes, in order: (1) **finish the backlog via the rebuild machine** (B17, running now): once the base is rebuilt and swapped, the live publisher has nothing to compute and steady state has no contention — re-run this scenario then; (2) for any future pass, run `performance-2x` so the worker thread and the CLI child have a second core (`fly.toml` pin, ~2× the machine cost only for the pass), or keep passes off the bot entirely (B17 is exactly that). R1/R3/R4 pass (every reply correct and ordered; `rank` answered from row tables).

## 12 · Full rebuild on a throwaway machine (B17), dry run #2 (04:00–04:16Z)

performance-8x, 16 GB, `REBUILD_JOBS=8`: dump 1.6 s → **all 4,179 layouts computed in 783 s** (5.3 layouts/s, 108 cells each) → catalog rows 0.8 s → 78 base tables + manifest uploaded in 152 s → **total 938 s ≈ 15.6 min**, well under a dime of machine time. (Dry run #1 an hour earlier: identical compute, killed by one 30 s R2 PUT timeout → LDB-B216 retries + 180 s timeout.)

**Oracle**: the rebuilt base vs everything the live per-layout publisher had published (62,400 cells across 78 tables): every field byte-identical EXCEPT the per-finger speed arrays `fsp`/`fspw`, which differ in the 15th–16th significant digit (e.g. 1.0865115811619153 vs …155; sums equal to 4 dp) — float summation order in the grouped harvest vs the single-layout run. Semantically equivalent; NOT bit-identical, so S4's CLI↔CLI comparison needs a relative tolerance (≈1e-9) rather than `JSON.stringify` equality once cells come from both paths (B19). Layout identities (hash/rulesSig) match for every id present in both (726/727; the one difference is a layout edited after the dump's cursor). 73 overlay ids absent from the base = 71 legacy-pipeline names + 2 tombstones — correct.

**Compared to the live pass**: 4,179 layouts would have taken ≈ 10.5 h on the bot machine at 25 per 4-min tick (and starved commands the whole time, §11). The rebuild machine does it in 16 min without touching the bot's CPU. Passes belong there from now on.

**Real rebuild (04:06–04:23Z)**: 1,009 s total — compute 883 s, upload 116 s, pre-swap smoke 2.3 s, pointer swap 3.3 s, post-swap smoke 1.2 s. Pointer now `{base: 20260913T042115Z-d83b197cd674, overlay: null, db_seq: 24001}`; the db-alias site serves it (200 in 71 ms). The live publisher's next tick re-plans against the new base (its backlog of 3,352 becomes the handful of layouts changed after seq 24001).

## 13 · Round 2 close-out: steady state, real Discord commands (v50, 04:57Z)

Conditions: publisher idle (base rebuilt, nothing to compute), eager wasm sweep running in the background (3,236 layouts still missing wasm cells after the rebuild — B21), machine **performance-1x**. The spark-tester bot posted the same 49 commands (one every ~1 s).

| what | value |
|---|---|
| loop stalls over 1 s during the round | **0** (loop lag p50 20 / p95 23 / p99 24 / max 825 ms) |
| heap | 270 / 298 MB (cap 1,400 MB) — GC was never the problem (§13a) |
| commands over 1 s | 12 / 49; over 5 s: **0** |
| median per-verb total (handler start → reply posted) | 419 ms; p90 1,556 ms |
| `help` (does no work) | 443 ms = the Discord reply POST floor from Fly |
| reads: view / stats / rank | 1,067 / 574 / 430 (view's 520 ms was the `/v1/meta` check on a cold connection) |
| writes: like / rename / add / swap! / remove | 1.1–1.9 s (layoutdb PUT ≈ 400 ms + reply POST ≈ 400 ms + Discord rate-limit queueing) |
| sfbs / examples | 4.3 / 4.2 s with fresh 60 ms, compute 0, no stall |
| tester-side round trip | p50 608 ms, p95 4,367, max 4,759 |

**What the 4 s on `sfbs`/`examples` is**: not CPU (no stall), not layoutdb (fresh 60 ms), not compute. Both verbs post the longest replies, and the tester fires 49 commands into ONE channel in about a minute — Discord's per-channel send bucket (5 messages / 5 s) makes discord.js queue the replies, and `total` is measured to "reply posted". Every long total in this round has the same shape (tiny measured phases, large remainder). The same lesson was learned on 2026-09-12 and forgotten; this time it is pinned down as **B22**: split the record into `handlerMs` (reply ready) and `postMs` (Discord send), keep the >1 s violations with their phases (today only >5 s are kept, so this round's twelve left no detail), and give the tester harness a pacing flag so a measurement never trips the bucket.

### 13a · What tonight ruled out, in order
1. **Publisher main-thread work** (111 s smoke stall, 46 s merge): fixed (LDB-B180, B12). Real, and gone.
2. **CPU contention with the CLI child on 1 vCPU**: real during a pass; passes now run on the throwaway machine (B17), the child is at nice 10 (B15).
3. **GC pressure**: ruled out — heap sits at 270 MB under a 1,400 MB cap; the 4–7 s idle stalls persisted after raising it (LDB-B218 keeps the heap visible).
4. **shared-cpu-2x**: FAILS at steady state — CPU probe 45 M iterations / 2 s (vs 2.2 B unthrottled), 4–7 s stalls in phase `idle`. The eager wasm sweep alone spends the burst credits. performance-1x is pinned in fly.toml; B21 (seed the cell store from the published base, so the sweep has nothing to do) is the path back to shared.
5. **Discord send-bucket queueing under the tester's burst**: the remaining >1 s totals — an artefact of measuring 49 commands per minute, to be separated out by B22.

### Verdict after round 2
- **R1 (correct, ordered)**: PASS — 49/49 answered correctly in every round.
- **R2 (≈ 1 s per command)**: **PASS for the bot's own work** at steady state on performance-1x — handler time is tens of ms for reads, ≈ 400–500 ms for writes (one layoutdb PUT), zero main-thread stalls; **the Discord reply POST adds ≈ 400 ms** from Fly `iad` that no bot change removes. **FAIL on shared-cpu-2x** (throttling) and **FAIL during an on-machine bulk pass** (both now avoided by configuration: performance-1x pinned, passes on the rebuild machine). B22 is needed before a clean number can be quoted for the write verbs under load.
- **R3 (incremental sorts)**: PASS (`rank` 430 ms total, 67 ms handler).
- **R4 (publish checks layoutdb)**: PASS.
- **R5 (site freshness)**: edit → published pointer ≈ 3–6 min at steady state (one small tick), 16 min for a whole-catalog rebuild; the < 1 min target needs B16's small ticks to skip the fixed ~2 min upload/smoke overhead (fold cadence, B18) — open.
