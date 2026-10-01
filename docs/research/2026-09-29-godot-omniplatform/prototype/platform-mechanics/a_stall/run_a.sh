#!/bin/bash
# S-05 (a) harness: install the probe APK on a device/emulator and run mount cases.
# usage: run_a.sh install            -> adb install -r out/a/s05stall.apk (OUT_APK to override)
#        run_a.sh case <name> <cold|warm> '<plan-json-without-case>'
#        run_a.sh matrix               -> the S-05 matrix (see below)
# Env: DEV (adb serial, default emulator-5556), ADB.
set -e
cd "$(dirname "$0")"
ADB=${ADB:-$HOME/Library/Android/sdk/platform-tools/adb}
DEV=${DEV:-emulator-5556}
PKG=${PKG:-org.polariskey.s05stall}
EXT=/sdcard/Android/data/$PKG/files
OUT=$(cd .. && pwd)/out/a; mkdir -p "$OUT"
A() { "$ADB" -s "$DEV" "$@"; }

run_case() { # name cold|warm plan-json-fragment
  local name=$1 temp=$2 frag=$3
  local plan="{\"case\":\"$name\",$frag}"
  echo "$plan" > "$OUT/plan.json"
  A shell mkdir -p $EXT >/dev/null
  A push "$OUT/plan.json" $EXT/plan.json >/dev/null
  A shell rm -f $EXT/result_$name.json
  A shell am force-stop $PKG
  if [ "$temp" = cold ]; then A shell "sync; echo 3 > /proc/sys/vm/drop_caches"; sleep 1; fi
  A logcat -c || true
  local t0=$(python3 -c 'import time; print(time.time())')
  A shell am start -W -n $PKG/com.godot.game.GodotApp > "$OUT/am_$name.txt"
  for i in $(seq 1 240); do
    if A shell "[ -f $EXT/result_$name.json ] && echo y" | grep -q y; then break; fi
    sleep 0.5
  done
  sleep 0.5
  A pull $EXT/result_$name.json "$OUT/result_${name}_$temp.json" >/dev/null 2>&1 || { echo "no result for $name"; A logcat -d | grep -i -E "godot|S05A" | tail -20; return 1; }
  local tt=$(grep TotalTime "$OUT/am_$name.txt" | awk '{print $2}')
  python3 - "$OUT/result_${name}_$temp.json" "$temp" "$tt" <<'PY' | tee -a "$OUT/results.jsonl"
import json, sys
r = json.load(open(sys.argv[1])); r["temp"] = sys.argv[2]; r["am_total_ms"] = sys.argv[3]
print(json.dumps(r))
PY
  A shell am force-stop $PKG
}

case "$1" in
  install) A install -r -g --no-incremental "${OUT_APK:-$OUT/s05stall.apk}";;
  case) run_case "$2" "$3" "$4";;
  *) echo "usage: run_a.sh install|case"; exit 1;;
esac
