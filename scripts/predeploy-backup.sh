#!/bin/sh
# db/scripts/predeploy-backup.sh -- CI's pre-deploy checkpoint, step 3
# (akl-infra/db#8): dispatch akl-infra/db-backup's `backup` workflow and
# WAIT for it, so the snapshot of the dump predeploy-dump.sh just wrote is
# a git commit before any migration runs. GH_TOKEN is a fine-grained token
# on akl-infra/db-backup alone (Actions: read and write) -- this repo's own
# GITHUB_TOKEN cannot reach another repository.
#
# `gh workflow run` returns no run id, so the run is found as the newest
# workflow_dispatch run of backup.yml created at or after the dispatch. The
# backup workflow's own concurrency group queues it behind a nightly run in
# flight; `gh run watch --exit-status` then fails this step if it fails.
#
# A green run is not yet the proof (the backup commits nothing on "no
# change"), so the last step CONFIRMS it: db-backup's committed
# manifest.json must name the very dump the API serves as latest right now
# (`source_sha256` == latest.json's `sha256`). Read through the API, not
# raw.githubusercontent.com, whose CDN can serve a minutes-old file. Only
# then does this script exit 0 and let the deploy job reach migrations.
set -eu
REPO="${BACKUP_REPO:-akl-infra/db-backup}"
BASE="${DB_BASE_URL:-https://api.akldb.org}"
[ -n "${GH_TOKEN:-}" ] || { echo "predeploy-backup: GH_TOKEN is not set (deploy job secret BACKUP_DISPATCH_TOKEN)" >&2; exit 2; }
since=$(date -u +%Y-%m-%dT%H:%M:%SZ)
gh workflow run backup.yml -R "$REPO"
run=""
for _ in 1 2 3 4 5 6 7 8 9 10 11 12; do
  run=$(gh run list -R "$REPO" --workflow backup.yml --event workflow_dispatch --created ">=$since" --limit 1 --json databaseId -q '.[0].databaseId // empty')
  [ -n "$run" ] && break
  sleep 5
done
[ -n "$run" ] || { echo "predeploy-backup: the dispatched backup run never appeared in $REPO" >&2; exit 1; }
echo "predeploy-backup: waiting on https://github.com/$REPO/actions/runs/$run"
gh run watch "$run" -R "$REPO" --exit-status --interval 10 > /dev/null
gh run view "$run" -R "$REPO" --json conclusion,url -q '"backup \(.conclusion): \(.url)"'
want=$(curl -fsS "$BASE/v1/dump/latest.json" | jq -r .sha256)
got=$(gh api "repos/$REPO/contents/manifest.json" -H "Accept: application/vnd.github.raw" | jq -r .source_sha256)
[ -n "$want" ] && [ "$want" = "$got" ] || { echo "predeploy-backup: NOT confirmed -- $REPO's manifest has dump $got, the API's latest is $want" >&2; exit 1; }
echo "predeploy-backup: confirmed, $REPO holds dump $want"
