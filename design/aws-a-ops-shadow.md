# akldb on AWS, design A: phase D ops (the shadow stage, the proving ground)

Companion to `design/aws-a-ops.md` (stacks, deploy, secrets) and `design/aws-a-ops-boot.md` (boot, snapshots). Invariants:
LDB-PV1..PV11 in `INVARIANTS.md`. Nothing here is deployed yet; every command below is saltorbit's or the main session's to run.

## What shadow is

`shadow` is the same template and the same bundle as prod (`STAGE=shadow`), seeded from the latest PUBLIC dump and kept equal to
production by following production's public `/v1/changes` feed. It serves reads only. It exists to be compared with production for
7 days before the cutover, and to be measured from us-east-2.

| Piece | Where | What it does |
|---|---|---|
| Egress guard | `src/platform/shadow-egress.ts` | replaces the Lambda's `fetch`: allows the stack's own AWS endpoints (DynamoDB, S3, SSM, Lambda in us-east-2), `api.akldb.org` GET/HEAD, and the fake Discord; everything else throws and logs `akldb-alarm: shadow-egress: refused <METHOD> <host>` |
| Fake Discord | `src/platform/fake-discord.ts` | the lane P server as an in-process module; `DISCORD_API_URL` is `http://fake-discord.akldb.invalid/api` (forced in code, set by `infra/stages/shadow.json`); records calls, never the credential |
| Read-only front | `src/platform/lambda.ts` | non-GET/HEAD/OPTIONS is 405, `Authorization` / `X-Akl-Client` is 403; the Discord SSM settings are ignored |
| Seed job | `src/replica/shadow/seed.ts` | `{"akldb":"seed","dumpUrl":".../v1/dump/latest.json"[,"reset":true]}`, refused unless `STAGE=shadow` |
| Follower | `src/replica/shadow/{apply,follower,upstream}.ts` | the shadow tick runs it INSTEAD of the Worker's scheduled jobs (which append events and notify Discord) |
| Checkpoint | `src/replica/shadow/{checkpoint,checksum}.ts` | when production publishes a dump: apply exactly up to its seq, compare table by table, resync the state tables, mirror the dump |
| Shadow schema | `migrations-shadow/` | the follower's table; NOT in `migrations/`; shipped in the shadow zip only |
| Replay | `scripts/lab/shadow/replay.mjs` | public GETs from Workers Observability replayed against prod and shadow, diffed |
| Checksums CLI | `scripts/lab/shadow/checksums.mjs` | two dump files, table by table |
| Probe | `infra/akldb-probe.yaml`, `infra/probe/`, `scripts/aws/probe.sh` | the us-east-2 latency probe, created and deleted around each measurement |
| Gate | `scripts/lab/shadow/gate.mjs` | the D row of the plan as a table |
| Helpers | `scripts/aws/shadow.sh` | seed, status, tick, log export (prints unless `--execute`) |

### Feed tables and state tables

The public feed carries events, not tables. The follower reproduces EXACTLY the tables an event determines, and does not pretend about the rest.

| class | tables | how |
|---|---|---|
| feed (exact) | `events`, `layouts` (with `link`, `like_count`, `n`, upstream, source), `layout_formats`, `layout_revs`, `likes`, and `layouts_head` by its triggers | the applier (`apply.ts`) rebuilds the rows the write path left: statements over the database's own state, payloads from `GET /v1/layouts/<id>/rev/<rev>?format=<format>` checked to be the event's own. Proven equal to `dump(S2)` from `dump(S1)` + the feed (LDB-PV5, `tests/replica/shadow-apply.test.ts`) |
| state (replaced from the dump) | `authors` (+`authors_head`), `admins`, `clients`, `bans`, `import_state`, `import_map`, `link_submissions`, `wpm_submissions`, `layout_comments`, `comment_likes` | not derivable from public data (comment bodies, wpm receipts, `notified_at` claims, sign-ins that write an author without an event). The event is applied as its `events` row; the follower counts it in `stale_json`; at the next checkpoint the tables are replaced wholesale from the public dump. Nothing is ever approximated |

Kinds. Every kind `/v1/changes` can serve is in the applier's table (a test keeps it equal to `KNOWN_KINDS`):

- **applied exactly (feed tables):** `created`, `format_added`, `updated`, `renamed`, `fingermap`, `transferred`, `deleted`, `restored`, `imported`, `upstream_deleted` (rev-bumping), `liked`, `unliked`, `link_approved`, `link_cleared`.
- **row only, state table counted stale:** `link_submitted`, `link_rejected` (link_submissions); `wpm_*` (wpm_submissions); `comment_*` (layout_comments, comment_likes); `admin.added/removed` (admins); `admin.user_banned/unbanned` (bans); `admin.author_renamed` (authors); `admin.client_*` (clients, import_state); `admin.import_*`, `admin.diff_ticked`, `admin.nightly_ticked` (import_state); `upstream_changed`, `import_conflict`, `import_error`, `import_relabel`, `upstream_deleted` (informational: import_map, import_state); `admin.likes_set` (retired, nothing).
- **refused, loudly (`akldb-alarm: shadow-follower: apply seq N (kind): <reason>`, cursor stays, next tick retries):** a kind not in the table; a rev on a non-write kind or a write kind without a rev; an `after` of unexpected scope; a source `legacy:` that is not `legacy:<via>`; a payload that is unavailable or is not the event's; a feed that skips a seq; an event that contradicts the database (a like of an unknown layout, a duplicate or missing like).

