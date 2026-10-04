#!/usr/bin/env bash
# check_flavours.sh: the flavour boundary of polaris-key-platform, checked on the release outputs
# (P5-06; notes/S-10 Recommendation 9). Run after
#
#   ./gradlew :platform:assembleRelease :godot:assembleRelease :boundary:assembleRelease
#
# It reads the two AARs of each module and the :boundary app's release APK per flavour (an empty app
# that packages the platform AAR and the Godot binding with their dependencies, so its manifest is
# the MERGED one and its dex holds every class a game would ship):
#
#   play    no install permission in the merged manifest; no PackageInstaller session creation or
#           commit anywhere in the dex (Play services' GooglePlayServicesUtilLight only READS
#           getAllSessions, notes/S-10 §5, so a bare "PackageInstaller" match would be wrong); no
#           direct-flavour class; no install-status receiver
#   direct  no com.google.android.play class or reference; no play-flavour class; the platform
#           AAR's classes.jar references no Play Core either (P6-09), though it carries the
#           flavour-neutral PlatformIntegrity (which answers Unsupported "outlet" there)
#   both    no native libraries (pure Kotlin: no .so to 16 KB-align, notes/E4 §2.1); the
#           PlatformIntegrity surface is present (P6-09)
#
# Exits non-zero on the first violated rule, printing every violation of that build first.
# Needs the Android SDK (ANDROID_HOME, default ~/Library/Android/sdk) with build-tools.

set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SDK="${ANDROID_HOME:-${ANDROID_SDK_ROOT:-$HOME/Library/Android/sdk}}"
BT="$SDK/build-tools/36.1.0"
if [ ! -x "$BT/dexdump" ]; then
  BT="$(ls -d "$SDK"/build-tools/* 2>/dev/null | tail -n 1)"
fi
DEXDUMP="$BT/dexdump"
AAPT2="$BT/aapt2"
[ -x "$DEXDUMP" ] && [ -x "$AAPT2" ] || { echo "check_flavours: no build-tools under $SDK" >&2; exit 2; }

WORK="$(mktemp -d "${TMPDIR:-/tmp}/pkey-flavours.XXXXXX")"
trap 'rm -rf "$WORK"' EXIT

FAILED=0
fail() { echo "  FAIL: $*"; FAILED=1; }
ok() { echo "  ok: $*"; }

aar() { echo "$ROOT/$1/build/outputs/aar/$2-$3-release.aar"; }
GODOT_DIR="../godot/native/android"

# dex_text <apk> <out>: every dex in the APK, disassembled.
dex_text() {
  local apk="$1" out="$2" d
  d="$WORK/dex.$$"
  rm -rf "$d" && mkdir -p "$d"
  unzip -q -o "$apk" 'classes*.dex' -d "$d"
  : >"$out"
  for f in "$d"/classes*.dex; do
    "$DEXDUMP" -d "$f" >>"$out" 2>/dev/null
  done
}

count() { grep -c -E "$1" "$2" || true; }

