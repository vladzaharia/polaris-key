#!/usr/bin/env bash
# The one entry point for the Godot SDK's tests, locally and in CI (the `godot` job).
#
#   GODOT_BIN         the editor binary (default: `godot` on PATH; missing => exit 2, never a skip)
#                     (point it at the real binary or .app: a wrapper script gets a per-run TMPDIR
#                     and HOME but no self-contained editor copy)
#   GODOT_TEMPLATE    optional: an export-template binary. When set, the project is exported as a
#                     pack with the "Conformance (Linux)" preset (stamped PKEY_BUILD_OUTLET=steam,
#                     PKEY_BUILD_CHANNEL=beta, PKEY_BUILD_NUMBER=42), the template is copied beside
#                     it as build/pkey_conformance.x86_64, and the same suites run from the pack.
#   PKEY_TEST_SUITES  the --pkey-test selection (default: ci)
#   PKEY_TEST_STAMPS  1 runs the build-stamp exports (step 4) whatever the selection; they run
#                     by default only with the `ci` selection
#   PKEY_TEST_MATRIX  1 runs the UI resolution matrix (step 3b, the ui_matrix suite) whatever the
#                     selection; it runs by default only with the `ci` selection
#   PKEY_TEST_TIMEOUT seconds per step (default: 300)
#   PKEY_CONTENT_CORPUS the content corpus directory the packs suite reads (default: the
#                     checkout's conformance/corpus/v2/content; `content/` is not mirrored)
#   PKEY_KEYRING_TESTS 1 runs the keyring suite's real-keyring contract (the CI keyring job, SP-27)
#                     and lets default stores use the OS keyring; otherwise every run exports
#                     PKEY_DESKTOP_KEYRING=0, so no suite touches the developer's or runner's keyring
#   Extra arguments are passed to every suite after the selection.
#
# Steps: import (retried once on a signal exit), the untracked-.uid check, the f_uid data packs
# (two projects under tests/fixtures/uid_packs/, imported and exported with --export-pack into
# build/uid_packs/, read by the packs suite through PKEY_UID_PACKS), the editor run, the UI
# resolution matrix (the ui_matrix suite, `ci` only unless PKEY_TEST_MATRIX=1), the
# build-stamp exports (six ZIP exports with the P1-11 and P3-11 env overrides, checked by the
# export_stamps suite in the editor; --export-pack needs no templates), then export + template
# run. Every step runs under a log watchdog: a fatal line (below) kills and
# fails it at once, as do the timeout and a non-zero exit, and a run without a final
# `PKEY-TEST SUMMARY … failed=0` fails. A script parse error is not reliably reported by exit
# code (`--import` exits 0, and on macOS 4.7 a main loop that fails to load hangs on a modal
# alert), so the log is the authority. Generic `ERROR:` lines are NOT fatal: a slim container
# prints `ERROR: Unable to load fontconfig` on every run.
#
# Every run is isolated from other Godot processes on the machine (other worktrees, other engine
# versions): its own TMPDIR, its own HOME (so `user://`, editor settings and caches are per run)
# and a self-contained copy of the editor (a `._sc_` marker beside it), because the exporter
# writes its `packtmp` file into the editor temp directory, which outside self-contained mode is
# the OS temp directory shared by every process of the user (macOS ignores TMPDIR for it). All of
# it lives in one `mktemp -d` directory removed on exit.
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

# The run's own scratch: TMPDIR, HOME and the self-contained editor copy (see the header).
RUN_DIR="$(mktemp -d "${TMPDIR:-/tmp}/pkey-godot-run.XXXXXX")" || exit 2
# The physical path: macOS's TMPDIR is under /var, a symlink to /private/var, and Godot's
# DirAccess maps `user://` back from the resolved current directory, so a symlinked HOME breaks
# relative renames inside `user://`.
RUN_DIR="$(cd "$RUN_DIR" && pwd -P)" || exit 2
DIST_DIR=""
cleanup() {
  [ -n "$DIST_DIR" ] && rm -rf "$DIST_DIR"
  rm -rf "$RUN_DIR"
}
trap cleanup EXIT
trap 'exit 130' INT TERM
mkdir -p "$RUN_DIR/tmp" "$RUN_DIR/home" "$RUN_DIR/editor"
export TMPDIR="$RUN_DIR/tmp"
if [ "${PKEY_KEYRING_TESTS:-}" != 1 ]; then export PKEY_DESKTOP_KEYRING=0; fi
RUN_HOME="$RUN_DIR/home"
# The real-keyring run keeps the user's HOME: macOS resolves the login keychain from it, and under
# a fresh HOME every Keychain add fails with -60006 (no default keychain). That run selects the
# keyring suite only, whose roots are unique per run.
if [ "${PKEY_KEYRING_TESTS:-}" = 1 ]; then RUN_HOME="$HOME"; fi

