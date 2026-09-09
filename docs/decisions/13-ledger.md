# 13 — Operations ledger (handoff)

The living record for the layout-DB effort: what is deployed where, how it is
operated, and what is open. A new agent or session should be able to pick up
from this file plus `00-plan.md`'s index. Keep it current at every milestone;
dates are UTC.

## 1. Deployed state (2026-09-09 19:10Z)

| thing | where | version / state |
|---|---|---|
| `akl-db` Worker (production) | Cloudflare account **akl** (community, Workers Paid), `https://akl-db.akl-58a.workers.dev` | deployed by hand from 56cef60b as v499a8778 (If-Match required, LDB-P2); D1 `akl-db` (migrations 0001–0004), R2 `akl-db-dumps`; 4,176 layouts, diff vs cmini = zero; Workers Logs (observability) on |
| `akl-db-preview` Worker | same account, `https://akl-db-preview.akl-58a.workers.dev` | deployed from ≈18660e9e; D1 `akl-db-preview`, R2 `akl-db-dumps-preview`; seeded from cmini (4,176 records, seq 6213) with its first dump; clients `ops-bootstrap-preview` (`db/.env.ops.preview`) and `spark-preview` (`bot/.env.spt`) |
| Cron | akl account | **not dispatched by Cloudflare** (zero `workersInvocationsScheduled` rows since 12:45Z, recreated 3×, single `*/5` trigger since 15:03Z). Support ticket text: scratchpad `cloudflare-ticket.txt` (saltorbit submits). Manual kicks below (import, diff, nightly all have admin routes now). |
| `spark` Discord bot | saltorbit's Fly.io account, app `spark-bot`, region iad, **512 MB** (256 MB thrashed silently), volume `botdata` at `/data` | deployed by hand from the branch (`flyctl deploy --config bot/fly.toml --dockerfile bot/Dockerfile --remote-only --app spark-bot` from the repo root); prefixes `!spark !sp !aklgg !ag`; points at production; `TEST_BOT_IDS` = spark-tester (Fly secret, 18:57Z) so the e2e harness drives PRODUCTION with `E2E_ALLOW_PRODUCTION=1 --prefix '!sp'` (saltorbit: production is wiped before go-live; a run leaves no `e2e-*` layouts); verify-then-serve reads, fresh `If-Match` writes, SSE feed, memory watchdog DMing saltorbit (ALERT_USER_ID), 20 s request timeout, code-block-safe router, `!authors` under Discord's 2000-char cap, columnar harvest + LRU n-gram cache + heap flags (LDB-B20: peak ≈ 398 MB), failure DMs (LDB-B21: internal_error / db_timeout / db_unreachable / unhandled / discord_api_error / feed_down / bug, one digest per 10 min), shared `@akl/core` stats-cache with lazy per-corpus harvest (idle ≈ 188 MB); redeployed 18:22Z from 3341421e; live e2e 46/46 |
| `!spt` test instance (retired 18:57Z; config kept in `bot/.env.spt`) | saltorbit's laptop (`nohup node --env-file=.env.spt dist/main.js` in `bot/`, pid in scratchpad `spt.pid`, log `spt.log`) | same Discord bot user, prefix `!spt`, preview DB, `TEST_BOT_IDS` = spark-tester; the e2e harness drives it in `#bot-spam`. Dies with the laptop. |
| akl.gg (the site) | saltorbit's Cloudflare account, Pages project `aklgg` (subdomain `cmini-web.pages.dev`) | **production unchanged**: still scrapes cmini, no sign-in. Only `web/proposals/**` reached `main`. |
| Site PREVIEW with the write path | same project, Pages preview alias `db` → `https://db.cmini-web.pages.dev` | building from the branch (`gh workflow run build.yml --ref worktree-layout-db`, run 34392788816, dispatched 19:03Z). Preview env: `DB_BASE_URL` = the preview DB, `TOKEN_KEY` set, `DEPLOY_GIT_REF`=worktree-layout-db, `DEPLOY_PAGES_BRANCH`=db, Discord secrets from the magic era; D1 = the shared `cb-magic` with migration 0008 applied 19:00Z (additive `discord_tokens` table). Needs saltorbit: Discord redirect URI `https://db.cmini-web.pages.dev/auth/discord/callback`. |
| Registered DB clients | production `clients` table | `ops-bootstrap` (act-as-owner-only, saltorbit; key in `db/.env.ops`), `spark` (act-as-user; key in `bot/.env` and Fly secrets) |
| Admins | production `admins` table | saltorbit only (184412255822020608). Second admin: "later" (saltorbit, 2026-09-09). |

