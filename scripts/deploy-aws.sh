#!/usr/bin/env bash
# Deploys an akldb stack (design/aws-port.md section 5.2): esbuild bundle -> S3 -> cloudformation deploy.
#   aws-vault exec akldb -- scripts/deploy-aws.sh <lab|staging|prod|acm>
#   AWS_PROFILE=akldb scripts/deploy-aws.sh staging
# Run by the main session only. Refuses to run outside the akldb profile (account 335937358231).
set -euo pipefail

ACCOUNT=335937358231
REGION=us-east-2
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
STAGE="${1:-}"

if [[ "${AWS_PROFILE:-}" != "akldb" && "${AWS_VAULT:-}" != "akldb" ]]; then
  echo "refusing: run with AWS_PROFILE=akldb or under 'aws-vault exec akldb --' (account $ACCOUNT)" >&2
  exit 2
fi
case "$STAGE" in
  lab | staging | prod | acm) ;;
  *) echo "usage: deploy-aws.sh <lab|staging|prod|acm>   (stage: '$STAGE')" >&2; exit 2 ;;
esac

export AWS_PAGER=""
caller="$(aws sts get-caller-identity --query Account --output text)"
if [[ "$caller" != "$ACCOUNT" ]]; then
  echo "refusing: credentials are for account $caller, not $ACCOUNT" >&2
  exit 2
fi

ARTIFACTS="akldb-artifacts-$ACCOUNT"
ensure_artifacts_bucket() {
  if ! aws s3api head-bucket --bucket "$ARTIFACTS" --region "$REGION" 2>/dev/null; then
    aws s3api create-bucket --bucket "$ARTIFACTS" --region "$REGION" \
      --create-bucket-configuration "LocationConstraint=$REGION"
    aws s3api put-public-access-block --bucket "$ARTIFACTS" --region "$REGION" \
      --public-access-block-configuration BlockPublicAcls=true,IgnorePublicAcls=true,BlockPublicPolicy=true,RestrictPublicBuckets=true
  fi
}

if [[ "$STAGE" == "acm" ]]; then
  # CloudFront certificates live in us-east-1. The stack stays CREATE_IN_PROGRESS until the
  # DNS validation CNAMEs exist (saltorbit's batch); read them with:
  #   aws acm describe-certificate --region us-east-1 --certificate-arn <arn> --query 'Certificate.DomainValidationOptions[].ResourceRecord'
  exec aws cloudformation deploy --region us-east-1 --stack-name akldb-acm \
    --template-file "$ROOT/infra/acm-us-east-1.yaml" --no-fail-on-empty-changeset
fi

STACK="akldb-$STAGE"
PREFIX="/akldb/$STAGE"

ensure_secret() { # name: created once as a random SecureString, never rotated here
  local name="$PREFIX/$1"
  if ! aws ssm get-parameter --region "$REGION" --name "$name" >/dev/null 2>&1; then
    aws ssm put-parameter --region "$REGION" --name "$name" --type SecureString \
      --value "$(openssl rand -hex 32)" >/dev/null
    echo "created $name"
  fi
}
ensure_secret origin-verify
[[ "$STAGE" == "prod" ]] && ensure_secret tee-hmac
ORIGIN_VERIFY="$(aws ssm get-parameter --region "$REGION" --name "$PREFIX/origin-verify" --with-decryption --query Parameter.Value --output text)"

# Build: one bundle, several handlers (lambda.api, .feed, .jobs, .mirrorIngest, .mirrorApply).
ENTRY="${AKLDB_LAMBDA_ENTRY:-$ROOT/src/platform/lambda.ts}"
[[ -f "$ENTRY" ]] || { echo "missing Lambda entry $ENTRY (set AKLDB_LAMBDA_ENTRY)" >&2; exit 2; }
DIST="$ROOT/dist/lambda-$STAGE"
rm -rf "$DIST" && mkdir -p "$DIST"
"$ROOT/node_modules/.bin/esbuild" "$ENTRY" --bundle --platform=node --target=node24 --format=esm \
  --sourcemap --outfile="$DIST/lambda.mjs" --banner:js="import{createRequire as __cr}from'module';const require=__cr(import.meta.url);"
SHA="$(shasum -a 256 "$DIST/lambda.mjs" | cut -c1-16)"
(cd "$DIST" && zip -q -X "akldb-$SHA.zip" lambda.mjs lambda.mjs.map)

ensure_artifacts_bucket
CODE_KEY="code/$STAGE/akldb-$SHA.zip"
aws s3 cp --region "$REGION" "$DIST/akldb-$SHA.zip" "s3://$ARTIFACTS/$CODE_KEY"

# Parameters the cutover flips are kept as they are on an update; only the first deploy sets them.
param_now() {
  aws cloudformation describe-stacks --region "$REGION" --stack-name "$STACK" \
    --query "Stacks[0].Parameters[?ParameterKey=='$1'].ParameterValue | [0]" --output text 2>/dev/null || true
}
exists=false
aws cloudformation describe-stacks --region "$REGION" --stack-name "$STACK" >/dev/null 2>&1 && exists=true

cert="${CERTIFICATE_ARN:-}"
if [[ -z "$cert" ]]; then
  cert="$(aws cloudformation describe-stacks --region us-east-1 --stack-name akldb-acm \
    --query "Stacks[0].Outputs[?OutputKey=='CertificateArn'].OutputValue | [0]" --output text 2>/dev/null || true)"
  [[ "$cert" == "None" ]] && cert=""
fi

mirror_mode="${MIRROR_MODE:-apply}"
schedule="${SCHEDULE_ENABLED:-true}"
tee_url="${TEE_URL:-}"
if [[ "$STAGE" == "prod" ]]; then
  if $exists; then
    mirror_mode="$(param_now MirrorMode)"; schedule="$(param_now ScheduleEnabled)"; tee_url="$(param_now TeeUrl)"
    [[ "$tee_url" == "None" ]] && tee_url=""
  else
    schedule="false" # the cutover enables the schedule
  fi
fi

aws cloudformation deploy --region "$REGION" --stack-name "$STACK" \
  --template-file "$ROOT/infra/akldb.yaml" \
  --s3-bucket "$ARTIFACTS" --s3-prefix "templates/$STAGE" \
  --capabilities CAPABILITY_NAMED_IAM --no-fail-on-empty-changeset \
  --tags project=akldb stage="$STAGE" \
  --parameter-overrides \
    "Stage=$STAGE" "CodeBucket=$ARTIFACTS" "CodeKey=$CODE_KEY" \
    "OriginVerifySecret=$ORIGIN_VERIFY" "CertificateArn=$cert" \
    "DiscordApiUrl=${DISCORD_API_URL:-https://discord.com/api}" \
    "MirrorMode=$mirror_mode" "ScheduleEnabled=$schedule" "TeeUrl=$tee_url" \
    "AlertEmail=${ALERT_EMAIL:?set ALERT_EMAIL}"

aws cloudformation describe-stacks --region "$REGION" --stack-name "$STACK" \
  --query 'Stacks[0].Outputs[].[OutputKey,OutputValue]' --output text
