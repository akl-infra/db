# HANDOFF — layoutdb v2 (written 2026-09-12 ~22:50Z, end of the architecture-review + implementation day)

**Read in this order:** this file → `LEDGER.md` (slice table + log) → `REQUIREMENTS.md` (binding) → `PROPOSAL.md` (target shape, saltorbit's answers) → `LATENCY.md` (round-1 measurements). The three audits (`audit-db.md`, `audit-bot.md`, `audit-site.md`) are the evidence behind the proposal. Pages for humans: https://db.cmini-web.pages.dev/artifacts/ (proposal, data flow, layoutdb architecture, ecosystem map).

## 1 · Where everything is

| thing | where | state |
|---|---|---|
| integration branch | `ldb-arch-review` (from `ldb-formats`), pushed; **761 commits ahead of `main`, nothing merged to `main`** (saltorbit: never merge to main / never disrupt shipping akl.gg without him) | tip `f11747a46` + this commit |
| worktree | `~/git/akl/aklgg/.claude/worktrees/ldb-arch-review` (has `node_modules`, `db/node_modules`, `bot/node_modules`, `vendor/mana2` checked out) | keep |
| layoutdb (prod, the ONE) | Cloudflare account `akl` (58a5eb82…), Worker `akl-db` at https://akl-db.akl-58a.workers.dev, D1 `akl-db`, R2 `akl-db-dumps` | wave 1 deployed (v1fa2965c, migrations 0010–0013); **every push to `ldb-arch-review` redeploys it via `db.yml` pr-deploy** |
| spark (bot + publisher) | Fly app `spark-bot`, machine `7841609c5d3628`, iad, shared-cpu-2x 2 GB, volume `botdata` at `/data`; saltorbit's Fly account | release **v41** (all of wave 2 + fixes); `/health` on port 8787 inside the machine |
| data bucket | R2 `aklgg-data-preview` in saltorbit's CF account (e86dfd0f…) — the ONE bucket despite the name; public origin `https://pub-bba1babff00548f4b9960b17c1d898ea.r2.dev`; line `H = 2cb8a634dffbebc1469476d4c4c1f011bba0e194215f1c1f65dbadddf3654024` | publisher writes here via S3 API |
| pointer-mode site | `https://db.cmini-web.pages.dev` = the `db` alias of Pages project `aklgg` (saltorbit's CF account) | A1 build deployed by hand (recipe §4) |
| production akl.gg | untouched all day; still on `main`'s pipeline (meta-watch, live-sync, D1 stat patches) | the flip is A2, saltorbit runs it |
| old stats service | Fly app `aklgg-stats-preview` | **scaled to 0** (was double-publishing); delete when confident |
| data-writer Worker | `aklgg-data-writer-preview` (saltorbit's CF) | code deleted from repo; Worker still deployed — delete it |

Secrets/credentials (never in the repo): `~/.config/aklgg/spark-r2.env` (R2 keys; staged on Fly as `R2_ACCESS_KEY_ID`/`R2_SECRET_ACCESS_KEY`), `~/.config/aklgg/latency-client.env` + `.pub` (Ed25519 client `01M2BJ11PDDXS6SBT4TQPE9R3H`, caps `act-as-owner-only,feed:wait`, acts as saltorbit — **revoke when V1 is done**: `UPDATE clients SET status='revoked' …`), `~/.config/aklgg/ldb-scratch-path` (this session's scratchpad path). Wrangler is logged in to both CF accounts; `flyctl` to saltorbit's Fly.

## 2 · What landed today (all on `ldb-arch-review`)

Wave 1 (layoutdb): L4 deletions + gated long-poll (`?wait=`), L1 import fixes (likes union, sticky shadow names, tombstone revive, tick lock, per-id isolation), L2 backups (dump catch-up, `clients` dumped, health, CI artifact, Time Travel runbook), L3 Idempotency-Key with reservation. db suite 15,810 green.

Wave 2 (spark): B1 cell store/row tables/instant rank, B2 publisher (SigV4 S3 client, base/overlay/pointer CAS, smoke test), B3 long-poll feed + boot + write reconciliation + baked wasm, B4 safety nets S1/S2/S4 + `/health`, B5 overlay catalog rows via `scripts/overlay_rows.py`, B6 boot never waits on the sweep (incident 1), B7 publisher never downloads the base (incident 2), B8 bounded ticks + `--jobs 2` + sweep pause, V0 per-verb latency histogram + `bot/scripts/measure-latency.mjs`. Plus live fixes: CLI wrapper chmod, `overlay_rows.py` path, weak-ETag normalisation, smoke-test Origin header, feed actor before login (`BOT_USER_ID`) + long-poll retry. bot suite 1,133+ green (live parity tests gated behind `LIVE_TESTS=1`, nightly job).

Wave 3 (site): A1 pointer-only build (`npm run build`), owned-but-uncatalogued rows render, 60 s pointer poll, proxy hardening, dead dispatch deleted. Site vitest 6,688 green, gates `--fast` pass.

Docs: REQUIREMENTS, PROPOSAL, LATENCY, LEDGER, four artifact pages (all measured for SVG clipping in Chrome).

## 3 · What is running right now, and what to watch

- **Publisher backlog pass**: ~4,100 layouts left at ~25 per 11–16 min (shared-CPU throttled) ≈ 33 h. Progress: `flyctl logs --app spark-bot --no-tail | grep 'publisher: tick'`; pointer: `curl https://pub-…r2.dev/lines/<H>/current.json`. Each tick swaps the pointer, so the site gains ~25 layouts' fresh stats per tick. **DONE 2026-09-13: resized to `performance-1x`** (`flyctl scale vm performance-1x --memory 2048 -a spark-bot`, ~$31/mo, ~2–3 h backlog) — see LATENCY.md §7b.
- **Bot health**: `flyctl ssh console -a spark-bot -C "node -e \"fetch('http://localhost:8787/health').then(r=>r.json()).then(j=>console.log(JSON.stringify(j).slice(0,3000)))\""` — checks S1/S2/S4/feed/publisher/memory, `latency.since_boot` per verb (empty until real Discord commands arrive), `latency_violations`, `feed_wake_ms`.
- **After ANY spark deploy**: watch `flyctl logs … --no-tail` for `spark-bot ready as` within ~60 s and `publisher: started`; boot should log `boot timings … totalMs ≈ 3000`. Rollback: `flyctl releases -a spark-bot --image` → `flyctl machine update 7841609c5d3628 -a spark-bot --image <previous> --yes`.
- **layoutdb**: `curl https://akl-db.akl-58a.workers.dev/v1/meta` → `health.dump.stale` must be false; import runs every 5 min.

## 4 · How to operate

- **Agents**: spawn with `isolation: "worktree"`, first commands `git reset --hard ldb-arch-review` + `npm ci` (+ `cd db && npm ci && npm run build:formats`, build `packages/akl-core`, `cd bot && npm ci`); parallel is fine; each brief names sibling slices' files. Land with `scripts/land-slice.sh <branch>` (rebases onto the integration branch, auto-resolves LEDGER-only conflicts, ff-merges, pushes); the lead commits its own doc edits with `scripts/lead-commit.sh "<msg>"`. Both scripts live in `design/layout-db/review/scripts/` (copy to a scratchpad; they hard-code the worktree path).
- **Deploy layoutdb**: automatic on push (db.yml). By hand: `cd db && CLOUDFLARE_ACCOUNT_ID=58a5eb82948e2134d8b7b242e9567ac4 npx wrangler d1 migrations apply akl-db --remote && npx wrangler deploy`.
- **Deploy spark**: from the worktree root `flyctl deploy --config bot/fly.toml --dockerfile bot/Dockerfile --remote-only --yes` (needs `vendor/mana2` checked out: `git submodule update --init --depth 1 vendor/mana2`). Then watch the logs (above).
- **Deploy the db-alias site**: `VITE_DATA_LINE=2cb8a634dffbebc1469476d4c4c1f011bba0e194215f1c1f65dbadddf3654024 npm run build` (pointer mode; PIN the live line -- since L9 (2026-09-13) this checkout's derived line key is 70b38d1c…, whose pointer does not exist, and an unpinned build boots EMPTY -- happened once, 18:28Z), then copy `dist`, `functions`, `web/src` to a folder OUTSIDE the repo and `CLOUDFLARE_ACCOUNT_ID=e86dfd0fe883a226db7cb97a327b98ad npx wrangler@4 pages deploy dist --project-name aklgg --branch db --commit-dirty=true` (running inside the repo picks up a placeholder `wrangler.jsonc`).
- **Measure**: `node bot/scripts/measure-latency.mjs --db-url=https://akl-db.akl-58a.workers.dev --site-url=https://akl.gg --key-file=$HOME/.config/aklgg/latency-client.env --client-id=01M2BJ11PDDXS6SBT4TQPE9R3H --author=184412255822020608 --plain-layout=colemak --magic-layout=hours --reps=5 --no-fail` (add `MEASURE_WRITES=1 --scratch-layout=<name>` for writes). `scripts/edit2pointer.mts` (run with `node --experimental-strip-types`) times a create → published pointer; `scripts/del-e2p.mts <id>` deletes a leftover test layout.

## 5 · Open items, in priority order

0a. **State as of 2026-09-13 11:00Z (cutover done)**: prod layoutdb runs the rewritten spark/1 (wiped + re-imported: 4,177 layouts, ids are the identity); spark on the new-shape reader in Fly `lax` (machine 86de22fee000e8, volume vol_vp26w21jgw97ddw4; the iad machine 7841609c5d3628 + vol_v8ek7w2p3ky17xlv are STOPPED rollback, delete after 2026-09-14); pointer → complete base `20260913T104711Z-e5fac4119679`; db.cmini-web.pages.dev verified. First jobs: **B28b** (rebuild.js emits a complete base keyed by the DB id — until then a bot edit duplicates its row on the alias; a re-publish artifact sits in `.claude/worktrees/agent-ab513b7a38b27080c/build/newbase`), **B26**, **B27**, then the other sessions' L8/L9/I1. Memory: growth was the wasm engine's linear memory → capped (B29, `ENGINE_WASM_MAX_MB=384`). Incidents 3–4 and the Smart Placement lesson are in the ledger log.

0. **State as of 2026-09-13 05:00Z**: spark v50 on `performance-1x` (pinned; shared-cpu-2x throttles at steady state), batch compute ON, heap cap 1.4 GB. First real B17 rebuild done (base `20260913T042115Z-d83b197cd674`); `bash scripts/rebuild-on-fly.sh` is the rebuild path (`DRY_RUN=1` first). LATENCY.md §13 has the round-2 verdict. Next: **B24 move spark to Fly `den`** (writes 1.0–1.3 s → ≈ 0.4 s; LATENCY §14a), **B21** (seed cells from the base → back to shared CPU), **B20** (publisher notices an external base swap), then W3/L5 per saltorbit's order.

1. **Deploy spark** (saltorbit; the permission classifier denies the lead's `flyctl deploy`): `cd .claude/worktrees/ldb-arch-review && flyctl deploy --config bot/fly.toml --dockerfile bot/Dockerfile --remote-only` — ships B10 (quiet feed timeouts, S4 at boot, truthful S2/S1, watchdog digest) + B11 (`/health.loop_lag_ms`, per-tick publisher fields). Machine is already `performance-1x` 2 GB (resized 2026-09-13 00:41Z; first pass ≈ 10.5 h at 25 layouts / 4 min); drop back to `shared-cpu-2x` after the backlog and watch `/health.loop_lag_ms` + `feed_wake_ms` for 24 h.
1b. **B12 publisher off the main thread** — after B11 numbers: `overlay.ts applyDelta`, `manifest.ts sha256Hex`, `fold.ts mergeOneFile` are synchronous multi-MB JSON/hash work on the bot's thread (LATENCY.md §9); move to `worker_threads` or chunk with yields. Also: publisher health check should go red on `catalog_rows_failed`/`pointer_contention`, not only smoke failure.
2. **V1 round 2**: after real Discord usage, read `/health.latency` p50/p95 per verb on Fly; `feed_wake_ms`; steady-state edit → pointer (expected < 1 min); 24 h memory/CPU. Write it into LATENCY.md and the artifacts page (a LATENCY page is not yet an artifact — make one and add it to `design/artifacts/index.json`; test `web/tests/tools/artifacts.test.mjs`).
3. **#330 (PR #332 open, fix verified; merge before A2) akl.gg tab memory growth** (production Safari tab reached 3 GB in ~4 days). Pre-existing, but A1's 60 s poll would amplify it — fix before A2. Repro plan in the issue.
4. **B9 follow-ups**: S1 should log divergent ids; Worker long-poll check interval 1 s → 250 ms (wake p50 ≈ 1 s today); delete `aklgg-stats-preview` and `aklgg-data-writer-preview`; the `history.json` written per tick has `db_seq: None` (bug in `recordHistory`).
5. **A2 the production flip** (saltorbit runs): Pages prod `DB_BASE_URL`, CI var, pointer-only build, remove meta-watch — one atomic change; then delete the prod stats path + rotate `GITHUB_DISPATCH_TOKEN`. **A3** monthly reference harvest (S6).
6. **L5 moderation** (bans, admin overrides, `link` + queue) → **W1 layoutdb website** (own design round) → **W3 spark/1 format discussion** (saltorbit: not done) → **L6** delete the frozen format-chain machinery once spark/2's shape is decided → **W2** second admin + domain.
7. **D3** retire `design/layout-db/00–22` and `design/pipeline-313/*` to `historical/` (saltorbit said yes); make REQUIREMENTS.md the standing file; point CLAUDE.md at it.
8. Revoke the latency-measure client when V1 closes; remove the `lead-e2p-*` / `lead-latency-scratch*` tombstones if they bother anyone (disposable DB).

## 6 · Gotchas learned today (also in memory)

- Fly shared CPU: full core for ~1 min of sustained load, then ~1/11th. Any sustained compute (publisher backlog, full rebuild) needs `performance-*` or patience.
- R2 S3 API: conditional PUT works (If-Match quoted or unquoted → 200; stale → 412; If-None-Match:* on existing → 412), but a GET may return a **weak ETag** `W/"…"` — normalise before comparing. R2 emits CORS headers **only** when the request has an `Origin` header.
- The bundled bot is `/app/dist/main.js` (esbuild flattens): resolve sibling files from `/app`, not `dist/..`. `COPY` doesn't guarantee +x: `chmod` scripts in the Dockerfile. The submodule's `.git` pointer file must be removed before `git apply` in the image; the bake stage needs `ca-certificates`.
- Never `await` background work in boot; start `/health` first; log every boot phase.
- Agents in `isolation: "worktree"` run in parallel fine; the old livelock was cd-based. Agent branches base on `main` — always `git reset --hard ldb-arch-review` first. Renumber invariant ids at landing time (three collisions today).
- macOS has no `timeout`; the Fly image has no `curl`/`ps` — probe with `node -e` over `flyctl ssh console`. Background waiters on the laptop get killed when memory is low — keep them short.
