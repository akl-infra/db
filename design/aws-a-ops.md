# akldb on AWS (design A): ops note for phase C

Project 335937358231, region us-east-2 only. Stages: `staging` (staging-api.akldb.org), `shadow` (shadow-api.akldb.org),
`prod` (api.akldb.org). Templates in `infra/`, deploy script `scripts/deploy-aws.sh`, CI file `design/ci/aws-deploy.yml`.
Nothing here has been deployed. Commands use profile `akldb`.

## Once per account

1. IAM user `akldb-ci` (no console, one access key) with the inline policy in `infra/iam-akldb-ci.json` (it may only assume
   `akldb-deploy`). Then the bootstrap stack:
   `aws cloudformation deploy --region us-east-2 --stack-name akldb-bootstrap --template-file infra/akldb-bootstrap.yaml --capabilities CAPABILITY_NAMED_IAM`
2. GitHub environment `akldb-production` on akl-infra/db: secrets `AKLDB_CI_ACCESS_KEY_ID`, `AKLDB_CI_SECRET_ACCESS_KEY`
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

- Reserved concurrency is unset: the account limit is 10 and a reservation must leave 10 unreserved. After a quota increase,
  `RESERVED_CONCURRENCY=<n> sh scripts/deploy-aws.sh --stage <stage> --execute`.
- Keep-warm: EventBridge Scheduler pings the live alias every 5 minutes with `k=4`; the function fans out 3 concurrent child
  invocations (150 ms each). Concurrency use is 4 of the account's 10.
- Responses are buffered: Lambda and API Gateway cap them near 6 MB (today's dump is far below). A divergent replica makes the
  invocation fail (Lambda Errors alarm) and the next invocation boots a fresh one.
- The table, bucket and log group are `Retain`: deleting a stack leaves them, and recreating the stack under the same name
  needs them removed (or imported) first. The table also has deletion protection on.
- The jobs schedule is `rate(5 minutes)`, not clock-aligned; the function floors each tick to the 5-minute boundary so the
  03:00 nightly job runs exactly once.
