#!/usr/bin/env bash
# Regenerates the P2b-05 build-metadata fixtures: a tiny signed APK, a tiny IPA, and the TEST-ONLY
# keystore that signs the APK (and, in buildMetadata.test.ts, an F-Droid entry.jar). Nothing here
# is a real app or a real key: the keystore's passwords are in this file on purpose.
#
# Needs: a JDK (keytool; Android Studio's bundled JBR works), the Android SDK (build-tools with
# aapt2, zipalign and apksigner; a platform's android.jar), python3, and on macOS clang, codesign
# and plutil. The committed outputs are what the tests read; CI never runs this script.
# Re-running it mints a NEW test key: update KEY_SHA256 in test/buildMetadata.test.ts and
# test/feeds.test.ts to the fingerprint it prints.
set -euo pipefail
cd "$(dirname "$0")"

SDK="${ANDROID_HOME:-$HOME/Library/Android/sdk}"
BT="$SDK/build-tools/$(ls "$SDK/build-tools" | sort -V | tail -1)"
PLATFORM="$SDK/platforms/$(ls "$SDK/platforms" | sort -V | tail -1)"
export JAVA_HOME="${JAVA_HOME:-/Applications/Android Studio.app/Contents/jbr/Contents/Home}"
export PATH="$JAVA_HOME/bin:$PATH"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

# ── The test keystore ───────────────────────────────────────────────────────────────────────
rm -f test.keystore
keytool -genkeypair -keystore test.keystore -storetype PKCS12 -storepass testpass \
  -alias pkey -keyalg RSA -keysize 2048 -validity 36500 \
  -dname "CN=Polaris Key test fixture" >/dev/null 2>&1

# ── tiny.apk ────────────────────────────────────────────────────────────────────────────────
cat > "$WORK/AndroidManifest.xml" <<'XML'
<?xml version="1.0" encoding="utf-8"?>
<manifest xmlns:android="http://schemas.android.com/apk/res/android"
    package="gg.vlad.diceroll"
    android:versionCode="10203"
    android:versionName="1.2.3">
  <uses-sdk android:minSdkVersion="24" android:targetSdkVersion="35" />
  <application android:label="Diceroll" android:hasCode="false" />
</manifest>
XML
"$BT/aapt2" link -I "$PLATFORM/android.jar" --manifest "$WORK/AndroidManifest.xml" \
  -o "$WORK/unsigned.apk"
python3 - "$WORK/unsigned.apk" <<'PY'
import sys, zipfile
with zipfile.ZipFile(sys.argv[1], "a", zipfile.ZIP_DEFLATED) as z:
    for abi in ("arm64-v8a", "armeabi-v7a"):
        z.writestr(f"lib/{abi}/libdiceroll.so", b"\x7fELF fixture " + abi.encode())
PY
"$BT/zipalign" -f -p 4 "$WORK/unsigned.apk" "$WORK/aligned.apk"
"$BT/apksigner" sign --ks test.keystore --ks-pass pass:testpass --ks-key-alias pkey \
  --min-sdk-version 24 --out tiny.apk "$WORK/aligned.apk"
rm -f tiny.apk.idsig

# ── tiny.ipa ────────────────────────────────────────────────────────────────────────────────
APP="$WORK/Payload/Diceroll.app"
mkdir -p "$APP/PlugIns/Widget.appex"
printf 'int main(void){return 0;}\n' > "$WORK/main.c"
clang -Os -o "$APP/Diceroll" "$WORK/main.c"
clang -Os -o "$APP/PlugIns/Widget.appex/Widget" "$WORK/main.c"
cat > "$WORK/app.entitlements" <<'XML'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>application-identifier</key><string>ABCDE12345.gg.vlad.diceroll</string>
  <key>com.apple.developer.team-identifier</key><string>ABCDE12345</string>
  <key>com.apple.developer.game-center</key><true/>
  <key>get-task-allow</key><true/>
</dict>
</plist>
XML
cat > "$WORK/widget.entitlements" <<'XML'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>com.apple.security.application-groups</key>
  <array><string>group.gg.vlad.diceroll</string></array>
</dict>
</plist>
XML
codesign -s - -f --entitlements "$WORK/app.entitlements" "$APP/Diceroll" 2>/dev/null
codesign -s - -f --entitlements "$WORK/widget.entitlements" \
  "$APP/PlugIns/Widget.appex/Widget" 2>/dev/null
cat > "$APP/Info.plist" <<'XML'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleIdentifier</key><string>gg.vlad.diceroll</string>
  <key>CFBundleExecutable</key><string>Diceroll</string>
  <key>CFBundleShortVersionString</key><string>1.2.3</string>
  <key>CFBundleVersion</key><string>10203</string>
  <key>MinimumOSVersion</key><string>16.0</string>
  <key>NSCameraUsageDescription</key><string>Scan a friend&apos;s dice code.</string>
  <key>NSMicrophoneUsageDescription</key><string>Shout at your dice — “roll!”</string>
</dict>
</plist>
XML
plutil -convert binary1 "$APP/Info.plist"
cat > "$APP/PlugIns/Widget.appex/Info.plist" <<'XML'
<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0">
<dict>
  <key>CFBundleIdentifier</key><string>gg.vlad.diceroll.widget</string>
  <key>CFBundleExecutable</key><string>Widget</string>
</dict>
</plist>
XML
rm -f tiny.ipa
(cd "$WORK" && zip -qr -X "$OLDPWD/tiny.ipa" Payload)

# ── signed-entry.jar: an F-Droid entry.jar signed the way `pkey feeds fdroid` signs one (v1) ──
python3 - "$WORK/entry.jar" <<'PY'
import sys, zipfile
with zipfile.ZipFile(sys.argv[1], "w", zipfile.ZIP_STORED) as z:
    z.writestr("entry.json", '{"timestamp":1}')
PY
PKEY_FDROID_KS_PASS=testpass "$BT/apksigner" sign --min-sdk-version 23 \
  --v1-signing-enabled true --v2-signing-enabled false --v3-signing-enabled false \
  --v4-signing-enabled false --ks test.keystore --ks-key-alias pkey \
  --ks-pass env:PKEY_FDROID_KS_PASS --out signed-entry.jar "$WORK/entry.jar"

echo "keystore sha256 (cert): $(keytool -list -v -keystore test.keystore -storepass testpass -alias pkey | awk '/SHA256:/{print $2}' | tr -d : | tr 'A-F' 'a-f')"
