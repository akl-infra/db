#!/usr/bin/env bash
# db/scripts/ops-call.sh -- one signed client-lane request against the layout DB
# as the ops-bootstrap client (design/layout-db/13-ledger.md §3).
#
#   sh db/scripts/ops-call.sh METHOD PATH [json-body] [--preview]
#
# Reads CLIENT_ID / CLIENT_PRIVATE_KEY from db/.env.ops (production) or
# db/.env.ops.preview (--preview); signs with bot/scripts/sign.mjs (the same
# signing string db/src/auth/client.ts verifies); never prints the key.
set -euo pipefail
ROOT=$(cd "$(dirname "$0")/../.." && pwd)
M="$1"; P="$2"; BODY="${3:-}"
BASE=https://akl-db.akl-58a.workers.dev; ENVF="$ROOT/db/.env.ops"
for a in "$@"; do [ "$a" = "--preview" ] && { BASE=https://akl-db-preview.akl-58a.workers.dev; ENVF="$ROOT/db/.env.ops.preview"; }; done
[ "$BODY" = "--preview" ] && BODY=""
ACTOR="${OPS_ACTOR:-184412255822020608}"
set -a; . "$ENVF"; set +a
cd "$ROOT/bot"
HDRS=$(mktemp)
if [ -n "$BODY" ]; then node scripts/sign.mjs "$M" "$P" --actor="$ACTOR" --body="$BODY"; else node scripts/sign.mjs "$M" "$P" --actor="$ACTOR"; fi | sed "s/^-H '\(.*\)'$/\1/" > "$HDRS"
ARGS=(); while IFS= read -r line; do ARGS+=(-H "$line"); done < "$HDRS"; rm -f "$HDRS"
if [ -n "$BODY" ]; then
  curl -s -m 400 -X "$M" "${ARGS[@]}" -H "Content-Type: application/json" -d "$BODY" -w "\n[%{http_code} %{time_total}s]\n" "$BASE$P"
else
  curl -s -m 400 -X "$M" "${ARGS[@]}" -w "\n[%{http_code} %{time_total}s]\n" "$BASE$P"
fi
