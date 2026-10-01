#!/usr/bin/env bash
# Builds the pkba GDExtension shim:
#   - build/pkba.xcframework  (ios-arm64 + ios-arm64-simulator dynamic frameworks)
#   - build/macos/libpkba.dylib (plumbing check on the desktop editor only)
# and copies the xcframework into ../godot/bin/ where pkba.gdextension points.
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
out="$here/build"
min_ios="${MIN_IOS:-26.4}" # ensureLocalAvailabilityOfAssetPack:requireLatestVersion: is 26.4+
rm -rf "$out" && mkdir -p "$out"

# gdextension_interface.h comes from the engine binary itself, so it always matches.
(cd "$out" && godot --headless --dump-gdextension-interface >/dev/null 2>&1)
test -f "$out/gdextension_interface.h"

cflags=(-fobjc-arc -fmodules -O2 -Wall -Wno-unused-parameter -I"$out")

build_fw() { # <sdk> <target-triple> <slice-dir>
  local sdk="$1" triple="$2" dir="$out/$3/pkba.framework"
  mkdir -p "$dir"
  xcrun --sdk "$sdk" clang "${cflags[@]}" -target "$triple" -dynamiclib \
    -install_name @rpath/pkba.framework/pkba \
    -framework Foundation -framework BackgroundAssets \
    "$here/pkba.m" -o "$dir/pkba"
  /usr/libexec/PlistBuddy -c "Clear dict" \
    -c "Add :CFBundleExecutable string pkba" \
    -c "Add :CFBundleIdentifier string dev.polariskey.research.pkba-shim" \
    -c "Add :CFBundleName string pkba" \
    -c "Add :CFBundlePackageType string FMWK" \
    -c "Add :CFBundleShortVersionString string 0.1" \
    -c "Add :CFBundleVersion string 1" \
    -c "Add :MinimumOSVersion string $min_ios" \
    "$dir/Info.plist" >/dev/null 2>&1 || true
  plutil -convert xml1 "$dir/Info.plist"
}

build_fw iphoneos "arm64-apple-ios$min_ios" ios-arm64
build_fw iphonesimulator "arm64-apple-ios$min_ios-simulator" ios-arm64-simulator
xcodebuild -create-xcframework \
  -framework "$out/ios-arm64/pkba.framework" \
  -framework "$out/ios-arm64-simulator/pkba.framework" \
  -output "$out/pkba.xcframework" >/dev/null

mkdir -p "$out/macos"
xcrun --sdk macosx clang "${cflags[@]}" -target arm64-apple-macos26.4 -dynamiclib \
  -framework Foundation -framework BackgroundAssets "$here/pkba.m" -o "$out/macos/libpkba.dylib"

mkdir -p "$here/../godot/bin"
rm -rf "$here/../godot/bin/pkba.xcframework" "$here/../godot/bin/libpkba.macos.dylib"
cp -R "$out/pkba.xcframework" "$here/../godot/bin/"
cp "$out/macos/libpkba.dylib" "$here/../godot/bin/libpkba.macos.dylib"
echo "built: $out/pkba.xcframework and $out/macos/libpkba.dylib"
