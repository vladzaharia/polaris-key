#!/bin/bash
# S-05 (a): export the probe as a signed release APK with the official 4.7.2 template.
# Generates a throwaway local keystore (git-ignored) on first use. Env: GODOT, JAVA_HOME
# (default: Android Studio's bundled JBR), ANDROID_HOME (default ~/Library/Android/sdk), OUT_APK.
set -e
cd "$(dirname "$0")"
GODOT=${GODOT:-$(../tools/editor_sc.sh)}
export JAVA_HOME=${JAVA_HOME:-"/Applications/Android Studio.app/Contents/jbr/Contents/Home"}
export ANDROID_HOME=${ANDROID_HOME:-$HOME/Library/Android/sdk}
export PATH="$JAVA_HOME/bin:$PATH"
OUT=$(cd .. && pwd)/out/a; mkdir -p "$OUT" ../logs
KS="$OUT/s05-throwaway.keystore"
[ -f "$KS" ] || keytool -genkeypair -keystore "$KS" -alias s05 -storepass s05test -keypass s05test \
  -keyalg RSA -keysize 2048 -validity 3650 -dname "CN=S05 throwaway test key" >/dev/null 2>&1
sed "s|@KEYSTORE@|$KS|" export_presets.cfg.in > probe/export_presets.cfg
"$GODOT" --headless --path probe --import > ../logs/a_import.txt 2>&1 || true
APK=${OUT_APK:-$OUT/s05stall.apk}
"$GODOT" --headless --path probe --export-release Android "$APK" > ../logs/a_export.txt 2>&1 || { tail -20 ../logs/a_export.txt; exit 1; }
ls -l "$APK"
