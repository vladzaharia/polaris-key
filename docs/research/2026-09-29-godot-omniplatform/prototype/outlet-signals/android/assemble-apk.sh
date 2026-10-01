#!/usr/bin/env bash
# Build the Godot outlet probe APK without the editor's Android exporter (which needs a Java path in
# the global editor settings): export the project as a ZIP pack, drop its files into the official
# android_debug.apk template's assets/, then zipalign and sign with a throwaway debug key.
# The package name stays the template's `com.godot.game`.
# Needs: godot 4.7.x + templates on PATH, ANDROID_HOME, JAVA_HOME (JDK 17+).
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
OUT="$HERE/../out/android"
BT="$(ls -d "$ANDROID_HOME"/build-tools/* | sort -V | tail -1)"
TPL="$HOME/Library/Application Support/Godot/export_templates/4.7.2.stable/android_debug.apk"
[ -f "$TPL" ] || TPL="${GODOT_TEMPLATES:?set GODOT_TEMPLATES to the 4.7.2 templates dir}/android_debug.apk"
mkdir -p "$OUT"
"$HERE/../godot/export.sh" pack
rm -rf "$OUT/stage" && mkdir -p "$OUT/stage/assets"
(cd "$OUT/stage/assets" && unzip -q "$OUT/probe.zip")
# assets/_cl_ is the command line Godot's Android activity reads at start (int32 count, then
# int32 length + UTF-8 per argument, little endian), so the runner starts the outlet suite.
python3 -c "
import struct,sys
args=[b'--', b'outlet']
sys.stdout.buffer.write(struct.pack('<i',len(args))+b''.join(struct.pack('<i',len(a))+a for a in args))" >"$OUT/stage/assets/_cl_"
cp "$TPL" "$OUT/unsigned.apk"
# arm64 only: the universal template is ~127 MB, which makes adb pushes slow on a loaded host.
zip -q -d "$OUT/unsigned.apk" 'lib/armeabi-v7a/*' 'lib/x86/*' 'lib/x86_64/*' || true
(cd "$OUT/stage" && zip -q -r "$OUT/unsigned.apk" assets)
"$BT/zipalign" -f -p 4 "$OUT/unsigned.apk" "$OUT/aligned.apk"
KS="$OUT/debug.keystore"
[ -f "$KS" ] || "$JAVA_HOME/bin/keytool" -genkeypair -keystore "$KS" -storepass android -alias androiddebugkey \
	-keypass android -keyalg RSA -keysize 2048 -validity 3650 -dname "CN=Android Debug,O=Android,C=US" >/dev/null
PATH="$JAVA_HOME/bin:$PATH" "$BT/apksigner" sign --ks "$KS" --ks-pass pass:android --key-pass pass:android \
	--out "$OUT/outletprobe.apk" "$OUT/aligned.apk"
echo "built $OUT/outletprobe.apk"