The cursor lives in the shadow database (`shadow_follower`), not in a DynamoDB item, because it must move in the same commit unit as the event it applied (LDB-PV7): a second store means a second write and a window in which an event is applied twice or lost.

### Log lines

| Prefix | Meaning |
|---|---|
| `akldb-alarm: shadow-egress: ...` | something tried to leave the stack (or `DISCORD_API_URL` was not the fake) |
| `akldb-alarm: shadow-follower: ...` | a refusal, an upstream failure (`reading the feed`, `reading latest.json`), a checksum mismatch, a missed checkpoint |
| `akldb-follower: applied=N cursor=S head=H [checkpoint=...]` | one tick |
| `akldb-checkpoint: {...}` | one structured line per nightly check (result, dump key and seq, per-table equality); the gate reads these |
| `akldb-seed: ...` | a seed finished |
| `akldb-cold: {"first":"http","initMs":..,"requestMs":..}` | the first invocation of a container (every stage); the gate's cold share and cold p95 |

## What the replay masks, and why

Only answers computed at the same head seq are compared (the head is in each ETag; otherwise `skipped: different heads`). Compared: status, the contract headers (ETag, Cache-Control, Content-Type, X-Akldb-Api, X-Wait-Ignored, Retry-After, Deprecation, Sunset, Location, WWW-Authenticate, CORS, Vary), and the body as canonical JSON. Masked, and only these:

