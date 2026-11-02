#!/usr/bin/env bash
# export_check.sh: exports a throwaway Godot project carrying the Polaris Key addon with two iOS
# presets, runs the post-export step on both, and checks the result (P5-05 acceptance):
#
#   "iOS (store)"     outlet app-store, polaris_key/apple_background_assets=auto
#                     → the Xcode project has the PKBADownloader extension target, the App Group
#                       on both targets and the three BA* Info.plist keys; a second patch run
#                       changes nothing
#   "iOS (sideload)"  outlet altstore, auto
#                     → no extension target, no App Group, no BA* keys
#
# Sign in with Apple (I-48.4b): the store preset sets polaris_key/apple_sign_in=true and carries the
# com.apple.developer.applesignin entitlement; the sideload preset leaves it off (the default) and
# carries none.
#
# Game Center (I-48.6b): the store preset sets polaris_key/game_center=true and carries the
# com.apple.developer.game-center entitlement; the sideload preset leaves it off (the default) and
# carries none. The opt-in extension is exported exactly when pkey_gamecenter.xcframework is installed
# in the addon (EXTENSION=gamecenter ./build.sh): Godot exports every GDExtension it finds.
#
#   GODOT_BIN   the 4.5+ editor (default: godot on PATH) with the iOS export templates installed
#   BUILD=1     also build both projects for the device, unsigned (CODE_SIGNING_ALLOWED=NO)
#   OUT         the work directory (default: sdks/godot/build/ios_export_check)
#
# The xcframework is copied in when it has been built (native/ios/build.sh); the check does not
# need it. No Apple account is used: the team id is a placeholder and nothing is signed.

set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
SDK="$(cd "$HERE/../.." && pwd)"
GODOT="${GODOT_BIN:-godot}"
OUT="${OUT:-$SDK/build/ios_export_check}"
BID="dev.polariskey.exportcheck"
rm -rf "$OUT"
mkdir -p "$OUT/project/addons" "$OUT/logs"

fail() { echo "export_check: FAIL: $*" >&2; exit 1; }

# The project: the addon, a main scene, the plugin enabled, two presets.
cp -R "$SDK/addons/polaris_key" "$OUT/project/addons/"
# The iOS export needs an app icon: a 256x256 solid PNG written here (no image tools needed).
python3 - "$OUT/project/icon.png" <<'PY'
import struct, sys, zlib
w = h = 256
raw = b"".join(b"\x00" + bytes((0x1a, 0x23, 0x5c, 0xff)) * w for _ in range(h))
def chunk(t, d): return struct.pack(">I", len(d)) + t + d + struct.pack(">I", zlib.crc32(t + d) & 0xffffffff)
png = b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", w, h, 8, 6, 0, 0, 0)) + chunk(b"IDAT", zlib.compress(raw)) + chunk(b"IEND", b"")
open(sys.argv[1], "wb").write(png)
PY
cat >"$OUT/project/project.godot" <<'EOF'
config_version=5

[application]

config/name="PKeyExportCheck"
config/version="1.0.0"
config/icon="res://icon.png"
run/main_scene="res://main.tscn"

[editor_plugins]

enabled=PackedStringArray("res://addons/polaris_key/plugin.cfg")

[rendering]

renderer/rendering_method="gl_compatibility"
renderer/rendering_method.mobile="gl_compatibility"
textures/vram_compression/import_etc2_astc=true
EOF
cat >"$OUT/project/main.tscn" <<'EOF'
[gd_scene format=3]

