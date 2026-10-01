#!/usr/bin/env bash
# Build the Swift outlet probe without an Xcode project.
#   ./build.sh ios-sim   -> out/swift/ios-sim/OutletProbe.app  (ad hoc signed, for `simctl install`)
#   ./build.sh macos     -> out/swift/macos/OutletProbe.app    (ad hoc signed)
# Run (iOS):   xcrun simctl install <udid> <app> && xcrun simctl launch --console-pty <udid> org.example.pkey.outletprobe
# Run (macOS): out/swift/macos/OutletProbe.app/Contents/MacOS/OutletProbe
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
OUT="$HERE/../out/swift/${1:?usage: build.sh ios-sim|macos}"
BID=org.example.pkey.outletprobe
rm -rf "$OUT" && mkdir -p "$OUT"
plist() { # <path> <extra xml>
	cat >"$1" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>CFBundleIdentifier</key><string>$BID</string>
<key>CFBundleExecutable</key><string>OutletProbe</string>
<key>CFBundleName</key><string>OutletProbe</string>
<key>CFBundlePackageType</key><string>APPL</string>
<key>CFBundleShortVersionString</key><string>1.0</string>
<key>CFBundleVersion</key><string>1</string>
$2
</dict></plist>
EOF
}
case "$1" in
ios-sim)
	APP="$OUT/OutletProbe.app"
	mkdir -p "$APP"
	xcrun -sdk iphonesimulator swiftc -parse-as-library -O -target arm64-apple-ios17.4-simulator \
		"$HERE/OutletProbe.swift" -o "$APP/OutletProbe"
	plist "$APP/Info.plist" "<key>UIDeviceFamily</key><array><integer>1</integer></array>
<key>MinimumOSVersion</key><string>17.4</string><key>UILaunchScreen</key><dict/>"
	codesign -s - --force "$APP"
	;;
macos)
	APP="$OUT/OutletProbe.app"
	mkdir -p "$APP/Contents/MacOS"
	xcrun -sdk macosx swiftc -parse-as-library -O -target arm64-apple-macos13 \
		"$HERE/OutletProbe.swift" -o "$APP/Contents/MacOS/OutletProbe"
	plist "$APP/Contents/Info.plist" "<key>LSMinimumSystemVersion</key><string>13.0</string>"
	codesign -s - --force "$APP"
	;;
esac
echo "built $APP"
