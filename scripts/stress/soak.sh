#!/bin/sh
# Fresh local akldb + the soak, with a memory watch. Kills only its own PIDs.
#   sh scripts/stress/soak.sh <out-dir> <minutes> [cap-MB=3072] [workers=16] [owners=120]
# Writes <out-dir>/soak.log (every failure as it happens, with the request), <out-dir>/rss.tsv (every 15 s: seconds, KB of
# the wrangler tree, its workerd processes, the driver), and stops the driver if the whole tree passes the cap.
OUT=$1; MIN=$2; CAP=${3:-3072}; WORKERS=${4:-16}; OWNERS=${5:-120}
cd "$(dirname "$0")/../.." || exit 2
mkdir -p "$OUT"; : > "$OUT/rss.tsv"
node scripts/stress/serve.mjs --state "$OUT/state" > "$OUT/serve.log" 2>&1 &
SP=$!
until grep -q READY "$OUT/serve.log" 2>/dev/null; do sleep 1; done
WP=$(sed -n 's/.*pid=\([0-9]*\).*/\1/p' "$OUT/serve.log")
node scripts/stress/run.mjs --state "$OUT/state" --soak-minutes "$MIN" --workers "$WORKERS" --owners "$OWNERS" > "$OUT/soak.log" 2>&1 &
DP=$!
T0=$(date +%s)
while kill -0 $DP 2>/dev/null; do
  KIDS="$WP $(pgrep -P $WP) $(pgrep -P $(pgrep -P $WP))"
  tree=0; wd=0
  for p in $KIDS; do r=$(ps -o rss= -p $p 2>/dev/null); r=${r:-0}; tree=$((tree + r)); case "$(ps -o comm= -p $p)" in *workerd*) wd=$((wd + r));; esac; done
  r=$(ps -o rss= -p $DP 2>/dev/null); r=${r:-0}
  printf '%s\t%s\t%s\t%s\n' $(( $(date +%s) - T0 )) $((tree + r)) $wd $r >> "$OUT/rss.tsv"
  if [ $((tree + r)) -gt $((CAP * 1024)) ]; then echo "KILLED: tree+driver passed ${CAP} MB" >> "$OUT/soak.log"; kill $DP; fi
  sleep 15
done
wait $DP; RC=$?
kill $SP; sleep 3
echo "exit $RC"; exit $RC