[node name="Main" type="Node"]
EOF
preset() { # <index> <name> <outlet> <export path> <apple_sign_in: true|false>
  cat <<EOF
[preset.$1]

name="$2"
platform="iOS"
runnable=false
dedicated_server=false
custom_features=""
export_filter="all_resources"
include_filter=""
exclude_filter=""
export_path="$4"
patches=PackedStringArray()
encryption_include_filters=""
encryption_exclude_filters=""
seed=0
encrypt_pck=false
encrypt_directory=false
script_export_mode=2

[preset.$1.options]

application/app_store_team_id="ABCDE12345"
application/export_project_only=true
application/bundle_identifier="$BID"
application/min_ios_version="18.0"
application/short_version="1.0.0"
application/version="1"
application/export_method_debug=1
application/export_method_release=0
polaris_key/outlet="$3"
polaris_key/apple_background_assets="auto"
polaris_key/apple_sign_in=$5
polaris_key/game_center=$5

EOF
}
{
  preset 0 "iOS (store)" "app-store" "$OUT/store/PKeyExportCheck.ipa" true
  preset 1 "iOS (sideload)" "altstore" "$OUT/sideload/PKeyExportCheck.ipa" false
} >"$OUT/project/export_presets.cfg"
mkdir -p "$OUT/store" "$OUT/sideload"

# Import, then export both presets (project only).
"$GODOT" --headless --path "$OUT/project" --import >"$OUT/logs/import.log" 2>&1 || true
for p in store sideload; do
  "$GODOT" --headless --path "$OUT/project" --export-release "iOS ($p)" "$OUT/$p/PKeyExportCheck.ipa" \
    >"$OUT/logs/export-$p.log" 2>&1 || true
  [ -d "$OUT/$p/PKeyExportCheck.xcodeproj" ] || { cat "$OUT/logs/export-$p.log"; fail "$p: no Xcode project exported"; }
done

# The post-export step on both.
"$HERE/patch_export.sh" "$OUT/store" | tee "$OUT/logs/patch-store.log"
"$HERE/patch_export.sh" "$OUT/sideload" | tee "$OUT/logs/patch-sideload.log"
before="$(find "$OUT/store/PKeyExportCheck.xcodeproj" "$OUT/store/PKeyExportCheck" -type f -exec shasum {} + | sort | shasum)"
"$HERE/patch_export.sh" "$OUT/store" | tee "$OUT/logs/patch-store-again.log"
after="$(find "$OUT/store/PKeyExportCheck.xcodeproj" "$OUT/store/PKeyExportCheck" -type f -exec shasum {} + | sort | shasum)"

pb() { /usr/libexec/PlistBuddy -c "Print :$2" "$1" 2>/dev/null || true; }
S="$OUT/store/PKeyExportCheck"
L="$OUT/sideload/PKeyExportCheck"

# Store: extension, App Group on both targets, BA keys, idempotent.
grep -q "PKBADownloader" "$OUT/store/PKeyExportCheck.xcodeproj/project.pbxproj" || fail "store: no PKBADownloader target"
grep -q "com.apple.product-type.extensionkit-extension" "$OUT/store/PKeyExportCheck.xcodeproj/project.pbxproj" || fail "store: no ExtensionKit product type"
grep -q "$BID.BackgroundDownload" "$OUT/store/PKeyExportCheck.xcodeproj/project.pbxproj" || fail "store: extension bundle id"
[ "$(pb "$S/PKeyExportCheck.entitlements" "com.apple.security.application-groups:0")" = "group.$BID" ] || fail "store: app entitlements lack the App Group"
[ "$(pb "$OUT/store/PKBADownloader/PKBADownloader.entitlements" "com.apple.security.application-groups:0")" = "group.$BID" ] || fail "store: extension entitlements lack the App Group"
[ "$(pb "$S/PKeyExportCheck-Info.plist" BAAppGroupID)" = "group.$BID" ] || fail "store: BAAppGroupID"
[ "$(pb "$S/PKeyExportCheck-Info.plist" BAHasManagedAssetPacks)" = "true" ] || fail "store: BAHasManagedAssetPacks"
[ "$(pb "$S/PKeyExportCheck-Info.plist" BAUsesAppleHosting)" = "true" ] || fail "store: BAUsesAppleHosting"
grep -q "already patched: no changes" "$OUT/logs/patch-store-again.log" || fail "store: second patch run was not a no-op"
[ "$before" = "$after" ] || fail "store: second patch run changed files"

