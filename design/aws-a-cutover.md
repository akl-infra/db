# akldb on AWS, design A: phase E (the cutover and the rollback)

Companion to `design/aws-a-ops.md` (stacks), `design/aws-a-ops-boot.md` (boot, snapshots) and `design/aws-a-ops-shadow.md` (the proving
ground). Invariants: LDB-CV2..CV4 and CV10..CV14 in `INVARIANTS.md`. Nothing in this file has been run against Cloudflare or AWS: the
tools are tested against fakes (`tests/cutover/`), and the rehearsal below is what proves the real commands.

**Target:** 2026-11-04, 09:00-14:00 UTC. There is no 7-day proving run: manual tests, flip, watch about one hour.
**Gate (build plan, phase E):** write pause at most 5 minutes on each rehearsal; every proof equal; a signed write, `If-Match` 412, feed
contiguity and ETag 304 after the flip; 24 h of prod alarms quiet.

## How it works

D1 stays the source of truth until the flip. Both stacks carry the same code, and the mode flag rides in the data
(`import_state['cutover.mode']`: unset, `read_only`, `proxy`, cached 1 s), so the database that arrives on AWS arrives frozen.

1. D1 is frozen (`read_only`: writes answer 503 + Retry-After, jobs stop; reads continue).
2. D1 is exported, loaded into SQLite, and **proven equal** to D1 table by table (count + a checksum of the canonical rows, `meta.seq`,
   and the `events` AUTOINCREMENT counter, so the next seq is D1's).
3. The SQLite image becomes **seq 1 of the empty prod log** (kind `image`, the zstd image in S3 as `log/<unit>.image.zst`, the proof in
   the entry). The prod function refuses to migrate an empty log first (`AKLDB_AWAIT_IMAGE=1`), because the image carries D1's own
   `d1_migrations`.
4. The Worker goes to `proxy` (everything forwarded to `aws-api.akldb.org`, answers carry `X-Akldb-Backend: aws`), then the operator
   appends one unit that deletes `cutover.mode` from AWS's data: **writes open**. The write pause is freeze -> that unit.
5. 48 h later DNS moves `api.akldb.org` to the AWS HTTP API and the Worker retires (phase F).

The two machines are `scripts/cutover/run.mjs` and `scripts/cutover/rollback.mjs`. Without `--execute` they only print the commands each step
would run. With it they write a JSON state file after every step; a failed step stops the run, says why, and prints the command that resumes it
(`--from <step>`); `--only <step>` runs one; a plain re-run skips done steps. Each step re-checks its own precondition. Nothing is undone
automatically.

| # | step | what it does | proof recorded |
|---|---|---|---|
| 1 | `preflight` | stack outputs present; the prod function has `AKLDB_AWAIT_IMAGE=1`; the AWS log is empty; the Worker serves `/v1/meta` `api.minor` >= the modes' version; D1 has no `cutover.mode`; Time Travel bookmark recorded | head 0, bookmark |
| 2 | `freeze` | `cutover.mode='read_only'` on D1; wait 3 s; `POST /v1/layouts` with an empty body must be **503 read_only with Retry-After**, not 400 | probe, freeze seq |
| 3 | `export` | `wrangler d1 export --remote` to `export.sql` (reads may stall) | bytes, sha256, ms |
| 4 | `load` | node:sqlite builds the database; `integrity_check`, `foreign_key_check`, every table of `migrations/*.sql` present, `d1_migrations` equals `migrations/*.sql` exactly; `sqlite_sequence` raised from D1 if the export lacked it | checks, image sha256 |
| 5 | `verify` | per table `COUNT(*)` + checksum on the image **and** on D1 (read-only paged SELECTs), `sqlite_master` equal, `meta.seq` equal, `events` counter equal (CV3) | per-table counts and checksums |
| 6 | `image` | image appended as seq 1 (S3 object first, then the conditional append), then the snapshot pointer written at seq 1 | unit id, hash, snapshot |
| 7 | `serve` | prod `migrate` (a no-op: `applied: []`) and `warm k=4`; `meta`, a list page and 3 layouts straight from `aws-api.akldb.org` equal D1's (bodies minus `age_s`, ETags); `X-Akldb-Backend: aws` present | the 5 comparisons |
| 8 | `proxy` | `cutover.mode='proxy'` on D1; wait 3 s; through `api.akldb.org`: `X-Akldb-Backend: aws`, `meta.seq` = D1's, a write answers 503 read_only **from AWS** | headers, probe |
| 9 | `open` | needs verify + image + serve + proxy done and the log's image = the verified one (CV2); the operator appends `DELETE FROM import_state WHERE key = 'cutover.mode'`; then a write probe is no longer 503 | open seq, **write pause** |
| 10 | `post-smoke` | a signed write (ops client), `If-Match` 412 on a stale rev, `/v1/changes?since=<D1 last seq>` continues at the counter + 1 and is contiguous, `If-None-Match` 304 | each check |
| 11 | `report` | markdown: timings per step, the write pause, every proof | `report.md` |

If something fails before `image`: `node scripts/cutover/run.mjs --execute --abort` clears D1's flag (it refuses once the log holds the
image: that is a rollback).

