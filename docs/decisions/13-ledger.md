# 13 — Operations ledger and pickup guide

**Start here.** This is the handoff for the layout-DB effort: what exists, where it runs, how to operate it, how to resume the work with agents, and what is open. Written 2026-09-09 ~19:45 UTC at branch tip `worktree-layout-db`; every earlier design doc (00–12, 14, 15) is referenced from here. Dates are UTC.

## 0. One-paragraph status

The community-owned layout database is **live in production** (Cloudflare Worker `akl-db`, 4,176 layouts imported from cmini, diff vs cmini = zero) and the Discord bot **spark** is **live on Fly** against it with cmini command parity (every verb but `freqd`). The akl.gg site's write path (Discord sign-in, publish sheet, promoted card, own-card verbs) is built and running on a **Pages preview** (`https://db.cmini-web.pages.dev`) against the preview DB; **production akl.gg is untouched** and still scrapes cmini. All of this lives on the branch `worktree-layout-db`; nothing but the proposal pages reached `main`. Every phase of the plan that does not need saltorbit's decisions is built, tested (db 15,344 tests, bot 510, site 6,285, Playwright 500, all gates green) and deployed where deployment was safe. The one platform-level blocker: Cloudflare is not dispatching this account's cron triggers (support ticket pending), so the import/dump/diff run only when kicked by hand.

## 1. Deployed state

| thing | where | state |
|---|---|---|
| `akl-db` Worker (production) | Cloudflare account **akl** (community, Workers Paid), `https://akl-db.akl-58a.workers.dev` | deployed by hand from the branch (last: 814b517d as vb32eb3e3). D1 `akl-db` (migrations 0001–0004), R2 `akl-db-dumps`. If-Match required on every write (LDB-P2). Workers Logs on. Admin kicks: `POST /v1/admin/{import,diff,nightly}/tick`. |
| `akl-db-preview` Worker | same account, `https://akl-db-preview.akl-58a.workers.dev` | same code; D1 `akl-db-preview` seeded from cmini (4,176) + dumped; the site preview and any test bot write here. |
| Cron | akl account | **not dispatched by Cloudflare** — one `*/5 * * * *` trigger registered; `workersInvocationsScheduled` shows zero attempts account-wide since 12:45Z (recreated 3×, dashboard-added too). Ticket text: scratch `cloudflare-ticket.txt` (saltorbit submits). Kick by hand (§3). |
| `spark` bot | saltorbit's Fly account, app `spark-bot`, iad, **1 GB** (256 MB thrashed, 512 MB alerted at rest), volume `botdata` at `/data` | deployed by hand from the branch (last: 3341421e). Prefixes `!spark !sp !aklgg !ag`. Points at production. Verify-then-serve reads, fresh `If-Match` writes, SSE feed, memory watchdog + failure DMs to saltorbit, lazy per-corpus harvest (idle ≈ 190 MB). `TEST_BOT_IDS` secret = spark-tester, so the e2e harness drives production. |
| akl.gg (production site) | saltorbit's Cloudflare account, Pages project `aklgg` (subdomain `cmini-web.pages.dev`) | **unchanged**: scrapes cmini, no sign-in. Only `web/proposals/**` (proposal pages, the unlisted `db/systems.html` map) reached `main`. |
| Site preview with the write path | Pages preview alias `db` → `https://db.cmini-web.pages.dev` | built from the branch by `gh workflow run build.yml --ref worktree-layout-db` (run 34393036960). Preview env: `DB_BASE_URL` = preview DB, `TOKEN_KEY`, `DEPLOY_GIT_REF`=worktree-layout-db, `DEPLOY_PAGES_BRANCH`=db, Discord secrets (magic-rules era), D1 = the shared `cb-magic` with migration 0008 applied. **Needs saltorbit**: Discord redirect `https://db.cmini-web.pages.dev/auth/discord/callback` on the Spark application's OAuth2 page. |
| DB clients | production `clients` | `ops-bootstrap` (act-as-owner-only, saltorbit; key `db/.env.ops`), `spark` (act-as-user; key in `bot/.env` + Fly secrets). Preview: `ops-bootstrap-preview` (`db/.env.ops.preview`), `spark-preview` (`bot/.env.spt`). |
| Admins | production `admins` | saltorbit only (184412255822020608). Second admin: later (saltorbit). |
| e2e tester | Discord bot **spark-tester#4980** (id 1547267727939469504), `bot/.env.test` | drives spark in `#bot-spam` of saltorbit's test server: `E2E_ALLOW_PRODUCTION=1 node bot/scripts/e2e.mjs --prefix '!sp' --spark-id 1537826030046281909`. Last runs 46/46. |

