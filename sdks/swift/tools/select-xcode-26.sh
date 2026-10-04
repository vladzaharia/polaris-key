#!/usr/bin/env bash
# Select Xcode 26.6 on a macos-26 runner and fail unless its compiler is Swift 6.3 or later.
#
# sdks/swift/Package.swift needs Swift tools 6.x, and the Background Assets client is behind
# `#if compiler(>=6.3)`, so an older default Xcode would either refuse the package (macos-14's
# Swift 5.10) or silently compile that code out. Used by ci.yml's `apple` job and by
# publish-sdks.yml's Swift jobs, so the SDK is tested and signed with the toolchain CI verified.
set -euo pipefail

sudo xcode-select -s /Applications/Xcode_26.6.app
xcodebuild -version
swift --version
v="$(swift --version 2>&1 | sed -n 's/.*Swift version \([0-9][0-9]*\.[0-9][0-9]*\).*/\1/p' | head -n 1)"
major="${v%%.*}"
minor="${v#*.}"
if [ -z "$v" ] || [ "$major" -lt 6 ] || { [ "$major" -eq 6 ] && [ "$minor" -lt 3 ]; }; then
  echo "Swift $v is below 6.3: the guarded Background Assets code would not compile" >&2
  exit 1
fi