## Before anything: what must exist

| What | Who | Where it is checked |
|---|---|---|
| Worker build with the modes (`akldb/cutover-modes`) deployed to prod, and the API minor it announced | saltorbit lands/deploys, team-lead tells the number | `preflight` (`--min-api-minor`, default = this tree's `WIRE_VERSION` + 1 = 34) |
| aklgg Pages `DB_BASE_URL`: workers.dev -> `https://api.akldb.org` | saltorbit | before the window |
| Prod stack `akldb-prod` deployed (empty log, `AwaitImage` auto), its cert, SSM `/akldb/prod/*` (origin secret, Discord) | saltorbit (SSM, DNS clicks), team-lead (deploy) | `preflight` |
| DNS and certificate for the cutover hostname: ACM certificate for `aws-api.akldb.org` (`aws cloudformation deploy --region us-east-2 --stack-name akldb-cert-aws-api --template-file infra/akldb-cert.yaml --parameter-overrides DomainName=aws-api.akldb.org`, then the validation CNAME, grey cloud); after the prod deploy a proxied CNAME `aws-api` -> the stack's `ApiDomainTarget`; the Transform Rule (Modify Request Header, Set static) for host `aws-api.akldb.org`: `x-akldb-origin` = the prod origin secret | saltorbit (dashboard clicks), team-lead (the two `aws` commands) | `serve` (403 without the rule) |
| A Cloudflare token or `wrangler login` that can run D1 export/execute/create on the akl account, and `CLOUDFLARE_ACCOUNT_ID` | whoever runs it | `run.mjs` stops with "CLOUDFLARE_ACCOUNT_ID is not set" |
| AWS operator credentials with DynamoDB read/write on `akldb-prod-log` and S3 get/put on `akldb-prod-data-*` (`aws-vault exec akldb -- ...`; `akldb-deploy` is not enough) | team-lead | `image`, `open` |
| The ops client (`../db.env.ops`: `CLIENT_ID`, `CLIENT_PRIVATE_KEY`, `OPS_ACTOR`) | saltorbit's file, team-lead sources it | `post-smoke` |
| The cutover window and the go | saltorbit | -- |

Prod's stack serves `aws-api.akldb.org` during the cutover and `api.akldb.org` afterwards (LDB-CV15): deploy it once with
`DOMAIN_NAME=aws-api.akldb.org AWAIT_IMAGE=auto CERTIFICATE_ARN=<akldb-cert-aws-api output> ALARM_EMAIL=... sh scripts/deploy-aws.sh --stage prod --execute`
(the script's default certificate for that hostname is the `akldb-cert-aws-api` stack). The SSM parameters under `/akldb/prod/` come first
(`design/aws-a-ops.md`). The log stays empty, and `migrate` answers `awaiting image`.

## Setup for every run

```sh
cd <worktree with aws-a/cutover merged>
export PATH=/opt/homebrew/opt/node@24/bin:$PATH
npm ci
set -a; . ../db.env.ops; set +a                      # CLIENT_ID, CLIENT_PRIVATE_KEY, OPS_ACTOR (post-smoke)
export CLOUDFLARE_ACCOUNT_ID=<the akl account id>    # wrangler needs it
# every command below is `aws-vault exec akldb -- node scripts/cutover/...`; without --execute it prints and does nothing
```

## Rehearsal on staging with a scratch D1 (team-lead)

Staging stands in for prod, a scratch D1 plus a rehearsal Worker stand in for D1 and the Worker. `--stage staging` makes the tools refuse the
production D1 and `https://api.akldb.org`.

**Prepare once** (all of it deletable):

```sh
# 1. the scratch D1, filled from a copy of prod (a read-only export of prod: this is also the timed export of the build plan)
time wrangler d1 export akl-db --remote --output /tmp/rehearsal-src.sql
wrangler d1 create akl-db-rehearsal                      # note its database_id
wrangler d1 execute akl-db-rehearsal --remote --file /tmp/rehearsal-src.sql --yes
# 2. a rehearsal Worker: this repo's main WITH the modes, name akl-db-rehearsal, [[d1_databases]] binding DB -> akl-db-rehearsal,
#    NO custom domain / routes, its proxy target = https://staging-api.akldb.org (open question 2). Deploy it; its URL is
#    https://akl-db-rehearsal.<subdomain>.workers.dev  (<RW>)
# 3. staging empty and awaiting its image: the "reset" commands below (staging's log has data today, so the stack is recreated)
```

**Rehearsal 1, rollback first.**

```sh
S="--stage staging --d1 akl-db-rehearsal --worker-url <RW>"
node scripts/cutover/run.mjs $S                                   # the dry run: read it
# 1a. cutover up to `proxy` (AWS still frozen, head 1), then roll back to the ORIGINAL D1 (variant original-d1)
for s in preflight freeze export load verify image serve proxy; do node scripts/cutover/run.mjs $S --execute --only $s || break; done
node scripts/cutover/rollback.mjs $S                              # the dry run
node scripts/cutover/rollback.mjs $S --execute                    # decide: original-d1; aws-readonly, capture, d1-refreeze, d1-prove, reopen
# 1b. reset (below), then the whole cutover with ten minutes of writes on AWS, then roll back to a FRESH D1
node scripts/cutover/run.mjs $S --execute
node scripts/cutover/rollback.mjs $S --execute                    # variant fresh-d1: stops at point-worker (manual)
#    repoint the rehearsal Worker at the new D1 the tool printed (akl-db-rollback-<date>): edit its wrangler config, `wrangler deploy`
node scripts/cutover/rollback.mjs $S --execute --from point-worker --worker-pointed
```

**Reset between rehearsals** (staging's log must be empty again, the scratch D1 fresh):

```sh
sh scripts/deploy-aws.sh --stage staging --destroy-nonprod --confirm akldb-staging --execute
AWAIT_IMAGE=1 sh scripts/deploy-aws.sh --stage staging --execute
wrangler d1 delete akl-db-rehearsal && wrangler d1 create akl-db-rehearsal   # new database_id: update the rehearsal Worker's config and redeploy
wrangler d1 execute akl-db-rehearsal --remote --file /tmp/rehearsal-src.sql --yes
rm -rf dist/cutover-staging                                      # the old state file and work files
```

**Rehearsal 2, the cutover.** Reset as in 1b, then `node scripts/cutover/run.mjs $S --execute` once, timed. Read `dist/cutover-staging/report.md`.

What the rehearsals must show (write them into the PR/issue):

- the **write pause** (report) <= 5 min, and where it went (`verify` is the one that scales with the data: pages are 500 rows by default;
  `--page-rows 5000 --concurrency 6` make it faster);
- every step green, every proof equal; the ETag/`age_s` comparison of `serve` on real data;
- that the exact `wrangler` commands behaved (open question 3): `d1 time-travel info`, `d1 export --output`, `d1 execute --json/--file/--yes`,
  `d1 create`, `d1 info --json`;
- the Worker's proxy reaches `staging-api.akldb.org` with the origin header added by the Transform Rule on a Worker subrequest (question 2);
- the rollback's D1 import: statement size and time for the real data (the dump refuses a row over D1's 100 KB statement limit by name);
- rollback timings, to size the real rollback window.

## The cutover, 2026-11-04 (09:00-14:00 UTC)

T-1 day: rehearsal 2 passed and its numbers are in the PR; prod stack deployed with an empty log; `preflight` dry-run clean:

```sh
aws-vault exec akldb -- node scripts/cutover/run.mjs --execute --only preflight
```

The window (saltorbit says go; reserve about 30 minutes; the write pause is `freeze` -> `open`):

```sh
aws-vault exec akldb -- node scripts/cutover/run.mjs --execute --page-rows 5000 --concurrency 6
# a failure prints why and the resume command; steps before `image`:  ... run.mjs --execute --abort   (D1 is writable again)
```

It stops by itself at the first red step. After `image`, a failed step is resumed (`--from <step>`), not undone; if it cannot be, roll back.
Order of consequence: before `image` nothing on AWS changed; after `image` and before `open` the original D1 is still the truth
(rollback variant `original-d1`); after `open` AWS is (rollback variant `fresh-d1`).

## The watch, 1 hour after `open`

Every 5 minutes for the hour (and again at +24 h):

| What | How |
|---|---|
| CloudWatch alarms (12 across stages; prod has the full set) | `aws cloudwatch describe-alarms --alarm-name-prefix akldb-prod- --state-value ALARM --region us-east-2` must be empty: `lambda-errors`, `alarm-lines`, `jobs-errors`, `lambda-throttles`, `lambda-duration-p95`, `api-5xx`, `log-system-errors`, `log-throttled-requests` |
| `akldb-alarm:` lines (boot fallback, replica halt, snapshot, proof, retention) | `aws logs filter-log-events --log-group-name /aws/lambda/akldb-prod-api --filter-pattern '"akldb-alarm:"' --start-time $(( ($(date +%s) - 3600) * 1000 )) --region us-east-2` (and `/aws/lambda/akldb-prod-jobs`); expect none. `replica: halted` is the serious one |
| Error rates | API 5xx and Lambda Errors in CloudWatch; the Worker side (still in proxy mode): Workers Logs / `wrangler tail akl-db` for 5xx or `proxy` failures |
| Feed contiguity | `curl -s 'https://api.akldb.org/v1/changes?since=<report: events counter>'` continues at counter + 1 with no gap; `/v1/meta` `seq` rises with writes |
| Log health | `aws dynamodb get-item --table-name akldb-prod-log --key '{"pk":{"S":"HEAD"},"sk":{"S":"HEAD"}}' --consistent-read` moves; `snap/slot-*` written by the 5-minute tick (`akldb-snapshot:` lines) |
| Cold starts | `akldb-cold:` lines; keep-warm k=4 pings every 5 min |
| Spark's freshness | Spark's `/health` (S2 coverage, freshness) read on the live bot: `flyctl ssh console -a spark-bot --machine <id> -C "node -e \"fetch('http://localhost:<port>/health').then(r=>r.text()).then(console.log)\""`; the next-day Discord interactions and a `/s` command still work |
| A Discord interaction (build plan) | click a modqueue button or run a slash command that reaches akldb; confirm in `akldb-prod-api` logs. Check first that the Discord developer portal's interactions endpoint names `api.akldb.org`, not workers.dev |
| The dump route | `curl -s https://api.akldb.org/v1/dump/latest.json` after the post-smoke's manual nightly tick |
| First night | at 03:00 UTC: daily snapshot, retention, and `akldb-proof: ok seq=... base=snap/daily/...` in the jobs log (RP4, now across the image) |

If anything is off, the call is saltorbit's (rollback, below, or hold).

## Rollback

`node scripts/cutover/rollback.mjs` (dry run first). It first freezes AWS, then picks the variant from the AWS log:

- **`original-d1`: AWS head is 1** (the `open` step never ran, no write reached AWS). The ORIGINAL D1 is still the freeze state: it is put back
  to `read_only`, proven equal to the image (every table, `meta.seq`, the events counter, and the checksums the cutover recorded in the log),
  and its flag cleared. AWS stays `read_only`. No new database, no PR.
- **`fresh-d1`: anything later.** AWS's database at the head is captured by a local replica, dumped to SQL (CREATE + INSERT, `sqlite_sequence`
  included), imported into `akl-db-rollback-<date>` (`--new-d1`), proven equal, and **the Worker is pointed at it**. That is deploy-time
  configuration: in `wrangler.toml` `[[d1_databases]] database_name` / `database_id` change to the printed values, through a PR on
  `akl-infra/db` and its deploy (the old D1 is not touched, so this is also the safe place to stop). Then
  `rollback.mjs --execute --from point-worker --worker-pointed` checks the Worker serves from the new D1 and refuses writes by itself, and the
  flag is cleared there. The old D1 stays as the evidence until phase F.

The report (`rollback-report.md`) states which variant applied. `--variant` forces one (never `original-d1` after AWS took writes).
After the DNS step the Worker no longer fronts `api.akldb.org`: a rollback then also needs DNS back (re-add the Worker's custom-domain route
in `wrangler.toml`, remove the CNAME and the Transform Rule on `api`).

## DNS, 48 hours after the flip (saltorbit, dashboard)

Only when the 24 h of alarms were quiet and saltorbit says so.

1. Before the 48 h are up, the certificate for `api.akldb.org` exists and is validated (`aws cloudformation deploy --region us-east-2 --stack-name akldb-cert-prod --template-file infra/akldb-cert.yaml --parameter-overrides DomainName=api.akldb.org`; grey-cloud validation CNAME, kept for renewals).
2. Update the prod stack back to its own hostname (a new custom domain is created beside the old, the mapping moves, the old one goes; no downtime):
   `aws-vault exec akldb -- sh scripts/deploy-aws.sh --stage prod --execute` (no `DOMAIN_NAME`: default `api.akldb.org`, default certificate `akldb-cert-prod`). Read the new target:
   `aws cloudformation describe-stacks --stack-name akldb-prod --region us-east-2 --query "Stacks[0].Outputs[?OutputKey=='ApiDomainTarget'].OutputValue" --output text` -> `d-xxxx.execute-api.us-east-2.amazonaws.com`.
3. The Worker's `api.akldb.org` custom domain owns the DNS record: remove `[[routes]] pattern = "api.akldb.org"` from `wrangler.toml` (PR + deploy; the Worker stays
   on workers.dev, still in `proxy` mode, until phase F).