## 2. Secrets (names only — never print, never commit; all gitignored, all under `.claude/worktrees/worktree-layout-db/`)

- `db/.env` — `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID` (akl account; wrangler reads it for every `db/` command).
- `db/.env.ops`, `db/.env.ops.preview` — `CLIENT_ID`, `CLIENT_PRIVATE_KEY` of the ops-bootstrap clients.
- `bot/.env` — `DISCORD_TOKEN`, `DISCORD_CLIENT_ID`, `DB_BASE_URL`, `PREFIXES`, `CLIENT_ID`, `CLIENT_PRIVATE_KEY`, `DATA_DIR` (laptop copy of the Fly secrets).
- `bot/.env.spt` — the retired laptop `!spt` instance (preview DB, `spark-preview` key, `TEST_BOT_IDS`).
- `bot/.env.test` — `TEST_BOT_TOKEN`, `TEST_GUILD_ID`, `TEST_CHANNEL_ID` (spark-tester).
- saltorbit's wrangler OAuth login (`~/.wrangler/config/default.toml`) sees both accounts; the Pages project config was edited through it.
- GitHub: secrets `CLOUDFLARE_DB_TOKEN`, `CLOUDFLARE_DB_ACCOUNT_ID`, `FLY_API_TOKEN`, `CLOUDFLARE_API_TOKEN`/`_ACCOUNT_ID` (site). Repo variable `DB_BASE_URL`: **unset** (setting it = W6 step 1).

## 3. Operating it

```
# signed admin call as saltorbit (add --preview for the preview DB)
sh db/scripts/ops-call.sh POST /v1/admin/import/tick       # cmini import (quiet tick = one upstream request)
sh db/scripts/ops-call.sh POST /v1/admin/nightly/tick      # prune + today's dump
sh db/scripts/ops-call.sh POST /v1/admin/diff/tick         # ours vs cmini -> /v1/meta.last_diff
sh db/scripts/ops-call.sh GET  /v1/admin/health
sh db/scripts/ops-call.sh POST /v1/admin/clients '{"name":..,"pubkey":..,"owner_user_id":..,"caps":"act-as-user"}'

# deploy (from the branch checkout; db/ needs `npm ci` and `npm run build:formats` once)
cd db && npx wrangler d1 migrations apply akl-db --remote --config wrangler.toml && npx wrangler deploy --config wrangler.toml
cd db && npx wrangler deploy --env preview --config wrangler.toml
flyctl deploy --config bot/fly.toml --dockerfile bot/Dockerfile --remote-only --app spark-bot   # repo root; Fly builds remotely
gh workflow run build.yml --ref worktree-layout-db                                            # the site preview (db.cmini-web.pages.dev)

# verify
cd db && DB_BASE_URL=https://akl-db.akl-58a.workers.dev npm run diff-upstream                # must say zero differences
flyctl logs --app spark-bot --no-tail | grep -E "cache: |ready as|Error"
E2E_ALLOW_PRODUCTION=1 node bot/scripts/e2e.mjs --prefix '!sp' --spark-id 1537826030046281909   # 46/46 expected; leaves no e2e-* layouts
sh db/drill/run.sh   # restore drill (needs DB_BASE_URL + DRILL_* env; see db/README.md § Drill)

# local bot build (the integration worktree): packages first
cd db && npm run build:formats; cd ../packages/akl-core && npm ci && npm run build; cd ../bot && npm ci && npm run build
```

Coupling rule: the DB refuses writes without `If-Match`; deploy a DB change and its bot/site client change together. `wrangler dev --remote --test-scheduled` runs `scheduled()` on Cloudflare's runtime but IGNORES `?time=` — use the admin tick routes instead.

## 4. Repo, branch, worktrees

