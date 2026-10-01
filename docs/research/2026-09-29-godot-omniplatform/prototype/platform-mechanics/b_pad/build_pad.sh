#!/bin/bash
# S-05 (b): build the a_stall probe as an AAB with Godot's Gradle build, two extra asset packs
# (s05ondemand = on-demand, s05fastfollow = fast-follow) and the S05Pad Java plugin
# (com.google.android.play:asset-delivery:2.3.0), then bundletool build-apks --local-testing and
# install-apks. Works on a copy under ../tpl/b/ so the committed probe stays untouched.
# Env: DEV (default emulator-5556), JAVA_HOME (default Android Studio JBR), BUNDLETOOL jar.
set -e
cd "$(dirname "$0")"
HERE=$(pwd); PM=$(cd .. && pwd)
DEV=${DEV:-emulator-5556}
export JAVA_HOME=${JAVA_HOME:-"/Applications/Android Studio.app/Contents/jbr/Contents/Home"}
export ANDROID_HOME=${ANDROID_HOME:-$HOME/Library/Android/sdk}
export PATH="$JAVA_HOME/bin:$ANDROID_HOME/platform-tools:$PATH"
GODOT=${GODOT:-$("$PM/tools/editor_sc.sh")}
BT=${BUNDLETOOL:-$PM/tpl/bundletool/bundletool-all-1.18.3.jar}
TPL="$HOME/Library/Application Support/Godot/export_templates/4.7.2.stable"
W=$PM/tpl/b/probe; OUT=$PM/out/b; mkdir -p "$OUT" "$PM/logs"
KS=$PM/out/a/s05-throwaway.keystore
[ -f "$KS" ] || keytool -genkeypair -keystore "$KS" -alias s05 -storepass s05test -keypass s05test -keyalg RSA -keysize 2048 -validity 3650 -dname "CN=S05 throwaway test key" >/dev/null 2>&1
rm -rf "$W"; mkdir -p "$W"
cp "$PM/a_stall/probe/project.godot" "$PM/a_stall/probe/probe.gd" "$PM/a_stall/probe/probe.tscn" "$W/"
mkdir -p "$W/packs"
python3 "$PM/tools/gen_packs.py" "$W/packs/p5_many.pck" 5000000 320 >/dev/null   # install-time (Godot's own asset pack)
# Gradle build template (what "Install Android Build Template" does) + overlay.
mkdir -p "$W/android/build"
( cd "$W/android/build" && unzip -q "$TPL/android_source.zip" )
echo "4.7.2.stable" > "$W/android/.build_version"
touch "$W/android/build/.gdignore"
cp -R overlay/src/. "$W/android/build/src/"
for n in s05ondemand s05fastfollow; do
  mkdir -p "$W/android/build/$n/src/main/assets"
  cp overlay/$n/build.gradle "$W/android/build/$n/"
  python3 "$PM/tools/gen_packs.py" "$W/android/build/$n/src/main/assets/$n.pck" 5000000 320 "data/$n" >/dev/null
  echo "include ':$n'" >> "$W/android/build/settings.gradle"
done
python3 - "$W/android/build" <<'PY'
import sys, re
b = sys.argv[1]
g = open(b + "/build.gradle").read()
g = g.replace('assetPacks = [":assetPackInstallTime"]', 'assetPacks = [":assetPackInstallTime", ":s05ondemand", ":s05fastfollow"]')
g = g.replace('dependencies {\n', 'dependencies {\n    implementation "com.google.android.play:asset-delivery:2.3.0"\n', 1)
open(b + "/build.gradle", "w").write(g)
m = open(b + "/src/main/AndroidManifest.xml").read()
m = m.replace("    </application>", '        <meta-data android:name="org.godotengine.plugin.v2.S05Pad" android:value="org.polariskey.s05.S05Pad" />\n    </application>')
open(b + "/src/main/AndroidManifest.xml", "w").write(m)
PY
sed -e "s|@KEYSTORE@|$KS|" -e 's|gradle_build/use_gradle_build=false|gradle_build/use_gradle_build=true|' \
  -e 's|gradle_build/export_format=0|gradle_build/export_format=1|' -e 's|org.polariskey.s05stall|org.polariskey.s05pad|' \
  -e 's|include_filter="packs/\*.pck,filler/\*.txt"|include_filter="packs/*.pck"|' "$PM/a_stall/export_presets.cfg.in" > "$W/export_presets.cfg"
sed -i '' 's/^config\/name="s05stall"/config\/name="s05pad"/' "$W/project.godot"
sed -i '' 's/^const PKG := "org.polariskey.s05stall"/const PKG := "org.polariskey.s05pad"/' "$W/probe.gd"
"$GODOT" --headless --path "$W" --import > "$PM/logs/b_import.txt" 2>&1 || true
"$GODOT" --headless --path "$W" --export-release Android "$OUT/s05pad.aab" > "$PM/logs/b_export.txt" 2>&1 || { tail -30 "$PM/logs/b_export.txt"; exit 1; }
ls -l "$OUT/s05pad.aab"
java -jar "$BT" build-apks --local-testing --overwrite --bundle "$OUT/s05pad.aab" --output "$OUT/s05pad.apks" \
  --ks "$KS" --ks-key-alias s05 --ks-pass pass:s05test --key-pass pass:s05test
java -jar "$BT" install-apks --apks "$OUT/s05pad.apks" --device-id "$DEV" --adb "$ANDROID_HOME/platform-tools/adb"
