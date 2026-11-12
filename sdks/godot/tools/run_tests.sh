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
#   PKEY_TEST_PNG     1 compares the PNG baselines (step 3c, windowed: needs a display; macOS-recorded);
#                     PKEY_TEST_PNG_UPDATE=1 records them
#   PKEY_TEST_MATRIX  1 runs the UI resolution matrix (step 3b, the ui_matrix suite) whatever the
#                     selection; it runs by default only with the `ci` selection
#   PKEY_UI_MATRIX_PATHS  both | 0 | 1 | auto (default): the presentation path(s) the UI matrix runs: both = the scrim
#                     and the opaque page, 0 = the scrim only (PKEY_UI_REDUCE_TRANSPARENCY=0), 1 = the opaque
#                     page only, auto = the engine's own path
#   PKEY_UI_MATRIX_SHARDS  shards the cases of each matrix path are split into (default 4, or 2 per path with
#                     PATHS=both; 1 = one process per path)
#   PKEY_UI_MATRIX_SHARD_RANGE  lo-hi (default: all of them): this run executes only shards lo..hi (inclusive) of
#                     the SHARDS, so CI can spread one path over several jobs; the run still checks that its shards
#                     ran exactly the cases the (unsharded) listing assigns to them
#   PKEY_TEST_PARALLEL  1 runs the `ci` selection of the editor and template steps as the four disjoint sets
#                     ci_p1..ci_p4 (tests/runner.gd) in parallel processes, each with its own HOME (so its own
#                     `user://`) and TMPDIR; any other selection runs as one process
#   PKEY_TEST_DEV_LIVE  1 adds the `dev_live` suite (in no set; it needs a `pkey dev` server) to the editor step's
#                     last parallel process; only the 4.7.2 editor CI leg sets it
#   PKEY_TEST_TIMEOUT seconds per step (default: 300)
#   PKEY_TEST_PART    all (default) | editor | editor-a | editor-b | matrix | template: which heavy
#                     steps run, so CI can spread them over runners. editor = the editor run + the
#                     build-stamp exports; editor-a / editor-b = the same split in two: with the `ci`
#                     selection each runs its half of it (the ci_a and ci_b sets in tests/runner.gd,
#                     disjoint, together `ci`) and editor-a also runs the build-stamp exports;
#                     matrix = the UI resolution matrix; template = export + release-template run.
#                     The import, uid-check and uid-pack steps run in every part.
#   PKEY_CONTENT_CORPUS the content corpus directory the packs suite reads (default: the
#                     checkout's conformance/corpus/v2/content; `content/` is not mirrored)
#   PKEY_KEYRING_TESTS 1 runs the keyring suite's real-keyring contract (the CI keyring job, SP-27)
#                     and lets default stores use the OS keyring; otherwise every run exports
#                     PKEY_DESKTOP_KEYRING=0, so no suite touches the developer's or runner's keyring
#   PKEY_TEST_LEAK_GATE  auto (default: on for 4.7 engines) | 1 | 0: whether a run step fails on the engine's leak report
#   PKEY_TEST_SEED_LEAK  1 makes the runner leak one object, to prove the leak gate: the run step must then
#                     fail ("the engine reported a leak at exit"). `run_tests.sh --self-check` tests the gate's
#                     pattern on seeded logs, without an engine.
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
# `PKEY-TEST SUMMARY … failed=0` fails, and so does one whose log has the engine's leak report
# (`ObjectDB instances were leaked at exit`, `resources still in use at exit`; see LEAK below). A script
# parse error is not reliably reported by exit code (`--import` exits 0, and on macOS 4.7 a main loop that fails to load hangs on a modal
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
PART="${PKEY_TEST_PART:-all}"
case "$PART" in
  all | editor | editor-a | editor-b | matrix | template) ;;
  *)
    echo "run_tests: PKEY_TEST_PART=$PART is not all, editor, editor-a, editor-b, matrix or template" >&2
    exit 2
    ;;
esac
# part <name>: true when this run owns that heavy step.
# `editor` is also owned by both halves of the split editor run (editor-a, editor-b).
part() {
  [ "$PART" = all ] || [ "$PART" = "$1" ] && return 0
  [ "$1" = editor ] && { [ "$PART" = editor-a ] || [ "$PART" = editor-b ]; } && return 0
  return 1
}
# The split editor run's half of the default selection.
case "$PART:$SUITES" in
  editor-a:ci) SUITES=ci_a ;;
  editor-b:ci) SUITES=ci_b ;;
