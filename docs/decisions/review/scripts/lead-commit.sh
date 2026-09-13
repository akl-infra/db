#!/bin/sh
# lead's git on the integration worktree only; guards on branch name
set -e
cd ~/git/akl/aklgg/.claude/worktrees/ldb-arch-review
[ "$(git rev-parse --abbrev-ref HEAD)" = "ldb-arch-review" ] || { echo "not on ldb-arch-review"; exit 1; }
git add -A design
git -c commit.gpgsign=false commit -q -m "$1

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01NCyJLCk3FYrjdggMQruuVu" || echo "nothing to commit"
git push -q origin ldb-arch-review
git log -1 --format='%h %s'
