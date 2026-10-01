#!/usr/bin/env bash
# Install the Godot probe APK several ways on an emulator or device and record, for each, what
# `dumpsys package` reports and what the probe itself reads from GDScript (AndroidRuntime +
# JavaClassWrapper -> PackageManager.getInstallSourceInfo).
#   SERIAL=emulator-5558 ./run-variants.sh [variant...]
# Variants: adb (plain adb install), adb-i-play / adb-i-fdroid / adb-i-obtainium (adb install -i
# <installer>: the installer of record is whatever the caller claims), session (pm install-create
# / install-write / install-commit), update-owner (adb install --update-ownership -i <play>).
# Results go to ../out/android/variants/<variant>.{dumpsys,probe}.txt
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
OUT="$HERE/../out/android"
APK="$OUT/outletprobe.apk"
PKG=com.godot.game
ADB=("${ANDROID_HOME:-$HOME/Library/Android/sdk}/platform-tools/adb" -s "${SERIAL:?set SERIAL}")
mkdir -p "$OUT/variants"
VARIANTS=("$@")
[ ${#VARIANTS[@]} -gt 0 ] || VARIANTS=(adb adb-i-play adb-i-fdroid adb-i-obtainium session update-owner)

probe() { # <variant>
	"${ADB[@]}" logcat -c
	"${ADB[@]}" shell monkey -p "$PKG" -c android.intent.category.LAUNCHER 1 >/dev/null 2>&1
	for _ in $(seq 1 60); do
		sleep 2
		if "${ADB[@]}" logcat -d -s godot | grep -a OUTLET_PROBE_JSON >/dev/null; then break; fi
	done
	"${ADB[@]}" logcat -d -s godot | grep -a -o 'OUTLET_PROBE_JSON .*' | head -1 >"$OUT/variants/$1.probe.txt" || true
	"${ADB[@]}" shell am force-stop "$PKG" || true
}

dump() { # <variant>
	"${ADB[@]}" shell dumpsys package "$PKG" |
		grep -E 'installerPackageName|initiatingPackageName|originatingPackageName|installerPackageUid|packageSource|updateOwner|installInitiatingPackageName|installerAttributionTag|installSource' \
			>"$OUT/variants/$1.dumpsys.txt" || true
}

for v in "${VARIANTS[@]}"; do
	echo "== $v"
	"${ADB[@]}" uninstall "$PKG" >/dev/null 2>&1 || true
	case "$v" in
	adb) "${ADB[@]}" install --no-incremental "$APK" ;;
	adb-i-play) "${ADB[@]}" install --no-incremental -i com.android.vending "$APK" ;;
	adb-i-fdroid) "${ADB[@]}" install --no-incremental -i org.fdroid.fdroid "$APK" ;;
	adb-i-obtainium) "${ADB[@]}" install --no-incremental -i dev.imranr.obtainium "$APK" ;;
	update-owner) "${ADB[@]}" install --no-incremental --update-ownership -i com.android.vending "$APK" ;;
	session)
		SIZE=$(stat -f %z "$APK" 2>/dev/null || stat -c %s "$APK")
		"${ADB[@]}" push "$APK" /data/local/tmp/probe.apk >/dev/null
		SID=$("${ADB[@]}" shell pm install-create -S "$SIZE" | sed -E 's/.*\[([0-9]+)\].*/\1/')
		"${ADB[@]}" shell pm install-write -S "$SIZE" "$SID" base /data/local/tmp/probe.apk >/dev/null
		"${ADB[@]}" shell pm install-commit "$SID"
		;;
	*) echo "unknown variant $v" && exit 2 ;;
	esac
	dump "$v"
	probe "$v"
	cat "$OUT/variants/$v.dumpsys.txt"
	python3 -c "import json,sys;t=open(sys.argv[1]).read().split(' ',1);print(json.dumps(json.loads(t[1])['android']) if len(t)>1 else 'no probe output')" "$OUT/variants/$v.probe.txt"
done