## 2. Where the secrets are (names only — never print, never commit)

- `db/.env` — `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID` for the akl account (wrangler reads it).
- `db/.env.ops` — `CLIENT_ID`, `CLIENT_PRIVATE_KEY` of the ops-bootstrap client (signs admin calls as saltorbit).
- `bot/.env` — `DISCORD_TOKEN`, `DISCORD_CLIENT_ID`, `DB_BASE_URL`, `PREFIXES`, `CLIENT_ID`, `CLIENT_PRIVATE_KEY`, `DATA_DIR` (the laptop instance; the same values are Fly secrets).
- `bot/.env.spt` — the `!spt` instance's config (preview DB, `spark-preview` client key, `TEST_BOT_IDS`); `db/.env.ops.preview` — the preview ops key.
- `bot/.env.test` — `TEST_BOT_TOKEN`, `TEST_GUILD_ID`, `TEST_CHANNEL_ID` of **spark-tester#4980** (id 1547267727939469504), the e2e driver; it posts in `#bot-spam` of saltorbit's test server.
- GitHub repo secrets: `CLOUDFLARE_DB_TOKEN`, `CLOUDFLARE_DB_ACCOUNT_ID`, `FLY_API_TOKEN`. Repo variable `DB_BASE_URL`: **unset** (setting it flips CI's scrape source to the DB — W6 step 1, saltorbit's call).

All four `.env*` files live in `.claude/worktrees/worktree-layout-db/{db,bot}/` and are gitignored.

## 3. Operating it

```
# signed admin call as saltorbit (scratchpad helper; reads db/.env.ops)
bash scratchpad/ops-call.sh POST /v1/admin/import/tick     # import kick (quiet tick = one upstream request)
bash scratchpad/ops-call.sh POST /v1/admin/diff/tick       # diff kick -> /v1/meta.last_diff
bash scratchpad/ops-call.sh GET  /v1/admin/health

# the nightly (prune + dump) or any cron job, run on Cloudflare's runtime through a dev session
cd db && npx wrangler dev --remote --test-scheduled --port 8799 --config wrangler.toml   # then:
curl "http://localhost:8799/__scheduled?cron=*/5+*+*+*+*"                  # import + drain tick
curl "http://localhost:8799/__scheduled?cron=*/5+*+*+*+*&time=<ms at 03:00Z>"  # + prune + dump (04:00Z -> + diff); the old cron strings now throw

# deploy
cd db && npx wrangler d1 migrations apply akl-db --remote --config wrangler.toml && npx wrangler deploy --config wrangler.toml
cd db && npx wrangler deploy --env preview --config wrangler.toml
flyctl deploy --config bot/fly.toml --dockerfile bot/Dockerfile --remote-only --app spark-bot   # from the repo root

# verify
cd db && DB_BASE_URL=https://akl-db.akl-58a.workers.dev npm run diff-upstream
flyctl logs --app spark-bot --no-tail | grep -E "cache: |ready as|Error"
```

Coupling rule: the DB refuses writes without `If-Match` (LDB-P2, v499a8778+); deploy a DB change and its bot/site client change together.

## 4. Branches

- `main`: the site as it runs; proposal pages; `web/proposals/db/systems.html` (the map).
- `worktree-layout-db`: the integration branch — every slice fast-forward-merged after its gate; pushed. Base is 10 commits behind `origin/main` (the bridge, popovers, backup work landed on main 2026-09-09). **Before the PR to main:** rebase, and renumber W4b's I-229..I-231 (main uses I-229..I-236); reconcile `design/cmini-write/06-holistic-proposal.md` (exists on main, not in this lineage).
- Slice branches `ldb-*` (worktrees under `.claude/worktrees/`): merged ones can be deleted.

## 5. Agent recipe (the worktree-pin bug)