esac
FATAL='SCRIPT ERROR|Parse Error|Failed to load script|Cannot get class|Invalid MainLoop'
# The engine's exit report of a leak: `WARNING: 5 ObjectDB instances were leaked at exit (…)` and
# `ERROR: 2 resources still in use at exit (…)`; one object reads `1 ObjectDB instance was leaked`, and older engines
# drop the count or the "were". Anchored, because suite_exit_leaks prints a PASS line that contains the phrase. A
# `run` step fails on a match.
LEAK='^(WARNING|ERROR): ([0-9]+ )?ObjectDB instances? (were |was )?leaked at exit|^(WARNING|ERROR): ([0-9]+ )?resources? (is |are )?still in use at exit'

# `run_tests.sh --self-check`: the leak gate against seeded logs, without an engine (tools/godotCiSplit.test.ts
# runs it). A seeded leak must match, whatever the engine's wording; the suite's own PASS line must not.
if [ "${1:-}" = --self-check ]; then
  bad=0
  expect() { # expect <match|clean> <line>
    local got=clean
    printf '%s\n' "$2" | grep -Eq "$LEAK" && got=match
    if [ "$got" != "$1" ]; then
      echo "self-check: expected $1 for: $2" >&2
      bad=1
    fi
  }
  expect match 'WARNING: 5 ObjectDB instances were leaked at exit (run with `--verbose` for details).'
  expect match 'ERROR: 2 resources still in use at exit (run with --verbose for details).'
  expect match 'ERROR: 2 resources still in use at exit.'
  expect match 'WARNING: ObjectDB instances leaked at exit (run with -v for details).'
  expect match 'ERROR: 1 resources still in use at exit'
  expect match 'WARNING: 1 ObjectDB instance was leaked at exit (run with `--verbose` for details).'
  expect clean "PASS exit_leaks quit — no 'ObjectDB instances were leaked' and no 'resources still in use at exit'"
  expect clean 'PASS exit_leaks ObjectDB instances were leaked at exit'
  expect clean '    WARNING: 5 ObjectDB instances were leaked at exit'
  expect clean 'INFO connect resources still in use at exit'
  [ "$bad" -eq 0 ] && echo "self-check: ok"
  exit "$bad"
fi

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
    # Windows: the console exe is a thin wrapper that starts its sibling GUI exe (same name
    # without _console); copied alone it cannot start.
    case "$GODOT_REAL" in
      *_console.exe) cp "${GODOT_REAL%_console.exe}.exe" "$RUN_DIR/editor/" || exit 2 ;;
    esac
    GODOT="$RUN_DIR/editor/$(basename "$GODOT_REAL")"
    ;;
esac
: >"$RUN_DIR/editor/._sc_"
ENGINE_VERSION="$("$GODOT" --version 2>/dev/null | tail -n 1)"
# The leak gate is on for engines whose runs are clean (4.7); PKEY_TEST_LEAK_GATE=1 forces it on, 0 off. Older engines
# also report every coroutine still suspended at exit as a leaked object, and a coroutine whose RefCounted object died
# (a host, a service) never resumes: 4.5.2 still leaks in identity, connect, ui_holders_flow and the 4.6.3 ones in
# those and the cloud_sync_* and dropin suites, so the gate stays off for them (boot, ui and updater are clean).
case "${PKEY_TEST_LEAK_GATE:-auto}" in
  1) LEAK_GATE=1 ;;
  0) LEAK_GATE=0 ;;
  *) case "$ENGINE_VERSION" in 4.7*) LEAK_GATE=1 ;; *) LEAK_GATE=0 ;; esac ;;
