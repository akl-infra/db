#!/bin/sh
# db/scripts/predeploy-dump.sh -- CI's pre-deploy checkpoint, step 2
# (akl-infra/db#8): one signed POST /v1/admin/dump, so the dump
# akl-infra/db-backup snapshots next is the database as it stands NOW, not
# last night's. Same signer as scripts/ops-call.sh, but CLIENT_ID /
# CLIENT_PRIVATE_KEY / OPS_ACTOR come from the environment (the deploy job's
# secrets), and any non-2xx fails the step -- ops-call.sh prints the status
# and exits 0, which is right for a hand call and wrong for a gate.
set -eu
REPO=$(cd "$(dirname "$0")/.." && pwd)
BASE="${DB_BASE_URL:-https://api.akldb.org}"
for v in CLIENT_ID CLIENT_PRIVATE_KEY OPS_ACTOR; do
  eval "[ -n \"\${$v:-}\" ]" || { echo "predeploy-dump: $v is not set (deploy job secrets OPS_CLIENT_ID / OPS_CLIENT_PRIVATE_KEY / OPS_ACTOR)" >&2; exit 2; }
done
HDRS=$(mktemp); trap 'rm -f "$HDRS"' EXIT
node "$REPO/scripts/client-sign.mjs" POST /v1/admin/dump > "$HDRS"
set --
while IFS= read -r line; do set -- "$@" -H "$line"; done < "$HDRS"
curl -fsS -m 400 -X POST "$@" "$BASE/v1/admin/dump"
echo
