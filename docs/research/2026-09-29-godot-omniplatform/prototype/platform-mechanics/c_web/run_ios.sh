#!/bin/bash
# S-05 (c) on the iOS Simulator's Safari: first visit, second visit (same Safari process) and a
# Safari relaunch, for each mode and pack count; one report per load arrives at server.mjs
# (../out/c/reports.jsonl, rows with run=ios_*). usage: [MODES="idb mem cache"] run_ios.sh <udid>
# Needs `node server.mjs` running. Clears Safari's website data once at the start so the first
# idb visit really starts empty. `simctl openurl` (not `simctl launch <url>`, which Safari ignores
# once it is running) is what navigates.
UDID=$1; B=http://localhost:8765
cnt() { curl -s $B/_reports | python3 -c 'import json,sys;print(len(json.load(sys.stdin)))'; }
wait_report() { local n0=$1 i; for i in $(seq 1 180); do [ "$(cnt)" -gt "$n0" ] && return 0; sleep 1; done; echo "timeout"; }
xcrun simctl terminate "$UDID" com.apple.mobilesafari 2>/dev/null
DATA=$(xcrun simctl get_app_container "$UDID" com.apple.mobilesafari data 2>/dev/null)
[ -n "$DATA" ] && rm -rf "$DATA/Library/WebKit/WebsiteData" "$DATA/Library/Caches/WebKit" "$DATA/Library/Caches/com.apple.mobilesafari"
for mode in ${MODES:-idb mem}; do for n in 1 3 6; do
  for run in first reload restart; do
    [ $run = restart ] && { xcrun simctl terminate "$UDID" com.apple.mobilesafari; sleep 2; }
    c=$(cnt)
    t0=$(python3 -c 'import time;print(time.time())')
    xcrun simctl openurl "$UDID" "$B/?mode=$mode&n=$n&run=ios_${run}&chunk=4194304&t=$RANDOM"
    wait_report "$c"
    echo "$mode $n $run wall_s=$(python3 -c "import time;print(round(time.time()-$t0,1))")"
  done
done; done
