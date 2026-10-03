#!/usr/bin/env bash
# smoke_install.sh <zip>: install a packaged addon into an empty project, the way an adopter does,
# and fail on anything that goes wrong (P1-12).
#
#   GODOT_BIN          the editor binary (default: `godot` on PATH; missing => exit 2)
#   PKEY_SMOKE_TIMEOUT seconds per step (default: 180)
#
# Steps, each in a fresh project under one `mktemp -d` (its own HOME and TMPDIR, so no editor
# settings, caches or other worktrees leak in):
#
#   1. unzip <zip> into the empty project (the canonical zip is rooted at addons/; the assetlib
#      zip's single wrapper directory is dropped, as the Asset Library installer does);
#   2. `--import` the project;
#   3. open the editor headless with a throwaway helper plugin that enables polaris_key the way
#      the Project Settings checkbox does (EditorInterface.set_plugin_enabled, so _enable_plugin
#      registers the autoload) and then asserts: the plugin is on, `autoload/PolarisKey` names
#      res://addons/polaris_key/polaris_key.gd (by path, or by its UID on 4.7), and the setup dock
#      is in the editor (on 4.6+, an EditorDock carrying the brand glyph as its icon);
#   4. run the project headless and assert /root/PolarisKey exists and its SDK_VERSION equals
#      plugin.cfg's version.
#
# A step fails on a non-zero exit, on its timeout, without its PKEY-SMOKE OK line, and on any
# error line in its log: `ERROR`, `SCRIPT ERROR`, `Parse Error`, `Failed to load`, `Cannot get
# class`, `WARNING` from a script (`res://`). The only lines let through are the slim-container
# fontconfig error and the editor's own headless-mode notices, listed in ALLOW below.
#
# Written for bash 3.2 (macOS /bin/bash) and without GNU `timeout`.

set -u

