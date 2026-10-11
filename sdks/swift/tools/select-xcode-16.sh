#!/usr/bin/env bash
# Select Xcode 16.4 on a macos-15 runner and fail unless its compiler is Swift 6.0, 6.1 or 6.2.
#
# The floor half of select-xcode-26.sh. sdks/swift/Package.swift supports Swift tools 6.0, and the
# Xcode 26+ SDK code of PolarisKeyPlatform (the Background Assets client: AssetPackManager and its
# 26.4 methods) is behind `#if compiler(>=6.3)`, the iOS 27 manifest API behind `#if compiler(>=6.4)`.
# Used by ci.yml's `swift-floor` job, which builds the package with the compiler those guards
# compile OUT for, so a newer API used outside its guard fails there and not only for a client on
# Xcode 16.4. The runner's default Xcode is not relied on (a bump of it would turn the job into a
# second modern-toolchain build), and a 6.3 compiler fails the job, so the leg cannot pass while
# checking nothing.
set -euo pipefail

sudo xcode-select -s /Applications/Xcode_16.4.app
xcodebuild -version
swift --version
v="$(swift --version 2>&1 | sed -n 's/.*Swift version \([0-9][0-9]*\.[0-9][0-9]*\).*/\1/p' | head -n 1)"
major="${v%%.*}"
minor="${v#*.}"
if [ -z "$v" ] || [ "$major" -ne 6 ] || [ "$minor" -ge 3 ]; then
  echo "Swift ${v:-(unreadable)} is not 6.0 to 6.2: the compiler(>=6.3) guards would not be compiled out" >&2
  exit 1
fi
