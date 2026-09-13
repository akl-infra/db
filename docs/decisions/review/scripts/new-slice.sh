#!/bin/sh
# create a slice worktree from the integration branch: new-slice.sh <slice>
set -e
cd ~/git/akl/aklgg
git worktree add ".claude/worktrees/ldb-$1" -b "ldb-$1" ldb-arch-review
echo "~/git/akl/aklgg/.claude/worktrees/ldb-$1"
