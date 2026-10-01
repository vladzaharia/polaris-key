#!/usr/bin/env bash
# Install the probe the way a user does from a website: Chrome on the emulator downloads the APK
# from a host HTTP server (adb reverse), the download is opened, and the system Package Installer
# installs it. uiautomator taps through Chrome's download prompt and the installer.
#   SERIAL=emulator-5558 ./chrome-download.sh
# Result: ../out/android/variants/chrome-download.{dumpsys,probe}.txt
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
OUT="$HERE/../out/android"
V="$OUT/variants"
PORT=8765
ADB=("${ANDROID_HOME:-$HOME/Library/Android/sdk}/platform-tools/adb" -s "${SERIAL:?set SERIAL}")
mkdir -p "$V"
(cd "$OUT" && python3 -m http.server "$PORT" --bind 127.0.0.1 >/dev/null 2>&1) &
SRV=$!
trap 'kill $SRV 2>/dev/null || true' EXIT
"${ADB[@]}" uninstall com.godot.game >/dev/null 2>&1 || true
"${ADB[@]}" shell 'rm -f /sdcard/Download/outletprobe*.apk' || true
"${ADB[@]}" reverse "tcp:$PORT" "tcp:$PORT" >/dev/null
"${ADB[@]}" shell appops set com.android.chrome REQUEST_INSTALL_PACKAGES allow
"${ADB[@]}" shell am force-stop com.android.chrome
"${ADB[@]}" shell am start -a android.intent.action.VIEW -d "http://127.0.0.1:$PORT/outletprobe.apk" com.android.chrome >/dev/null || true

# Tap the first visible node whose text or content-desc matches; print the label tapped.
tap_any() { # <regex of labels>
	"${ADB[@]}" shell uiautomator dump /sdcard/ui.xml >/dev/null 2>&1 || return 1
	local node
	node=$("${ADB[@]}" shell cat /sdcard/ui.xml | tr '>' '\n' | grep -E "(text|content-desc)=\"($1)\"" | head -1 || true)
	[ -n "$node" ] || return 1
	read -r x1 y1 x2 y2 < <(echo "$node" | sed -E 's/.*bounds="\[([0-9]+),([0-9]+)\]\[([0-9]+),([0-9]+)\]".*/\1 \2 \3 \4/')
	"${ADB[@]}" shell input tap $(((x1 + x2) / 2)) $(((y1 + y2) / 2))
	echo "tapped: $1"
}
# 1. Chrome first run and the download prompt, until the file lands in Download/.
for _ in $(seq 1 30); do
	sleep 3
	"${ADB[@]}" shell ls /sdcard/Download/ | grep -q outletprobe && break
	tap_any 'Use without an account|No thanks|Accept & continue|Got it|Download|Download anyway|Keep' || true
done
# 2. Open it from Chrome's own Downloads page, so Chrome is the originating package (the "Open"
#    snackbar is transient and was missed in the first run), then the installer's Install button.
sleep 2
tap_any 'Customize and control Google Chrome|Update available. More options' && sleep 2 && tap_any 'Downloads' && sleep 3
tap_any 'outletprobe[^"]*apk' || true
for _ in $(seq 1 20); do
	sleep 3
	"${ADB[@]}" shell pm path com.godot.game >/dev/null 2>&1 && break
	tap_any 'Install|Update|Settings|Allow from this source' || true
done
"${ADB[@]}" shell pm path com.godot.game >/dev/null 2>&1 || { echo "install did not complete" >&2; exit 1; }
"${ADB[@]}" shell dumpsys package com.godot.game |
	grep -E 'installerPackageName|initiatingPackageName|originatingPackageName|installerPackageUid|packageSource|updateOwner' | tee "$V/chrome-download.dumpsys.txt"
"${ADB[@]}" logcat -c
"${ADB[@]}" shell monkey -p com.godot.game -c android.intent.category.LAUNCHER 1 >/dev/null 2>&1
for _ in $(seq 1 60); do
	sleep 2
	"${ADB[@]}" logcat -d -s godot | grep -a -o 'OUTLET_PROBE_JSON .*' | head -1 >"$V/chrome-download.probe.txt" || true
	[ -s "$V/chrome-download.probe.txt" ] && break
done
"${ADB[@]}" shell am force-stop com.godot.game || true
cut -c1-460 "$V/chrome-download.probe.txt"
