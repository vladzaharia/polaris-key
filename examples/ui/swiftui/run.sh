#!/usr/bin/env bash
# The SwiftUI kit's sample: generate the project, build it, and render every state on the iOS
# simulator (KitRenderTests), writing the PNGs, audit.json and voiceover.json to PKEY_KIT_SHOTS.
#
#   run.sh                     build and run the render tests on an iPhone (iPhone 17 Pro Max)
#   DEVICE="iPad Air 11-inch (M4)" run.sh   the same on another installed simulator
#   PKEY_KIT_ONLY=Welcome.default,SignIn.methods run.sh   only these states
#   PKEY_KIT_QUICK=1 run.sh    each state in both schemes only (no AX, landscape or native)
#   run.sh --open              generate the project and open it in Xcode
#   run.sh --mac               build the macOS sample and run KitRenderMacTests on this Mac (UK-08.2)
#   run.sh --mac --build-only  build the Mac sample and its UI tests (build-for-testing); needs no
#                              UI automation
#   PKEY_KIT_TESTS=KitRenderMacTests/testRenders run.sh --mac   only these tests (xcodebuild
#                              -only-testing, comma separated; CI's macos-15 leg runs the board only)
#   Mac renders: mac<OS>-<W>x<H>-<state>-<preset>-<scheme>[-inactive].png and renders-mac.json in
#   PKEY_KIT_SHOTS (default build/shots-mac). Also PKEY_KIT_WINDOWS=900x640,480x520 and
#   PKEY_KIT_INACTIVE=1 (also render each state with the window inactive). The test runner needs
#   UI automation allowed (owner step O1); CI images have it.
#
#   PKEY_KIT_SHOTS  where the renders go (default: build/shots)
#   PKEY_KIT_OS     the simulator runtime (OS=…) when the device exists on several (default: latest)
#   PKEY_KIT_DEVICE the device's name in the file names (default: the simulator's, lower-cased)
#   PKEY_KIT_BASELINES  compare every render with the baselines in this directory
#                   (sdks/swift/Tests/PolarisKeyUISnapshotTests/__Snapshots__); a missing one fails
#   PKEY_KIT_RECORD=1   write the baselines instead of comparing (say why in the commit)
#                   On the Mac, an OS with no mac<OS>-*.png under PKEY_KIT_BASELINES yet records
#                   instead (record-first, UK-08.8): the first CI run on an OS produces its set.
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

if [ "${1:-}" = "--mac" ]; then
  MSHOTS="${PKEY_KIT_SHOTS:-$BUILD/shots-mac}"
  mkdir -p "$MSHOTS"
  VERB=test
  [ "${2:-}" = "--build-only" ] && VERB=build-for-testing
  ONLY_TESTING=()
  if [ -n "${PKEY_KIT_TESTS:-}" ]; then
    IFS=',' read -r -a TESTS <<<"$PKEY_KIT_TESTS"
    for t in "${TESTS[@]}"; do ONLY_TESTING+=("-only-testing:TidewaterKitMacUITests/$t"); done
  fi
  TEST_RUNNER_PKEY_KIT_SHOTS="$MSHOTS" TEST_RUNNER_PKEY_KIT_ONLY="${PKEY_KIT_ONLY:-}" \
    TEST_RUNNER_PKEY_KIT_QUICK="${PKEY_KIT_QUICK:-0}" \
    TEST_RUNNER_PKEY_KIT_WINDOWS="${PKEY_KIT_WINDOWS:-}" \
    TEST_RUNNER_PKEY_KIT_INACTIVE="${PKEY_KIT_INACTIVE:-0}" \
    TEST_RUNNER_PKEY_KIT_EXTRA_ARGS="${PKEY_KIT_EXTRA_ARGS:-}" \
    TEST_RUNNER_PKEY_KIT_BASELINES="${PKEY_KIT_BASELINES:-}" \
    TEST_RUNNER_PKEY_KIT_RECORD="${PKEY_KIT_RECORD:-0}" \
    xcodebuild "$VERB" \
    -project "$HERE/TidewaterKit.xcodeproj" -scheme TidewaterKitMac \
    -destination "platform=macOS" \
    ${ONLY_TESTING[@]+"${ONLY_TESTING[@]}"} \
    -derivedDataPath "$BUILD/dd-mac" -resultBundlePath "$BUILD/results-mac-$(date +%s).xcresult" \
    CODE_SIGNING_ALLOWED=YES
  echo "run.sh: Mac renders in $MSHOTS"
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
  -destination "platform=iOS Simulator,name=$DEVICE${PKEY_KIT_OS:+,OS=$PKEY_KIT_OS}" \
  -derivedDataPath "$BUILD/dd" -resultBundlePath "$BUILD/results-$(date +%s).xcresult" \
  CODE_SIGNING_ALLOWED=YES
echo "run.sh: renders in $SHOTS"
