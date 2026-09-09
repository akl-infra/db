# Infrastructure — where everything runs, and what is penciled in

Status: notes (2026-09-09). Part of `00-plan.md`. Nothing here changes the
phase-1 briefs (`07`); it is the map of what runs where today, what phase 1
adds, and the follow-ups saltorbit asked to have written down rather than
decided now.

## 1. The map

| what | where | account / owners | cost | state |
|---|---|---|---|---|
| akl.gg site — static SPA + Pages Functions + D1 `cb-magic` (magic rules, stat/layout patches, analytics) | Cloudflare Pages project `aklgg` | the site's account | free tier | live |
| `workers/meta-watch` — 2-min poll that dispatches live-sync | Cloudflare Workers | the site's account | free | live |
| **Layout DB** — Worker `akl-db`, D1 `akl-db` (`53f596d5…`), R2 `akl-db-dumps` (90-day expiry on `dump-*`); crons: import `*/5`, dump `0 3` | Cloudflare Workers | **`akl` account** (`58a5eb82…`), ≥ 2 Super Admins; CI uses an account-owned token (`CLOUDFLARE_DB_TOKEN` / `CLOUDFLARE_DB_ACCOUNT_ID`) | free tier; Workers Paid ($5/mo) only if polling outgrows it | D1 + R2 created 2026-09-09; Worker deploys at S7 |
| **Discord bot** — `!aklgg` (tentative), TypeScript, shares the site's engine (`05`) | Fly.io, one `shared-cpu-1x`, 256 MB to start, no volume | a Fly organisation with both admins; Discord app under a Discord Team | ~$2–3/mo | phase 4 |
| CI — site gate/builds/live-sync; `db.yml` test + deploy; daily DB diff + rehost drill | GitHub Actions, hosted runners | the repo (an org later, `04 §1`) | private-repo minutes (the site's builds are the consumer, not the DB) | live; DB jobs from S7/S8 |
| upstream — cmini `layoutapi/v3` | not ours | — | — | imported one-way while it exists (`06 §2`) |

New monthly spend for DB + bot: $2–3; ~$8 if the DB needs Workers Paid.

## 2. Penciled in — not now, but written down

Each is a self-contained follow-up; none blocks phase 1, none changes the
briefs. Order is a suggestion.

1. **Daily upstream diff → a Worker cron.** It is HTTP + compare, so it
   needs no CI: a third cron in `wrangler.toml`, result in `import_state`
   (`cmini.last_diff = {at, differences, summary}`), surfaced on `/v1/meta`
   or a small `/v1/health`. Free, faster to check, and independent of
   GitHub — a takeover survives GitHub going away. Keep `db.yml`'s daily
   job until the cron has run green for a week, then delete the job.
2. **Rehost drill → a Fly scheduled machine.** It needs a fresh local D1
   (miniflare), so it cannot live in the Worker; `fly machine run <image>
   --schedule daily` in the bot's org, same Dockerfile lineage, posting
   its result to the same health endpoint. Cents per month. Same handover
   rule as (1).
3. **`db/` → its own public repo** (`04 §5`, `00 §7`): unlimited Actions
   minutes, the format registry gets its own OWNERS/CODEOWNERS, and
   `db/formats` publishes as `@akl/layout-formats`. Do this as soon as
   phase 1 is stable, not "eventually".
4. **A domain inside the `akl` account** for the API (a Workers custom
   domain must be on a zone in the same account — a CNAME from `akl.gg`
   to `*.workers.dev` gets no certificate). Registered in the account so
   it is co-owned. Also unlocks the edge-cache half of `03 §5`.
5. **Self-hosted runner for the site's builds** — only if the repo's
   minutes keep being the constraint: one Hetzner CX32/CX42 (~€7–15/mo)
   registered as an ephemeral, containerised runner; `runs-on:
   self-hosted` on `full-rebuild.yml` and `build.yml`'s build job first
   (the minute hogs; also 3–4× faster than the 2-vCPU hosted runners),
   hosted `ubuntu-latest` kept as the fallback label. Not a different CI
   system — the workflows stay as they are.
6. **Bot memory:** start at 256 MB and measure peak RSS across every
   compute verb in the test guild; `fly scale memory 512` is one command
   if the logs show OOM restarts (an OOM drops one command, loses nothing).
7. **Bot ↔ site sharing:** `web/src/core` → `@akl/core` package at the
   split (`05 §1`); until then the archlint exception `bot → web/src/core |
   db/formats` only.

## 3. What is deliberately *not* on the list

- Moving the DB to Fly (or anywhere with a database to run): Workers + D1 +
  R2 is the right shape for a request/response API with two crons, and the
  rehost drill is one D1 import; on Fly it would be volumes and backups we
  own.
- Moving CI to another system (Buildkite, Woodpecker, GitLab CI): eight
  workflows with matrices and composite actions rewritten for no functional
  gain; (5) gets the cost and speed with a one-line change per job.
- Cloudflare for the bot: it must hold a Discord gateway websocket open —
  a Worker cannot.
