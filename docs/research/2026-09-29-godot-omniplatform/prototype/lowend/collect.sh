#!/bin/bash
# Pulls one wrapper run's results into results/<name>.json.
# usage: ./collect.sh android <name> [adb serial]     reassembles the S04CHUNK lines from logcat
#        ./collect.sh ios-sim <name> [device udid]    copies Documents/.. user://results.json from the app container
#        ./collect.sh ios-device <name> <udid>        same, from a physical iPhone (devicectl; needs a signed build)
#        ./collect.sh macos <name>                    copies ~/Library/Application Support/Godot/app_userdata/...
# Web results arrive by POST at the browser server (browser/server.mjs writes results/<tag>-*.json).
# Records the host load average next to the results, because timings on a shared host are only
# as good as its idle time.
set -euo pipefail
L=$(cd "$(dirname "$0")" && pwd)
KIND=$1
NAME=$2
OUT=$L/results/$NAME.json
mkdir -p "$L/results"
PKG=org.polariskey.s04lowend
case "$KIND" in
  android)
    ADB="${ADB:-adb}"
    [ -n "${3:-}" ] && ADB="$ADB -s $3"
    $ADB logcat -d -s godot:I | sed -n 's/.*S04CHUNK \([0-9]*\)\/\([0-9]*\) \(.*\)$/\1 \2 \3/p' > "$OUT.chunks"
    python3 - "$OUT.chunks" "$OUT" <<'PY'
import sys, json
rows = [l.rstrip("\n").split(" ", 2) for l in open(sys.argv[1])]
if not rows: sys.exit("no S04CHUNK lines in logcat: has the run finished?")
n = int(rows[-1][1])
last = {}
for i, tot, body in rows:
    if int(tot) == n: last[int(i)] = body
missing = [i for i in range(n) if i not in last]
if missing: sys.exit(f"missing chunks {missing}")
doc = json.loads("".join(last[i] for i in range(n)))
json.dump(doc, open(sys.argv[2], "w"))
PY
    rm -f "$OUT.chunks"
    ;;
  ios-sim)
    DEV=${3:-booted}
    C=$(xcrun simctl get_app_container "$DEV" "$PKG" data)
    cp "$C/Documents/results.json" "$OUT" 2>/dev/null || cp "$(find "$C" -name results.json | head -1)" "$OUT"
    ;;
  ios-device)
    xcrun devicectl device copy from --device "$3" --domain-type appDataContainer --domain-identifier "$PKG" \
      --source Documents/results.json --destination "$OUT"
    ;;
  macos)
    cp "$HOME/Library/Application Support/Godot/app_userdata/pkey-s04-lowend/results.json" "$OUT"
    ;;
  *) echo "unknown kind $KIND" >&2; exit 2 ;;
esac
python3 - "$OUT" "$(uptime)" <<'PY'
import sys, json
d = json.load(open(sys.argv[1])); d.setdefault("host", {})["uptime_at_collect"] = sys.argv[2]
json.dump(d, open(sys.argv[1], "w"))
PY
echo "wrote $OUT: $(python3 -c "import json,sys; print(json.load(open(sys.argv[1]))['correctness']['summary'])" "$OUT")"
