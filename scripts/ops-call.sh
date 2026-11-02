#!/bin/sh
# db/scripts/ops-call.sh -- one signed client-lane request against akldb as
# the maintainer's ops client (docs/decisions/13-ledger.md §3).
#
#   sh scripts/ops-call.sh METHOD PATH [json-body]
#
# Reads CLIENT_ID / CLIENT_PRIVATE_KEY / OPS_ACTOR from `db.env.ops` beside
# the clones (`../db.env.ops` from this repo's root) -- the env-file
# convention of ~/git/akl since the
# 2026-09-13 split, when this repo became its own root and its old
# `db/.env.ops` went away with the monorepo. Signs with this repo's own
# scripts/client-sign.mjs (the bot's signer no longer lives next door);
# never prints the key. POSIX sh: it is documented as `sh scripts/...`.
set -eu
REPO=$(cd "$(dirname "$0")/.." && pwd)
M="$1"; P="$2"; BODY="${3:-}"
BASE=https://api.akldb.org; ENVF="$REPO/../db.env.ops"
# There is one akldb: the `--preview` target (akl-db-preview) was deleted 2026-11-02.
for a in "$@"; do [ "$a" = "--preview" ] && { echo "ops-call: --preview is gone (akl-db-preview was deleted 2026-11-02); every call goes to $BASE" >&2; exit 2; }; done
[ -f "$ENVF" ] || { echo "ops-call: $ENVF not found (CLIENT_ID / CLIENT_PRIVATE_KEY / OPS_ACTOR)" >&2; exit 2; }
set -a; . "$ENVF"; set +a
HDRS=$(mktemp); trap 'rm -f "$HDRS"' EXIT
if [ -n "$BODY" ]; then node "$REPO/scripts/client-sign.mjs" "$M" "$P" --body="$BODY" > "$HDRS"; else node "$REPO/scripts/client-sign.mjs" "$M" "$P" > "$HDRS"; fi
set --
while IFS= read -r line; do set -- "$@" -H "$line"; done < "$HDRS"
if [ -n "$BODY" ]; then
  curl -s -m 400 -X "$M" "$@" -d "$BODY" -w "\n[%{http_code} %{time_total}s]\n" "$BASE$P"
else
  curl -s -m 400 -X "$M" "$@" -w "\n[%{http_code} %{time_total}s]\n" "$BASE$P"
fi
