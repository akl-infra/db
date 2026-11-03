# akldb on AWS, design A: phase E (the cutover and the rollback)

Companion to `design/aws-a-ops.md` (stacks), `design/aws-a-ops-boot.md` (boot, snapshots) and `design/aws-a-ops-shadow.md` (the proving
ground). Invariants: LDB-CV10..CV24 in `INVARIANTS.md`. Nothing in this file has been run against Cloudflare or AWS: the tools are tested against
fakes (`tests/cutover/`), and the rehearsal below is what proves the real commands.

**Target:** 2026-11-04, 09:00-14:00 UTC. There is no 7-day proving run: manual tests, flip, watch about one hour.
**Gate (build plan, phase E):** write pause at most 5 minutes on each rehearsal; every proof equal; a signed write, `If-Match` 412, feed
contiguity and ETag 304 after the flip; 24 h of prod alarms quiet.

## How it works

There is one hostname, `api.akldb.org`. The prod stack serves it (custom domain, certificate stack `akldb-cert-prod`). The cutover moves the DNS
record for it from the Worker's custom domain to the stack, and nothing else. The Worker needs only the `read_only` flag (D1's
`import_state['cutover.mode']`, cached 1 s: writes answer 503 + Retry-After, jobs stop, reads continue). The flag rides in the data, so the database
that arrives on AWS arrives frozen.

1. The dump history is copied R2 -> S3 (idempotent; the bulk can be done days before).
2. D1 is frozen (`read_only`).
3. D1 is exported, loaded into SQLite (triggers created after the rows) and **proven equal** to D1 table by table (count + a checksum of the canonical
   rows, `meta.seq`, and the `events` AUTOINCREMENT counter, so the next seq is D1's).
4. The SQLite image becomes **seq 1 of the empty prod log** (kind `image`; the zstd image in S3 as `log/<unit>.image.zst`; the proof in the entry). The
   prod function refuses to migrate an empty log first (`AKLDB_AWAIT_IMAGE=1`): the image carries D1's own `d1_migrations`.
5. The tool reads the prod stack **directly** (its regional domain target, TLS name and Host `api.akldb.org`, the `x-akldb-origin` secret from a local
   file) and compares its answers with D1's.
6. saltorbit moves the DNS record. The tool polls `https://api.akldb.org/v1/meta` on fresh connections until it answers from AWS.
7. The operator appends one unit that deletes `cutover.mode` from AWS's data: **writes open**. The write pause is freeze -> that unit.

The machines are `scripts/cutover/run.mjs` and `scripts/cutover/rollback.mjs`. Without `--execute` they only print the commands each step would
run. With it they write a JSON state file after every step; a failed step stops the run, says why, and prints the command that resumes it
(`--from <step>`); `--only <step>` runs one; a plain re-run skips done steps. Each step re-checks its own precondition. Nothing is undone
automatically.

| # | step | what it does | proof recorded |
|---|---|---|---|
| 1 | `preflight` | stack outputs present; the prod function has `AKLDB_AWAIT_IMAGE=1`; the AWS log is empty; the Worker serves `/v1/meta` `api.minor` >= the read_only version; the origin secret file is readable; D1 has no `cutover.mode`; Time Travel bookmark recorded | head 0, bookmark |
| 2 | `copy-dumps` | R2 `akl-db-dumps` -> the stack's data bucket `dumps/<key>`: every object, content type kept, R2's md5/size and S3's size/md5/content type verified, equal ones skipped. First run long, re-run cheap. Runs before the freeze so it is outside the write pause | objects, copied, bytes |
| 3 | `freeze` | `cutover.mode='read_only'` on D1; wait 3 s; `POST /v1/layouts` with an empty body must be **503 read_only with Retry-After**, not 400 | probe, freeze seq |
| 4 | `export` | `wrangler d1 export --remote` to `export.sql` (reads may stall) | bytes, sha256, ms |
| 5 | `load` | statements split by a tokenizer, tables and rows first, **indexes, views and triggers after**; `integrity_check`, `foreign_key_check`, every table of `migrations/*.sql` present, `d1_migrations` equals `migrations/*.sql`; `sqlite_sequence` raised from D1 if the export lacked it | checks, image sha256 |
| 6 | `verify` | per table `COUNT(*)` + checksum on the image and on D1, `sqlite_master` equal, `meta.seq` equal, the `events` counter equal. D1 side over the REST API: one count query, one call for all small tables, big tables paged ~3 MB at a time, 4 at once | per-table counts and checksums, D1 call count |
| 7 | `image` | image appended as seq 1 (S3 object first, then the conditional append), then the snapshot pointer at seq 1 | unit id, hash, snapshot |
| 8 | `serve` | prod `migrate` (a no-op: `applied: []`) and `warm k=4`; `meta`, a list page, 3 layouts and the dump routes read straight from the stack equal the Worker's (bodies minus `age_s`, ETags, Content-Type, Cache-Control, Location, bytes); `X-Akldb-Backend: aws` present | the comparisons |
| 9 | `dns` | prints saltorbit's instruction; polls the public name until it answers `X-Akldb-Backend: aws` with `seq` = the image's `meta.seq`, **5 times in a row on fresh connections** (a connection failure or a stale answer restarts the count), at most 15 min; on timeout stops with what to check, writes still closed | polls, wait |
| 10 | `open` | needs verify + image + serve + dns done and the logged image = the verified one (CV16); the operator appends `DELETE FROM import_state WHERE key = 'cutover.mode'`; a write probe is then no longer 503 and comes from AWS | open seq, **write pause** |
| 11 | `post-smoke` | a signed write (ops client), `If-Match` 412 on a stale rev, `/v1/changes?since=<D1 last seq>` continues at the counter + 1 and is contiguous, `If-None-Match` 304, through `api.akldb.org` | each check |
| 12 | `report` | markdown: timings per step, the write pause, every proof | `report.md` |

If something fails before `image`: `node scripts/cutover/run.mjs --execute --abort` clears D1's flag (it refuses once the log holds the image: that is
a rollback). A failed `dns` is not a rollback: the name simply has not moved yet, AWS and D1 are both read_only, re-run `--from dns`.

