#!/usr/bin/env bash
# Export the outlet probe with official Godot 4.7 release templates, into a scratch copy of the
# prototype project so the shared export_presets.cfg stays untouched.
#   ./export.sh macos     -> out/macos/OutletProbe.app          (ad-hoc signed by Godot's built-in signer)
#   ./export.sh linux     -> out/linux/outletprobe.x86_64 (+ .pck); LINUX_ARCH=arm64 for arm64
#   ./export.sh windows   -> out/windows/outletprobe.exe (+ .pck)
#   ./export.sh android   -> out/android/outletprobe.apk        (needs java_sdk_path in editor settings)
#   ./export.sh pack      -> out/android/probe.zip              (used by ../android/assemble-apk.sh)
# Needs: godot 4.7.x on PATH with matching export templates; for android, ANDROID_HOME and a JDK 17+
# (JAVA_HOME). Run the result with `<binary> --headless -- outlet`.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
PROTO="$(cd "$HERE/../.." && pwd)"
OUT="$HERE/../out"
TARGET="${1:?usage: export.sh macos|linux|windows|android|pack}"
WORK="$OUT/project"
mkdir -p "$OUT/$TARGET"
rsync -a --delete --exclude .godot --exclude build --exclude 'outlet-signals/out' "$PROTO/" "$WORK/"

cat >"$WORK/export_presets.cfg" <<EOF
[preset.0]
name="macOS"
platform="macOS"
runnable=true
export_filter="all_resources"
include_filter="*.json"
exclude_filter=""
custom_features=""
export_path=""
[preset.0.options]
binary_format/architecture="universal"
application/bundle_identifier="org.example.pkey.outletprobe"
application/short_version="1.0"
application/version="1"
codesign/codesign=1
notarization/notarization=0

[preset.1]
name="Linux"
platform="Linux"
runnable=true
export_filter="all_resources"
include_filter="*.json"
exclude_filter=""
custom_features=""
export_path=""
[preset.1.options]
binary_format/embed_pck=false
binary_format/architecture="${LINUX_ARCH:-x86_64}"

[preset.2]
name="Windows"
platform="Windows Desktop"
runnable=true
export_filter="all_resources"
include_filter="*.json"
exclude_filter=""
custom_features=""
export_path=""
[preset.2.options]
binary_format/embed_pck=false
binary_format/architecture="x86_64"
codesign/enable=false
application/modify_resources=false

[preset.3]
name="Android"
platform="Android"
runnable=true
export_filter="all_resources"
include_filter="*.json"
exclude_filter=""
custom_features=""
export_path=""
[preset.3.options]
gradle_build/use_gradle_build=false
architectures/arm64-v8a=true
architectures/x86_64=true
package/unique_name="org.example.pkey.outletprobe"
package/name="OutletProbe"
version/code=1
version/name="1.0"
EOF

cd "$WORK"
printf '\n[rendering]\n\ntextures/vram_compression/import_etc2_astc=true\n' >>project.godot
godot --headless --path . --import >/dev/null 2>&1 || true
case "$TARGET" in
macos) godot --headless --path . --export-release macOS "$OUT/macos/OutletProbe.zip" ;;
linux) godot --headless --path . --export-release Linux "$OUT/linux/outletprobe.x86_64" ;;
windows) godot --headless --path . --export-release Windows "$OUT/windows/outletprobe.exe" ;;
pack) mkdir -p "$OUT/android" && godot --headless --path . --export-pack Android "$OUT/android/probe.zip" ;;
android)
	KS="$OUT/android/debug.keystore"
	[ -f "$KS" ] || "$JAVA_HOME/bin/keytool" -genkeypair -keystore "$KS" -storepass android -alias androiddebugkey \
		-keypass android -keyalg RSA -keysize 2048 -validity 3650 -dname "CN=Android Debug,O=Android,C=US" >/dev/null
	GODOT_ANDROID_KEYSTORE_DEBUG_PATH="$KS" GODOT_ANDROID_KEYSTORE_DEBUG_USER=androiddebugkey \
		GODOT_ANDROID_KEYSTORE_DEBUG_PASSWORD=android \
		godot --headless --path . --export-debug Android "$OUT/android/outletprobe.apk"
	;;
esac
if [ "$TARGET" = macos ]; then
	(cd "$OUT/macos" && rm -rf OutletProbe.app && ditto -x -k OutletProbe.zip . && mv pkey-ed25519-lab.app OutletProbe.app && ls)
fi
echo "exported $TARGET to $OUT/$TARGET"
