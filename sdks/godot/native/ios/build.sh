#!/usr/bin/env bash
# build.sh: builds addons/polaris_key/native/ios/$NAME.xcframework, the Godot iOS binding of
# PolarisKeyPlatform (P5-05; notes/S-09 §Recommendation 6), and installs pkey_apple.gdextension
# beside it (see that file for why it is not committed in the addon).
#
# One dynamic framework per slice holds BOTH the C-interface glue (pkey_apple.m) and the
# PolarisKeyPlatform Swift sources and its C surface (sdks/swift/Sources/PolarisKeyPlatform and
# PolarisKeyPlatformC), compiled in Swift 6
# language mode with warnings as errors:
#
#   ios-arm64                 device
#   ios-arm64_x86_64-simulator  Apple Silicon and Intel simulators
#
#   MIN_IOS         the deployment target (default 18.0, the package floor; never lower). Build it
#                   at the APP's floor, not at 26.4: every newer API is behind #available, and a
#                   framework newer than the app fails to load on older devices. The iOS preset's
#                   application/min_ios_version must be at least this (the export plugin warns).
#   GODOT_BIN       the editor whose `--dump-gdextension-interface` provides gdextension_interface.h
#                   (default: godot on PATH; 4.7+ for the creation-info-6 types), or
#   GDEXTENSION_HEADER  an existing gdextension_interface.h to use instead
#   OUT             the output xcframework (default: the addon path above)
#
# EXTENSION=gamecenter builds the OPT-IN Game Center extension instead (I-48.6a; Q-4): the same glue
# compiled with -DPKEY_GAMECENTER over PolarisKeyGameCenter and its C surface PolarisKeyGameCenterC
# (sdks/swift/Sources), into addons/polaris_key/native/ios/pkey_gamecenter.xcframework with
# pkey_gamecenter.gdextension beside it, class PolarisKeyGameCenter. GameKit is weak-linked there and
# nowhere else: a game that does not ask for Game Center never ships it.
#
# The output is a build product and is never committed (.gitignore). Each framework carries its
# own bundle id (dev.polariskey.godot.pkey-apple): a framework that reuses the app's id blocks
# the install (S-01). Never links StoreKitTest or XCTest.

set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
REPO="$(cd "$HERE/../../../.." && pwd)"
SRC="$REPO/sdks/swift/Sources/PolarisKeyPlatform"
CSRC="$REPO/sdks/swift/Sources/PolarisKeyPlatformC"
GCSRC="$REPO/sdks/swift/Sources/PolarisKeyGameCenter"
GCCSRC="$REPO/sdks/swift/Sources/PolarisKeyGameCenterC"
EXTENSION="${EXTENSION:-apple}"
case "$EXTENSION" in
  apple) NAME=pkey_apple ;;
  gamecenter) NAME=pkey_gamecenter ;;
  *) echo "build.sh: EXTENSION must be apple or gamecenter" >&2; exit 2 ;;
esac
OUT="${OUT:-$REPO/sdks/godot/addons/polaris_key/native/ios/$NAME.xcframework}"
MIN_IOS="${MIN_IOS:-18.0}"
BUNDLE_ID="dev.polariskey.godot.${NAME//_/-}"
VERSION="$(sed -n 's/^config\/version="\(.*\)"$/\1/p' "$REPO/sdks/godot/project.godot")"

# The package floor is iOS 18 (UK-07): refuse anything lower rather than build a binary that would
# need availability guards the sources do not have.
if [ "$(printf '%s\n18.0\n' "$MIN_IOS" | sort -V | head -n1)" != "18.0" ]; then
  echo "build.sh: MIN_IOS=$MIN_IOS is below PolarisKeyPlatform's iOS 18.0 floor" >&2
  exit 2
fi

GLUE_DEFS=""
[ "$EXTENSION" = gamecenter ] && GLUE_DEFS="-DPKEY_GAMECENTER"
WORK="$(mktemp -d "${TMPDIR:-/tmp}/$NAME.XXXXXX")"
trap 'rm -rf "$WORK"' EXIT

if [ -n "${GDEXTENSION_HEADER:-}" ]; then
  cp "$GDEXTENSION_HEADER" "$WORK/gdextension_interface.h"
else
  GODOT="${GODOT_BIN:-godot}"
  (cd "$WORK" && "$GODOT" --headless --dump-gdextension-interface >/dev/null 2>&1) || true
fi
if ! grep -q "GDExtensionClassCreationInfo6" "$WORK/gdextension_interface.h" 2>/dev/null; then
  echo "build.sh: need a Godot 4.7+ gdextension_interface.h (set GODOT_BIN or GDEXTENSION_HEADER)" >&2
  exit 2
fi

