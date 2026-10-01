#!/usr/bin/env bash
# Cross-check the probe's `initiator_signing.apkContentsSigners_sha256` (read in GDScript through
# JavaClassWrapper and hashed with HashingContext) against apksigner: pull each named package's
# base APK from the device and print its certificate SHA-256 digest.
#   SERIAL=emulator-5558 ./signer-digest.sh com.google.android.packageinstaller com.android.vending
# Needs: ANDROID_HOME, JAVA_HOME (JDK 17+; Android Studio's jbr works). Output: out/android/signers.txt
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
OUT="$HERE/../out/android"
ADB=("${ANDROID_HOME:-$HOME/Library/Android/sdk}/platform-tools/adb" -s "${SERIAL:?set SERIAL}")
BT="$(ls -d "${ANDROID_HOME:-$HOME/Library/Android/sdk}"/build-tools/* | sort -V | tail -1)"
mkdir -p "$OUT/signers"
: >"$OUT/signers.txt"
for pkg in "$@"; do
	path=$("${ADB[@]}" shell pm path "$pkg" | head -1 | sed 's/^package://' | tr -d '\r')
	[ -n "$path" ] || { echo "$pkg not installed" | tee -a "$OUT/signers.txt"; continue; }
	"${ADB[@]}" pull "$path" "$OUT/signers/$pkg.apk" >/dev/null
	digest=$(PATH="$JAVA_HOME/bin:$PATH" "$BT/apksigner" verify --print-certs "$OUT/signers/$pkg.apk" |
		grep -m1 'certificate SHA-256 digest' | sed 's/.*: //')
	echo "$pkg $path $digest" | tee -a "$OUT/signers.txt"
done
