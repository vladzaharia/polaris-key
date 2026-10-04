#!/usr/bin/env bash
# build.sh: builds polaris-key-platform and the Godot binding (both flavours, release) from
# sdks/kotlin, publishes them to the local repository sdks/kotlin/build/repo (P6-09, P6-10: the
# per-flavour coordinates im.plrs.key:polaris-key-{platform,godot}-{play,direct}, never a remote
# repository), checks that publication, and installs the four PUBLISHED AARs where the export plugin
# looks for them:
#
#   sdks/godot/addons/polaris_key/native/android/bin/polaris-key-{platform,godot}-{play,direct}-release.aar
#
# (build products, not committed). A Godot export therefore carries exactly the artifacts the
# local repository holds: polaris-key-platform-<flavour> and the thin binding over it. Needs JDK
# 17+ (JAVA_HOME or `java` on PATH) and the Android SDK (ANDROID_HOME, default
# ~/Library/Android/sdk) with platforms;android-36 and build-tools 36.1.0.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
KOTLIN="$(cd "$HERE/../../../kotlin" && pwd)"
BIN="$(cd "$HERE/../.." && pwd)/addons/polaris_key/native/android/bin"
export ANDROID_HOME="${ANDROID_HOME:-$HOME/Library/Android/sdk}"
(cd "$KOTLIN" && ./gradlew --quiet :godot:checkPlatformOnly \
  :platform:publishAllPublicationsToLocalRepository :godot:publishAllPublicationsToLocalRepository)
"$KOTLIN/tools/check_publication.sh"
VERSION="$(sed -n 's/^ *version = "\(.*\)"/\1/p' "$KOTLIN/build.gradle.kts" | head -n 1)"
REPO="$KOTLIN/build/repo/im/plrs/key"
mkdir -p "$BIN"
for flavor in play direct; do
  for lib in platform godot; do
    /bin/cp -f "$REPO/polaris-key-$lib-$flavor/$VERSION/polaris-key-$lib-$flavor-$VERSION.aar" \
      "$BIN/polaris-key-$lib-$flavor-release.aar"
  done
done
ls -l "$BIN"