# slice <sdk> <triple> <out dir>: one framework binary for one architecture.
slice() {
  local sdk="$1" triple="$2" dir="$3" sdkp
  sdkp="$(xcrun --sdk "$sdk" --show-sdk-path)"
  mkdir -p "$dir"
  xcrun --sdk "$sdk" clang -c -fobjc-arc -fmodules -O2 -Wall -Wextra -Werror -Wno-unused-parameter -Wno-cast-function-type \
    $GLUE_DEFS -I"$WORK" -target "$triple" -isysroot "$sdkp" "$HERE/pkey_apple.m" -o "$dir/pkey_apple.o"
  # Two modules, as in the Swift package: PolarisKeyPlatform (a static library + its module),
  # then the C surface PolarisKeyPlatformC over it, linked with the glue into one dylib.
  mkdir -p "$dir/mods"
  xcrun --sdk "$sdk" swiftc -target "$triple" -sdk "$sdkp" -swift-version 6 -warnings-as-errors -O \
    -parse-as-library -module-name PolarisKeyPlatform -emit-library -static \
    -emit-module -emit-module-path "$dir/mods/PolarisKeyPlatform.swiftmodule" \
    "$SRC"/*.swift -o "$dir/libPolarisKeyPlatform.a"
  if [ "$EXTENSION" = gamecenter ]; then
    # PolarisKeyGameCenter (standalone, static), then its C surface over it and PolarisKeyPlatform's
    # event sink; GameKit is weak-linked, so the framework loads where GameKit is absent.
    xcrun --sdk "$sdk" swiftc -target "$triple" -sdk "$sdkp" -swift-version 6 -warnings-as-errors -O \
      -parse-as-library -module-name PolarisKeyGameCenter -emit-library -static \
      -emit-module -emit-module-path "$dir/mods/PolarisKeyGameCenter.swiftmodule" \
      "$GCSRC"/*.swift -o "$dir/libPolarisKeyGameCenter.a"
    xcrun --sdk "$sdk" swiftc -target "$triple" -sdk "$sdkp" -swift-version 6 -warnings-as-errors -O \
      -parse-as-library -module-name PolarisKeyGameCenterC -I "$dir/mods" -emit-library "$GCCSRC"/*.swift \
      "$dir/pkey_apple.o" "$dir/libPolarisKeyGameCenter.a" "$dir/libPolarisKeyPlatform.a" \
      -Xlinker -install_name -Xlinker "@rpath/$NAME.framework/$NAME" \
      -framework Foundation -Xlinker -weak_framework -Xlinker GameKit -o "$dir/$NAME"
  else
    xcrun --sdk "$sdk" swiftc -target "$triple" -sdk "$sdkp" -swift-version 6 -warnings-as-errors -O \
      -parse-as-library -module-name PolarisKeyPlatformC -I "$dir/mods" -emit-library "$CSRC"/*.swift \
      "$dir/pkey_apple.o" "$dir/libPolarisKeyPlatform.a" \
      -Xlinker -install_name -Xlinker "@rpath/$NAME.framework/$NAME" \
      -framework Foundation -framework StoreKit -framework Security -o "$dir/$NAME"
  fi
}

# framework <dir> <binary>: wrap a binary as $NAME.framework.
framework() {
  local fw="$1/$NAME.framework"
  mkdir -p "$fw"
  cp "$2" "$fw/$NAME"
  /usr/libexec/PlistBuddy \
    -c "Add :CFBundleExecutable string $NAME" \
    -c "Add :CFBundleIdentifier string $BUNDLE_ID" \
    -c "Add :CFBundleName string $NAME" \
    -c "Add :CFBundlePackageType string FMWK" \
    -c "Add :CFBundleShortVersionString string ${VERSION:-0.0.0}" \
    -c "Add :CFBundleVersion string 1" \
    -c "Add :CFBundleSupportedPlatforms array" \
    -c "Add :MinimumOSVersion string $MIN_IOS" \
    "$fw/Info.plist" >/dev/null
  plutil -convert xml1 "$fw/Info.plist"
}

slice iphoneos "arm64-apple-ios$MIN_IOS" "$WORK/device"
slice iphonesimulator "arm64-apple-ios$MIN_IOS-simulator" "$WORK/sim-arm64"
slice iphonesimulator "x86_64-apple-ios$MIN_IOS-simulator" "$WORK/sim-x86_64"
lipo -create "$WORK/sim-arm64/$NAME" "$WORK/sim-x86_64/$NAME" -output "$WORK/sim-fat"

framework "$WORK/fw-device" "$WORK/device/$NAME"
/usr/libexec/PlistBuddy -c "Add :CFBundleSupportedPlatforms:0 string iPhoneOS" "$WORK/fw-device/$NAME.framework/Info.plist"
framework "$WORK/fw-sim" "$WORK/sim-fat"
/usr/libexec/PlistBuddy -c "Add :CFBundleSupportedPlatforms:0 string iPhoneSimulator" "$WORK/fw-sim/$NAME.framework/Info.plist"

rm -rf "$OUT"
mkdir -p "$(dirname "$OUT")"
xcodebuild -create-xcframework \
  -framework "$WORK/fw-device/$NAME.framework" \
  -framework "$WORK/fw-sim/$NAME.framework" \
  -output "$OUT" >/dev/null
cp "$HERE/$NAME.gdextension" "$(dirname "$OUT")/$NAME.gdextension"
echo "build.sh: built $OUT (iOS $MIN_IOS; $(du -sk "$OUT" | cut -f1) KB)"