esac

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
  local log="$LOGS/$name.log" elapsed=0 started reason="" shown=0 size
  started=$(date +%s)
  echo "── $name: $*"
  HOME="$RUN_HOME" "$@" >"$log" 2>&1 &
  local pid=$!
  while kill -0 "$pid" 2>/dev/null; do
    # Stream the log as it grows (not only after the step ends), unless STEP_LIVE=0 (parallel steps,
    # whose logs would interleave): a long step is then visible while it runs.
    if [ "${STEP_LIVE:-1}" = 1 ]; then
      size=$(wc -c <"$log" | tr -d ' ')
      if [ "$size" -gt "$shown" ]; then
        tail -c +$((shown + 1)) "$log"
        shown=$size
      fi
    fi
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
    elif [ "$kind" = run ] && [ "$LEAK_GATE" = 1 ] && grep -Eq "$LEAK" "$log"; then
      reason="the engine reported a leak at exit"
    fi
  fi
  if [ "${STEP_LIVE:-1}" = 1 ]; then
    tail -c +$((shown + 1)) "$log"
  else
    cat "$log"
  fi
  local took=$(($(date +%s) - started))
  if [ -n "$reason" ]; then
    echo "── $name: FAIL ($reason) in ${took}s; log: $log"
    grep -En "$FATAL" "$log" | head -n 5
    [ "$kind" = run ] && [ "$LEAK_GATE" = 1 ] && grep -En "$LEAK" "$log" | head -n 5
    return 1
  fi
  echo "── $name: ok in ${took}s"
  return 0
}

EXTRA=("$@")
# launch_editor / launch_template <selection>: one suite process (exec: the step's watchdog kills Godot itself).
launch_editor() { exec "$GODOT" --headless --path "$PROJECT" -- --pkey-test "$1" ${EXTRA[@]+"${EXTRA[@]}"}; }
launch_template() { exec "$BUILD/pkey_conformance.x86_64" --headless -- --pkey-test "$1" ${EXTRA[@]+"${EXTRA[@]}"}; }

