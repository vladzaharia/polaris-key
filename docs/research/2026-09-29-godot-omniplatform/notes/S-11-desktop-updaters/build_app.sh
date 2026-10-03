#!/bin/bash
# usage: build_app.sh <short_version> <build> <codesign: 0|1|2|post> <outdir> [ats:yes|no] [pubkey:yes|no]
#   codesign 0 = Godot "Disabled", 1 = Godot built-in, 2 = Godot Xcode codesign with identity "-",
#   post = Godot Disabled then `codesign --force --deep -s -` afterwards.
set -e
cd "$(dirname "$0")"
V=$1; B=$2; CS=$3; OUT=$4; ATS=${5:-yes}; PUB=${6:-yes}
FEED=${FEED:-http://127.0.0.1:8711/sparkle/appcast.xml}
PK=$(cat keys/ed_pub.b64)
PLIST="<key>SUFeedURL</key><string>$FEED</string><key>SUEnableAutomaticChecks</key><false/>"
[ "$PUB" = yes ] && PLIST="$PLIST<key>SUPublicEDKey</key><string>$PK</string>"
[ "$ATS" = yes ] && PLIST="$PLIST<key>NSAppTransportSecurity</key><dict><key>NSAllowsLocalNetworking</key><true/></dict>"
SBX=""
if [ "${SANDBOX:-no}" = yes ]; then
  PLIST="$PLIST<key>SUEnableInstallerLauncherService</key><true/>"
  SBX=$(printf 'codesign/entitlements/app_sandbox/enabled=true\ncodesign/entitlements/app_sandbox/network_client=true\ncodesign/entitlements/additional="<key>com.apple.security.temporary-exception.mach-lookup.global-name</key><array><string>org.polariskey.s11sparkle-spks</string><string>org.polariskey.s11sparkle-spki</string></array>"')
fi
GCS=$CS; [ "$CS" = post ] && GCS=0
mkdir -p "$OUT"; OUT=$(cd "$OUT" && pwd)
sed -i '' "s/^config\/version=.*/config\/version=\"$V\"/" game/project.godot
/bin/cat > game/export_presets.cfg <<P
[preset.0]

name="macOS"
platform="macOS"
runnable=true
dedicated_server=false
custom_features=""
export_filter="all_resources"
include_filter=""
exclude_filter=""
export_path=""
patches=PackedStringArray()
encryption_include_filters=""
encryption_exclude_filters=""
seed=0
encrypt_pck=false
encrypt_directory=false
script_export_mode=2

[preset.0.options]

binary_format/architecture="universal"
application/bundle_identifier="org.polariskey.s11sparkle"
application/short_version="$V"
application/version="$B"
application/additional_plist_content="$PLIST"
codesign/codesign=$GCS
codesign/identity="-"
codesign/entitlements/disable_library_validation=true
notarization/notarization=0
$SBX
P
rm -rf "$OUT/S11Sparkle.app"
godot --headless --path game --export-release macOS "$OUT/S11Sparkle.app" > "$OUT/export.log" 2>&1 || { tail -30 "$OUT/export.log"; exit 1; }
if [ "${FIXX:-yes}" = yes ]; then
  B="$OUT/S11Sparkle.app/Contents/Frameworks/Sparkle.framework/Versions/B"
  chmod +x "$B/Sparkle" "$B/Autoupdate" "$B/Updater.app/Contents/MacOS/Updater" "$B/XPCServices/Downloader.xpc/Contents/MacOS/Downloader" "$B/XPCServices/Installer.xpc/Contents/MacOS/Installer"
fi
if [ "$CS" = post ]; then codesign --force --deep -s - "$OUT/S11Sparkle.app"; fi
echo "== $OUT"; ls "$OUT/S11Sparkle.app/Contents" "$OUT/S11Sparkle.app/Contents/Frameworks" 2>&1
/usr/libexec/PlistBuddy -c "Print :CFBundleVersion" -c "Print :SUPublicEDKey" "$OUT/S11Sparkle.app/Contents/Info.plist" 2>&1
codesign -dv "$OUT/S11Sparkle.app" 2>&1 | grep -E "Signature|flags|Identifier|TeamIdentifier" || true
codesign --verify --deep --strict "$OUT/S11Sparkle.app" 2>&1 && echo "verify: ok" || echo "verify: FAIL"
