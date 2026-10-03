#!/usr/bin/env bash
# Runs PolarisKeyPlatform's hosted XCTest project (project.yml) on an iOS simulator: StoreKit
# Testing, the Keychain and AppDistributor, which `swift test` cannot reach (notes/S-09).
#
#   SIM_UDID     a simulator to use (default: a dedicated "pkey-platform-host" iPhone, created on
#                the newest installed iOS runtime and reused; it is erased first, because
#                storekitd keeps a StoreKit configuration per bundle id across runs)
#   BUILD_DIR    where the generated project, derived data and logs go (default: ./build)
#
# Needs Xcode 26+ (the macos-26 CI job) and XcodeGen (`brew install xcodegen`). Uses no Apple
# developer account: the app and the test bundle are ad hoc signed for the simulator.

set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
BUILD="${BUILD_DIR:-$HERE/build}"
mkdir -p "$BUILD/logs" "$HERE/build/generated"

command -v xcodegen >/dev/null || { echo "run.sh: xcodegen is required (brew install xcodegen)" >&2; exit 2; }

udid="${SIM_UDID:-}"
if [ -z "$udid" ]; then
  name="pkey-platform-host"
  udid="$(xcrun simctl list devices available -j | python3 -c '
import json, sys
for rt, devs in json.load(sys.stdin)["devices"].items():
    for d in devs:
        if d["name"] == sys.argv[1]:
            print(d["udid"]); raise SystemExit
' "$name")"
  if [ -z "$udid" ]; then
    # The newest iOS runtime, and an iPhone it supports.
    read -r runtime device_type <<<"$(xcrun simctl list runtimes -j | python3 -c '
import json, sys
rts = [r for r in json.load(sys.stdin)["runtimes"] if r["platform"] == "iOS" and r["isAvailable"]]
rts.sort(key=lambda r: [int(x) for x in r["version"].split(".")])
if rts:
    phones = [t for t in rts[-1].get("supportedDeviceTypes", []) if t["name"].startswith("iPhone")]
    if phones:
        print(rts[-1]["identifier"], phones[-1]["identifier"])')"
    [ -n "${runtime:-}" ] || { echo "run.sh: no iOS simulator runtime with an iPhone installed" >&2; exit 2; }
    udid="$(xcrun simctl create "$name" "$device_type" "$runtime")"
  fi
  xcrun simctl shutdown "$udid" >/dev/null 2>&1 || true
  xcrun simctl erase "$udid"
fi
echo "run.sh: simulator $udid"

(cd "$HERE" && xcodegen generate --spec project.yml --quiet)

set +e
xcodebuild test \
  -project "$HERE/PKPlatformHost.xcodeproj" -scheme PKPlatformHost \
  -destination "platform=iOS Simulator,id=$udid" \
  -test-timeouts-enabled YES -default-test-execution-time-allowance 120 \
  -derivedDataPath "$BUILD/dd" -resultBundlePath "$BUILD/logs/result-$(date +%s).xcresult" \
  CODE_SIGN_IDENTITY=- CODE_SIGN_STYLE=Manual DEVELOPMENT_TEAM= \
  >"$BUILD/logs/xcodebuild-test.log" 2>&1
rc=$?
set -e
grep -E "Test Case .*(passed|failed)|error:|\*\* TEST [A-Z]+ \*\*|Executed [0-9]+ test" "$BUILD/logs/xcodebuild-test.log" || true
if [ "$rc" -ne 0 ]; then
  echo "run.sh: FAILED (exit $rc); log: $BUILD/logs/xcodebuild-test.log" >&2
  exit "$rc"
fi
echo "run.sh: hosted PolarisKeyPlatform tests passed"