if [ $# -ne 1 ] || [ ! -f "$1" ]; then
  echo "usage: smoke_install.sh <polaris-key-godot-vX.Y.Z[-assetlib].zip>" >&2
  exit 2
fi
ZIP="$(cd "$(dirname "$1")" && pwd)/$(basename "$1")"
GODOT="${GODOT_BIN:-$(command -v godot || true)}"
if [ -z "$GODOT" ] || ! command -v "$GODOT" >/dev/null 2>&1; then
  echo "smoke_install: no Godot editor found; set GODOT_BIN or put godot on PATH" >&2
  exit 2
fi
TIMEOUT="${PKEY_SMOKE_TIMEOUT:-180}"
FATAL='ERROR|Parse Error|Failed to load|Cannot get class|Invalid MainLoop|WARNING:.*res://'
ALLOW='Unable to load fontconfig|fontconfig'

# The physical path: on macOS the temp directory sits behind the /var -> /private/var link, and
# the 4.7 editor then fails to create its ObjectDB snapshots directory (an empty project shows it).
ROOT="$(cd "$(mktemp -d "${TMPDIR:-/tmp}/pkey_smoke.XXXXXX")" && pwd -P)"
trap 'rm -rf "$ROOT"' EXIT
P="$ROOT/project"
LOGS="${PKEY_SMOKE_LOGS:-$ROOT/logs}"
mkdir -p "$P" "$ROOT/home" "$ROOT/tmp" "$LOGS"
export HOME="$ROOT/home" TMPDIR="$ROOT/tmp"

fail() {
  echo "smoke_install: FAIL: $*" >&2
  exit 1
}

# run <name> <expect-ok-line: 0|1> <args...>: run Godot under a watchdog; the log is the authority.
run() {
  local name="$1" want_ok="$2"
  shift 2
  local log="$LOGS/$name.log"
  "$GODOT" "$@" >"$log" 2>&1 &
  local pid=$! waited=0
  while kill -0 "$pid" 2>/dev/null; do
    if [ "$waited" -ge "$TIMEOUT" ]; then
      kill -9 "$pid" 2>/dev/null
      cat "$log" >&2
      fail "$name timed out after ${TIMEOUT}s"
    fi
    sleep 1
    waited=$((waited + 1))
  done
  wait "$pid"
  local code=$?
  local bad
  bad="$(grep -E "$FATAL" "$log" | grep -Ev "$ALLOW" || true)"
  if [ -n "$bad" ] || [ "$code" -ne 0 ] || { [ "$want_ok" = 1 ] && ! grep -q '^PKEY-SMOKE OK' "$log"; }; then
    cat "$log" >&2
    [ -n "$bad" ] && echo "smoke_install: error lines in $name:" >&2 && echo "$bad" >&2
    fail "$name (exit $code)"
  fi
  echo "smoke_install: $name ok (${waited}s)"
}

# 1. Install. A single top-level directory other than addons/ is the assetlib wrapper: drop it.
mkdir -p "$ROOT/unzip"
(cd "$ROOT/unzip" && unzip -q "$ZIP") || fail "unzip $ZIP"
top="$(ls -A "$ROOT/unzip")"
if [ "$top" != "addons" ] && [ "$(echo "$top" | wc -l | tr -d ' ')" = 1 ] && [ -d "$ROOT/unzip/$top/addons" ]; then
  mv "$ROOT/unzip/$top/addons" "$P/addons"
else
  [ "$top" = "addons" ] || fail "the zip's top level is not addons/: $top"
  mv "$ROOT/unzip/addons" "$P/addons"
fi
[ "$(ls -A "$P/addons")" = "polaris_key" ] || fail "addons/ holds more than polaris_key: $(ls -A "$P/addons")"
VERSION="$(sed -n 's/^version="\(.*\)"$/\1/p' "$P/addons/polaris_key/plugin.cfg")"
[ -n "$VERSION" ] || fail "no version in plugin.cfg"

cat >"$P/project.godot" <<'EOF'
config_version=5

[application]

config/name="Polaris Key smoke"

[editor_plugins]

enabled=PackedStringArray("res://addons/pkey_smoke/plugin.cfg")
EOF

# The throwaway helper plugin (never shipped): enable polaris_key as a user would, then check.
mkdir -p "$P/addons/pkey_smoke"
cat >"$P/addons/pkey_smoke/plugin.cfg" <<'EOF'
[plugin]

name="pkey_smoke"
description="P1-12 clean-install smoke helper"
author="Polaris Key"
version="0"
script="plugin.gd"
EOF
cat >"$P/addons/pkey_smoke/plugin.gd" <<'EOF'
@tool
extends EditorPlugin

var _frames := 0
var _phase := 0


func _enter_tree() -> void:
	set_process(true)


func _process(_delta: float) -> void:
	_frames += 1
	if _phase == 0 and _frames > 10:
		# The editor may instantiate this helper twice (4.5 after its first scan): enable once.
		if not EditorInterface.is_plugin_enabled("polaris_key"):
			EditorInterface.set_plugin_enabled("polaris_key", true)
		_phase = 1
		_frames = 0
	elif _phase == 1 and _frames > 30:
		_phase = 2
		if Engine.has_meta("pkey_smoke_done"):
			return
		Engine.set_meta("pkey_smoke_done", true)
		var problems := PackedStringArray()
		if not EditorInterface.is_plugin_enabled("polaris_key"):
			problems.append("plugin polaris_key is not enabled")
		# 4.7 records the autoload by UID, earlier engines by path; either names polaris_key.gd.
		var autoload := str(ProjectSettings.get_setting("autoload/PolarisKey", ""))
		var uid := FileAccess.get_file_as_string("res://addons/polaris_key/polaris_key.gd.uid").strip_edges()
		if autoload != "*res://addons/polaris_key/polaris_key.gd" and (uid.is_empty() or autoload != "*" + uid):
			problems.append("autoload/PolarisKey is %s (polaris_key.gd is %s)" % [autoload, uid])
		var dock := EditorInterface.get_base_control().find_child("PolarisKeySetup", true, false)
		if dock == null:
			problems.append("the setup dock PolarisKeySetup is not in the editor")
		elif ClassDB.class_exists("EditorDock") and dock.get_parent().get_class() == "EditorDock" and dock.get_parent().get("dock_icon") == null:
			problems.append("the setup dock has no brand icon")
		# The editor writes project.godot on its own schedule; save now, as closing the editor would.
		if ProjectSettings.save() != OK:
			problems.append("ProjectSettings.save() failed")
		print("PKEY-SMOKE OK" if problems.is_empty() else "PKEY-SMOKE FAIL " + "; ".join(problems))
		get_tree().quit(0 if problems.is_empty() else 1)
EOF

cat >"$P/smoke_runtime.gd" <<EOF
extends SceneTree

var _frames := 0


func _process(_delta: float) -> bool:
	_frames += 1
	if _frames < 3:
		return false
	var pk := root.get_node_or_null("PolarisKey")
	var version := ""
	if pk != null:
		version = str(pk.get_script().get_script_constant_map().get("SDK_VERSION", ""))
	if pk != null and version == "$VERSION":
		print("PKEY-SMOKE OK PolarisKey SDK_VERSION=%s" % version)
	else:
		print("PKEY-SMOKE FAIL PolarisKey=%s SDK_VERSION=%s, plugin.cfg says $VERSION" % [pk, version])
		quit(1)
	return true
EOF

echo "smoke_install: $(basename "$ZIP") on $("$GODOT" --version 2>/dev/null | tail -1)"
# 2. Import (a fresh project imports twice on some engines: the first pass writes .uid files).
run import 0 --headless --editor --import --path "$P"
# 3. Enable the plugin in the editor.
run enable 1 --headless --editor --path "$P"
SCRIPT_UID="$(tr -d '[:space:]' <"$P/addons/polaris_key/polaris_key.gd.uid")"
grep -Eq "^PolarisKey=\"\\*(res://addons/polaris_key/polaris_key.gd|$SCRIPT_UID)\"" "$P/project.godot" ||
  { cat "$P/project.godot" >&2; fail "enabling the plugin did not write the PolarisKey autoload to project.godot"; }
# 4. Run the project with the autoload.
run runtime 1 --headless --path "$P" --script res://smoke_runtime.gd
echo "smoke_install: OK ($VERSION)"