# run_selection <step> <launcher>: the selection as one process, or, for `ci` with PKEY_TEST_PARALLEL=1,
# as the four disjoint sets ci_p1..ci_p4 in parallel processes (a hosted runner has 4 vCPUs). Each
# process has its own log ($name-p<i>.log), HOME (user://, editor settings) and TMPDIR; every suite uses
# loopback ports bound on port 0 and writes only under user://, so the processes share nothing but the
# read-only project, the corpus and the editor copy. The step fails when any process fails.
run_selection() {
  local name="$1" launcher="$2"
  if [ "${PKEY_TEST_PARALLEL:-0}" = 1 ] && [ "$SUITES" = ci ]; then
    local pids="" g failed=0 pid
    for g in 1 2 3 4; do
      (
        STEP_LIVE=0
        RUN_HOME="$RUN_DIR/home-$name-p$g"
        export TMPDIR="$RUN_DIR/tmp-$name-p$g"
        mkdir -p "$RUN_HOME" "$TMPDIR"
        local sel="ci_p$g"
        [ "$g" = 4 ] && [ "$name" = editor ] && [ "${PKEY_TEST_DEV_LIVE:-0}" = 1 ] && sel="$sel,dev_live"
        step "$name-p$g" run "$launcher" "$sel"
      ) &
      pids="$pids $!"
    done
    for pid in $pids; do wait "$pid" || failed=1; done
    [ "$failed" -eq 0 ]
  else
    step "$name" run "$launcher" "$SUITES"
  fi
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
if part editor; then
  run_selection editor launch_editor || exit 1
fi

# 3b. The UI resolution matrix (tests/ui/matrix.gd): every drop-in screen laid out at every size,
# look and locale, in the editor, as a step of its own so the editor step keeps its budget. It
# grew with the matrix (UK-11, ui-matrix v3): on a slow runner it can exceed 900 s, so it gets its own
# limit, PKEY_UI_MATRIX_TIMEOUT (default 1800 s), and the shared PKEY_TEST_TIMEOUT stays as it was.
# Layout is the same engine code on a release template, so it runs once.
if part matrix && { [ "$SUITES" = ci ] || [ "${PKEY_TEST_MATRIX:-0}" = 1 ]; }; then
  # PKEY_UI_MATRIX_PATHS=both runs it once per presentation path (UI-KITS.md DL16): the scrim
  # (PKEY_UI_REDUCE_TRANSPARENCY=0, the see-through glass card) and the opaque page (=1). The engines
  # disagree on which one a headless run takes by default (4.4.1 the scrim, 4.7 on macOS the opaque
  # page, GODOT-441b), so the newest lane asks for both. Unset: one run, the engine's own path.
  case "${PKEY_UI_MATRIX_PATHS:-auto}" in
    both) MATRIX_PATHS="0 1" ;;
    0 | 1) MATRIX_PATHS="$PKEY_UI_MATRIX_PATHS" ;;
    auto) MATRIX_PATHS="auto" ;;
    *)
      echo "run_tests: PKEY_UI_MATRIX_PATHS=$PKEY_UI_MATRIX_PATHS is not both, 0, 1 or auto" >&2
      exit 2
      ;;
  esac
  # PKEY_UI_MATRIX_SHARDS=<n> splits the cases of each path into n deterministic shares
  # (`--pkey-shard <i>/<n>`, tests/suite_ui_matrix.gd), and every share of every path runs as its own
  # PARALLEL process (a hosted runner has 4 vCPUs): default n = 4 / paths (4, or 2 for `both`), 1 =
  # today's single process per path. Each process has its own log (build/logs/ui-matrix-<i>.log, or
  # ui-matrix-rt<path>-<i>.log), its own HOME (the suites share `user://` scratch files) and the same
  # per-step limit; the step fails when any of them fails or times out. The shards are checked
  # against an unsharded `--pkey-list` dry run: together they must run exactly the listed cases,
  # each once, per path.
  case "$MATRIX_PATHS" in "0 1") NPATHS=2 ;; *) NPATHS=1 ;; esac
  SHARDS="${PKEY_UI_MATRIX_SHARDS:-$((4 / NPATHS))}"
  case "$SHARDS" in
    '' | *[!0-9]* | 0)
      echo "run_tests: PKEY_UI_MATRIX_SHARDS=$SHARDS is not a positive number" >&2
      exit 2
      ;;
  esac
  # PKEY_UI_MATRIX_SHARD_RANGE=lo-hi: this run executes shards lo..hi of the SHARDS (default: all).
  SHARD_LO=0
  SHARD_HI=$((SHARDS - 1))
  if [ -n "${PKEY_UI_MATRIX_SHARD_RANGE:-}" ]; then
    SHARD_LO="${PKEY_UI_MATRIX_SHARD_RANGE%-*}"
    SHARD_HI="${PKEY_UI_MATRIX_SHARD_RANGE#*-}"
    case "$SHARD_LO$SHARD_HI" in
      '' | *[!0-9]*)
        echo "run_tests: PKEY_UI_MATRIX_SHARD_RANGE=$PKEY_UI_MATRIX_SHARD_RANGE is not <lo>-<hi>" >&2
        exit 2
        ;;
    esac
    if [ "$SHARD_LO" -gt "$SHARD_HI" ] || [ "$SHARD_HI" -ge "$SHARDS" ]; then
      echo "run_tests: PKEY_UI_MATRIX_SHARD_RANGE=$PKEY_UI_MATRIX_SHARD_RANGE is outside the $SHARDS shards" >&2
      exit 2
    fi
  fi
  if [ "$SHARDS" -gt 1 ]; then
    (
      TIMEOUT="${PKEY_UI_MATRIX_TIMEOUT:-1800}"
      step ui-matrix-list plain "$GODOT" --headless --path "$PROJECT" -- --pkey-test ui_matrix --pkey-shard "0/$SHARDS" --pkey-list
    ) || exit 1
    sed -n 's/^PKEY-MATRIX-CASE //p' "$LOGS/ui-matrix-list.log" | sort >"$LOGS/ui-matrix-cases.txt"
    if [ ! -s "$LOGS/ui-matrix-cases.txt" ]; then
      echo "── ui-matrix: FAIL (--pkey-list printed no cases)"
      exit 1
    fi
    # The cases this run owns: those of its shards (the whole list when it runs every shard).
    sed -n 's/^PKEY-MATRIX-OWNER //p' "$LOGS/ui-matrix-list.log" |
      awk -v lo="$SHARD_LO" -v hi="$SHARD_HI" '$1 >= lo && $1 <= hi { sub(/^[0-9]+ /, ""); print }' |
      sort >"$LOGS/ui-matrix-owned.txt"
    if [ ! -s "$LOGS/ui-matrix-owned.txt" ]; then
      echo "── ui-matrix: FAIL (shards $SHARD_LO-$SHARD_HI own no case)"
      exit 1
    fi
  fi
  pids=""
  for path in $MATRIX_PATHS; do
    MNAME="ui-matrix$([ "$path" = auto ] || echo "-rt$path")"
    i="$SHARD_LO"
    while [ "$i" -le "$SHARD_HI" ]; do
      (
        STEP_LIVE=0
        TIMEOUT="${PKEY_UI_MATRIX_TIMEOUT:-1800}"
        if [ "$path" != auto ]; then
          export PKEY_UI_REDUCE_TRANSPARENCY="$path"
        fi
        if [ "$SHARDS" -le 1 ]; then
          step "$MNAME" run "$GODOT" --headless --path "$PROJECT" -- --pkey-test ui_matrix
        else
          RUN_HOME="$RUN_DIR/home-$MNAME-$i"
          mkdir -p "$RUN_HOME"
          step "$MNAME-$i" run "$GODOT" --headless --path "$PROJECT" -- --pkey-test ui_matrix --pkey-shard "$i/$SHARDS"
        fi
      ) &
      pids="$pids $!"
      i=$((i + 1))
    done
  done
  shard_failed=0
  for pid in $pids; do
    wait "$pid" || shard_failed=1
  done
  [ "$shard_failed" -eq 0 ] || exit 1
  if [ "$SHARDS" -gt 1 ]; then
    for path in $MATRIX_PATHS; do
      MNAME="ui-matrix$([ "$path" = auto ] || echo "-rt$path")"
      : >"$LOGS/$MNAME-ran.unsorted"
      i="$SHARD_LO"
      while [ "$i" -le "$SHARD_HI" ]; do
        sed -n 's/^PKEY-MATRIX-RAN //p' "$LOGS/$MNAME-$i.log" >>"$LOGS/$MNAME-ran.unsorted"
        i=$((i + 1))
      done
      sort "$LOGS/$MNAME-ran.unsorted" >"$LOGS/$MNAME-ran.txt"
      if ! cmp -s "$LOGS/ui-matrix-owned.txt" "$LOGS/$MNAME-ran.txt"; then
        echo "── $MNAME: FAIL (shards $SHARD_LO-$SHARD_HI of $SHARDS did not run exactly their $(wc -l <"$LOGS/ui-matrix-owned.txt" | tr -d ' ') listed cases once each)"
        diff "$LOGS/ui-matrix-owned.txt" "$LOGS/$MNAME-ran.txt" | head -n 20
        exit 1
      fi
      echo "── $MNAME: ok, shards $SHARD_LO-$SHARD_HI of $SHARDS ran their $(wc -l <"$LOGS/ui-matrix-owned.txt" | tr -d ' ') of the $(wc -l <"$LOGS/ui-matrix-cases.txt" | tr -d ' ') listed cases once each"
    done
  fi
