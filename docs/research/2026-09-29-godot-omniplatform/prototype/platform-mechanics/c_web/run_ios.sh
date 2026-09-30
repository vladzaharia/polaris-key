#!/bin/bash
# S-05 (c) on the iOS Simulator's Safari: first visit, second visit (same Safari process) and a
# Safari relaunch, for each mode and pack count; one report per load arrives at server.mjs
# (../out/c/reports.jsonl, rows with run=ios_*). usage: [MODES="idb mem cache"] run_ios.sh <udid>
# Needs `node server.mjs` running. Before the first visit of every mode and pack count it quits
# Safari and erases its website data and caches, so each "first" visit starts with an empty IDBFS
# and an empty HTTP cache (CLEAR=once restores the old behaviour: erase only at the start, which
# lets later series boot with the earlier series' files in user://). Every URL carries
# batch=$BATCH so the rows of one run can be told apart in reports.jsonl. `simctl openurl` (not
# `simctl launch <url>`, which Safari ignores once it is running) is what navigates.
UDID=$1; B=http://localhost:8765; BATCH=${BATCH:-$(date +%Y%m%d%H%M)}
cnt() { curl -s $B/_reports | python3 -c 'import json,sys;print(len(json.load(sys.stdin)))'; }
wait_report() { local n0=$1 i; for i in $(seq 1 180); do [ "$(cnt)" -gt "$n0" ] && return 0; sleep 1; done; echo "timeout"; }
clear_safari() {
  xcrun simctl terminate "$UDID" com.apple.mobilesafari 2>/dev/null; sleep 1
  local DATA; DATA=$(xcrun simctl get_app_container "$UDID" com.apple.mobilesafari data 2>/dev/null)
  [ -n "$DATA" ] && rm -rf "$DATA/Library/WebKit/WebsiteData" "$DATA/Library/Caches/WebKit" "$DATA/Library/Caches/com.apple.mobilesafari"
}
clear_safari
for mode in ${MODES:-idb mem}; do for n in 1 3 6; do
  [ "${CLEAR:-each}" = each ] && clear_safari
  for run in first reload restart; do
    [ $run = restart ] && { xcrun simctl terminate "$UDID" com.apple.mobilesafari; sleep 2; }
    c=$(cnt)
    t0=$(python3 -c 'import time;print(time.time())')
    xcrun simctl openurl "$UDID" "$B/?mode=$mode&n=$n&run=ios_${run}&chunk=4194304&batch=$BATCH&t=$RANDOM"
    wait_report "$c"
    echo "$mode $n $run wall_s=$(python3 -c "import time;print(round(time.time()-$t0,1))")"
  done
done; done
