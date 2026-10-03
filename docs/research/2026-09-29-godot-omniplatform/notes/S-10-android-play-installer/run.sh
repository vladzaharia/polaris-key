#!/bin/bash
# S-10 harness: push a plan, launch the probe, wait for result_<case>.json, pull it to results/.
# usage: run.sh <pkg> <case> '<steps-json-array>' [timeout_s]
# Env: DEV (default emulator-5610), NOSTOP=1 to leave the app running.
set -euo pipefail
W=$(cd "$(dirname "$0")" && pwd)
ADB=$HOME/Library/Android/sdk/platform-tools/adb
DEV=${DEV:-127.0.0.1:5611}
export ANDROID_ADB_SERVER_PORT=${ANDROID_ADB_SERVER_PORT:-5099}
PKG=$1; CASE=$2; STEPS=$3; TMO=${4:-60}
A() { "$ADB" -s "$DEV" "$@"; }
# Other agents restart the adb server; our emulator port is outside the default scan range.
A get-state >/dev/null 2>&1 || "$ADB" connect "$DEV" >/dev/null
EXT=/sdcard/Android/data/$PKG/files
mkdir -p "$W/results"
printf '{"case":"%s","steps":%s}' "$CASE" "$STEPS" > "$W/results/plan_$CASE.json"
A shell mkdir -p $EXT
A push "$W/results/plan_$CASE.json" $EXT/plan.json >/dev/null
A shell rm -f $EXT/result_$CASE.json
A shell am force-stop $PKG
A logcat -c || true
A shell am start -W -n $PKG/com.godot.game.GodotAppLauncher > "$W/results/am_$CASE.txt"
for _ in $(seq 1 $((TMO * 2))); do
  if A shell "grep -q done $EXT/result_$CASE.json 2>/dev/null && echo y" | grep -q y; then break; fi
  sleep 0.5
done
sleep 0.3
A logcat -d -s S10:* godot:* > "$W/results/logcat_$CASE.txt" || true
A pull $EXT/result_$CASE.json "$W/results/result_$CASE.json" >/dev/null 2>&1 || { echo "no result for $CASE"; tail -20 "$W/results/logcat_$CASE.txt"; exit 1; }
[ -n "${NOSTOP:-}" ] || A shell am force-stop $PKG
python3 -c 'import json,sys; r=json.load(open(sys.argv[1])); print(json.dumps(r)[:6000])' "$W/results/result_$CASE.json"
