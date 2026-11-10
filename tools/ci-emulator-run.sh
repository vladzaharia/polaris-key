#!/usr/bin/env bash
# Runs the consumer app's instrumented tests inside the emulator action and keeps the output in the
# log given as $1, so tools/ci-emulator-retry.mjs can tell an infrastructure failure from a test
# failure. The file exists as soon as this script starts: if it does not, the emulator never booted.
set -uo pipefail
log="$1"
: >"$log"
cd "$(dirname "$0")/../sdks/kotlin"
./gradlew --no-daemon -p samples/android-consumer connectedLeanDebugAndroidTest connectedPacksDebugAndroidTest 2>&1 | tee -a "$log"
exit "${PIPESTATUS[0]}"
