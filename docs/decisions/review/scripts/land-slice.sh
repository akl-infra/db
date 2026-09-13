#!/bin/sh
# land-slice.sh <agent-branch> : rebase the agent branch onto ldb-arch-review and fast-forward it. Run from anywhere.
set -e
B="$1"; [ -n "$B" ] || { echo "usage: land-slice.sh <branch>"; exit 1; }
cd ~/git/akl/aklgg/.claude/worktrees/ldb-arch-review
[ "$(git rev-parse --abbrev-ref HEAD)" = "ldb-arch-review" ] || { echo "not on ldb-arch-review"; exit 1; }
[ -z "$(git status --porcelain)" ] || { echo "integration worktree dirty"; git status --short; exit 1; }
W="$(git worktree list --porcelain | awk -v b="refs/heads/$B" '$1=="worktree"{w=$2} $1=="branch"&&$2==b{print w}')"
[ -n "$W" ] || { echo "no worktree for $B"; exit 1; }
echo "agent worktree: $W"
( cd "$W" && [ -z "$(git status --porcelain)" ] || { echo "agent worktree dirty — ask the agent to commit"; exit 1; } )
( cd "$W" && git rebase ldb-arch-review ) || {
  # auto-resolve conflicts that are ONLY in the shared ledger: keep the integration side (lead re-edits it after landing)
  while :; do
    CONF="$(cd "$W" && git diff --name-only --diff-filter=U)"
    [ -n "$CONF" ] || break
    if [ "$CONF" = "design/layout-db/review/LEDGER.md" ]; then
      ( cd "$W" && git checkout --ours design/layout-db/review/LEDGER.md && git add design/layout-db/review/LEDGER.md && GIT_EDITOR=true git rebase --continue ) >/dev/null 2>&1 || true
      ( cd "$W" && git status --porcelain | grep -q '^UU' ) || { ( cd "$W" && [ ! -d .git/rebase-merge ] && [ ! -d .git/rebase-apply ] ) && break; }
      continue
    fi
    echo "REBASE CONFLICT in $W on: $CONF — resolve there (the agent has the context), then rerun"; exit 1
  done
  ( cd "$W" && [ ! -d "$(git rev-parse --git-path rebase-merge)" ] ) || { echo "rebase still in progress in $W"; exit 1; }
}
git merge --ff-only "$B"
git push -q origin ldb-arch-review
git log -1 --format='landed %h %s'
