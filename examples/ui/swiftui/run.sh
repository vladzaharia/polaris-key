#!/usr/bin/env bash
# The SwiftUI kit's sample: generate the project, build it, and render every state on the iOS
# simulator (KitRenderTests), writing the PNGs, audit.json and voiceover.json to PKEY_KIT_SHOTS.
#
#   run.sh                     build and run the render tests on an iPhone (iPhone 17 Pro Max)
#   DEVICE="iPad Air 11-inch (M4)" run.sh   the same on another installed simulator
#   PKEY_KIT_ONLY=Welcome.default,SignIn.methods run.sh   only these states
#   PKEY_KIT_QUICK=1 run.sh    each state in both schemes only (no AX, landscape or native)
#   run.sh --open              generate the project and open it in Xcode
#
#   PKEY_KIT_SHOTS  where the renders go (default: build/shots)
#   PKEY_KIT_DEVICE the device's name in the file names (default: the simulator's, lower-cased)
#   PKEY_KIT_BASELINES  compare every render with the baselines in this directory
#                   (sdks/swift/Tests/PolarisKeyUISnapshotTests/__Snapshots__); a missing one fails
#   PKEY_KIT_RECORD=1   write the baselines instead of comparing (say why in the commit)
#   XCODEGEN        the xcodegen binary (default: xcodegen on PATH)
#
# Needs Xcode 26+ and XcodeGen. Uses no Apple developer account (ad hoc simulator signing).

set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
BUILD="$HERE/build"
DEVICE="${DEVICE:-iPhone 17 Pro Max}"
LABEL="${PKEY_KIT_DEVICE:-$(echo "$DEVICE" | tr '[:upper:] ' '[:lower:]-')}"
SHOTS="${PKEY_KIT_SHOTS:-$BUILD/shots}"

mkdir -p "$BUILD"
# Xcode's package resolution for this project rewrites the SDK package's own Package.resolved
# (adding this sample's test-only pins); keep the SDK's file as it is.
RESOLVED="$HERE/../../../sdks/swift/Package.resolved"
cp "$RESOLVED" "$BUILD/Package.resolved.sdk"
trap 'cp "$BUILD/Package.resolved.sdk" "$RESOLVED"' EXIT
(cd "$HERE" && "${XCODEGEN:-xcodegen}" generate --quiet --spec project.yml)

if [ "${1:-}" = "--open" ]; then
  open "$HERE/TidewaterKit.xcodeproj"
  exit 0
fi

mkdir -p "$SHOTS"
# A fixed status bar, so a render matches its baseline on every run.
xcrun simctl boot "$DEVICE" 2>/dev/null || true
xcrun simctl bootstatus "$DEVICE" -b >/dev/null 2>&1 || true
xcrun simctl status_bar "$DEVICE" override --time "9:41" --dataNetwork wifi --wifiMode active \
  --wifiBars 3 --cellularMode active --cellularBars 4 --batteryState charged --batteryLevel 100 \
  2>/dev/null || true
TEST_RUNNER_PKEY_KIT_SHOTS="$SHOTS" TEST_RUNNER_PKEY_KIT_ONLY="${PKEY_KIT_ONLY:-}" \
  TEST_RUNNER_PKEY_KIT_QUICK="${PKEY_KIT_QUICK:-0}" TEST_RUNNER_PKEY_KIT_DEVICE="$LABEL" \
  TEST_RUNNER_PKEY_KIT_EXTRA_ARGS="${PKEY_KIT_EXTRA_ARGS:-}" \
  TEST_RUNNER_PKEY_KIT_BASELINES="${PKEY_KIT_BASELINES:-}" TEST_RUNNER_PKEY_KIT_RECORD="${PKEY_KIT_RECORD:-0}" \
  xcodebuild test \
  -project "$HERE/TidewaterKit.xcodeproj" -scheme TidewaterKit \
  -destination "platform=iOS Simulator,name=$DEVICE" \
  -derivedDataPath "$BUILD/dd" -resultBundlePath "$BUILD/results-$(date +%s).xcresult" \
  CODE_SIGNING_ALLOWED=YES
echo "run.sh: renders in $SHOTS"
