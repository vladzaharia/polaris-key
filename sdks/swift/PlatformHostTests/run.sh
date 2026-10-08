#!/usr/bin/env bash
# Runs PolarisKeyPlatform's hosted XCTest project (project.yml) on an iOS simulator: StoreKit
# Testing, the Keychain and AppDistributor, which `swift test` cannot reach (notes/S-09).
#
#   run.sh          build, wait for the simulator to settle, warm StoreKit up, then test
#   run.sh --boot   only create (or find), erase and boot the simulator, and print its UDID. CI
#                   runs this at the start of the job, so the first boot settles while the
#                   libraries build, and hands the UDID back as SIM_UDID
#
#   SIM_UDID     a simulator to use as it is (default: a dedicated "pkey-platform-host" iPhone,
#                created on the newest installed iOS runtime and reused; it is erased first,
#                because storekitd keeps a StoreKit configuration per bundle id across runs)
#   BUILD_DIR    where the generated project, derived data and logs go (default: ./build)
#   SETTLE_MAX   the longest wait, in seconds, for the simulator to go quiet (default 300)
#
#   XCODEGEN     the xcodegen binary (default: xcodegen on PATH; CI pins 2.45.4 by SHA-256)
#
# Needs Xcode 26+ (the macos-26 CI job) and XcodeGen. Uses no Apple
# developer account: the app and the test bundle are ad hoc signed for the simulator.
#
# Why it waits: a new simulator's first boot (wallpapers, Health, Fitness, AppleMediaServices'
# first downloads) keeps several cores busy for minutes, and StoreKit Testing calls through the
# same daemons (accountsd, amsengagementd). On the 3-vCPU CI runner, tests started four minutes
# after the boot saw purchases, AppTransaction and refund updates stall for 10 to 130 s (4 of 59
# main runs, 2026-10-05 to 2026-10-08). The first StoreKit call also makes AppleMediaServices
# fetch its bag and engagement content, so two read-only StoreKit tests run once before the suite.

set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
BUILD="${BUILD_DIR:-$HERE/build}"
SETTLE_MAX="${SETTLE_MAX:-300}"
# Quiet: the simulator's processes together use under SETTLE_CPU percent of one core (ps's
# decaying average) for SETTLE_FOR seconds in a row.
SETTLE_CPU=50
SETTLE_FOR=30

# The named simulator, created on the newest iOS runtime if it does not exist, then erased.
named_simulator() {
  local name="pkey-platform-host" udid runtime device_type
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
  xcrun simctl erase "$udid" >&2
  echo "$udid"
}

udid="${SIM_UDID:-}"
[ -n "$udid" ] || udid="$(named_simulator)"

if [ "${1:-}" = "--boot" ]; then
  xcrun simctl boot "$udid" >/dev/null 2>&1 || true
  echo "$udid"
  exit 0
fi

XCODEGEN="${XCODEGEN:-xcodegen}"
command -v "$XCODEGEN" >/dev/null || { echo "run.sh: xcodegen is required (XCODEGEN=<path>, or brew install xcodegen)" >&2; exit 2; }
mkdir -p "$BUILD/logs" "$HERE/build/generated"

echo "run.sh: simulator $udid"
# Boot it here, with a bound: when xcodebuild has to boot a simulator that does not come up, it
# falls into `simctl diagnose` and can sit there indefinitely without a useful message.
xcrun simctl boot "$udid" >/dev/null 2>&1 || true
booted=0
for _ in $(seq 1 180); do
  if xcrun simctl list devices | grep -F "$udid" | grep -q "(Booted)"; then booted=1; break; fi
  sleep 1
done
[ "$booted" = 1 ] || { echo "run.sh: simulator $udid did not boot within 180 s" >&2; exit 3; }
xcrun simctl bootstatus "$udid" -b >/dev/null

