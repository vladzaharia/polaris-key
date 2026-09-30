#!/usr/bin/env bash
# Install the probe through the system Package Installer UI (the path a browser download or a file
# manager takes): VIEW intent on a MediaStore Downloads URI, then tap "Install" via uiautomator.
#   SERIAL=emulator-5558 ./system-installer.sh [referrer-url]
# With a referrer the intent carries EXTRA_REFERRER, as a browser download does, which AOSP's
# installer maps to PACKAGE_SOURCE_DOWNLOADED_FILE; without one it uses PACKAGE_SOURCE_LOCAL_FILE.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
V="$HERE/../out/android/variants"
ADB=("${ANDROID_HOME:-$HOME/Library/Android/sdk}/platform-tools/adb" -s "${SERIAL:?set SERIAL}")
LABEL=system-installer-view${1:+-referrer}
mkdir -p "$V"
"${ADB[@]}" uninstall com.godot.game >/dev/null 2>&1 || true
"${ADB[@]}" push "$HERE/../out/android/outletprobe.apk" /sdcard/Download/outletprobe.apk >/dev/null
ID=""
for _ in $(seq 1 20); do # adb push does not index the file; ask MediaStore to rescan until it shows up
	"${ADB[@]}" shell content call --uri content://media/external/file --method scan_volume --arg external_primary >/dev/null 2>&1 || true
	ID=$("${ADB[@]}" shell content query --uri content://media/external/downloads --projection _id:_display_name |
		grep outletprobe.apk | head -1 | sed -E 's/.*_id=([0-9]+).*/\1/' || true)
	[ -n "$ID" ] && break
	sleep 3
done
[ -n "$ID" ] || { echo "MediaStore never indexed the APK" >&2; exit 1; }
EXTRA=()
[ -n "${1:-}" ] && EXTRA=(--eu android.intent.extra.REFERRER "$1")
"${ADB[@]}" shell am start -a android.intent.action.VIEW -t application/vnd.android.package-archive \
	-d "content://media/external/downloads/$ID" --grant-read-uri-permission "${EXTRA[@]}" >/dev/null || true
for _ in $(seq 1 40); do
	sleep 3
	"${ADB[@]}" shell uiautomator dump /sdcard/ui.xml >/dev/null 2>&1 || continue
	B=$("${ADB[@]}" shell cat /sdcard/ui.xml | grep -o -E 'text="(Install|Wait)"[^>]*bounds="\[[0-9]+,[0-9]+\]\[[0-9]+,[0-9]+\]"' | head -1 || true)
	[ -n "$B" ] || continue
	read -r x1 y1 x2 y2 < <(echo "$B" | sed -E 's/.*bounds="\[([0-9]+),([0-9]+)\]\[([0-9]+),([0-9]+)\]".*/\1 \2 \3 \4/')
	"${ADB[@]}" shell input tap $(((x1 + x2) / 2)) $(((y1 + y2) / 2))
	echo "$B" | grep -q 'text="Install"' && break
done
for _ in $(seq 1 40); do sleep 3; "${ADB[@]}" shell pm path com.godot.game >/dev/null 2>&1 && break; done
"${ADB[@]}" shell dumpsys package com.godot.game |
	grep -E 'installerPackageName|initiatingPackageName|originatingPackageName|installerPackageUid|packageSource|updateOwner' | tee "$V/$LABEL.dumpsys.txt"
"${ADB[@]}" logcat -c
"${ADB[@]}" shell monkey -p com.godot.game -c android.intent.category.LAUNCHER 1 >/dev/null 2>&1
for _ in $(seq 1 60); do
	sleep 2
	"${ADB[@]}" logcat -d -s godot | grep -a -o 'OUTLET_PROBE_JSON .*' | head -1 >"$V/$LABEL.probe.txt" || true
	[ -s "$V/$LABEL.probe.txt" ] && break
done
cut -c1-460 "$V/$LABEL.probe.txt"