## What must exist, and who provides it

| What | Who | Checked by |
|---|---|---|
| Worker build with `read_only` deployed to prod (`akldb/cutover-modes`) and the API minor it announced | saltorbit lands/deploys, team-lead tells the number | `preflight` (`--min-api-minor`, default this tree's `WIRE_VERSION` + 1 = 34) |
| aklgg Pages `DB_BASE_URL` -> `https://api.akldb.org` | saltorbit | before the window |
| Prod stack `akldb-prod` deployed with `DomainName=api.akldb.org` (certificate `akldb-cert-prod`, issued), empty log, `AwaitImage` auto, SSM `/akldb/prod/*` | saltorbit (SSM), team-lead (deploy) | `preflight` |
| The Transform Rule adding `x-akldb-origin` for host `api.akldb.org` (exists) and the **same secret in `~/git/akl/akldb-origin-prod.env`** (staging: `akldb-origin-staging.env`; `--origin-env` overrides) | saltorbit | `serve` (403 if wrong) |
| R2 read credentials: `~/git/akl/akldb-r2-dumps-read.env` (`R2_KEY_ID`, `R2_SECRET`, `R2_ENDPOINT=https://58a5eb82948e2134d8b7b242e9567ac4.r2.cloudflarestorage.com`; bucket-scoped list and read on `akl-db-dumps`; optional `R2_BUCKET`) | saltorbit (exists) | `copy-dumps` |
| A Cloudflare API token with **D1 read** (`CLOUDFLARE_API_TOKEN`) so `verify` uses the REST API, and `AKLDB_D1_ID` (the D1 database id: prod `53f596d5-9cb5-43b0-9026-17518d18052f`, the scratch one in a rehearsal). Without the token `verify` falls back to `wrangler` processes (slower, many more calls). The REST limit is 1,200 calls per 5 minutes per user and other sessions share it: `verify` takes about 30 | saltorbit (token) | `verify` |
| `CLOUDFLARE_ACCOUNT_ID` and a `wrangler login` that can export/execute/create D1 | whoever runs it | `run.mjs` stops without the first |
| AWS operator credentials with DynamoDB read/write on `akldb-prod-log` and S3 get/put on `akldb-prod-data-*` (`aws-vault exec akldb -- ...`; do not also pass `--profile`; `akldb-deploy` is not enough) | team-lead | `image`, `open`, `copy-dumps` |
| The ops client (`../db.env.ops`: `CLIENT_ID`, `CLIENT_PRIVATE_KEY`, `OPS_ACTOR`) | saltorbit's file, team-lead sources it | `post-smoke` |
| The cutover window, the go, and the DNS move at step 9 (Cloudflare dashboard) | saltorbit | -- |

## Setup for every run

```sh
cd <worktree with aws-a/cutover merged>
export PATH=/opt/homebrew/opt/node@24/bin:$PATH
npm ci
set -a; . ../db.env.ops; set +a                      # CLIENT_ID, CLIENT_PRIVATE_KEY, OPS_ACTOR (post-smoke)
export CLOUDFLARE_ACCOUNT_ID=58a5eb82948e2134d8b7b242e9567ac4
export CLOUDFLARE_API_TOKEN=<D1 read token>          # optional but strongly advised (verify speed, rate limit)
export AKLDB_D1_ID=<the D1 database id>              # prod: 53f596d5-9cb5-43b0-9026-17518d18052f
# every command below runs as `aws-vault exec akldb -- node scripts/cutover/...`; without --execute it prints and does nothing
```

## Rehearsal on staging with a scratch D1 (team-lead)

Staging stands in for prod; a scratch D1 plus a rehearsal Worker stand in for D1 and the Worker. `--stage staging` makes the tools refuse the production
D1 and `https://api.akldb.org` (as Worker or public name). The public name of the rehearsal is `https://staging-api.akldb.org`, which already points at
the staging stack, so the `dns` step has nothing to move and passes at once: **the real DNS move is exercised only in prod**, which is why it is polled,
gated, and reversible by the record alone.

**Prepare once** (all of it deletable):

```sh
# 1. the scratch D1, filled from a copy of prod (a read-only export of prod: also the timed export of the build plan)
time wrangler d1 export akl-db --remote --output /tmp/rehearsal-src.sql
wrangler d1 create akl-db-rehearsal                      # note its database_id  ->  export AKLDB_D1_ID=<it>
wrangler d1 execute akl-db-rehearsal --remote --file /tmp/rehearsal-src.sql --yes
# 2. a rehearsal Worker: this repo's main WITH read_only, name akl-db-rehearsal, [[d1_databases]] binding DB -> akl-db-rehearsal, NO routes or
#    custom domain. Deploy it; its URL is https://akl-db-rehearsal.<subdomain>.workers.dev  (<RW>)
# 3. staging empty and awaiting its image: see "Reset" below (staging's log has data today, so the stack is recreated)
# 4. ~/git/akl/akldb-origin-staging.env holds staging's x-akldb-origin secret (the Transform Rule on staging-api.akldb.org uses the same one)
# 5. the dump history for staging: node scripts/cutover/copy-dumps.mjs --dest-bucket akldb-staging-data-335937358231 --execute
```

**Rehearsal 1, rollback first.**

```sh
S="--stage staging --d1 akl-db-rehearsal --worker-url <RW>"     # --public-url defaults to https://staging-api.akldb.org
node scripts/cutover/run.mjs $S                                  # the dry run: read it
# 1a. cutover up to `dns` (AWS still frozen, log = the image), then roll back: variant original-d1
for s in preflight copy-dumps freeze export load verify image serve dns; do node scripts/cutover/run.mjs $S --execute --only $s || break; done
node scripts/cutover/rollback.mjs $S                             # the dry run
node scripts/cutover/rollback.mjs $S --execute                   # decide, aws-readonly, capture, d1-prove, dns-back, reopen
# 1b. reset (below), then the whole cutover with ten minutes of writes on AWS, then roll back to a FRESH D1
node scripts/cutover/run.mjs $S --execute
node scripts/cutover/rollback.mjs $S --execute                   # variant fresh-d1: stops at point-worker (manual)
#    repoint the rehearsal Worker at the new D1 the tool printed (akl-db-rollback-<date>): edit its wrangler config, `wrangler deploy`
node scripts/cutover/rollback.mjs $S --execute --from point-worker --worker-pointed
```

**Reset between rehearsals** (staging's log must be empty again, the scratch D1 fresh):

```sh
sh scripts/deploy-aws.sh --stage staging --destroy-nonprod --confirm akldb-staging --execute
AWAIT_IMAGE=1 sh scripts/deploy-aws.sh --stage staging --execute
wrangler d1 delete akl-db-rehearsal && wrangler d1 create akl-db-rehearsal   # new database_id: update AKLDB_D1_ID and the rehearsal Worker's config
wrangler d1 execute akl-db-rehearsal --remote --file /tmp/rehearsal-src.sql --yes
rm -rf dist/cutover-staging                                      # the old state file and work files
```

**Rehearsal 2, the cutover.** Reset as above, then `node scripts/cutover/run.mjs $S --execute` once, timed. Read `dist/cutover-staging/report.md`.

What the rehearsals must show (write them into the PR/issue):

- the **write pause** (report) <= 5 min and where it went: `verify` (30 REST calls, projected 4-9 s on 63 MB, `scripts/lab/verify-bench.mjs`), `serve`, `dns` (zero in a rehearsal);
- every step green, every proof equal; the ETag / `age_s` comparison of `serve` on real data; the dump comparison including the history;
- the direct read works: `serve` reaches the staging stack at its `ApiDomainTarget` with the origin secret from the file;
- that the exact `wrangler` commands behaved: `d1 time-travel info`, `d1 export --output`, `d1 execute --file/--yes`, `d1 create`, `d1 info --json`, and the REST `/query` endpoint with multi-statement bodies;
- the rollback's D1 import: statement size and time for the real data (the dump refuses a row over D1's 100 KB statement limit by name);
- rollback timings, to size the real rollback window.

## The cutover, 2026-11-04 (09:00-14:00 UTC)

T-1 day: rehearsal 2 passed and its numbers are in the PR; prod stack deployed with an empty log; the bulk dump copy done
(`aws-vault exec akldb -- node scripts/cutover/copy-dumps.mjs --dest-bucket akldb-prod-data-335937358231 --execute`); `preflight` clean:

```sh
aws-vault exec akldb -- node scripts/cutover/run.mjs --execute --only preflight
```

The window (saltorbit says go; reserve about 30 minutes; the write pause is `freeze` -> `open`):

```sh
aws-vault exec akldb -- node scripts/cutover/run.mjs --execute
# it stops by itself at the first red step and prints why and the resume command;  before `image`:  ... run.mjs --execute --abort
```

At step 9 the tool prints this and waits (saltorbit, Cloudflare dashboard, akl account):

1. Workers & Pages > `akl-db` > Settings > Domains & Routes: **remove the custom domain `api.akldb.org`** (this deletes its DNS record; the Worker stays reachable at `https://akl-db.akl-58a.workers.dev`).
2. akldb.org > DNS: **add `CNAME api -> <the stack's ApiDomainTarget>`, Proxied**, SSL/TLS mode Full (strict). The Transform Rule adding `x-akldb-origin` for host `api.akldb.org` already exists.

(There is a gap of seconds between the two; the poll tolerates connection failures and counts only fresh, correct answers.) The `wrangler.toml` `[[routes]] api.akldb.org custom_domain` entry is then stale: remove it in a PR after the window so a Worker deploy cannot re-claim the name.

Order of consequence: before `image` nothing on AWS changed; after `image` and before `open` the original D1 is still the truth; after `open` AWS is.

## The watch, 1 hour after `open`

Every 5 minutes for the hour (and again at +24 h):

| What | How |
|---|---|
| CloudWatch alarms | `aws cloudwatch describe-alarms --alarm-name-prefix akldb-prod- --state-value ALARM --region us-east-2` must be empty: `lambda-errors`, `alarm-lines`, `jobs-errors`, `lambda-throttles`, `lambda-duration-p95`, `api-5xx`, `log-system-errors`, `log-throttled-requests` |
| `akldb-alarm:` lines (boot fallback, replica halt, snapshot, proof, retention, **response-too-large**) | `aws logs filter-log-events --log-group-name /aws/lambda/akldb-prod-api --filter-pattern '"akldb-alarm:"' --start-time $(( ($(date +%s) - 3600) * 1000 )) --region us-east-2` (and `/aws/lambda/akldb-prod-jobs`); expect none. `replica: halted` is the serious one |
| Error rates | API 5xx and Lambda Errors in CloudWatch |
| Feed contiguity | `curl -s 'https://api.akldb.org/v1/changes?since=<report: events counter>'` continues at counter + 1 with no gap; `/v1/meta` `seq` rises with writes |
| Log health | `aws dynamodb get-item --table-name akldb-prod-log --key '{"pk":{"S":"HEAD"},"sk":{"S":"HEAD"}}' --consistent-read` moves; `snap/slot-*` written by the 5-minute tick (`akldb-snapshot:` lines) |
| Cold starts | `akldb-cold:` lines; keep-warm k=4 pings every 5 min |
| Spark's freshness | Spark's `/health` read on the live bot: `flyctl ssh console -a spark-bot --machine <id> -C "node -e \"fetch('http://localhost:<port>/health').then(r=>r.text()).then(console.log)\""`; a `/s` command still works |
| A Discord interaction | click a modqueue button or run a slash command that reaches akldb; confirm in `akldb-prod-api` logs. Check first that the Discord developer portal's interactions endpoint names `api.akldb.org`, not workers.dev |
| The dump routes | `curl -sI https://api.akldb.org/v1/dump/latest.json` and a dated dump from the history; Content-Type `application/json` / `application/gzip`, no Cache-Control from the origin (see "Browser Cache TTL" below) |
| First night | at 03:00 UTC: daily snapshot, retention, and `akldb-proof: ok seq=... base=snap/daily/...` in the jobs log (RP4, now across the image) |

If anything is off, the call is saltorbit's (rollback, below, or hold).

**Browser Cache TTL.** After the flip the origin is AWS, not a Worker. Cloudflare's zone-level Browser Cache TTL (the 14400 seconds seen on shadow-api's
`.gz` answers) is added to origin answers that carry no Cache-Control, which Worker-generated answers never got. For the dump routes to look as they did,
set the zone's Browser Cache TTL to "Respect Existing Headers" or add a Cache Rule for `/v1/dump*` ("respect origin" Browser TTL); the Lambda adds no
caching header on purpose (LDB-CV20).