# Waits until the simulator is quiet (SETTLE_CPU, SETTLE_FOR), for at most SETTLE_MAX seconds;
# past that the tests run anyway and the log names what was still busy.
settle() {
  local launchd cpu busy quiet=0 waited=0
  launchd="$(pgrep -f "launchd_sim.*$udid" | head -1 || true)"
  [ -n "$launchd" ] || { echo "run.sh: no launchd_sim for $udid, so not waiting"; return 0; }
  while :; do
    # The runtime's paths hold spaces ("iOS 26.5.simruntime"), so the name is the command's last
    # path component, not the third field.
    read -r cpu busy <<<"$(ps -Ao ppid=,pcpu=,comm= | awk -v l="$launchd" '
      $1 == l {
        s += $2; c = $0; sub(/^ *[0-9]+ +[0-9.]+ +/, "", c); n = split(c, p, "/")
        if ($2 >= 5) b = b " " p[n] "=" int($2) "%"
      }
      END { printf "%d%s\n", s, b }')"
    if [ "$cpu" -lt "$SETTLE_CPU" ]; then quiet=$((quiet + 5)); else quiet=0; fi
    if [ "$quiet" -ge "$SETTLE_FOR" ]; then
      echo "run.sh: simulator quiet $1 after ${waited} s (${cpu}% CPU)"
      return 0
    fi
    if [ "$waited" -ge "$SETTLE_MAX" ]; then
      echo "run.sh: simulator still busy $1 after ${SETTLE_MAX} s (${cpu}% CPU:${busy:- nothing over 5%}); testing anyway" >&2
      return 0
    fi
    [ $((waited % 30)) -eq 0 ] && echo "run.sh: waiting for the simulator $1: ${cpu}% CPU${busy:+ (}${busy# }${busy:+)}"
    sleep 5
    waited=$((waited + 5))
  done
}

(cd "$HERE" && "$XCODEGEN" generate --spec project.yml --quiet)

XB=(
  -project "$HERE/PKPlatformHost.xcodeproj" -scheme PKPlatformHost
  -destination "platform=iOS Simulator,id=$udid"
  -derivedDataPath "$BUILD/dd"
  CODE_SIGN_IDENTITY=- CODE_SIGN_STYLE=Manual DEVELOPMENT_TEAM=
)
TIMEOUTS=(-test-timeouts-enabled YES -default-test-execution-time-allowance 120)

xcodebuild build-for-testing "${XB[@]}" >"$BUILD/logs/xcodebuild-build.log" 2>&1 || {
  tail -40 "$BUILD/logs/xcodebuild-build.log"
  echo "run.sh: build FAILED; log: $BUILD/logs/xcodebuild-build.log" >&2
  exit 65
}

settle "after the boot"
# The warm-up's result does not count: the suite below runs both tests again.
xcodebuild test-without-building "${XB[@]}" "${TIMEOUTS[@]}" \
  -only-testing:PKPlatformHostTests/StoreKitHostTests/testProductsLoad \
  -only-testing:PKPlatformHostTests/StoreKitHostTests/testAppTransaction \
  -resultBundlePath "$BUILD/logs/warmup-$(date +%s).xcresult" \
  >"$BUILD/logs/xcodebuild-warmup.log" 2>&1 || true
echo "run.sh: StoreKit warm-up: $(grep -cE "Test Case .* passed" "$BUILD/logs/xcodebuild-warmup.log" || true) of 2 passed"
settle "after the StoreKit warm-up"

set +e
xcodebuild test-without-building "${XB[@]}" "${TIMEOUTS[@]}" \
  -resultBundlePath "$BUILD/logs/result-$(date +%s).xcresult" \
  >"$BUILD/logs/xcodebuild-test.log" 2>&1
rc=$?
set -e
grep -E "Test Case .*(passed|failed)|error:|\*\* TEST [A-Z]+ \*\*|Executed [0-9]+ test" "$BUILD/logs/xcodebuild-test.log" || true
if [ "$rc" -ne 0 ]; then
  echo "run.sh: FAILED (exit $rc); log: $BUILD/logs/xcodebuild-test.log" >&2
  exit "$rc"
fi
echo "run.sh: hosted PolarisKeyPlatform tests passed"