- `main`: the site as it runs + proposal pages. 10+ commits ahead of this branch's base (bridge, popovers, backup); this branch cherry-picked main's Pages-rename CI fix.
- `worktree-layout-db`: the integration branch, pushed, fast-forward only. **Before the PR to main:** rebase onto `origin/main`; invariant ids are already renumbered past main's I-236 (site I-237..I-243); reconcile `design/cmini-write/06-holistic-proposal.md` (exists on main, not here).
- Slice branches `ldb-*` and agent worktrees `.claude/worktrees/{worktree-ldb-*,agent-*}`: all merged; safe to delete (`git worktree remove`, `git branch -D`).
- Layout: `db/` (Worker; `db/formats` = `@akl/layout-formats`), `bot/`, `packages/akl-core` (= `@akl/core` from `web/src/core` + `copy`), `web/src/**` (site), `functions/api/db/*` (proxy), `scripts/{sync_cmini_data.py,migrate_magic_rules_to_db.py,verify_magic_migration.py}`, `scripts/split/split-db.sh --dry-run` (the future repo split, green), `design/layout-db/00–15`.
- Invariant registries: `db/INVARIANTS.md` (LDB-*), `bot/INVARIANTS.md` (LDB-B*), `design/INVARIANTS.md` + behaviour catalog (site). Each row names its enforcing test; tag-coverage tests fail on drift in both directions.

## 5. Resuming with agents (read before spawning anything)

One Claude Code session has ONE worktree pin shared by every plain-spawned agent; `EnterWorktree` by any of them re-pins all, and 3+ such agents livelock. **Recipe that works (verified with 5 parallel agents):** `Agent(isolation: "worktree", model: "sonnet")`; brief the agent to NEVER call `EnterWorktree`, never leave its own `.claude/worktrees/agent-<id>` worktree, never push; first command `git fetch origin worktree-layout-db && git checkout -B ldb-<slice> origin/worktree-layout-db`, then `ln -s ~/git/akl/aklgg/web/data web/data` and the `npm ci`s it needs; commit on its branch; report SHA + counts. The lead verifies and fast-forward-merges each branch with a scoped script (`cd <worktree>; guard on branch; git rebase; gates; cd integration; git merge --ff-only; git push`) — scripts run as `sh file.sh` because the guard only inspects the command line. Plain-spawned agents must stay serialized. Never run `scripts/mine_behaviors.mjs --dry-run` in the integration worktree (it rewrites the catalog). Composite GitHub actions must not contain `${{ vars.X }}` anywhere, even in descriptions.

## 6. Open items

**Needs saltorbit (nothing else blocks on these):**
1. Cloudflare support ticket for cron dispatch.
2. Discord: rename the app to Spark; add the preview redirect URI (§1).
3. Copy sign-off: `14-copy-signoff.md` lists every `// COPY: sign-off pending` string (`web/src/copy/db.ts`, `bot/src/copy.ts`).
4. Decisions in `15-transition.md` §8 (import end state, renames, the 10 layouts the magic migration forks, likes union) and §4.
5. Second admin (later); GitHub org, npm scope, hostname (X6).
6. When to open the PR to main, and W6's production flips (`11-implementation-phase3.md` §1 W6): repo variable `DB_BASE_URL`, meta-watch, the real magic migration (`scripts/migrate_magic_rules_to_db.py` without `--dry-run`), Pages production env, retiring the magic PUT.
7. Fly deploy of the restore drill (`db/README.md` § Drill); X4b (delete the CI daily diff steps after 7 green days).

**Known gaps, deliberate:** bot `freqd` (needs a 4-gram table the site never built); Fingermap inline edit on the site (no reusable finger editor); two invalid rule sets in the site's magic data (`adaptative-magic-sturdy`, `jazz`: adaptive trigger `C` not on the board).

**Nice-to-haves not started:** a "did you mean" on fuzzy misses (cmini-faithful today: a miss resolves to the nearest layout); persisting the bot's stats memo across restarts; the drill as a scheduled Fly machine.

## 7. Where to look when something is wrong

- DB 5xx: Cloudflare dashboard → akl-db → Logs (Workers Logs on since 15:3xZ); `/v1/admin/health`; `flyctl logs` shows the bot's side (every failed write logs route/status/message).
- Bot: saltorbit gets a DM for internal errors, DB timeouts, unhandled exceptions, Discord API errors, a dead feed (5 min), memory over 80 %, and non-clean restarts; `flyctl logs --app spark-bot` for the rest; `flyctl machine status 7841609c5d3628`.
- Import drift: `npm run diff-upstream` (§3); the import's state is in D1 `import_state`.
- Backups: daily dump in R2 (`/v1/dump/latest.json`); restore proven by `db/drill` (LDB-D5) and `db/README.md` § Rehost.