# Resolve symlinks (Homebrew's `godot` links into the .app) without GNU readlink -f.
resolve() {
  local p="$1" l
  while [ -L "$p" ]; do
    l="$(readlink "$p")"
    case "$l" in
      /*) p="$l" ;;
      *) p="$(dirname "$p")/$l" ;;
    esac
  done
  echo "$(cd "$(dirname "$p")" && pwd)/$(basename "$p")"
}
GODOT_REAL="$(resolve "$(command -v "$GODOT")")"
case "$GODOT_REAL" in
  */Contents/MacOS/*)
    # A macOS bundle: clone the whole .app (an APFS clone when possible); the marker goes beside
    # the bundle, where the editor looks for it.
    APP="${GODOT_REAL%/Contents/MacOS/*}"
    cp -cR "$APP" "$RUN_DIR/editor/" 2>/dev/null || cp -R "$APP" "$RUN_DIR/editor/" || exit 2
    GODOT="$RUN_DIR/editor/$(basename "$APP")/Contents/MacOS/$(basename "$GODOT_REAL")"
    ;;
  *)
    cp "$GODOT_REAL" "$RUN_DIR/editor/" || exit 2
    GODOT="$RUN_DIR/editor/$(basename "$GODOT_REAL")"
    ;;
esac
: >"$RUN_DIR/editor/._sc_"

rm -rf "$BUILD"
mkdir -p "$LOGS"
: >"$BUILD/.gdignore"

# The packs suite reads the content corpus from the checkout and the f_uid packs from build/.
if [ -z "${PKEY_CONTENT_CORPUS:-}" ]; then
  PKEY_CONTENT_CORPUS="$(cd "$PROJECT/../../conformance/corpus/v2/content" 2>/dev/null && pwd || true)"
fi
export PKEY_CONTENT_CORPUS
export PKEY_UID_PACKS="$BUILD/uid_packs"

STEP_STATUS=0

# step <name> <kind: plain|run> <command…>
step() {
  local name="$1" kind="$2"
  shift 2
  local log="$LOGS/$name.log" elapsed=0 started reason=""
  started=$(date +%s)
  echo "── $name: $*"
  HOME="$RUN_HOME" "$@" >"$log" 2>&1 &
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

# 2b. The f_uid data packs (S-05 §4.6): two projects imported and exported independently, with
# this editor, so each leg mounts packs its own engine wrote.
mkdir -p "$PKEY_UID_PACKS" "$BUILD/uid_src"
for d in dataA dataB; do
  cp -R "$PROJECT/tests/fixtures/uid_packs/$d" "$BUILD/uid_src/$d"
  step "uid-import-$d" plain "$GODOT" --headless --path "$BUILD/uid_src/$d" --import || exit 1
  step "uid-export-$d" plain "$GODOT" --headless --path "$BUILD/uid_src/$d" --export-pack "Data" "$PKEY_UID_PACKS/$d.pck" || exit 1
done

# 3. The editor run.
step editor run "$GODOT" --headless --path "$PROJECT" -- --pkey-test "$SUITES" "$@" || exit 1

# 3b. The UI resolution matrix (tests/ui/matrix.gd): every drop-in screen laid out at every size,
# look and locale, in the editor, as a step of its own so the editor step keeps its budget. It
# takes 6-10 minutes, past the default 300 s step limit: CI and the local gate set
# PKEY_TEST_TIMEOUT=900. Layout is the same engine code on a release template, so it runs once.
if [ "$SUITES" = ci ] || [ "${PKEY_TEST_MATRIX:-0}" = 1 ]; then
  step ui-matrix run "$GODOT" --headless --path "$PROJECT" -- --pkey-test ui_matrix || exit 1
fi

# 4. The build stamp (P1-11): the export plugin end to end, headless, as CI exports a game.
STAMP_ENV="PKEY_BUILD_OUTLET=steam PKEY_BUILD_CHANNEL=beta PKEY_BUILD_NUMBER=42"
STAMPS="$BUILD/stamps"
if [ "$SUITES" = ci ] || [ "${PKEY_TEST_STAMPS:-0}" = 1 ]; then
  DIST="$PROJECT/.pkey"
  mkdir -p "$STAMPS"
  # export_stamp <name> [VAR=value…]: one ZIP export with the stamp env plus the extra variables.
  export_stamp() {
    local name="$1"
    shift
    # shellcheck disable=SC2086
    step "export-stamp-$name" plain env -u PKEY_OUTLET_IDS -u PKEY_BUILD_OUTLET_KIND -u PKEY_BUILD_OUTLET_SUBKIND \
      -u PKEY_BUILD_FORMAT $STAMP_ENV "$@" "$GODOT" --headless \
      --path "$PROJECT" --export-pack "Conformance (Linux)" "$STAMPS/$name.zip"
  }
  export_stamp steam || exit 1
  # The plugin never reads .pkey/distribution: a YAML one beside the project changes nothing.
  if [ -e "$DIST" ]; then
    echo "run_tests: $DIST exists; refusing to overwrite it" >&2
    exit 1
  fi
  # Removed on exit from here until the export below removes it.
  DIST_DIR="$DIST"
  mkdir -p "$DIST_DIR"
  printf 'apiVersion: pkey.dev/v1\noutlets:\n  steam:\n    identity:\n      appId: "999999"\n' >"$DIST_DIR/distribution.yaml"
  export_stamp steam2 || exit 1
  rm -rf "$DIST_DIR"
  DIST_DIR=""
  export_stamp env 'PKEY_OUTLET_IDS={"itchGameId":"2002","steamAppId":"999"}' || exit 1
  export_stamp bad 'PKEY_OUTLET_IDS={"itchGameId":1001}' || exit 1
  # The v4 fields (P3-11): a custom outlet id with its kind, subkind and format; and one with no
  # kind, which warns and stamps an empty outletKind (it decides as unknown at run time).
  export_stamp kind PKEY_BUILD_OUTLET=itch-beta PKEY_BUILD_OUTLET_KIND=itch PKEY_BUILD_FORMAT=zip || exit 1
  export_stamp nokind PKEY_BUILD_OUTLET=itch-beta PKEY_BUILD_OUTLET_SUBKIND=brew || exit 1
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