4. Cloudflare DNS: `CNAME api -> <ApiDomainTarget>`, **proxied**; SSL mode Full (strict). `aws-api` stays until the end of the rollback window.
5. The Transform Rule (Modify Request Header, Set static) for host `api.akldb.org`: `x-akldb-origin` = the prod origin secret.
6. `curl -si https://api.akldb.org/v1/meta` -> 200 with `x-akldb-backend: aws`; `sh scripts/ops-call.sh GET /v1/meta`; the Cache Rule for `/v1/formats*` and its purge
   secrets (`aws-a-ops.md`); then watch an hour as above.
7. The Worker and D1 retire in phase F, after the rollback window.

## Who does what

| | saltorbit | team-lead |
|---|---|---|
| Before | lands/deploys the Worker with the modes; aklgg `DB_BASE_URL`; SSM prod secrets; DNS and certificate clicks for `aws-api.akldb.org` and its Transform Rule; Discord portal check | rehearsals; prod stack deploy; `--dry-run`s; the PR with rehearsal numbers |
| The window | says go; owns the choice to hold or roll back | runs `run.mjs` (and `rollback.mjs` if told), watches the hour |
| After | DNS switch at +48 h; the rollback window length; phase F approvals | the 24 h watch, the report into the PR |

## Open questions

