#!/bin/sh
# Day-to-day commands of the shadow stage (design A phase D; design/aws-a-ops-shadow.md). Without --execute every command is only
# PRINTED. All of them act on the stack akldb-shadow in account 335937358231 only.
#
#   sh scripts/aws/shadow.sh seed [--reset] [--execute]   load production's latest public dump into the (empty) shadow database,
#                                                          on the jobs function (600 s). --reset restores over a non-empty one
#   sh scripts/aws/shadow.sh status [--execute]            the follower's row: cursor, last check, stale tables, fake Discord calls
#   sh scripts/aws/shadow.sh tick [--execute]              one follower tick now (otherwise the 5-minute schedule does it)
#   sh scripts/aws/shadow.sh logs [--hours 24] [--out DIR] [--execute]   export the lines the gate reads (akldb-checkpoint:,
#                                                          akldb-alarm:, akldb-cold:, REPORT) of both functions to DIR/logs-*.json
#   options: --profile NAME (default akldb; "none" uses the credentials in the environment)
set -eu

ACCOUNT=335937358231
REGION=us-east-2
CMD="${1:-}"
[ $# -gt 0 ] && shift
PROFILE=akldb
EXECUTE=0
RESET=0
HOURS=24
OUT="."

while [ $# -gt 0 ]; do
  case "$1" in
    --profile) PROFILE="${2:?--profile needs a value}"; shift 2 ;;
    --execute) EXECUTE=1; shift ;;
    --reset) RESET=1; shift ;;
    --hours) HOURS="${2:?--hours needs a value}"; shift 2 ;;
    --out) OUT="${2:?--out needs a value}"; shift 2 ;;
    -h | --help) sed -n '2,15p' "$0"; exit 0 ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
done
case "$CMD" in seed | status | tick | logs) ;; *) echo "usage: shadow.sh seed|status|tick|logs [--execute] [--profile NAME]" >&2; exit 2 ;; esac
case "$HOURS" in '' | *[!0-9]*) echo "--hours must be a number" >&2; exit 2 ;; esac

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
  echo "printing only (no --execute): nothing is invoked" >&2
fi

invoke() { # invoke FUNCTION PAYLOAD OUTFILE
  run $AWS lambda invoke --function-name "$1" --qualifier live --cli-binary-format raw-in-base64-out --cli-read-timeout 620 --payload "$2" "$3"
  [ "$EXECUTE" = 0 ] || { cat "$3"; echo; }
}

case "$CMD" in
  seed)
    if [ "$RESET" = 1 ]; then payload='{"akldb":"seed","dumpUrl":"https://api.akldb.org/v1/dump/latest.json","reset":true}'; else payload='{"akldb":"seed","dumpUrl":"https://api.akldb.org/v1/dump/latest.json"}'; fi
    invoke akldb-shadow-jobs "$payload" "$OUT/shadow-seed.json"
    ;;
  status) invoke akldb-shadow-api '{"akldb":"shadow-status"}' "$OUT/shadow-status.json" ;;
  tick) invoke akldb-shadow-api '{"akldb":"tick"}' "$OUT/shadow-tick.json" ;;
  logs)
    start=$(( ($(date -u +%s) - HOURS * 3600) * 1000 ))
    for fn in api jobs; do
      set -- $AWS logs filter-log-events --log-group-name "/aws/lambda/akldb-shadow-$fn" --start-time "$start" \
        --filter-pattern '?"akldb-checkpoint:" ?"akldb-alarm:" ?"akldb-cold:" ?"REPORT RequestId"' --output json
      show "$@"
      if [ "$EXECUTE" = 1 ]; then "$@" > "$OUT/logs-$fn.json.tmp" && mv "$OUT/logs-$fn.json.tmp" "$OUT/logs-$fn.json"; fi
    done
    ;;
esac
