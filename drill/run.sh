#!/bin/sh
# db/drill/run.sh -- the Fly restore drill (design/layout-db/
# 12-implementation-phase5.md §3 X4 "the drill on Fly", LDB-D5).
#
# Four steps, each a script under db/scripts/, each writing its own JSON
# result to $WORKDIR so the next step (and the final report) can read it:
#   1. drill-fetch-dump.mjs   GET latest.json + the dump, verify sha256/bytes
#   2. drill-restore.mjs      restore into a local D1 (real restore code path)
#   3. drill-verify.mjs       walk every layout id against a served Worker
#   4. report-drill.mjs       sign + POST the assembled report
#
# Exits non-zero on ANY failure -- including a red (ok:false) report that
# itself posted successfully. `report-drill.mjs`'s own "steps" mode exit
# code IS this script's exit code (see its header): 0 iff every step
# reported ok AND the POST succeeded. A Fly Machine run's own exit code is
# a second, redundant alarm alongside `/v1/meta`'s `last_drill`
# (LDB-M1's meta-watch) -- belt and suspenders, not either/or.
#
# Required environment: DB_BASE_URL, DRILL_CLIENT_ID, DRILL_PRIVATE_KEY,
# DRILL_ACTOR (never printed -- see db/README.md § Drill).
set -u
cd "$(dirname "$0")/.." || exit 1 # db/

: "${DB_BASE_URL:?DB_BASE_URL must be set}"
: "${DRILL_CLIENT_ID:?DRILL_CLIENT_ID must be set}"
: "${DRILL_PRIVATE_KEY:?DRILL_PRIVATE_KEY must be set}"
: "${DRILL_ACTOR:?DRILL_ACTOR must be set}"

WORKDIR=$(mktemp -d)
DEV_PID=""
cleanup() {
  [ -n "$DEV_PID" ] && kill "$DEV_PID" 2>/dev/null
  rm -rf "$WORKDIR"
}
trap cleanup EXIT INT TERM

START_MS=$(node -e 'console.log(Date.now())')

echo "drill: [1/4] fetching + verifying the dump ($DB_BASE_URL)" >&2
FETCH_ARGS="--fetch $WORKDIR/fetch.json" # written on both success AND failure -- always readable
if node scripts/drill-fetch-dump.mjs --base "$DB_BASE_URL" --out "$WORKDIR" >"$WORKDIR/fetch.json"; then
  echo "drill: [1/4] ok" >&2
else
  cat "$WORKDIR/fetch.json" >&2 || true
  echo "drill: [1/4] FAILED -- skipping restore/verify" >&2
fi

RESTORE_ARGS=""
if [ -f "$WORKDIR/dump.json" ]; then
  echo "drill: [2/4] restoring into a local D1" >&2
  RESTORE_ARGS="--restore $WORKDIR/restore.json"
  if node scripts/drill-restore.mjs --dump "$WORKDIR/dump.json" --db akl-db >"$WORKDIR/restore.json"; then
    echo "drill: [2/4] ok" >&2
  else
    cat "$WORKDIR/restore.json" >&2 || true
    echo "drill: [2/4] FAILED -- skipping verify" >&2
  fi
fi

VERIFY_ARGS=""
if [ -n "$RESTORE_ARGS" ]; then
  echo "drill: [3/4] serving the restored D1 (wrangler dev --local :8790)" >&2
  npx wrangler dev --local --port 8790 --config wrangler.toml >"$WORKDIR/dev.log" 2>&1 &
  DEV_PID=$!

  READY=false
  i=0
  while [ "$i" -lt 60 ]; do
    if node -e '
      fetch("http://localhost:8790/v1/meta").then((r) => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1));
    ' >/dev/null 2>&1; then
      READY=true
      break
    fi
    i=$((i + 1))
    sleep 1
  done

  if [ "$READY" = true ]; then
    VERIFY_ARGS="--verify $WORKDIR/verify.json"
    if node scripts/drill-verify.mjs --dump "$WORKDIR/dump.json" --base "http://localhost:8790" >"$WORKDIR/verify.json"; then
      echo "drill: [3/4] ok" >&2
    else
      cat "$WORKDIR/verify.json" >&2 || true
      echo "drill: [3/4] FAILED" >&2
    fi
  else
    echo '{"ok":false,"step":"wrangler dev","error":"never became ready on :8790"}' >"$WORKDIR/verify.json"
    VERIFY_ARGS="--verify $WORKDIR/verify.json"
    echo "drill: [3/4] FAILED -- wrangler dev never became ready" >&2
    cat "$WORKDIR/dev.log" >&2 || true
  fi

  kill "$DEV_PID" 2>/dev/null || true
  wait "$DEV_PID" 2>/dev/null || true
  DEV_PID=""
fi

END_MS=$(node -e 'console.log(Date.now())')
DURATION_MS=$((END_MS - START_MS))

echo "drill: [4/4] signing + posting the report" >&2
# shellcheck disable=SC2086 -- each *_ARGS is either empty or exactly
# "--flag <path>" built above, never user input, so word-splitting here is
# the intended way to pass (or omit) each optional flag.
node scripts/report-drill.mjs $FETCH_ARGS $RESTORE_ARGS $VERIFY_ARGS --duration-ms "$DURATION_MS"
REPORT_EXIT=$?

if [ "$REPORT_EXIT" -eq 0 ]; then
  echo "drill: ok" >&2
else
  echo "drill: FAILED (exit $REPORT_EXIT)" >&2
fi
exit "$REPORT_EXIT"
