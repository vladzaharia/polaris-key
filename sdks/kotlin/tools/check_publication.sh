#!/usr/bin/env bash
# check_publication.sh: the local publication of polaris-key-platform (P6-09). Run after
#
#   ./gradlew :platform:publishAllPublicationsToLocalRepository
#
# For each flavour, build/repo/im/plrs/key/polaris-key-platform-<flavour>/<version>/ must hold the
# AAR, the POM, the sources jar and the Gradle module metadata; no POM may depend on an im.plrs.key
# module (the module is standalone), and the direct POM names no Play Core library. No signature is
# produced, and no build script configures signing, Sonatype or a Central portal: the artifacts reach
# adopters only through the Polaris Key Maven feed (F-07, F-10).

set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
REPO="$ROOT/build/repo/im/plrs/key"
VERSION="$(sed -n 's/^ *version = "\(.*\)"/\1/p' "$ROOT/build.gradle.kts" | head -n 1)"
[ -n "$VERSION" ] || { echo "check_publication: no version in build.gradle.kts" >&2; exit 2; }

FAILED=0
fail() { echo "  FAIL: $*"; FAILED=1; }
ok() { echo "  ok: $*"; }

for flavor in play direct; do
  echo "── $flavor"
  a="polaris-key-platform-$flavor"
  dir="$REPO/$a/$VERSION"
  [ -d "$dir" ] || { echo "check_publication: $dir missing; run publishAllPublicationsToLocalRepository first" >&2; exit 2; }
  for f in "$a-$VERSION.aar" "$a-$VERSION.pom" "$a-$VERSION.module" "$a-$VERSION-sources.jar"; do
    [ -s "$dir/$f" ] && ok "$f" || fail "$f missing"
  done
  pom="$dir/$a-$VERSION.pom"
  if grep -q '<groupId>im.plrs.key</groupId>' <(sed '/<dependencies>/,$!d' "$pom"); then
    fail "$a's POM depends on an im.plrs.key module"
  else
    ok "$a's POM depends on no SDK module"
  fi
  if [ "$flavor" = direct ]; then
    if grep -q 'com.google.android.play' "$pom"; then fail "the direct POM names Play Core"; else ok "the direct POM names no Play Core"; fi
  else
    grep -q '<artifactId>integrity</artifactId>' "$pom" && ok "the play POM names Play Integrity" || fail "the play POM lacks Play Integrity"
  fi
  if grep -q -- "$a-$VERSION-sources.jar" "$dir/$a-$VERSION.module"; then
    ok "$a's module metadata lists the sources"
  else
    fail "$a's module metadata lists no sources"
  fi
  if ls "$dir" | grep -qE '\.(asc|sig)$'; then fail "$a is signed (no signing in this program)"; else ok "$a carries no signature"; fi
done

echo "── build scripts"
if grep -rlE --include='*.gradle.kts' --include='*.properties' -i 'id\("signing"\)|`signing`|sonatype|nexus-publish|central\.sonatype|vanniktech' "$ROOT" --exclude-dir=build --exclude-dir=.gradle >/dev/null 2>&1; then
  fail "a build script configures signing or a Central publication"
else
  ok "no signing, Sonatype or Central configuration"
fi

if [ "$FAILED" != 0 ]; then
  echo "check_publication: FAILED"
  exit 1
fi
echo "check_publication: both flavours published locally"
