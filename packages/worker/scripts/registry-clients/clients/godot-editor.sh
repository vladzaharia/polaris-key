#!/usr/bin/env bash
# F-09's manual editor check, automated: install the fixture addon from the feed in a REAL Godot
# editor of each shape, headless, by driving the editor's own AssetLib UI (godot-editor/ is the
# project whose editor plugin presses the buttons a person presses; see its plugin.gd).
#
#   GODOT_EDITOR_46=/path/to/Godot  (4.4 to 4.6: asset_library/available_urls, the Asset Library API)
#   GODOT_EDITOR_47=/path/to/Godot  (4.7+: asset_store/available_urls, the Asset Store API)
#
# Each editor runs against a fresh HOME (its settings live there, so your own are untouched). 4.6
# runs twice: with the installer's default "Ignore asset root" (the archive's first folder is
# stripped, so addons/smoke_addon lands at res://smoke_addon) and unticked (res://addons/smoke_addon,
# which then enables as a plugin). 4.7's installer has no such option and installs at
# res://addons/smoke_addon, which then enables. Skipped with a notice when neither variable is set, unless
# REQUIRE_GODOT_EDITORS is set. Not part of CI's matrix (no editor there).
set -euo pipefail

: "${REGISTRY:?REGISTRY is the registry host origin}"
: "${OWNER:?OWNER is the fixture owner}"
HERE="$(cd "$(dirname "$0")" && pwd)"
fail=0
ran=0
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

run_editor() { # <label> <binary> <setting key> <url> <ignore_root>
  local label="$1" bin="$2" key="$3" url="$4" ignore="$5"
  local home="$tmp/home-$label-$ignore" proj="$tmp/project-$label-$ignore" log="$tmp/log-$label-$ignore"
  mkdir -p "$home/Library/Application Support/Godot" "$home/.config/godot" "$proj"
  cp -R "$HERE/godot-editor/." "$proj/"
  local ver
  ver="$("$bin" --version | cut -d. -f1-2)"
  for dir in "$home/Library/Application Support/Godot" "$home/.config/godot"; do
    printf '[gd_resource type="EditorSettings" format=3]\n\n[resource]\n%s = { "Polaris Key": "%s" }\n' \
      "$key" "$url" >"$dir/editor_settings-$ver.tres"
  done
  # A hung editor must not hang the run: a watchdog kills it after 120 s.
  HOME="$home" XDG_CONFIG_HOME="$home/.config" PKEY_ADDON=smoke_addon PKEY_TITLE="Smoke Addon" \
    PKEY_EXPECT_VERSION=1.1.0 PKEY_IGNORE_ROOT="$ignore" \
    "$bin" --headless --editor --path "$proj" >"$log" 2>&1 &
  local pid=$!
  (sleep 120 && kill -9 "$pid" 2>/dev/null) &
  local dog=$!
  local rc=0
  wait "$pid" || rc=$?
  kill "$dog" 2>/dev/null || true
  grep -E '^(STEP|RESULT)' "$log" | sed "s/^/  [$label ignore_root=$ignore] /"
  ran=1
  if [ "$rc" = 0 ] && grep -q '^RESULT ok' "$log"; then
    echo "ok   $label: installed from the feed through the editor UI (ignore_root=$ignore)"
  else
    grep -E 'ERROR|SCRIPT' "$log" | head -10 || true
    echo "FAIL $label (ignore_root=$ignore, exit $rc)"
    fail=1
  fi
}

if [ -n "${GODOT_EDITOR_46:-}" ]; then
  for ignore in 1 0; do
    run_editor "4.6" "$GODOT_EDITOR_46" "asset_library/available_urls" "$REGISTRY/godot/$OWNER/asset-library/api" "$ignore"
  done
fi
if [ -n "${GODOT_EDITOR_47:-}" ]; then # 4.7's installer has no "Ignore asset root" option
  run_editor "4.7" "$GODOT_EDITOR_47" "asset_store/available_urls" "$REGISTRY/godot/$OWNER/store/api/v1" 1
fi

if [ "$ran" = 0 ]; then
  if [ -n "${REQUIRE_GODOT_EDITORS:-}" ]; then
    echo "FAIL no editor: set GODOT_EDITOR_46 and/or GODOT_EDITOR_47"
    exit 1
  fi
  echo "skip godot-editor: set GODOT_EDITOR_46 / GODOT_EDITOR_47 to a Godot binary to run it"
fi
exit "$fail"