## Rollback

`node scripts/cutover/rollback.mjs` (dry run first). It is the cutover backwards: freeze AWS, make the Worker's database the truth, **put the record
back**, clear the D1 flag. It picks the variant from the AWS log:

- **`original-d1`: AWS has taken no write past the image** (the log is the image, plus at most the operator's flag units). The ORIGINAL D1 is still the
  freeze state: it is proven against the per-table counts and checksums stored in the image entry (and `meta.seq`), the record goes back, and its flag is
  cleared. AWS stays `read_only`. No new database, no PR. A D1 that changed since the freeze refuses this variant.
- **`fresh-d1`: anything later.** AWS's database at the head is captured by a local replica, dumped to SQL (CREATE + INSERT, `sqlite_sequence` included),
  imported into `akl-db-rollback-<date>` (`--new-d1`), proven equal, and **the Worker is pointed at it**. That is deploy-time configuration: in
  `wrangler.toml` `[[d1_databases]] database_name` / `database_id` change to the printed values, through a PR on `akl-infra/db` and its deploy (the old
  D1 is not touched, so this is also the safe place to stop). Then `rollback.mjs --execute --from point-worker --worker-pointed` checks the Worker itself
  (at `https://akl-db.akl-58a.workers.dev`) serves from the new D1 and refuses writes; the record goes back; the flag is cleared there.

The `dns-back` step mirrors `dns`: it prints the instruction (**saltorbit deletes the proxied CNAME `api`, then re-adds the custom domain `api.akldb.org`
to the Worker `akl-db`**) and polls the public name until it answers from the Worker (no `X-Akldb-Backend`) with the database's seq, 5 times in a row on
fresh connections. The flag is cleared only after that. The report (`rollback-report.md`) states which variant applied.

## Open questions

1. **wrangler details not verifiable without running them:** `d1 export --output` while remote reads continue, `d1 execute --yes`, `d1 info --json` output
   keys, the Time Travel text. The rehearsal settles them; the port parsers are written defensively.
2. **The D1 REST API:** multi-statement `sql` bodies returning one result per statement, and the per-query result size (pages are sized to about 3 MB). If
   multi-statement is refused, `verify` falls back to one call per table (a few dozen more calls) by passing no `selectMany`; flag `--d1-api wrangler` uses the CLI.
3. **Does the real `wrangler d1 export` place triggers before the data?** The loader no longer cares (triggers are created after the rows), and `verify`
   would catch any double effect before anything reaches AWS.
4. **Post-smoke write.** Default `POST /v1/admin/nightly/tick` (a manual tick: runs the nightly dump and appends one event). Choose another with
   `--write-route "METHOD /path" --write-body '{...}'`. The `If-Match` probe is a PATCH rename with a deliberately wrong rev (it can only 412).
5. **Operator credentials:** `akldb-deploy` cannot write the log table; the tools assume an admin profile (`aws-vault exec akldb`) and read the credentials
   from the environment (do not also pass `--profile`).
6. **The feed rule.** After the flip the first new event is `sqlite_sequence('events') + 1`, which is `MAX(seq) + 1` unless events were deleted from the
   tail; the post-smoke checks the counter rule, the report prints both.
7. **Dump sizes through Lambda.** See `design/aws-a-ops.md`, "Response size": a dated dump larger than about 4.4 MB gzipped cannot be returned by a Lambda
   behind API Gateway at all (6 MB including base64); the real sizes must be read before the window.