for flavor in play direct; do
  echo "── $flavor"
  apk="$ROOT/boundary/build/outputs/apk/$flavor/release/boundary-$flavor-release.apk"
  [ -f "$apk" ] || { echo "check_flavours: $apk missing; run the assembleRelease tasks first" >&2; exit 2; }
  for a in "$(aar platform polaris-key-platform "$flavor")" "$(aar "$GODOT_DIR" polaris-key-godot "$flavor")"; do
    [ -f "$a" ] || { echo "check_flavours: $a missing" >&2; exit 2; }
    if unzip -l "$a" | grep -qE '\.so$'; then fail "$(basename "$a") carries native libraries"; else ok "$(basename "$a") has no native libraries"; fi
    if unzip -p "$a" AndroidManifest.xml | grep -q 'uses-permission'; then
      fail "$(basename "$a") declares a permission (the app decides; the export plugin adds them)"
    else
      ok "$(basename "$a") declares no permission"
    fi
  done

  # The platform AAR's own bytecode (P6-09): Integrity is in both, Play Core only in play.
  jar="$WORK/$flavor.classes.jar"
  unzip -p "$(aar platform polaris-key-platform "$flavor")" classes.jar >"$jar"
  if unzip -l "$jar" | grep -q 'im/plrs/key/platform/PlatformIntegrity.class'; then ok "platform AAR has PlatformIntegrity"; else fail "platform AAR lacks PlatformIntegrity"; fi
  n="$(unzip -p "$jar" '*.class' | LC_ALL=C grep -a -c 'com/google/android/play/' || true)"
  if [ "$flavor" = direct ]; then
    [ "$n" = 0 ] && ok "platform AAR references no Play Core" || fail "platform AAR references Play Core ($n)"
  else
    [ "$n" -ge 1 ] && ok "platform AAR links Play Core" || fail "platform AAR has no Play Core reference"
  fi

  perms="$("$AAPT2" dump permissions "$apk")"
  manifest="$("$AAPT2" dump xmltree "$apk" --file AndroidManifest.xml)"
  dex="$WORK/$flavor.dex.txt"
  dex_text "$apk" "$dex"

  if [ "$flavor" = play ]; then
    for p in REQUEST_INSTALL_PACKAGES UPDATE_PACKAGES_WITHOUT_USER_ACTION INSTALL_PACKAGES ENFORCE_UPDATE_OWNERSHIP; do
      if echo "$perms" | grep -q "android.permission.$p"; then fail "merged manifest has $p"; else ok "merged manifest has no $p"; fi
    done
    if echo "$manifest" | grep -q 'InstallStatusReceiver'; then fail "merged manifest has the install-status receiver"; else ok "no install-status receiver"; fi
    n="$(count 'Landroid/content/pm/PackageInstaller;\.(createSession|openSession|commitSessionAfterInstallConstraintsAreMet)' "$dex")"
    [ "$n" = 0 ] && ok "no PackageInstaller session creation" || fail "$n PackageInstaller session-creation call sites"
    n="$(count 'Landroid/content/pm/PackageInstaller\$Session;\.commit' "$dex")"
    [ "$n" = 0 ] && ok "no Session.commit" || fail "$n Session.commit call sites"
    n="$(count "Class descriptor *: 'Lim/plrs/key/platform/direct/|Class descriptor *: 'Lim/plrs/key/godot/DirectCommands" "$dex")"
    [ "$n" = 0 ] && ok "no direct-flavour class" || fail "$n direct-flavour classes"
    n="$(count "Class descriptor *: 'Lim/plrs/key/platform/play/InAppUpdates;'" "$dex")"
    [ "$n" = 1 ] && ok "In-App Updates present" || fail "In-App Updates missing ($n)"
    n="$(count "Class descriptor *: 'Lcom/google/android/play/core/assetpacks/AssetPackManager;'" "$dex")"
    [ "$n" = 1 ] && ok "Play Asset Delivery present" || fail "Play Asset Delivery missing ($n)"
    n="$(count "Class descriptor *: 'Lim/plrs/key/platform/play/PlayIntegrity;'" "$dex")"
    [ "$n" = 1 ] && ok "Play Integrity present" || fail "Play Integrity missing ($n)"
    n="$(count "Class descriptor *: 'Lim/plrs/key/platform/play/PlayPlatformIntegrity;'" "$dex")"
    [ "$n" = 1 ] && ok "PlatformIntegrity over Play present" || fail "PlatformIntegrity over Play missing ($n)"
  else
    n="$(count 'Lcom/google/android/play/' "$dex")"
    [ "$n" = 0 ] && ok "no Play Core class or reference" || fail "$n Play Core references"
    n="$(count "Class descriptor *: 'Lim/plrs/key/platform/play/|Class descriptor *: 'Lim/plrs/key/godot/PlayCommands" "$dex")"
    [ "$n" = 0 ] && ok "no play-flavour class" || fail "$n play-flavour classes"
    n="$(count "Class descriptor *: 'Lim/plrs/key/platform/PlatformIntegrity;'" "$dex")"
    [ "$n" = 1 ] && ok "PlatformIntegrity present (Unsupported outlet)" || fail "PlatformIntegrity missing ($n)"
    n="$(count 'Landroid/content/pm/PackageInstaller;\.createSession' "$dex")"
    [ "$n" -ge 1 ] && ok "PackageInstaller self-update present" || fail "PackageInstaller self-update missing"
    if echo "$manifest" | grep -q 'im.plrs.key.platform.direct.InstallStatusReceiver'; then ok "install-status receiver declared"; else fail "install-status receiver missing"; fi
    # The install permissions come from the export plugin, never the libraries.
    if echo "$perms" | grep -q 'android.permission.REQUEST_INSTALL_PACKAGES'; then fail "a library added REQUEST_INSTALL_PACKAGES"; else ok "no library-added install permission"; fi
  fi
done

if [ "$FAILED" != 0 ]; then
  echo "check_flavours: FAILED"
  exit 1
fi
echo "check_flavours: both flavours hold the boundary"
