#!/usr/bin/env bash
# Runs the consumer app's instrumented tests inside the emulator action and keeps the output in the
# log given as $1, so tools/ci-emulator-retry.mjs can tell an infrastructure failure from a test
# failure. The file exists as soon as this script starts: if it does not, the emulator never booted.
set -uo pipefail
log="$1"
: >"$log"
cd "$(dirname "$0")/../sdks/kotlin"
# uninstallAll between the two runs: the lean app and its test APK left on the device take the data
# partition the packs APKs (with zstd-jni's natives) then need (install-write failures on API 24, QA Q6).
# As in the single Gradle run this replaces, a failed lean run stops before the packs run.
gradle=(./gradlew --no-daemon -p samples/android-consumer)
"${gradle[@]}" connectedLeanDebugAndroidTest 2>&1 | tee -a "$log"
lean="${PIPESTATUS[0]}"
[ "$lean" -eq 0 ] || exit "$lean"
"${gradle[@]}" uninstallAll 2>&1 | tee -a "$log"
"${gradle[@]}" connectedPacksDebugAndroidTest 2>&1 | tee -a "$log"
exit "${PIPESTATUS[0]}"
