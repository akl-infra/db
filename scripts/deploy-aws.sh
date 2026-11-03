#!/bin/sh
# Deploy one akldb stage (design A, LDB-AX3). Never run by tests and never by a session: saltorbit or CI runs it.
#
#   sh scripts/deploy-aws.sh --stage staging                 # build, upload, print the change set, stop
#   sh scripts/deploy-aws.sh --stage staging --execute       # ... and carry it all the way through
#   sh scripts/deploy-aws.sh --stage prod --dry-run          # print every command, run none
#   sh scripts/deploy-aws.sh --stage staging --destroy-nonprod --confirm akldb-staging   # empty and delete a staging/shadow stack
#   options: --profile NAME (default akldb; "none" uses the credentials in the environment, as CI does)
#
# The order is the invariant (AX3):
#   1  bundle src/lambda.ts with esbuild (ESM, node24, minified) + migrations/ into a zip
#   2  upload the zip to the artifacts bucket under a content hash
#   3  create the stack's change set from the template, print it, and (--execute) run it
#   4  update-function-code (api and jobs) + publish-version (api) -> a new immutable version
#   5  invoke THAT version with {"akldb":"migrate"} -> pending migrations enter the log; the live alias still serves the old code
#   6  move the alias: a second change set with LiveVersion=<new version>, so CloudFormation stays the source of truth
#   7  pre-warm: invoke the live alias with {"akldb":"warm","k":4}
# A migration is additive-only (tests/tools/migrations-additive.test.ts), so the old code keeps serving through step 5.
#
# Settings read from the environment: ALARM_EMAIL (required on the first deploy; later deploys keep the stack's value),
# RESERVED_CONCURRENCY, KEEP_WARM, DISCORD_API_URL (each keeps the stack's current value when unset), CERTIFICATE_ARN
# (default: the output of the akldb-cert-<stage> stack).
set -eu

ACCOUNT=335937358231
REGION=us-east-2
STAGE=""
PROFILE=akldb
EXECUTE=0
DRY=0
DESTROY=0
CONFIRM=""

while [ $# -gt 0 ]; do
  case "$1" in
    --stage) STAGE="${2:?--stage needs a value}"; shift 2 ;;
    --profile) PROFILE="${2:?--profile needs a value}"; shift 2 ;;
    --execute) EXECUTE=1; shift ;;
    --dry-run) DRY=1; shift ;;
    --destroy-nonprod) DESTROY=1; shift ;;
    --confirm) CONFIRM="${2:?--confirm needs the stack name}"; shift 2 ;;
    -h | --help) sed -n '2,26p' "$0"; exit 0 ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
done
case "$STAGE" in
  staging) DOMAIN=staging-api.akldb.org ;;
  shadow) DOMAIN=shadow-api.akldb.org ;;
  prod) DOMAIN=api.akldb.org ;;
  *) echo "usage: deploy-aws.sh --stage staging|shadow|prod [--profile NAME] [--execute] [--dry-run]   (stage: '$STAGE')" >&2; exit 2 ;;
esac

# Prod is never destroyed by this script: its table, bucket and log group are Retain and protected on purpose.
if [ "$DESTROY" = 1 ] && [ "$STAGE" = prod ]; then
  echo "refusing: --destroy-nonprod never touches prod" >&2
  exit 2
fi

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
STACK="akldb-$STAGE"
FUNCTION="akldb-$STAGE-api"
JOBS_FUNCTION="akldb-$STAGE-jobs"
ARTIFACTS="akldb-artifacts-$ACCOUNT"
DIST="$ROOT/dist/lambda-$STAGE"
export AWS_PAGER=""
[ "$PROFILE" = none ] || export AWS_PROFILE="$PROFILE"
export AWS_DEFAULT_REGION="$REGION"

