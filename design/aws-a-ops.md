# akldb on AWS (design A): ops note for phase C

Project 335937358231, region us-east-2 only. Stages: `staging` (staging-api.akldb.org), `shadow` (shadow-api.akldb.org),
`prod` (api.akldb.org). Templates in `infra/`, deploy script `scripts/deploy-aws.sh`, CI file `design/ci/aws-deploy.yml`.
Staging is deployed; shadow and prod are not. Commands use profile `akldb`.

## Once per account

1. IAM user `akldb-ci` (no console, one access key) with the inline policy in `infra/iam-akldb-ci.json` (it may only assume
   `akldb-deploy`). Then the bootstrap stack:
   `aws cloudformation deploy --region us-east-2 --stack-name akldb-bootstrap --template-file infra/akldb-bootstrap.yaml --capabilities CAPABILITY_NAMED_IAM`
   The stack also holds the managed policy `akldb-boundary` (exported as `akldb-boundary-arn`), the permissions boundary of every
   role the akldb-* stacks create: DynamoDB on `table/akldb-*`, S3 on `akldb-*-data-*`, SSM `parameter/akldb/*`, log writes on
   `/aws/lambda/akldb-*`, invoke of `function:akldb-*`. `akldb-deploy` may create a role, or set a boundary, only with that policy,
   and is denied removing a boundary or editing the policy. **Update this stack (same command, in place; nothing is replaced)
   before deploying an akldb-<stage> stack that imports the export**, and run it with an admin profile, not `akldb-deploy`.
