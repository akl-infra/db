#!/bin/sh
# The latency probe stack (design A phase D, gate (a)): create it, run one measurement, delete it. Never run by a test and never
# by a session without saltorbit's go. Without --execute every command is only PRINTED, nothing is called.
#
#   sh scripts/aws/probe.sh create [--execute]            build the zip, upload it, create stack akldb-probe (one Lambda, no URL, no schedule)
#   sh scripts/aws/probe.sh run    [--execute] [--n 20] [--out FILE]   invoke it by hand against prod and shadow; the answer goes to FILE
#   sh scripts/aws/probe.sh delete [--execute]            delete the stack (and with it the function, role and log group)
#   options: --profile NAME (default akldb; "none" uses the credentials in the environment). `delete` needs a profile that may
#   delete a stack (the akldb-deploy role cannot: use an admin profile), like deploy-aws.sh --destroy-nonprod.
#
# The Lambda measures api.akldb.org and shadow-api.akldb.org from us-east-2 with the same routes and statistics as
# handoff/aws-tools/akldb/latency-compare.py; feed FILE to scripts/lab/shadow/gate.mjs (--probe FILE).
set -eu

ACCOUNT=335937358231
REGION=us-east-2
STACK=akldb-probe
FUNCTION=akldb-probe
ARTIFACTS="akldb-artifacts-$ACCOUNT"
CMD="${1:-}"
[ $# -gt 0 ] && shift
PROFILE=akldb
EXECUTE=0
N=20
OUT=""

while [ $# -gt 0 ]; do
  case "$1" in
    --profile) PROFILE="${2:?--profile needs a value}"; shift 2 ;;
    --execute) EXECUTE=1; shift ;;
    --n) N="${2:?--n needs a value}"; shift 2 ;;
    --out) OUT="${2:?--out needs a value}"; shift 2 ;;
    -h | --help) sed -n '2,13p' "$0"; exit 0 ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
done
case "$CMD" in create | run | delete) ;; *) echo "usage: probe.sh create|run|delete [--execute] [--profile NAME]" >&2; exit 2 ;; esac
case "$N" in '' | *[!0-9]*) echo "--n must be a number" >&2; exit 2 ;; esac
[ "$N" -ge 1 ] && [ "$N" -le 60 ] || { echo "--n must be between 1 and 60" >&2; exit 2; }

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
DIST="$ROOT/dist/probe"
[ "$PROFILE" = none ] || export AWS_PROFILE="$PROFILE"
export AWS_DEFAULT_REGION="$REGION" AWS_PAGER=""
AWS="aws --region $REGION"

show() {
  printf '+' >&2
  for a in "$@"; do printf " '%s'" "$(printf '%s' "$a" | sed "s/'/'\\\\''/g")" >&2; done
  printf '\n' >&2
}
run() {
  show "$@"
  [ "$EXECUTE" = 0 ] || "$@"
}

if [ "$EXECUTE" = 1 ]; then
  caller="$($AWS sts get-caller-identity --query Account --output text)"
  [ "$caller" = "$ACCOUNT" ] || { echo "refusing: the credentials are for account $caller, not $ACCOUNT" >&2; exit 2; }
else
  echo "printing only (no --execute): nothing is built, uploaded, created or invoked" >&2
fi

case "$CMD" in
  create)
    if [ "$EXECUTE" = 1 ]; then
      HASH="$(cat "$ROOT/infra/probe/index.mjs" "$ROOT/infra/probe/measure.mjs" | shasum -a 256 | cut -c1-16)"
    else
      HASH=0123456789abcdef
    fi
    KEY="code/probe/akldb-probe-$HASH.zip"
    run rm -rf "$DIST"
    run mkdir -p "$DIST"
    show sh -c "cd $ROOT/infra/probe && zip -q -X -j $DIST/akldb-probe-$HASH.zip index.mjs measure.mjs"
    if [ "$EXECUTE" = 1 ]; then mkdir -p "$DIST" && (cd "$ROOT/infra/probe" && zip -q -X -j "$DIST/akldb-probe-$HASH.zip" index.mjs measure.mjs); fi
    run $AWS s3 cp "$DIST/akldb-probe-$HASH.zip" "s3://$ARTIFACTS/$KEY"
    run $AWS cloudformation deploy --stack-name "$STACK" --template-file "$ROOT/infra/akldb-probe.yaml" \
      --parameter-overrides "ArtifactsBucket=$ARTIFACTS" "CodeKey=$KEY" --capabilities CAPABILITY_NAMED_IAM \
      --tags project=akldb purpose=akldb-probe --no-fail-on-empty-changeset
    [ "$EXECUTE" = 0 ] || echo "created $STACK (invoke with: sh scripts/aws/probe.sh run --execute)"
    ;;
  run)
    [ -n "$OUT" ] || OUT="$ROOT/probe-result-$(date -u +%Y%m%dT%H%M%SZ).json"
    run $AWS lambda invoke --function-name "$FUNCTION" --cli-binary-format raw-in-base64-out \
      --payload "{\"n\":$N,\"targets\":{\"prod\":\"https://api.akldb.org\",\"shadow\":\"https://shadow-api.akldb.org\"}}" --cli-read-timeout 330 "$OUT"
    [ "$EXECUTE" = 0 ] || echo "answer in $OUT"
    ;;
  delete)
    run $AWS cloudformation delete-stack --stack-name "$STACK"
    run $AWS cloudformation wait stack-delete-complete --stack-name "$STACK"
    [ "$EXECUTE" = 0 ] || echo "deleted $STACK"
    ;;
esac
