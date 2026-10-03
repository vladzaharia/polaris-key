#!/usr/bin/env bash
# build.sh: builds polaris-key-platform and the Godot binding (both flavours, release) from
# sdks/kotlin and installs the four AARs where the export plugin looks for them:
#
#   sdks/godot/addons/polaris_key/native/android/bin/polaris-key-{platform,godot}-{play,direct}-release.aar
#
# (build products, not committed). Needs JDK 17+ (JAVA_HOME or `java` on PATH) and the Android SDK
# (ANDROID_HOME, default ~/Library/Android/sdk) with platforms;android-36 and build-tools 36.1.0.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
KOTLIN="$(cd "$HERE/../../../kotlin" && pwd)"
BIN="$(cd "$HERE/../.." && pwd)/addons/polaris_key/native/android/bin"
export ANDROID_HOME="${ANDROID_HOME:-$HOME/Library/Android/sdk}"
(cd "$KOTLIN" && ./gradlew --quiet :platform:assembleRelease :godot:assembleRelease)
mkdir -p "$BIN"
for flavor in play direct; do
  cp "$KOTLIN/platform/build/outputs/aar/polaris-key-platform-$flavor-release.aar" "$BIN/"
  cp "$HERE/build/outputs/aar/polaris-key-godot-$flavor-release.aar" "$BIN/"
done
ls -l "$BIN"
