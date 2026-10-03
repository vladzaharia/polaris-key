#!/usr/bin/env bash
# Type-checks PolarisKeyPlatform and its tests with the Swift 6.0, 6.1 and 6.2 compilers in the
# official Linux images (Docker), in Swift 6 language mode with warnings as errors (P5-05). The
# Apple frameworks compile out there (`#if canImport(StoreKit)` and friends), so this proves the
# LANGUAGE side is clean on every compiler CI could use: no Swift 6.2+ feature (`@concurrent`,
# `nonisolated(nonsending)`, `Task.immediate`, `@c`, isolated conformances) slipped in. The Apple
# SDK side is proven by the macos-15 job (Xcode 16.4, Swift 6.1) and the macos-26 job.
#
#   VERSIONS   the image tags (default: "6.0 6.1 6.2")
set -euo pipefail
HERE="$(cd "$(dirname "$0")/.." && pwd)"
for v in ${VERSIONS:-6.0 6.1 6.2}; do
  echo "== swift:$v"
  docker run --rm -v "$HERE:/pkg:ro" "swift:$v" bash -ec '
    swift --version 2>&1 | head -n 1
    cd /tmp
    swiftc -emit-module -parse-as-library -swift-version 6 -warnings-as-errors -enable-testing \
      -module-name PolarisKeyPlatform -emit-module-path /tmp/PolarisKeyPlatform.swiftmodule \
      /pkg/Sources/PolarisKeyPlatform/*.swift
    swiftc -typecheck -swift-version 6 -warnings-as-errors -I /tmp /pkg/Tests/PolarisKeyPlatformTests/*.swift
    echo "swift:'"$v"': PolarisKeyPlatform and its tests type-check"'
done