1. **The Worker's proxy target** (set by the modes branch): is it `https://aws-api.akldb.org` fixed or a var? The staging rehearsal needs the
   rehearsal Worker to proxy to `https://staging-api.akldb.org`. Also confirm that a Worker subrequest to a proxied same-zone host gets the
   Transform Rule's `x-akldb-origin` header (the `proxy` step fails with a 403 if not).
2. **wrangler details not verifiable without running them:** `d1 export --output` while remote reads continue, `d1 execute --yes`, `d1 info --json`
   output keys, the Time Travel text. The rehearsal settles them; the port parsers are written defensively (regexes on the ids and bookmark).
3. **How long `verify` takes on real data.** D1's side is paged SELECTs through `wrangler` (a second or two each). If it threatens the 5-minute
   pause: bigger pages and concurrency (flags above), or the Cloudflare REST API directly (needs a token).
4. **Does the real `wrangler d1 export` place triggers after the data?** If it ever put them before, the load would fire them twice; `verify` would
   catch it (counts or checksums differ) and nothing would have reached AWS.
5. **Post-smoke write.** Default `POST /v1/admin/nightly/tick` (a manual tick: runs the nightly dump and appends one event). Choose another with
   `--write-route "METHOD /path" --write-body '{...}'`. The `If-Match` probe is a PATCH rename with a deliberately wrong rev (it can only 412).
6. **Operator credentials:** `akldb-deploy` cannot write the log table; the tools assume an admin profile (`aws-vault exec akldb`) and read the
   credentials from the environment (do not also pass `--profile`).
7. **The feed rule.** After the flip the first new event is `sqlite_sequence('events') + 1`, which is `MAX(seq) + 1` unless events were deleted
   from the tail; the post-smoke checks the counter rule, the report prints both.
