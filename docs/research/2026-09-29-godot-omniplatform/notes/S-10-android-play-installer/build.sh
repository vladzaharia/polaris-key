#!/bin/bash
# S-10: export the probe with Godot 4.7.2's Gradle build and the PKeyS10 v2 plugin.
# usage: build.sh <play|direct> <versionCode> [key=s10] [omit_silent=false] [tag]
# Needs (README): a self-contained Godot 4.7.2 editor whose settings point at a JDK and the
# Android SDK (GODOT), bundletool 1.18.3 (BUNDLETOOL), mise with java@temurin-21, and the
# AARs from plugin/ (./gradlew :plugin:assembleRelease). Throwaway keystores are generated.
#   play   -> AAB with two extra PAD packs (s10ff fast-follow, s10od on-demand), then
#             bundletool build-apks --local-testing (out/<tag>.apks)
#   direct -> APK (out/<tag>.apk)
set -euo pipefail
W=$(cd "$(dirname "$0")" && pwd)
FLAVOR=$1; VC=$2; KEY=${3:-s10}; OMIT=${4:-false}; TAG=${5:-$FLAVOR-v$VC-$KEY}
GODOT=${GODOT:-$W/editor/Godot.app/Contents/MacOS/Godot}
BUNDLETOOL=${BUNDLETOOL:-$W/bundletool-all-1.18.3.jar}
TPL="$HOME/Library/Application Support/Godot/export_templates/4.7.2.stable"
GEN=${GEN_PACKS:-$W/../../prototype/platform-mechanics/tools/gen_packs.py}
export JAVA_HOME=$(mise where java@temurin-21)
export ANDROID_HOME=$HOME/Library/Android/sdk
B=$W/build/$TAG; OUT=$W/out; mkdir -p "$OUT" "$W/logs" "$W/keys"
for k in s10 s10other; do # throwaway signing keys, never reused
  [ -f "$W/keys/$k.keystore" ] || "$JAVA_HOME/bin/keytool" -genkeypair -keystore "$W/keys/$k.keystore" -alias $k \
    -storepass s10test -keypass s10test -keyalg RSA -keysize 2048 -validity 3650 -dname "CN=S10 throwaway $k" >/dev/null 2>&1
done
/bin/rm -rf "$B"; mkdir -p "$B"
cp -R "$W/game/." "$B/"
mkdir -p "$B/addons/pkey_s10/bin"
cp "$W/plugin/plugin/build/outputs/aar/plugin-play-release.aar" "$B/addons/pkey_s10/bin/pkey-s10-play-release.aar"
cp "$W/plugin/plugin/build/outputs/aar/plugin-direct-release.aar" "$B/addons/pkey_s10/bin/pkey-s10-direct-release.aar"
# What "Install Android Build Template" does.
mkdir -p "$B/android/build"
(cd "$B/android/build" && unzip -q "$TPL/android_source.zip")
echo "4.7.2.stable" > "$B/android/.build_version"
touch "$B/android/build/.gdignore"
if [ "$FLAVOR" = play ]; then
  PKG=org.polariskey.s10; FORMAT=1
  for spec in "s10ff:fast-follow:5000000" "s10od:on-demand:20000000"; do
    IFS=: read -r n mode size <<<"$spec"
    mkdir -p "$B/android/build/$n/src/main/assets"
    printf "plugins {\n    id 'com.android.asset-pack'\n}\n\nassetPack {\n    packName = \"%s\"\n    dynamicDelivery {\n        deliveryType = \"%s\"\n    }\n}\n" "$n" "$mode" > "$B/android/build/$n/build.gradle"
    python3 "$GEN" "$B/android/build/$n/src/main/assets/$n.pck" "$size" 64 "data/$n" >/dev/null
    echo "include ':$n'" >> "$B/android/build/settings.gradle"
  done
  sed -i '' 's|assetPacks = \[":assetPackInstallTime"\]|assetPacks = [":assetPackInstallTime", ":s10ff", ":s10od"]|' "$B/android/build/build.gradle"
else
  PKG=org.polariskey.s10d; FORMAT=0
fi
sed -e "s|@FORMAT@|$FORMAT|" -e "s|@KEYSTORE@|$W/keys/$KEY.keystore|" -e "s|@ALIAS@|$KEY|" -e "s|@VC@|$VC|g" \
  -e "s|@PKG@|$PKG|" -e "s|@FLAVOR@|$FLAVOR|" -e "s|@OMIT@|$OMIT|" "$W/export_presets.cfg.in" > "$B/export_presets.cfg"
"$GODOT" --headless --path "$B" --import > "$W/logs/import_$TAG.txt" 2>&1 || true
EXT=$([ "$FLAVOR" = play ] && echo aab || echo apk)
T0=$(date +%s)
"$GODOT" --headless --path "$B" --export-release Android "$OUT/$TAG.$EXT" > "$W/logs/export_$TAG.txt" 2>&1 || { tail -40 "$W/logs/export_$TAG.txt"; exit 1; }
echo "export_seconds=$(( $(date +%s) - T0 ))"
ls -l "$OUT/$TAG.$EXT"
grep -h "PKeyS10 export" "$W/logs/export_$TAG.txt" || true
if [ "$FLAVOR" = play ]; then
  "$JAVA_HOME/bin/java" -jar "$BUNDLETOOL" build-apks --local-testing --overwrite \
    --bundle "$OUT/$TAG.aab" --output "$OUT/$TAG.apks" \
    --ks "$W/keys/$KEY.keystore" --ks-key-alias "$KEY" --ks-pass pass:s10test --key-pass pass:s10test
  ls -l "$OUT/$TAG.apks"
fi