fi

# 3c. The PNG baselines (tests/suite_ui_png.gd): the screens drawn and compared with the committed
# PNGs, windowed (a headless run has no renderer), as a step of its own. Off by default: CI's Linux
# jobs run headless, and the baselines were recorded on macOS arm64 with Godot 4.7.2 (record Linux
# ones before turning it on there). PKEY_TEST_PNG=1 compares, PKEY_TEST_PNG_UPDATE=1 records.
if [ "${PKEY_TEST_PNG:-0}" = 1 ] || [ "${PKEY_TEST_PNG_UPDATE:-0}" = 1 ]; then
  (
    TIMEOUT="${PKEY_UI_MATRIX_TIMEOUT:-1800}"
    UPD=""
    [ "${PKEY_TEST_PNG_UPDATE:-0}" = 1 ] && UPD="update"
    step ui-png run "$GODOT" --path "$PROJECT" -- --pkey-test ui_png $UPD
  ) || exit 1
fi

# 4. The build stamp (P1-11): the export plugin end to end, headless, as CI exports a game.
STAMP_ENV="PKEY_BUILD_OUTLET=steam PKEY_BUILD_CHANNEL=beta PKEY_BUILD_NUMBER=42"
STAMPS="$BUILD/stamps"
if part editor && [ "$PART" != editor-b ] && { [ "$SUITES" = ci ] || [ "$SUITES" = ci_a ] || [ "${PKEY_TEST_STAMPS:-0}" = 1 ]; }; then
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
if part template && [ -n "${GODOT_TEMPLATE:-}" ]; then
  # shellcheck disable=SC2086
  step export plain env -u PKEY_OUTLET_IDS $STAMP_ENV "$GODOT" --headless --path "$PROJECT" \
    --export-pack "Conformance (Linux)" "$BUILD/pkey_conformance.pck" || exit 1
  cp "$GODOT_TEMPLATE" "$BUILD/pkey_conformance.x86_64"
  chmod +x "$BUILD/pkey_conformance.x86_64"
  run_selection template launch_template || exit 1
fi

echo "── run_tests: all steps green in $(($(date +%s) - T0))s"