2. One GitHub environment, `akldb-production`, serves every stage (staging, shadow and prod share the one key) on akl-infra/db: secrets `AKLDB_CI_ACCESS_KEY_ID`, `AKLDB_CI_SECRET_ACCESS_KEY`
   (the user's key), variable `AKLDB_ALARM_EMAIL`; allow branches `main` and `aws-a/main`.
3. Copy `design/ci/aws-deploy.yml` to `.github/workflows/aws-deploy.yml`: tests, then staging on a push to `aws-a/main`
   (plus an HTTP smoke of staging-api.akldb.org), prod on manual dispatch with `stage: prod`.

## Per stage (`<host>` is the stage's hostname, `<stage>` its name)

1. SSM parameters under `/akldb/<stage>/` (SecureString, made by saltorbit; the function reads them with its role):

   | name | required | value |
   |---|---|---|
   | `origin-secret` | yes | `openssl rand -hex 32`; the same string goes into the Cloudflare rule below |
   | `discord-bot-token`, `discord-application-id`, `discord-public-key`, `discord-webhook`, `discord-guild-id`, `discord-channel-id`, `discord-cards`, `discord-actions`, `discord-dms` | no | the matching `MODQUEUE_DISCORD_*` settings (docs/technical-reference.md); a missing one leaves that feature off; shadow sets none |

   `aws ssm put-parameter --region us-east-2 --name /akldb/<stage>/origin-secret --type SecureString --value <value>`
   A changed value reaches running containers within 5 minutes (they re-read SSM on that TTL).
2. Certificate: `aws cloudformation deploy --region us-east-2 --stack-name akldb-cert-<stage> --template-file infra/akldb-cert.yaml --parameter-overrides DomainName=<host>`.
   It waits (CREATE_IN_PROGRESS) until the validation record exists. Read it:
   `ARN=$(aws cloudformation describe-stack-resources --region us-east-2 --stack-name akldb-cert-<stage> --query 'StackResources[0].PhysicalResourceId' --output text)`
   `aws acm describe-certificate --region us-east-2 --certificate-arn $ARN --query 'Certificate.DomainValidationOptions[].ResourceRecord'`
   Cloudflare record 1: type `CNAME`, name = the returned `Name` (strip `.akldb.org.`), target = the returned `Value`, **DNS only** (grey cloud). Keep it for renewals.
3. First deploy: `ALARM_EMAIL=<address> sh scripts/deploy-aws.sh --stage <stage> --execute` (without `--execute` it prints the change set and stops).
   Confirm the SNS subscription email. Read the target: `aws cloudformation describe-stacks --region us-east-2 --stack-name akldb-<stage> --query "Stacks[0].Outputs[?OutputKey=='ApiDomainTarget'].OutputValue" --output text`
4. Cloudflare record 2: type `CNAME`, name `<stage-api>` (e.g. `staging-api`), target = ApiDomainTarget (`d-xxxx.execute-api.us-east-2.amazonaws.com`), **Proxied** (orange cloud).
   SSL/TLS encryption mode for akldb.org: **Full (strict)** (the origin has a valid ACM certificate for the host).
5. Cloudflare Transform Rule, Modify Request Header (Rules > Transform Rules): when `http.host eq "<host>"`, **Set static**
   header `x-akldb-origin` = the `origin-secret` value. Without it every request is a 403; the API Gateway default
   endpoint is disabled, so there is no way around Cloudflare.

## Notes

- **Concurrency.** The account limit is 10 and a raise to 1000 is requested (pending). Keep-warm K=4 takes 4 of the 10, and real
  users have been measured bursting to 27 concurrent, so the increase is needed before real traffic; until it lands, bursts
  above the remaining 6 throttle (the Throttles alarm, per function: dimension `FunctionName`, never an account-wide metric).
  `ReservedConcurrency` stays unset until the quota is raised (a reservation must leave 10 unreserved); then
  `RESERVED_CONCURRENCY=<n> sh scripts/deploy-aws.sh --stage <stage> --execute`.
- **Logs are STANDARD class** (prod never expires, the others 14 days): Infrequent Access supports neither metric filters nor
  FilterLogEvents, and the cost difference is pennies at this volume. The code logs every failure it wants a human to see as a
  line starting `akldb-alarm:`; a metric filter turns those into `akldb/<stage>/Alarms` and an alarm fires on any (1 of 1 x 5 min).
- **Moving an existing stack from Infrequent Access to STANDARD replaces its log group** (the class cannot change in place), and the
  group has a fixed name, so CloudFormation refuses the update ("custom-named resource requires replacing"). Staging (deployed
  with IA): either `deploy-aws.sh --stage staging --destroy-nonprod --confirm akldb-staging` and deploy again (the stack is
  deletable by design; its log and data go), or delete `/aws/lambda/akldb-staging-api` by hand first and then update.
- **Alarms.** Prod has the full set (Lambda Errors on the api and the jobs function, Throttles, Duration p95, API 5xx, two DynamoDB
  alarms, the `akldb-alarm:` alarm); staging and shadow only Lambda Errors and the `akldb-alarm:` alarm. That is 12 alarms across the
  three stages against the account's free 10, and the two DynamoDB alarms are metric math over five metrics each, which CloudWatch
  may bill per metric: at most cents a month, but not zero.
- **Jobs function.** `akldb-<stage>-jobs` is the api's bundle with a 600 s timeout and its own log group, no URL. It has its own
  pinned `live` alias (parameter `LiveJobsVersion`), moved together with the api's by `deploy-aws.sh` after the new api version
  migrated, so the nightly never runs code the schema has not met; the api invokes the alias ARN (`JOBS_FUNCTION`)
  asynchronously, with no retries (the next tick re-triggers the nightly; overlapping retried runs are worse than a skipped one),
  and shares the role (and its boundary). The role reads and writes `snap/`, `dumps/` and `log/` in the data bucket and deletes
  only under `log/` (orphaned spill objects). `deploy-aws.sh` updates and publishes both functions.
- **Edge cache for the static routes (optional, pending saltorbit's decision; design note `handoff/akldb-on-aws-edge-cache.md` §3.2).**
  Cloudflare Cache Rule: when hostname is in {staging-api.akldb.org, shadow-api.akldb.org, api.akldb.org} AND URI path starts with
  `/v1/formats`: eligible for cache; Edge TTL 1 day, ignore origin; Browser TTL respect origin. Then give the deploy
  `CF_PURGE_TOKEN` (an API token scoped to zone akldb.org with **Cache Purge** only) and `CF_ZONE_ID`: after the aliases move and
  the pre-warm, `deploy-aws.sh` purges by URL `https://<host>/v1/formats` and each `/v1/formats/<id>/schema.json` for the
  registered formats (`scripts/purge-urls.mjs`, from the registry in the bundle's tree). Unset: it logs one line and skips. In CI the
  workflow already passes `secrets.CF_PURGE_TOKEN` and `vars.CF_ZONE_ID` of the `akldb-production` environment; empty means skip.
- **First deploy.** `deploy-aws.sh --stage <stage>` (a preview) leaves the stack in REVIEW_IN_PROGRESS holding its change set;
  `--execute` after it works: it creates a CREATE change set (deleting the preview's same-named one first). A stack stuck in
  ROLLBACK_COMPLETE is refused with a message; delete it first.
- **Prod keeps, the others delete.** Prod's table, bucket and log group are `Retain` (table with deletion protection, logs never
  expire). Staging and shadow are deletable (14-day logs), so a stack can be deleted and recreated:
  `sh scripts/deploy-aws.sh --stage staging --destroy-nonprod --confirm akldb-staging` empties the versioned bucket (versions
  and delete markers; S3 will not delete it otherwise) and deletes the stack, and refuses prod. Run it with an admin profile:
  `akldb-deploy` cannot delete stacks or objects. That path has only been run as `--dry-run`. The certificate stack is separate
  and stays.
- Keep-warm: EventBridge Scheduler pings the live alias every 5 minutes with `k=4`; the function fans out 3 concurrent child
  invocations (150 ms each).
- Responses are buffered: Lambda and API Gateway cap them near 6 MB (today's dump is far below). A divergent replica makes the
  invocation fail (Lambda Errors alarm) and the next invocation boots a fresh one.
- Shadow has no deploy job yet (phase D); `deploy-aws.sh --stage shadow` works by hand.

## Deviations from the brief, for the record

- **Test placement.** The infra and Lambda tests are vitest files (`tests/infra/`, `tests/platform/`), not `infra/akldb.test.mjs`,
  because the invariant registry check (LDB-T1) scans only `tests/**/*.test.ts`.
- **DynamoDB alarms are metric math.** `SystemErrors` and `ThrottledRequests` exist per Operation and an alarm cannot SEARCH, so each
  alarm sums the five operations the log uses (GetItem, Query, PutItem, UpdateItem, TransactWriteItems).
- **Ticks floor to 5 minutes.** `rate(5 minutes)` is not clock-aligned; the nightly job keys on hour 3, minute 0, so each tick's
  time is floored to the 5-minute boundary and the job runs exactly once.
- **`akldb-deploy` scope.** `lambda:*` on `akldb-*` functions as asked, plus create/update/pass of `akldb-*` roles (the stacks hold
  roles; the name prefix is the fence). No `DeleteStack`, no IAM user or OIDC actions.
- **`s3:ListBucket`** on the function role: without it S3 answers 403 for a missing key instead of 404, and the blob store needs the
  404. Object access stays limited to `snap/*` and `dumps/*`.
- **esbuild** is an explicit devDependency (pinned 0.28.2, the version tsup already resolved to), because `deploy-aws.sh` calls it
  directly.
- **Two copies of the stateful resources.** `DeletionPolicy` cannot take `Fn::If`, so the log table, data bucket and log group
  exist once per Condition (`LogTable` / `LogTableDev`, ...); the rest of the template names them by their deterministic names.
