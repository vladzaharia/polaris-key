#!/usr/bin/env bash
# Builds the PolarisKey scheme for tvOS, visionOS, iOS and macOS (generic destinations), so an
# availability error on one OS cannot hide behind `swift build`, which builds only macOS.
# Run from anywhere. CI should run it; wrap in the lead's heavy.sh on the shared machine.
set -euo pipefail
cd "$(dirname "$0")/.."
for dest in 'generic/platform=tvOS' 'generic/platform=visionOS' 'generic/platform=iOS' 'generic/platform=macOS'; do
  echo "== xcodebuild -scheme PolarisKey -destination '$dest' build"
  xcodebuild -scheme PolarisKey -destination "$dest" build -quiet
done
echo "all platforms built"
