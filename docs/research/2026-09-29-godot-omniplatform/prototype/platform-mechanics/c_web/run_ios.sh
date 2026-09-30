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
# Memory: iOS Safari has no JS heap API, so 3 s after each report the host samples `footprint` of
# every WebContent process whose parent is this simulator's launchd_sim and appends the largest
# (the page's) to ../out/c/ios_mem.jsonl (footprint, WebKit Malloc and WebAssembly Memory, dirty
# MB). NS="0 1 3 6" adds an n=0 baseline (the probe with no packs).
UDID=$1; B=http://localhost:8765; BATCH=${BATCH:-$(date +%Y%m%d%H%M)}
MEMLOG=$(cd "$(dirname "$0")/.." && pwd)/out/c/ios_mem.jsonl
sample_mem() { # mode n run
  local lsim; lsim=$(ps -axo pid,command | awk -v u="$UDID" '$2=="launchd_sim" && index($0,u) {print $1; exit}')
  ps -axo pid,ppid,command | awk -v p="$lsim" '$2==p && /ExtensionKit\/Extensions\/WebContent/ {print $1}' |
    while read -r pid; do footprint -p "$pid" 2>/dev/null; done |
    python3 -c '
import sys, re, json
def mb(v, u): return float(v) * {"B": 1/2**20, "KB": 1/1024, "MB": 1, "GB": 1024}[u]
procs, cur = [], None
for line in sys.stdin:
    m = re.search(r"\[(\d+)\].*Footprint: ([\d.]+) (B|KB|MB|GB)", line)
    if m: cur = {"pid": int(m[1]), "footprint_mb": round(mb(m[2], m[3]), 1)}; procs.append(cur); continue
    m = re.match(r"\s*([\d.]+) (B|KB|MB|GB)\s+\S+ \S+\s+\S+ \S+\s+\d+\s+(WebKit Malloc|WebAssembly Memory)\s*$", line)
    if m and cur: cur[m[3].replace(" ", "_").lower() + "_dirty_mb"] = round(mb(m[1], m[2]), 1)
top = max(procs, key=lambda p: p["footprint_mb"]) if procs else {}
top.update(mode=sys.argv[1], n=int(sys.argv[2]), run=sys.argv[3], batch=sys.argv[4], webcontent_procs=len(procs))
print(json.dumps(top))' "$1" "$2" "$3" "$BATCH" | tee -a "$MEMLOG"
}
cnt() { curl -s $B/_reports | python3 -c 'import json,sys;print(len(json.load(sys.stdin)))'; }
wait_report() { local n0=$1 i; for i in $(seq 1 180); do [ "$(cnt)" -gt "$n0" ] && return 0; sleep 1; done; echo "timeout"; }
clear_safari() {
  xcrun simctl terminate "$UDID" com.apple.mobilesafari 2>/dev/null; sleep 1
  local DATA; DATA=$(xcrun simctl get_app_container "$UDID" com.apple.mobilesafari data 2>/dev/null)
  # iOS 26.5: Safari keeps IndexedDB and Cache Storage under Library/WebKit/com.apple.mobilesafari/
  # WebsiteData (Library/WebKit/WebsiteData is the older location, erased too).
  [ -n "$DATA" ] && rm -rf "$DATA/Library/WebKit/com.apple.mobilesafari/WebsiteData" "$DATA/Library/WebKit/WebsiteData" \
    "$DATA/Library/Caches/WebKit" "$DATA/Library/Caches/com.apple.mobilesafari" "$DATA/Library/Caches/com.apple.WebKit.Networking"
}
clear_safari
for mode in ${MODES:-idb mem}; do for n in ${NS:-1 3 6}; do
  [ "${CLEAR:-each}" = each ] && clear_safari
  for run in first reload restart; do
    [ $run = restart ] && { xcrun simctl terminate "$UDID" com.apple.mobilesafari; sleep 2; }
    c=$(cnt)
    t0=$(python3 -c 'import time;print(time.time())')
    xcrun simctl openurl "$UDID" "$B/?mode=$mode&n=$n&run=ios_${run}&chunk=4194304&batch=$BATCH&t=$RANDOM"
    wait_report "$c"
    sleep 3; sample_mem "$mode" "$n" "$run"
    echo "$mode $n $run wall_s=$(python3 -c "import time;print(round(time.time()-$t0,1))")"
  done
done; done
