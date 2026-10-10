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
(cd "$HERE" && "${XCODEGEN:-xcodegen}" generate --quiet --spec project.yml)

if [ "${1:-}" = "--open" ]; then
  open "$HERE/TidewaterKit.xcodeproj"
  exit 0
fi

mkdir -p "$SHOTS"
TEST_RUNNER_PKEY_KIT_SHOTS="$SHOTS" TEST_RUNNER_PKEY_KIT_ONLY="${PKEY_KIT_ONLY:-}" \
  TEST_RUNNER_PKEY_KIT_QUICK="${PKEY_KIT_QUICK:-0}" TEST_RUNNER_PKEY_KIT_DEVICE="$LABEL" \
  TEST_RUNNER_PKEY_KIT_EXTRA_ARGS="${PKEY_KIT_EXTRA_ARGS:-}" \
  xcodebuild test \
  -project "$HERE/TidewaterKit.xcodeproj" -scheme TidewaterKit \
  -destination "platform=iOS Simulator,name=$DEVICE" \
  -derivedDataPath "$BUILD/dd" -resultBundlePath "$BUILD/results-$(date +%s).xcresult" \
  CODE_SIGNING_ALLOWED=YES
echo "run.sh: renders in $SHOTS"