One Claude Code session has ONE worktree pin shared by every plain-spawned agent; `EnterWorktree` by any of them re-pins all, and 3+ such agents livelock. **Working recipe:** spawn with `Agent(isolation: "worktree")`, brief the agent to NEVER call `EnterWorktree` and never leave its own `agent-<id>` worktree, first command `git fetch origin worktree-layout-db && git checkout -B ldb-<slice> origin/worktree-layout-db`, symlink `web/data`, `npm ci`; the lead merges with scoped scripts (`sh scratchpad/x.sh` — the guard inspects only the command line). Verified 2026-09-09 15:10 with four agents in parallel. Plain-spawned agents stay serialized.

## 6. Open items

Needs saltorbit: Cloudflare cron ticket; rename the Discord app to Spark; copy sign-off (`web/src/copy/db.ts`, `bot/src/copy.ts`, every `// COPY: sign-off pending`); second admin (later); GitHub org / npm scope / hostname (X6); when to PR to main and start W6's flips; W5 §5 Q2 — migrating magic forks 10 layouts from cmini (auditor, chog, echo, opal, opal-dario, opaline, sunstone, vylet, vylet-v4, whirl): acceptable?

In flight (2026-09-09 19:00Z): nothing — every slice through phase 5 that does not need saltorbit is on the branch. Merged since 18:00Z: X4's restore drill (`db/drill/`, LDB-D5; proof run against preview: fetch/restore/verify ok, 4,176 layouts, 22 s, report stored as `/v1/meta.last_drill` on preview), the e2e harness capture fix, X5b (`@akl/core/stats/stats-cache.ts`, I-243; bot cells.ts an adapter; site swap memo on the shared LRU; idle 290 → 188 MB). Merged since 17:45Z: `POST /v1/admin/nightly/tick` (deployed prod b32eb3e3 / preview 4de9d8fb; verified: all four jobs ok, dump rewritten), the memory work, the alerts module. Merged since 16:50Z: the transition plan (15), X5 (`@akl/layout-formats` from db/formats, `@akl/core` from web/src/core+copy, bot on file: links, repoLayout(), CODEOWNERS generator, `scripts/split/split-db.sh --dry-run` green for both repos, weekly split-dry-run CI job; bot tests that need web/data now skip with a reason in CI). Fly machine resized to 1 GB after the 80% watchdog fired at rest (345-375 of 459 MB). Merged since 16:30Z: W4d (catalog rows carry `_dbId`/`_rev` under --source db, forking stamps Draft.origin, real conflict path in Playwright; I-242; LDB-S1 parity now compares stripped of the two fields), the e2e checker's structural normalisation (9 ok / 37 explained / 5 skipped vs the offline transcript). Merged since 16:00Z: bot addendums (LDB-B15/B16/B17), W5's LDB-G5 fix, the copy sign-off list (14), the e2e harness (LDB-B18; first live run 45/51 → found the router code-block bug and `!authors` > 2000 chars), W4c (I-237..I-241; promoted card, own-card verbs, safe overwrite; Fingermap inline skipped — no bench finger editor to reuse), DB sweep (client-lane 401 codes across every A-group route, bidirectional tag coverage; 15,295 db tests), the two bot fixes (LDB-B19; live run now 46/46).

Site preview for saltorbit to try the publish UX needs two things that touch his Cloudflare account: migration 0008 (token table) on the site's D1 and `DB_BASE_URL` on the Pages preview environment — both W6-adjacent, not done.

Not started (saltorbit's, or gated on saltorbit): the drill's Fly deploy (`akl-db-drill`, `db/README.md` § Drill has the commands), X4b (delete CI daily steps after 7 green days), V7's remaining half (bot.yml deploy on main), W6 (every step saltorbit's), bot `freqd` (needs a 4-gram table), W5's two `invalid` rule sets (`adaptative-magic-sturdy`, `jazz`: adaptive trigger `C` not on the board — site data bug).

The `!spt` instance's e2e runs write throwaway layouts to the PREVIEW DB only (`e2e-<runid>` names, removed at the end of each run).

Known transient: two production 500s at 15:20–15:22Z (a PUT and a `/v1/changes`), untraceable at the time; Workers Logs are on since 15:3xZ so the next one is queryable in the dashboard.