- `/v1/meta` `health`: live bookkeeping (`dump.last_at`, ages in seconds, import/diff probes) that production's own jobs write. Shadow runs none of those jobs.
- `content-length` (transport), and the ETag of a dump file (md5 computed by R2 on one side, S3 on the other; the bytes are compared).
- `/v1/meta` `author_count`, `authors_modified_at`, `authors_version`, and the whole of `/v1/authors`: the authors table changes without an event, so a difference is `diff-state` (reported, not gated). The other state classes (comments, comment counts, wpm) are `skipped` when production's feed shows an event that changes that table after the seq of shadow's last dump (read from shadow's own `/v1/dump/latest.json`), and `diff` otherwise.

## Run book

Commands use profile `akldb`; delete-type commands need an admin profile (the deploy role cannot delete stacks). `<EMAIL>` is the alarm address.

**1. Once, by saltorbit (the list below).** Then the certificate and the stack:

```sh
aws cloudformation deploy --region us-east-2 --stack-name akldb-cert-shadow --template-file infra/akldb-cert.yaml --parameter-overrides DomainName=shadow-api.akldb.org
#   ... validation CNAME at Cloudflare (list item 1) ...
sh scripts/deploy-aws.sh --stage shadow                       # prints the change set
ALARM_EMAIL=<EMAIL> sh scripts/deploy-aws.sh --stage shadow --execute
aws cloudformation describe-stacks --region us-east-2 --stack-name akldb-shadow --query "Stacks[0].Outputs[?OutputKey=='ApiDomainTarget'].OutputValue" --output text
#   ... proxied CNAME + Transform Rule (items 2, 3) ...
```

**2. Seed** (on the jobs function; the dump restore takes a few minutes):

```sh
sh scripts/aws/shadow.sh seed --execute
sh scripts/aws/shadow.sh status --execute        # follower.cursor == the dump's seq; discordCalls 0
curl -sS https://shadow-api.akldb.org/v1/meta     # served by shadow
```

A second `seed` is refused; `seed --reset` restores over a non-empty database (a database that must also forget its log history is a deleted and recreated stack: `sh scripts/deploy-aws.sh --stage shadow --destroy-nonprod --confirm akldb-shadow`, admin profile).

**3. Every day for 7 days** (any machine with `CF_OBS_TOKEN`; about 400 requests at 2 per second is 3-4 minutes):

```sh
D=shadow-run/$(date -u +%F); mkdir -p $D
source ~/git/akl/cf-observability.env            # CF_OBS_TOKEN
node scripts/lab/shadow/replay.mjs --source obs --hours 6 --n 400 --rps 2 --out $D           # the plan only: look at it
node scripts/lab/shadow/replay.mjs --source obs --hours 6 --n 400 --rps 2 --out $D --execute # sends: $D/replay.ndjson, $D/summary.md
sh scripts/aws/shadow.sh logs --hours 26 --out $D --execute                                   # $D/logs-api.json, logs-jobs.json
```

**4. Once, near the end: latency.**

```sh
python3 -I ~/git/akl/handoff/aws-tools/akldb/latency-compare.py --n 20 --stage https://shadow-api.akldb.org --md $D/mac.md   # the Mac (gate (b)); run it after the fuzz
sh scripts/aws/probe.sh create --execute      # saltorbit's go (list item 6)
sh scripts/aws/probe.sh run --n 30 --out $D/probe.json --execute
sh scripts/aws/probe.sh delete --execute      # admin profile; the stack exists only for the measurement
```

CloudWatch sums for the cost row (`ApiRequests` = AWS/ApiGateway `Count`; the rest from AWS/Lambda and AWS/DynamoDB over the window), as `metrics.json` and `run.json` (shapes in the header of `scripts/lab/shadow/gate.mjs`), and `colos.json` for gate (c).

**5. The gate.**

```sh
node scripts/lab/shadow/gate.mjs $(for d in shadow-run/*/; do echo --replay $d/replay.ndjson; done) \
  $(for f in shadow-run/*/logs-*.json; do echo --logs $f; done) --probe $D/probe.json --mac $D/mac.md --colos colos.json --metrics metrics.json --run run.json --out gate.md
```

Rows: 1 seven consecutive clean days; 2a/2b/2c latency; 3 cold share <= 1% and cold p95 <= 600 ms; 4 cost <= $1.5 at 1x and <= $5 at 10x; 5 headers. The exit code is 0 only when every row is PASS; OPEN means the evidence is missing or thin.

## What saltorbit / team-lead must do

| # | What | Needed for | How |
|---|---|---|---|
| 1 | `shadow-api.akldb.org`: the ACM validation CNAME (DNS only) after `akldb-cert-shadow` is created | the stack's custom domain | dashboard click; `design/aws-a-ops.md` per-stage step 2 |
| 2 | `shadow-api.akldb.org`: a PROXIED CNAME to the shadow stack's `ApiDomainTarget` | any request reaching shadow | dashboard click |
| 3 | A Transform Rule (Modify Request Header) for host `shadow-api.akldb.org`: set `x-akldb-origin` to the origin secret | the replay sends nothing special; without it every request is 403 | dashboard |
| 4 | SSM `/akldb/shadow/origin-secret` (SecureString; the same value as the rule). No Discord parameter for shadow: the stage forbids them | before the first deploy | `!` command |
| 5 | The formats Cache Rule's host list includes `shadow-api.akldb.org` (with `staging-api` and `api`), and the Cache Purge token + zone id for the deploy (`CF_PURGE_TOKEN`, `CF_ZONE_ID`) | gate (b): `/v1/formats` served from the edge (`cf-cache-status: HIT`) | dashboard; `handoff/akldb-on-aws-edge-cache.md` |
| 6 | A go for the probe stack (create, one run, delete), and a profile that may delete a stack | gate (a) | reply; the deploy role cannot `DeleteStack` |
| 7 | `CF_OBS_TOKEN` (read-only Workers Observability, akl account) on the machine that runs the replay; the replay never sends it anywhere but `api.cloudflare.com` | the replay's source. If it cannot be there, a Logpush tree fetched from R2 `akl-db-logs` works (`--source logpush --logs DIR`), but those records carry no If-None-Match, so the 304 path is replayed only for what the plan marks | decision |
| 8 | The Lambda concurrency quota raise (10 -> 1000, requested, pending). Keep-warm K=4 per stack means staging + shadow + prod = 12 > 10, plus replay bursts and the probe | before shadow and staging run together, and before real traffic | AWS Settings / support |
| 9 | Confirm the first seed's timing: the restore is thousands of statements in log units of up to 100, some over 400 KB (spilled to S3); the jobs function has 600 s | the seed | run it, read `akldb-seed:` and the invoke result |

## Open questions

- **`SystemLogLevel: INFO`** on every stage (since 2026-11-03): Lambda's REPORT lines (Init Duration, billed ms, Max Memory Used) are back in the log group. The `akldb-cold:` line stays as well (init + first request, stricter than Init Duration alone); the gate reports both.
- **Observability event shape.** The extractor reads `$workers.event.request.{url,method,headers}` (nested or dotted), `source.request.*` and Logpush's `Event.Request.*`; it was written from the documented query shape and the fixtures in `tests/replica/shadow-replay.test.ts`, never against the live API. The first plan run (no `--execute`) prints how many events became requests: zero means the field names need one fix in `scripts/lab/shadow/replay/source.mjs`.
- **State classes.** Comments, wpm and authors are compared only as far as the daily resync allows (see above). A private, authenticated feed would make them exact; PV2 says the shadow reads public data only, so this is stated, not solved.
- **Why bans and comment likes stay state tables although their events carry ids.** `bans.at` and `comment_likes.created_at` are read from a separate `now()` call than the event's own `at` (`src/core/moderation.ts`, `src/core/comments.ts`), so the row cannot be rebuilt from the event byte for byte; `admins`, `clients`, the submissions and comment bodies carry private bookkeeping or text the feed redacts. A change to write the event and the row from one clock reading would make bans and comment likes exact; it is not part of phase D.
- **A skewed dump** (events past `meta.seq`: the dump reads `meta` first and its table pages later, `src/dump/write.ts`) cannot be compared exactly; the checkpoint records `inconclusive` and the day is not clean. If production's 03:00 dump is skewed often, the gate wants that fixed in the dump, not in shadow.