# Print a command to stderr (quoted, so it can be pasted), then run it unless --dry-run.
show() {
  printf '+' >&2
  for a in "$@"; do printf " '%s'" "$(printf '%s' "$a" | sed "s/'/'\\\\''/g")" >&2; done
  printf '\n' >&2
}
run() {
  show "$@"
  [ "$DRY" = 1 ] || "$@"
}
# cap PLACEHOLDER cmd...: print the command, run it and echo its output; under --dry-run echo PLACEHOLDER instead.
cap() {
  placeholder="$1"; shift
  show "$@"
  if [ "$DRY" = 1 ]; then printf '%s' "$placeholder"; else "$@"; fi
}
AWS="aws --region $REGION"
say() { printf '%s\n' "$*"; }

# ---- the account is the akldb project's, or nothing happens ----
caller="$(cap "$ACCOUNT" $AWS sts get-caller-identity --query Account --output text)"
if [ "$caller" != "$ACCOUNT" ]; then
  echo "refusing: the credentials are for account $caller, not $ACCOUNT" >&2
  exit 2
fi

# ---- --destroy-nonprod: empty the versioned data bucket, then delete the stack (staging and shadow only) ----
# The stack's table, bucket and log group are DeletionPolicy Delete outside prod, but S3 refuses to delete a bucket that
# still holds versions or delete markers, so they are removed first. Needs credentials that may delete a stack and
# objects (the akldb-deploy role may not: run it with an admin profile). The certificate stack is left alone.
if [ "$DESTROY" = 1 ]; then
  if [ "$DRY" = 0 ] && [ "$CONFIRM" != "$STACK" ]; then
    echo "refusing: pass --confirm $STACK to delete $STACK and everything in its data bucket" >&2
    exit 2
  fi
  BUCKET="akldb-$STAGE-data-$ACCOUNT"
  for kind in Versions DeleteMarkers; do
    while :; do
      query="{Objects: $kind[].{Key:Key,VersionId:VersionId}}"
      batch="$(cap '{"Objects": null}' $AWS s3api list-object-versions --bucket "$BUCKET" --max-items 500 --query "$query" --output json)"
      case "$batch" in *'"Objects": null'* | *'"Objects":null'* | "" | null) break ;; esac
      run $AWS s3api delete-objects --bucket "$BUCKET" --delete "$batch"
      [ "$DRY" = 1 ] && break
    done
  done
  run $AWS cloudformation delete-stack --stack-name "$STACK"
  run $AWS cloudformation wait stack-delete-complete --stack-name "$STACK"
  say "deleted $STACK"
  exit 0
fi

# ---- 1. bundle ----
run rm -rf "$DIST"
run mkdir -p "$DIST/migrations"
run "$ROOT/node_modules/.bin/esbuild" "$ROOT/src/lambda.ts" --bundle --platform=node --target=node24 --format=esm --minify \
  --external:node:sqlite --outfile="$DIST/lambda.mjs" \
  "--banner:js=import{createRequire as __cr}from'node:module';const require=__cr(import.meta.url);"
