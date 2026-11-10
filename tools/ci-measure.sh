#!/usr/bin/env bash
# Run a command and report what it cost: wall time, CPU (user + system) and peak resident memory.
#
#   tools/ci-measure.sh <label> <command> [args...]
#
# CI logs no CPU or memory, so a speed-up or a slimmer runner cannot be judged from it. A test step
# that starts with this script prints one line, and (inside GitHub Actions) appends it to the job
# summary, which is the baseline to re-measure against. The command's exit status is the script's,
# its output is untouched, and a failed run is reported too.
#
# The figures come from `/usr/bin/time` (GNU: -f; BSD/macOS: -l). Peak memory is that of the
# largest single process the command waited for, not the sum of its parallel forks (a vitest run
# of N forks peaks near one fork's RSS): it shows how close one worker is to the runner's memory,
# not the machine's total. CPU time counts every waited-for child, forks included. Where no
# `/usr/bin/time` works (a minimal image), only the wall time is reported.
#
# Environment: CI_MEASURE_TIME (the time binary, default /usr/bin/time), GITHUB_STEP_SUMMARY and
# RUNNER_TEMP (set by Actions; the summary is skipped without the first).
set -uo pipefail

if [ "$#" -lt 2 ]; then
  echo "usage: tools/ci-measure.sh <label> <command> [args...]" >&2
  exit 2
fi
LABEL="$1"
shift

TIME_BIN="${CI_MEASURE_TIME:-/usr/bin/time}"
OUT="$(mktemp "${TMPDIR:-/tmp}/ci-measure.XXXXXX")"
trap 'rm -f "$OUT"' EXIT

FLAVOR=""
if [ -x "$TIME_BIN" ]; then
  if "$TIME_BIN" -f '%e' -o "$OUT" true 2>/dev/null; then
    FLAVOR=gnu
  elif "$TIME_BIN" -l -o "$OUT" true 2>/dev/null; then
    FLAVOR=bsd
  fi
fi

START="$SECONDS"
case "$FLAVOR" in
  gnu) "$TIME_BIN" -f '%e %U %S %M' -o "$OUT" "$@" ;;
  bsd) "$TIME_BIN" -l -o "$OUT" "$@" ;;
  *) "$@" ;;
esac
STATUS=$?

case "$FLAVOR" in
  gnu)
    # The program's own stderr never lands in the file; on a signal GNU time prepends a line.
    LINE="$(tail -n 1 "$OUT")"
    # shellcheck disable=SC2086
    set -- $LINE
    WALL="$1" USER_S="$2" SYS_S="$3" RSS_MB="$(awk -v k="$4" 'BEGIN { printf "%.0f", k / 1024 }')"
    ;;
  bsd)
    WALL="$(awk '/ real / { print $1 }' "$OUT")"
    USER_S="$(awk '/ real / { print $3 }' "$OUT")"
    SYS_S="$(awk '/ real / { print $5 }' "$OUT")"
    RSS_MB="$(awk '/maximum resident set size/ { printf "%.0f", $1 / 1048576 }' "$OUT")"
    ;;
  *)
    WALL="$((SECONDS - START))" USER_S="" SYS_S="" RSS_MB=""
    ;;
esac

if [ -n "$USER_S" ]; then
  CPU="$(awk -v u="$USER_S" -v s="$SYS_S" 'BEGIN { printf "%.1f", u + s }')"
  MSG="wall ${WALL} s, cpu ${CPU} s (user ${USER_S} + sys ${SYS_S}), peak rss ${RSS_MB} MB"
else
  MSG="wall ${WALL} s (cpu and memory not measured: no working time binary)"
fi
[ "$STATUS" -eq 0 ] || MSG="$MSG, exit $STATUS"

echo "ci-measure: $LABEL: $MSG"
if [ -n "${GITHUB_STEP_SUMMARY:-}" ]; then
  {
    # One heading per job: a marker in the runner's temp dir says it was written.
    MARK="${RUNNER_TEMP:-${TMPDIR:-/tmp}}/ci-measure-heading.${GITHUB_JOB:-job}.${GITHUB_RUN_ID:-0}"
    if [ ! -e "$MARK" ]; then
      echo "### Step cost (wall, cpu, peak rss of the largest process)"
      echo
      : >"$MARK"
    fi
    echo "- \`$LABEL\`: $MSG"
  } >>"$GITHUB_STEP_SUMMARY"
fi
exit "$STATUS"