# Background transfer (U-41.5c): the engine's app delegate forwards a relaunch for a finished background
# session to a service the glue registers, which calls pkp_handle_background_events. The built binding must
# carry that symbol (the check needs the xcframework; without it the check says so and moves on).
XCF="$SDK/addons/polaris_key/native/ios/pkey_apple.xcframework"
if [ -d "$XCF" ]; then
  BIN="$(find "$XCF" -type f -name pkey_apple -path '*/ios-arm64/*' ! -path '*simulator*' | head -1)"
  [ -n "$BIN" ] || fail "background events: no device binary in $XCF"
  # Read nm to the end: `grep -q` closing the pipe early fails `nm` under pipefail.
  SYMS="$(nm "$BIN" 2>/dev/null || true)"
  grep -q '_pkp_handle_background_events' <<<"$SYMS" || fail "background events: pkp_handle_background_events is not in the device binary"
  echo "export_check: pkp_handle_background_events is in the device binary"
else
  echo "export_check: no pkey_apple.xcframework built, the background-events symbol is not checked"
fi

# Sign in with Apple: the entitlement is there with the option on, and absent with it off.
[ "$(pb "$S/PKeyExportCheck.entitlements" "com.apple.developer.applesignin:0")" = "Default" ] || fail "store: apple_sign_in=true did not add the applesignin entitlement"
[ -z "$(pb "$L/PKeyExportCheck.entitlements" "com.apple.developer.applesignin")" ] || fail "sideload: has the applesignin entitlement with the option off"

# Game Center: the entitlement follows the option; the opt-in extension ships only with it on.
[ "$(pb "$S/PKeyExportCheck.entitlements" "com.apple.developer.game-center")" = "true" ] || fail "store: game_center=true did not add the game-center entitlement"
[ -z "$(pb "$L/PKeyExportCheck.entitlements" "com.apple.developer.game-center")" ] || fail "sideload: has the game-center entitlement with the option off"
if [ -d "$SDK/addons/polaris_key/native/ios/pkey_gamecenter.xcframework" ]; then
  # Godot exports every GDExtension in the project and a plugin cannot keep one out: the extension's
  # presence is the opt-in, so a project that has it ships it in both presets.
  grep -q "pkey_gamecenter" "$OUT/store/PKeyExportCheck.xcodeproj/project.pbxproj" || fail "store: the installed Game Center extension is not in the project"
  echo "export_check: the installed Game Center extension is exported (its presence is the opt-in)"
else
  ! grep -q "pkey_gamecenter" "$OUT/store/PKeyExportCheck.xcodeproj/project.pbxproj" || fail "store: GameKit extension in a project that did not install it"
  ! grep -q "GameKit" "$OUT/store/PKeyExportCheck.xcodeproj/project.pbxproj" || fail "store: GameKit is linked without the opt-in extension"
  echo "export_check: no Game Center extension installed, none exported, GameKit not linked"
fi

# Sideload: none of it.
[ "$(pb "$L/PKeyExportCheck-Info.plist" PKeyAppleBackgroundAssets)" = "false" ] || fail "sideload: the export plugin did not mark Background Assets off"
! grep -q "PKBADownloader" "$OUT/sideload/PKeyExportCheck.xcodeproj/project.pbxproj" || fail "sideload: has an extension target"
[ -z "$(pb "$L/PKeyExportCheck-Info.plist" BAAppGroupID)" ] || fail "sideload: has BAAppGroupID"
[ -z "$(pb "$L/PKeyExportCheck.entitlements" "com.apple.security.application-groups")" ] || fail "sideload: has an App Group"

if [ "${BUILD:-0}" = 1 ]; then
  for p in store sideload; do
    (cd "$OUT/$p" && xcodebuild -project PKeyExportCheck.xcodeproj -scheme PKeyExportCheck -configuration Release \
      -sdk iphoneos -destination 'generic/platform=iOS' -derivedDataPath "$OUT/dd-$p" CODE_SIGNING_ALLOWED=NO build \
      >"$OUT/logs/build-$p.log" 2>&1) || { tail -30 "$OUT/logs/build-$p.log"; fail "$p: device build failed"; }
    echo "export_check: $p device build succeeded"
  done
fi

echo "export_check: OK (store preset has the extension, App Group and BA keys; sideload has none)"
