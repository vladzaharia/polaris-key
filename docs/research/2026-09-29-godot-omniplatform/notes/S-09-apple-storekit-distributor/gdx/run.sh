#!/usr/bin/env bash
# S-09 harness: export the probe, build for simulator (ad hoc + get-task-allow) and device
# (unsigned), install and launch plans. Logs under build/logs.
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
b="$here/build"; logs="$b/logs"; mkdir -p "$logs"
SIM_LIB="${GODOT_SIM_LIB:-$here/../godot-src/bin/libgodot.ios.template_release.arm64.simulator.a}"
UDID="${UDID:?set UDID to an iOS 26.5 simulator udid}"
BID="${BID:-dev.polariskey.research.pkap}"
proj="${PROJ:-$b/export}"

export_proj() {
  rm -rf "$b/export" && mkdir -p "$b/export"
  godot --headless --path "$here/godot" --export-release iOS "$b/export/probe.ipa" >"$logs/export.log" 2>&1
  test -d "$b/export/probe.xcodeproj"
  local slice="$b/export/probe.xcframework/ios-arm64_x86_64-simulator/libgodot.a"
  lipo -create "$SIM_LIB" "$slice" -output "$slice.fat" && mv "$slice.fat" "$slice"
  # Simulator StoreKit Testing needs a development install: storekitd refuses a bundle without
  # get-task-allow ("is not installed for development").
  /usr/libexec/PlistBuddy -c "Add :get-task-allow bool true" "$b/export/probe/probe.entitlements" 2>/dev/null || true
}

xb() { # <sdk> <dd> settings...
  local sdk="$1" dd="$2"; shift 2
  local dest="generic/platform=iOS"; [ "$sdk" = iphonesimulator ] && dest="generic/platform=iOS Simulator"
  (cd "$proj" && xcodebuild -project probe.xcodeproj -scheme probe -configuration Release -sdk "$sdk" \
    -destination "$dest" -derivedDataPath "$dd" "$@" build)
}
build_sim() { xb iphonesimulator "$b/dd/sim" CODE_SIGN_IDENTITY=- CODE_SIGN_STYLE=Manual DEVELOPMENT_TEAM= PROVISIONING_PROFILE_SPECIFIER= ARCHS=arm64 >"$logs/build-sim.log" 2>&1; grep -Eo '\*\* BUILD [A-Z]+ \*\*' "$logs/build-sim.log"; }
build_dev() { xb iphoneos "$b/dd/dev" CODE_SIGNING_ALLOWED=NO >"$logs/build-dev.log" 2>&1; grep -Eo '\*\* BUILD [A-Z]+ \*\*' "$logs/build-dev.log"; }

app() { echo "$b/dd/sim/Build/Products/Release-iphonesimulator/probe.app"; }
install() { xcrun simctl boot "$UDID" 2>/dev/null || true; xcrun simctl bootstatus "$UDID" -b >/dev/null; xcrun simctl install "$UDID" "$(app)"; }
uninstall() { xcrun simctl uninstall "$UDID" "$BID" || true; }
launch() { # <plan> <seconds>
  ( sleep "$2"; xcrun simctl terminate "$UDID" "$BID" 2>/dev/null ) & local w=$!
  xcrun simctl launch --console-pty --terminate-running-process "$UDID" "$BID" -- "--plan=$1" 2>&1 | tee "$logs/plan-$1.log" | grep '^PKAP ' || true
  kill "$w" 2>/dev/null || true
}
# The app's stdout does not reach --console-pty reliably; the probe also appends to user://.
applog() { local d; d=$(xcrun simctl get_app_container "$UDID" "$BID" data); cat "$d/Documents/pkap_log.jsonl" 2>/dev/null || find "$d" -name pkap_log.jsonl -exec cat {} \; ; }
clearlog() { local d; d=$(xcrun simctl get_app_container "$UDID" "$BID" data 2>/dev/null) || return 0; find "$d" -name pkap_log.jsonl -delete; }
"$@"
