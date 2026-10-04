#!/usr/bin/env bash
# check_publication.sh: the local publication of polaris-key-platform (P6-09) and of the Godot
# Android binding over it, polaris-key-godot (P6-10). Run after
#
#   ./gradlew :platform:publishAllPublicationsToLocalRepository :godot:publishAllPublicationsToLocalRepository
#
# (the Godot half is checked when :godot is part of the build, i.e. when an Android SDK is set.)
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

# The Godot binding (P6-10): per flavour the AAR, POM, sources jar and module metadata; the ONLY
# im.plrs.key dependency, in the POM and in the module metadata, is polaris-key-platform-<same
# flavour> at the same version (no :core, :license, :update, :packs or :sdk; never the other
# flavour); Play Core arrives only through the platform POM. And the Godot export plugin adds, for a
# play export, exactly the Play Core libraries the platform play POM names (android_export.gd's
# PLAY_DEPENDENCIES), so the two lists cannot drift apart again.
GODOT_EXPORT="$ROOT/../godot/addons/polaris_key/native/android_export.gd"
if [ -d "$REPO/polaris-key-godot-play" ] || [ -d "$REPO/polaris-key-godot-direct" ]; then
  for flavor in play direct; do
    echo "── godot $flavor"
    a="polaris-key-godot-$flavor"
    dir="$REPO/$a/$VERSION"
    [ -d "$dir" ] || { fail "$dir missing; run :godot:publishAllPublicationsToLocalRepository"; continue; }
    for f in "$a-$VERSION.aar" "$a-$VERSION.pom" "$a-$VERSION.module" "$a-$VERSION-sources.jar"; do
      [ -s "$dir/$f" ] && ok "$f" || fail "$f missing"
    done
    pom="$dir/$a-$VERSION.pom"
    sdk_deps="$(sed '/<dependencies>/,$!d' "$pom" | tr -d ' \n' | grep -o '<groupId>im.plrs.key</groupId><artifactId>[^<]*</artifactId><version>[^<]*</version>' |
      sed 's|<groupId>im.plrs.key</groupId><artifactId>\([^<]*\)</artifactId><version>\([^<]*\)</version>|\1:\2|' | sort -u | tr '\n' ' ' | sed 's/ $//')"
    if [ "$sdk_deps" = "polaris-key-platform-$flavor:$VERSION" ]; then
      ok "$a's POM depends on polaris-key-platform-$flavor:$VERSION and no other SDK module"
    else
      fail "$a's POM SDK dependencies are '$sdk_deps', expected 'polaris-key-platform-$flavor:$VERSION'"
    fi
    mod_deps="$(tr -d ' \n' <"$dir/$a-$VERSION.module" | grep -o '"group":"im.plrs.key","module":"[^"]*"' |
      sed 's/.*"module":"\([^"]*\)"/\1/' | grep -v "^$a\$" | sort -u | tr '\n' ' ' | sed 's/ $//')"
    if [ "$mod_deps" = "polaris-key-platform-$flavor" ]; then
      ok "$a's module metadata depends on polaris-key-platform-$flavor only"
    else
      fail "$a's module metadata SDK dependencies are '$mod_deps', expected 'polaris-key-platform-$flavor'"
    fi
    if grep -q 'com.google.android.play' "$pom"; then fail "$a's POM names Play Core itself"; else ok "$a's POM names no Play Core of its own"; fi
    if ls "$dir" | grep -qE '\.(asc|sig)$'; then fail "$a is signed (no signing in this program)"; else ok "$a carries no signature"; fi
  done
  echo "── godot export plugin"
  play_pom="$REPO/polaris-key-platform-play/$VERSION/polaris-key-platform-play-$VERSION.pom"
  want="$(sed '/<dependencies>/,$!d' "$play_pom" | tr -d ' \n' | grep -o '<groupId>com.google.android.play</groupId><artifactId>[^<]*</artifactId><version>[^<]*</version>' |
    sed 's|<groupId>\([^<]*\)</groupId><artifactId>\([^<]*\)</artifactId><version>\([^<]*\)</version>|\1:\2:\3|' | sort | tr '\n' ' ' | sed 's/ $//')"
  have="$(sed -n 's/^const PLAY_DEPENDENCIES := \[\(.*\)\]$/\1/p' "$GODOT_EXPORT" | tr ',' '\n' | tr -d ' "' | grep . | sort | tr '\n' ' ' | sed 's/ $//')"
  if [ -n "$want" ] && [ "$want" = "$have" ]; then
    ok "android_export.gd's PLAY_DEPENDENCIES match the platform play POM ($want)"
  else
    fail "android_export.gd's PLAY_DEPENDENCIES are '$have'; the platform play POM names '$want'"
  fi
fi

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
echo "check_publication: both flavours published locally (platform, and the Godot binding when built)"