run cp "$ROOT"/migrations/*.sql "$DIST/migrations/"
if [ "$DRY" = 1 ]; then
  HASH=0123456789abcdef
else
  # The hash covers exactly what runs: the bundle and the migration files. Fixed mtimes make the zip reproducible.
  HASH="$( (cat "$DIST/lambda.mjs"; find "$DIST/migrations" -type f | sort | xargs cat) | shasum -a 256 | cut -c1-16)"
  find "$DIST" -exec touch -t 200001010000 {} +
fi
ZIP="$DIST/akldb-$HASH.zip"
show sh -c "cd $DIST && zip -q -X -r $ZIP lambda.mjs migrations"
[ "$DRY" = 1 ] || (cd "$DIST" && zip -q -X -r "$ZIP" lambda.mjs migrations)

# ---- 2. upload ----
CODE_KEY="code/$STAGE/akldb-$HASH.zip"
run $AWS s3 cp "$ZIP" "s3://$ARTIFACTS/$CODE_KEY"
TEMPLATE_KEY="templates/$STAGE/akldb-$HASH.yaml"
run $AWS s3 cp "$ROOT/infra/akldb.yaml" "s3://$ARTIFACTS/$TEMPLATE_KEY"
TEMPLATE_URL="https://$ARTIFACTS.s3.$REGION.amazonaws.com/$TEMPLATE_KEY"

# ---- parameters: an explicit setting wins, then the stack's current value, then the default ----
# The stack's status decides CREATE or UPDATE. A first-deploy preview (no --execute) leaves the stack in REVIEW_IN_PROGRESS
# holding its change set; that stack still needs a CREATE change set, not an UPDATE one ("does not exist"), and the
# preview's change set of the same name is deleted before the new one is made (a name can be used once).
# --dry-run takes the status from DEPLOY_DRY_STACK_STATUS (default UPDATE_COMPLETE; "none" is a first deploy).
if [ "$DRY" = 1 ]; then
  show $AWS cloudformation describe-stacks --stack-name "$STACK" --query "Stacks[0].StackStatus"
  STATUS="${DEPLOY_DRY_STACK_STATUS-UPDATE_COMPLETE}"
  [ "$STATUS" != none ] || STATUS=""
else
  STATUS="$($AWS cloudformation describe-stacks --stack-name "$STACK" --query "Stacks[0].StackStatus" --output text 2>/dev/null)" || STATUS=""
fi
case "$STATUS" in
  ROLLBACK_COMPLETE | CREATE_FAILED | DELETE_FAILED)
    echo "refusing: $STACK is in $STATUS; delete it (and fix what failed) before deploying" >&2
    exit 1 ;;
esac
exists=1
{ [ -n "$STATUS" ] && [ "$STATUS" != REVIEW_IN_PROGRESS ]; } || exists=0
current() { # current NAME DEFAULT
  if [ "$exists" = 1 ] && [ "$DRY" = 0 ]; then
    v="$($AWS cloudformation describe-stacks --stack-name "$STACK" --query "Stacks[0].Parameters[?ParameterKey=='$1'].ParameterValue | [0]" --output text)"
    if [ "$v" != None ]; then printf '%s' "$v"; return; fi
  fi
  printf '%s' "$2"
}
CERT="${CERTIFICATE_ARN:-}"
if [ -z "$CERT" ]; then
  CERT="$(cap "arn:aws:acm:$REGION:$ACCOUNT:certificate/00000000-0000-0000-0000-000000000000" $AWS cloudformation describe-stacks --stack-name "akldb-cert-$STAGE" \
    --query "Stacks[0].Outputs[?OutputKey=='CertificateArn'].OutputValue | [0]" --output text)"
fi
EMAIL="${ALARM_EMAIL:-$(current AlarmEmail '')}"
[ -n "$EMAIL" ] || [ "$DRY" = 1 ] || { echo "set ALARM_EMAIL (the stack has none yet)" >&2; exit 2; }
RESERVED="${RESERVED_CONCURRENCY-$(current ReservedConcurrency '')}"
KEEP="${KEEP_WARM:-$(current KeepWarm 4)}"
DISCORD="${DISCORD_API_URL:-$(current DiscordApiUrl https://discord.com/api)}"
LIVE="$(current LiveVersion '$LATEST')"

# change_set LIVE_VERSION NAME: create, print, and (with --execute) execute the stack's change set.
change_set() {
  live="$1"; name="$2"
  if [ "$exists" = 1 ]; then type=UPDATE; else type=CREATE; fi
  if [ -n "$STATUS" ]; then # a stack (maybe only REVIEW_IN_PROGRESS) may hold the preview's change set of this name
    show $AWS cloudformation delete-change-set --stack-name "$STACK" --change-set-name "$name"
    [ "$DRY" = 1 ] || $AWS cloudformation delete-change-set --stack-name "$STACK" --change-set-name "$name" >/dev/null 2>&1 || true
  fi
  run $AWS cloudformation create-change-set --stack-name "$STACK" --change-set-name "$name" --change-set-type "$type" \
    --template-url "$TEMPLATE_URL" --capabilities CAPABILITY_NAMED_IAM \
    --tags "Key=project,Value=akldb" "Key=stage,Value=$STAGE" \
    --parameters \
    "ParameterKey=Stage,ParameterValue=$STAGE" "ParameterKey=DomainName,ParameterValue=$DOMAIN" \
    "ParameterKey=CertificateArn,ParameterValue=$CERT" "ParameterKey=ArtifactsBucket,ParameterValue=$ARTIFACTS" \
    "ParameterKey=CodeKey,ParameterValue=$CODE_KEY" "ParameterKey=LiveVersion,ParameterValue=$live" \
    "ParameterKey=ReservedConcurrency,ParameterValue=$RESERVED" "ParameterKey=KeepWarm,ParameterValue=$KEEP" \
    "ParameterKey=AlarmEmail,ParameterValue=$EMAIL" "ParameterKey=DiscordApiUrl,ParameterValue=$DISCORD"
  if [ "$DRY" = 1 ]; then
    show $AWS cloudformation wait change-set-create-complete --stack-name "$STACK" --change-set-name "$name"
    show $AWS cloudformation describe-change-set --stack-name "$STACK" --change-set-name "$name" --query Changes
  else
    if ! $AWS cloudformation wait change-set-create-complete --stack-name "$STACK" --change-set-name "$name" 2>/dev/null; then
      reason="$($AWS cloudformation describe-change-set --stack-name "$STACK" --change-set-name "$name" --query StatusReason --output text)"
      case "$reason" in
        *"didn't contain changes"* | *"No updates"*)
          say "no changes in $name"
          $AWS cloudformation delete-change-set --stack-name "$STACK" --change-set-name "$name"
          return 0 ;;
        *) echo "change set $name failed: $reason" >&2; return 1 ;;
      esac
    fi
    $AWS cloudformation describe-change-set --stack-name "$STACK" --change-set-name "$name" \
      --query 'Changes[].ResourceChange.{action:Action,resource:LogicalResourceId,type:ResourceType,replace:Replacement}' --output table
  fi
  [ "$EXECUTE" = 1 ] || return 0
  run $AWS cloudformation execute-change-set --stack-name "$STACK" --change-set-name "$name"
  if [ "$type" = CREATE ]; then wait_for=stack-create-complete; else wait_for=stack-update-complete; fi
  run $AWS cloudformation wait "$wait_for" --stack-name "$STACK"
  exists=1
  STATUS=ACTIVE
}

# ---- 3. the change set ----
change_set "$LIVE" "akldb-$HASH-code"
if [ "$EXECUTE" != 1 ]; then
  say "change set printed, nothing executed. Re-run with --execute to apply it and continue (steps 4-7)."
  exit 0
fi

# ---- 4. a new version of the code ----
run $AWS lambda update-function-code --function-name "$FUNCTION" --s3-bucket "$ARTIFACTS" --s3-key "$CODE_KEY"
# the jobs function runs the same bundle (it has no alias: the api invokes it by name)
run $AWS lambda update-function-code --function-name "$JOBS_FUNCTION" --s3-bucket "$ARTIFACTS" --s3-key "$CODE_KEY"
run $AWS lambda wait function-updated --function-name "$FUNCTION"
run $AWS lambda wait function-updated --function-name "$JOBS_FUNCTION"
VERSION="$(cap 42 $AWS lambda publish-version --function-name "$FUNCTION" --description "$HASH" --query Version --output text)"
say "published version $VERSION"

# ---- 5. migrate through the log, on the new version, before any traffic reaches it ----
OUT="$DIST/migrate.json"
FERR="$(cap None $AWS lambda invoke --function-name "$FUNCTION" --qualifier "$VERSION" --cli-binary-format raw-in-base64-out \
  --payload '{"akldb":"migrate"}' --query FunctionError --output text "$OUT")"
if [ "$DRY" = 0 ]; then cat "$OUT"; echo; fi
if [ "$FERR" != None ] && [ "$FERR" != "" ]; then echo "migrate failed on version $VERSION; the alias was not moved" >&2; exit 1; fi

# ---- 6. move the alias ----
change_set "$VERSION" "akldb-$HASH-live-$VERSION"

# ---- 7. pre-warm the live alias (AX3) ----
WOUT="$DIST/warm.json"
run $AWS lambda invoke --function-name "$FUNCTION" --qualifier live --cli-binary-format raw-in-base64-out \
  --payload "{\"akldb\":\"warm\",\"k\":$KEEP}" "$WOUT"
if [ "$DRY" = 0 ]; then cat "$WOUT"; echo; fi
say "deployed $STACK: version $VERSION is live"
