#!/usr/bin/env bash
# Builds pkap.xcframework: the Swift PKPlatform sources + the C-interface GDExtension glue in ONE
# dynamic framework per slice, Swift 6 language mode, at MIN_IOS (the app floor, not 26.4).
# The simulator slice also links StoreKitTest (probe-only hook, PKAP_SK_TEST=1).
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
pk="$here/../pkplat/Sources/PKPlatform"
out="$here/build"
min_ios="${MIN_IOS:-17.0}"
rm -rf "$out" && mkdir -p "$out"
(cd "$out" && godot --headless --dump-gdextension-interface >/dev/null 2>&1)

slice() { # <sdk> <triple> <dir> <sktest 0|1>
  local sdk="$1" triple="$2" dir="$out/$3/pkap.framework" sk="$4" sdkp
  sdkp="$(xcrun --sdk "$sdk" --show-sdk-path)"
  mkdir -p "$dir" "$out/$3/obj"
  xcrun --sdk "$sdk" clang -c -fobjc-arc -fmodules -O2 -Wall -Wno-unused-parameter -I"$out" \
    -target "$triple" -DPKAP_SK_TEST="$sk" "$here/pkap.m" -o "$out/$3/obj/pkap.o"
  local extra=()
  [ "$sk" = 1 ] && extra=("$here/SKTestHook.swift" -F "$sdkp/Developer/Library/Frameworks" -framework StoreKitTest)
  xcrun --sdk "$sdk" swiftc -target "$triple" -sdk "$sdkp" -swift-version 6 -O -parse-as-library \
    -module-name PKPlatform -emit-library "$pk"/*.swift "${extra[@]}" "$out/$3/obj/pkap.o" \
    -Xlinker -install_name -Xlinker @rpath/pkap.framework/pkap \
    -framework Foundation -framework StoreKit -framework Security -o "$dir/pkap"
  /usr/libexec/PlistBuddy -c "Clear dict" \
    -c "Add :CFBundleExecutable string pkap" \
    -c "Add :CFBundleIdentifier string dev.polariskey.research.pkap-gdext" \
    -c "Add :CFBundleName string pkap" -c "Add :CFBundlePackageType string FMWK" \
    -c "Add :CFBundleShortVersionString string 0.1" -c "Add :CFBundleVersion string 1" \
    -c "Add :MinimumOSVersion string $min_ios" "$dir/Info.plist" >/dev/null 2>&1 || true
  plutil -convert xml1 "$dir/Info.plist"
}
slice iphoneos "arm64-apple-ios$min_ios" ios-arm64 0
slice iphonesimulator "arm64-apple-ios$min_ios-simulator" ios-arm64-simulator 1
xcodebuild -create-xcframework -framework "$out/ios-arm64/pkap.framework" \
  -framework "$out/ios-arm64-simulator/pkap.framework" -output "$out/pkap.xcframework" >/dev/null
echo "built $out/pkap.xcframework"
