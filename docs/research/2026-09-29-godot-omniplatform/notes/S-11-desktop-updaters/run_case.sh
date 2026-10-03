#!/bin/bash
# usage: run_case.sh <case-name> <variant> <mode headless|standard> [feed-variant] [timeout_s]
# Installs out/<variant>-v1 to install/<case>/, writes run/config.json, launches it with `open`,
# waits until a process reports CFBundleVersion 2 (target) or the timeout, and prints the logs.
cd "$(dirname "$0")"
CASE=$1; VAR=$2; MODE=$3; FEEDVAR=${4:-$2}; TO=${5:-90}
I=$PWD/install/$CASE; L=$PWD/logs/$CASE.log
rm -rf "$I" "$L" "$L.gd"; mkdir -p "$I" logs run
ditto out/$VAR-v1/S11Sparkle.app "$I/S11Sparkle.app"
defaults delete org.polariskey.s11sparkle >/dev/null 2>&1
rm -rf ~/Library/Caches/org.polariskey.s11sparkle ~/Library/Application\ Support/org.polariskey.s11sparkle 2>/dev/null
/bin/cat > run/config.json <<J
{"mode":"$MODE","feed":"http://127.0.0.1:8711/$FEEDVAR/appcast.xml","log":"$L","channels":[],"headers":{"Authorization":"Bearer s11-test-token"},
 "quit_after_s": $TO, "target_version":"2" ${EXTRA:-}}
J
touch srv.log; MARK=$(wc -l < srv.log)
T0=$(python3 -c 'import time;print(time.time())')
open -n "$I/S11Sparkle.app"
for i in $(seq 1 $((TO*2))); do
  sleep 0.5
  if grep -q '"target_reached_or_idle"' "$L.gd" 2>/dev/null; then break; fi
done
T1=$(python3 -c 'import time;print(time.time())')
sleep 2
echo "== case $CASE elapsed $(python3 -c "print(round($T1-$T0,2))") s"
echo "-- installed bundle now:"; /usr/libexec/PlistBuddy -c "Print :CFBundleVersion" "$I/S11Sparkle.app/Contents/Info.plist"
codesign --verify --deep --strict "$I/S11Sparkle.app" 2>&1 && echo "installed codesign verify: ok"
echo "-- gd log:"; cat "$L.gd" 2>/dev/null | cut -c1-400
echo "-- native log:"; cat "$L" 2>/dev/null | cut -c1-400
echo "-- http:"; tail -n +$((MARK+1)) srv.log | cut -c1-300
pkill -f "install/$CASE/S11Sparkle.app" 2>/dev/null; true
