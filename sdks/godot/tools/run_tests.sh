#!/usr/bin/env bash
# The one entry point for the Godot SDK's tests, locally and in CI (the `godot` job).
#
#   GODOT_BIN         the editor binary (default: `godot` on PATH; missing => exit 2, never a skip)
#   GODOT_TEMPLATE    optional: an export-template binary. When set, the project is exported as a
#                     pack with the "Conformance (Linux)" preset, the template is copied beside it
#                     as build/pkey_conformance.x86_64, and the same suites run from the pack.
#   PKEY_TEST_SUITES  the --pkey-test selection (default: ci)
#   PKEY_TEST_TIMEOUT seconds per step (default: 300)
#   Extra arguments are passed to every suite after the selection.
#
# Steps: import (retried once on a signal exit), the untracked-.uid check, the editor run, then
# export + template run. Every step runs under a log watchdog: a fatal line (below) kills and
# fails it at once, as do the timeout and a non-zero exit, and a run without a final
# `PKEY-TEST SUMMARY … failed=0` fails. A script parse error is not reliably reported by exit
# code (`--import` exits 0, and on macOS 4.7 a main loop that fails to load hangs on a modal
# alert), so the log is the authority. Generic `ERROR:` lines are NOT fatal: a slim container
# prints `ERROR: Unable to load fontconfig` on every run.
#
# Written for bash 3.2 (macOS /bin/bash) and without GNU `timeout`.

set -u

PROJECT="$(cd "$(dirname "$0")/.." && pwd)"
BUILD="$PROJECT/build"
LOGS="$BUILD/logs"
SUITES="${PKEY_TEST_SUITES:-ci}"
TIMEOUT="${PKEY_TEST_TIMEOUT:-300}"
FATAL='SCRIPT ERROR|Parse Error|Failed to load script|Cannot get class|Invalid MainLoop'

if [ -n "${GODOT_BIN:-}" ]; then
  GODOT="$GODOT_BIN"
else
  GODOT="$(command -v godot || true)"
fi
if [ -z "$GODOT" ] || ! command -v "$GODOT" >/dev/null 2>&1; then
  echo "run_tests: no Godot editor found; set GODOT_BIN or put godot on PATH" >&2
  exit 2
fi
if [ -n "${GODOT_TEMPLATE:-}" ] && [ ! -f "$GODOT_TEMPLATE" ]; then
  echo "run_tests: GODOT_TEMPLATE=$GODOT_TEMPLATE does not exist" >&2
  exit 2
fi

rm -rf "$BUILD"
mkdir -p "$LOGS"
: >"$BUILD/.gdignore"

STEP_STATUS=0

# step <name> <kind: plain|run> <command…>
step() {
  local name="$1" kind="$2"
  shift 2
  local log="$LOGS/$name.log" elapsed=0 started reason=""
  started=$(date +%s)
  echo "── $name: $*"
  "$@" >"$log" 2>&1 &
  local pid=$!
  while kill -0 "$pid" 2>/dev/null; do
    if grep -Eq "$FATAL" "$log"; then
      reason="fatal line"
      break
    fi
    if [ "$elapsed" -ge "$TIMEOUT" ]; then
      reason="timeout after ${TIMEOUT}s"
      break
    fi
    sleep 1
    elapsed=$((elapsed + 1))
  done
  if [ -n "$reason" ]; then
    kill -9 "$pid" 2>/dev/null
    wait "$pid" 2>/dev/null
    STEP_STATUS=137
  else
    wait "$pid"
    STEP_STATUS=$?
    if grep -Eq "$FATAL" "$log"; then
      reason="fatal line"
    elif [ "$STEP_STATUS" -ne 0 ]; then
      reason="exit $STEP_STATUS"
    elif [ "$kind" = run ] && ! grep -E '^PKEY-TEST SUMMARY ' "$log" | tail -n 1 | grep -Eq ' failed=0$'; then
      reason="no final 'PKEY-TEST SUMMARY … failed=0'"
    fi
  fi
  cat "$log"
  local took=$(($(date +%s) - started))
  if [ -n "$reason" ]; then
    echo "── $name: FAIL ($reason) in ${took}s; log: $log"
    grep -En "$FATAL" "$log" | head -n 5
    return 1
  fi
  echo "── $name: ok in ${took}s"
  return 0
}

T0=$(date +%s)

# 1. Import: registers the class_name globals and writes .uid files for new scripts.
if ! step import plain "$GODOT" --headless --path "$PROJECT" --import; then
  if [ "$STEP_STATUS" -gt 128 ] && [ "$STEP_STATUS" -ne 137 ]; then
    echo "── import exited on a signal; retrying once"
    step import-retry plain "$GODOT" --headless --path "$PROJECT" --import || exit 1
  else
    exit 1
  fi
fi

# 2. Every script's .uid is committed: an untracked one means a new .gd arrived without it.
if command -v git >/dev/null 2>&1 && git -C "$PROJECT" rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  untracked="$(git -C "$PROJECT" status --porcelain --untracked-files=all -- . | grep -E '^\?\? .*\.uid$' || true)"
  if [ -n "$untracked" ]; then
    echo "── uid-check: FAIL — commit these .uid files with their scripts:"
    echo "$untracked"
    exit 1
  fi
  echo "── uid-check: ok"
else
  echo "── uid-check: skipped (not inside a git work tree)"
fi

# 3. The editor run.
step editor run "$GODOT" --headless --path "$PROJECT" -- --pkey-test "$SUITES" "$@" || exit 1

# 4. The exported pack on a release template.
if [ -n "${GODOT_TEMPLATE:-}" ]; then
  step export plain "$GODOT" --headless --path "$PROJECT" \
    --export-pack "Conformance (Linux)" "$BUILD/pkey_conformance.pck" || exit 1
  cp "$GODOT_TEMPLATE" "$BUILD/pkey_conformance.x86_64"
  chmod +x "$BUILD/pkey_conformance.x86_64"
  step template run "$BUILD/pkey_conformance.x86_64" --headless -- --pkey-test "$SUITES" "$@" || exit 1
fi

echo "── run_tests: all steps green in $(($(date +%s) - T0))s"
