#!/usr/bin/env bash
# The one entry point for the Godot SDK's tests, locally and in CI (the `godot` job).
#
#   GODOT_BIN         the editor binary (default: `godot` on PATH; missing => exit 2, never a skip)
#   GODOT_TEMPLATE    optional: an export-template binary. When set, the project is exported as a
#                     pack with the "Conformance (Linux)" preset (stamped PKEY_BUILD_OUTLET=steam,
#                     PKEY_BUILD_CHANNEL=beta, PKEY_BUILD_NUMBER=42), the template is copied beside
#                     it as build/pkey_conformance.x86_64, and the same suites run from the pack.
#   PKEY_TEST_SUITES  the --pkey-test selection (default: ci)
#   PKEY_TEST_STAMPS  1 runs the build-stamp exports (step 4) whatever the selection; they run
#                     by default only with the `ci` selection
#   PKEY_TEST_TIMEOUT seconds per step (default: 300)
#   Extra arguments are passed to every suite after the selection.
#
# Steps: import (retried once on a signal exit), the untracked-.uid check, the editor run, the
# build-stamp exports (four ZIP exports with the P1-11 env overrides, checked by the
# export_stamps suite in the editor; --export-pack needs no templates), then export + template
# run. Every step runs under a log watchdog: a fatal line (below) kills and
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

# 4. The build stamp (P1-11): the export plugin end to end, headless, as CI exports a game.
STAMP_ENV="PKEY_BUILD_OUTLET=steam PKEY_BUILD_CHANNEL=beta PKEY_BUILD_NUMBER=42"
STAMPS="$BUILD/stamps"
if [ "$SUITES" = ci ] || [ "${PKEY_TEST_STAMPS:-0}" = 1 ]; then
  DIST_DIR="$PROJECT/.pkey"
  mkdir -p "$STAMPS"
  # export_stamp <name> [VAR=value…]: one ZIP export with the stamp env plus the extra variables.
  export_stamp() {
    local name="$1"
    shift
    # shellcheck disable=SC2086
    step "export-stamp-$name" plain env -u PKEY_OUTLET_IDS $STAMP_ENV "$@" "$GODOT" --headless \
      --path "$PROJECT" --export-pack "Conformance (Linux)" "$STAMPS/$name.zip"
  }
  export_stamp steam || exit 1
  # The plugin never reads .pkey/distribution: a YAML one beside the project changes nothing.
  if [ -e "$DIST_DIR" ]; then
    echo "run_tests: $DIST_DIR exists; refusing to overwrite it" >&2
    exit 1
  fi
  trap 'rm -rf "$DIST_DIR"' EXIT
  mkdir -p "$DIST_DIR"
  printf 'apiVersion: pkey.dev/v1\noutlets:\n  steam:\n    identity:\n      appId: "999999"\n' >"$DIST_DIR/distribution.yaml"
  export_stamp steam2 || exit 1
  rm -rf "$DIST_DIR"
  trap - EXIT
  export_stamp env 'PKEY_OUTLET_IDS={"itchGameId":"2002","steamAppId":"999"}' || exit 1
  export_stamp bad 'PKEY_OUTLET_IDS={"itchGameId":1001}' || exit 1
  step stamps run "$GODOT" --headless --path "$PROJECT" -- --pkey-test export_stamps "$STAMPS" "$LOGS" || exit 1
fi

# 5. The exported pack on a release template, stamped as CI stamps a Steam beta build.
if [ -n "${GODOT_TEMPLATE:-}" ]; then
  # shellcheck disable=SC2086
  step export plain env -u PKEY_OUTLET_IDS $STAMP_ENV "$GODOT" --headless --path "$PROJECT" \
    --export-pack "Conformance (Linux)" "$BUILD/pkey_conformance.pck" || exit 1
  cp "$GODOT_TEMPLATE" "$BUILD/pkey_conformance.x86_64"
  chmod +x "$BUILD/pkey_conformance.x86_64"
  step template run "$BUILD/pkey_conformance.x86_64" --headless -- --pkey-test "$SUITES" "$@" || exit 1
fi

echo "── run_tests: all steps green in $(($(date +%s) - T0))s"
