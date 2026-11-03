#!/usr/bin/env bash
# export_check.sh: the Godot Android binding end to end (P5-06). Exports the device probe
# (e2e/game, with the Polaris Key addon copied in) through Godot's Gradle build, headless, with the
# real export plugin, and checks what each preset carries:
#
#   direct  APK, versionCodes 1 and 2: the merged manifest has REQUEST_INSTALL_PACKAGES and
#           UPDATE_PACKAGES_WITHOUT_USER_ACTION (and not ENFORCE_UPDATE_OWNERSHIP), the
#           PolarisKeyAndroid v2 meta-data and the install-status receiver; the dex has the direct
#           classes and no Play Core, no androidx/credentials and no googleid
#   play    AAB with one on-demand asset pack (`probeod`, a 2 MB data-only .pck), then a
#           `bundletool build-apks --local-testing` set: no install permission, no session commit,
#           no direct class, and androidx/credentials plus googleid packaged; a second play AAB with
#           polaris_key/play_games on carries the Play Games library and the APP_ID meta-data, the first none
#
# With DEVICE=<adb serial> it also runs the probe there (an emulator is enough; no Play Store, no
# Play Console):
#   direct  capabilities, install source, a Keystore round trip in the real AndroidKeyStore,
#           In-App Updates refused (outlet), refusals (wrong hash, public path), then a REAL silent
#           self-update v1 -> v2 THROUGH THE UPDATE DRIVER (PKeyDirectAdapter -> PKeyApkUpdate:
#           download from a loopback server over adb reverse, the record's size and SHA-256,
#           PackageInstaller) and, on the next launch, the journaled outcome and the self-updated
#           install source
#   play    capabilities, Keystore, In-App Updates refused for a non-Play install (outlet), and Play
#           Asset Delivery under local testing: fetch, COMPLETED, getPackLocation, mount
#
# Native redirect (I-48.17b): every export merges the redirect activity (not exported, no intent filter); a direct export
# whose project settings register a scheme and a claimed link exports it with exactly those two filters.
#
# Background transfer (U-41.6b): every export carries androidx.work (WorkManager) in the dex and, with the
# polaris_key/cloud_sync_background option off, NEITHER RUN_USER_INITIATED_JOBS nor POST_NOTIFICATIONS in the merged
# manifest (D-10: the export adds them only when opted in); a third, debuggable direct export with the option on keeps both. With DEVICE=<an API 34+ emulator>
# that export uploads 30 MiB as four parts to a loopback server (adb reverse, e2e/bulk_server.py), the script
# presses Home while the parts are in flight, and checks that every part arrives with the bearer, and that the
# notification reads "Syncing" (dumpsys notification).
#
# Env: GODOT_BIN (default: godot on PATH; 4.7.2 with its export templates installed, or
#      GODOT_TEMPLATES=<dir with android_source.zip and version.txt>), JAVA_HOME (JDK 17+; default
#      mise's temurin-17 when mise is there), ANDROID_HOME (default ~/Library/Android/sdk),
#      BUNDLETOOL (bundletool-all-1.18.3.jar, for play), SKIP_BUILD=1 (reuse the AARs in bin/),
#      DEVICE (adb serial), ANDROID_ADB_SERVER_PORT (a private adb server is wise on shared hosts).
# Output and logs: sdks/godot/build/android_export_check/. Throwaway keystores only.
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
SDKG="$(cd "$HERE/../.." && pwd)"
OUT="$SDKG/build/android_export_check"
LOGS="$OUT/logs"
export ANDROID_HOME="${ANDROID_HOME:-$HOME/Library/Android/sdk}"
if [ -z "${JAVA_HOME:-}" ] && command -v mise >/dev/null 2>&1; then
  JAVA_HOME="$(mise where java@temurin-17.0.20+8 2>/dev/null || mise where java 2>/dev/null || true)"
fi
export JAVA_HOME="${JAVA_HOME:?set JAVA_HOME to a JDK 17+}"
BT="$ANDROID_HOME/build-tools/36.1.0"
[ -x "$BT/aapt2" ] || BT="$(ls -d "$ANDROID_HOME"/build-tools/* | tail -n 1)"
ADB="$ANDROID_HOME/platform-tools/adb"
GODOT="${GODOT_BIN:-$(command -v godot || true)}"
[ -n "$GODOT" ] || { echo "export_check: no Godot (set GODOT_BIN)" >&2; exit 2; }

rm -rf "$OUT"
mkdir -p "$LOGS" "$OUT/keys"
: >"$SDKG/build/.gdignore" 2>/dev/null || true
FAILED=0
fail() { echo "  FAIL: $*"; FAILED=1; }
ok() { echo "  ok: $*"; }

# 1. The AARs.
if [ "${SKIP_BUILD:-0}" != 1 ]; then
  "$HERE/build.sh" >"$LOGS/build.log" 2>&1 || { tail -30 "$LOGS/build.log"; exit 1; }
fi

# 2. A self-contained editor copy whose settings point at the JDK and the SDK.
resolve() {
  local p="$1" l
  while [ -L "$p" ]; do
    l="$(readlink "$p")"
    case "$l" in /*) p="$l" ;; *) p="$(dirname "$p")/$l" ;; esac
  done
  echo "$(cd "$(dirname "$p")" && pwd)/$(basename "$p")"
}
REAL="$(resolve "$(command -v "$GODOT")")"
ED="$OUT/editor"
mkdir -p "$ED"
case "$REAL" in
  */Contents/MacOS/*)
    APP="${REAL%/Contents/MacOS/*}"
    cp -cR "$APP" "$ED/" 2>/dev/null || cp -R "$APP" "$ED/"
    GODOT="$ED/$(basename "$APP")/Contents/MacOS/$(basename "$REAL")"
    ;;
  *)
    cp "$REAL" "$ED/"
    GODOT="$ED/$(basename "$REAL")"
    ;;
esac
: >"$ED/._sc_"
VERSION="$("$GODOT" --headless --version 2>/dev/null | head -n 1)" # 4.7.2.stable.official.<hash>
MAJMIN="$(echo "$VERSION" | cut -d. -f1-2)"
TVER="$(echo "$VERSION" | cut -d. -f1-4)"
TPL="${GODOT_TEMPLATES:-$HOME/Library/Application Support/Godot/export_templates/$TVER}"
[ -f "$TPL/android_source.zip" ] || { echo "export_check: no android_source.zip in $TPL" >&2; exit 2; }
mkdir -p "$ED/editor_data/export_templates"
ln -s "$TPL" "$ED/editor_data/export_templates/$TVER"
cat >"$ED/editor_data/editor_settings-$MAJMIN.tres" <<EOT
[gd_resource type="EditorSettings" format=3]

[resource]
export/android/java_sdk_path = "$JAVA_HOME"
export/android/android_sdk_path = "$ANDROID_HOME"
EOT

# 3. Throwaway signing key.
"$JAVA_HOME/bin/keytool" -genkeypair -keystore "$OUT/keys/probe.keystore" -alias probe -storepass probetest \
  -keypass probetest -keyalg RSA -keysize 2048 -validity 3650 -dname "CN=P5-06 throwaway" >/dev/null 2>&1

# project <dir> <flavor> <versionCode> <format 0 apk | 1 aab> <package> [outlet]
project() {
  local B="$1" flavor="$2" vc="$3" format="$4" pkg="$5" outlet="${6:-}"
  [ -n "$outlet" ] || outlet="$([ "$flavor" = play ] && echo play || echo direct)"
  rm -rf "$B" && mkdir -p "$B/addons"
  cp -R "$HERE/e2e/game/." "$B/"
  # Project settings for the export (the native redirect registration, I-48.17b): PROJECT_EXTRA is appended to project.godot.
  if [ -n "${PROJECT_EXTRA:-}" ]; then printf '\n%s\n' "$PROJECT_EXTRA" >>"$B/project.godot"; fi
  rsync -a --exclude 'native/ios/' "$SDKG/addons/polaris_key" "$B/addons/"
  mkdir -p "$B/android/build"
  (cd "$B/android/build" && unzip -q "$TPL/android_source.zip")
  echo "$TVER" >"$B/android/.build_version"
  # The device probe talks http to a loopback server: the app must allow cleartext (a throwaway project only).
  if [ -n "${CLEARTEXT:-}" ]; then
    sed -i.bak 's|<application|<application android:usesCleartextTraffic="true"|' "$B/android/build/src/main/AndroidManifest.xml"
  fi
  : >"$B/android/build/.gdignore"
  if [ "$flavor" = play ]; then
    local n=probeod
    mkdir -p "$B/android/build/$n/src/main/assets"
    printf "plugins {\n    id 'com.android.asset-pack'\n}\n\nassetPack {\n    packName = \"%s\"\n    dynamicDelivery {\n        deliveryType = \"on-demand\"\n    }\n}\n" "$n" >"$B/android/build/$n/build.gradle"
    python3 "$SDKG/../../docs/research/2026-09-29-godot-omniplatform/prototype/platform-mechanics/tools/gen_packs.py" \
      "$B/android/build/$n/src/main/assets/$n.pck" 2000000 16 "data/$n" >/dev/null
    echo "include ':$n'" >>"$B/android/build/settings.gradle"
    sed -i.bak 's|assetPacks = \[":assetPackInstallTime"\]|assetPacks = [":assetPackInstallTime", ":probeod"]|' "$B/android/build/build.gradle"
  fi
  cat >"$B/export_presets.cfg" <<EOT
[preset.0]

name="Android"
platform="Android"
runnable=true
dedicated_server=false
custom_features=""
export_filter="all_resources"
include_filter=""
exclude_filter=""
export_path=""
script_export_mode=2

[preset.0.options]

gradle_build/use_gradle_build=true
gradle_build/export_format=$format
architectures/armeabi-v7a=false
architectures/arm64-v8a=true
architectures/x86=false
architectures/x86_64=false
keystore/debug="$OUT/keys/probe.keystore"
keystore/debug_user="probe"
keystore/debug_password="probetest"
keystore/release="$OUT/keys/probe.keystore"
keystore/release_user="probe"
keystore/release_password="probetest"
version/code=$vc
version/name="1.0.$vc"
package/unique_name="$pkg"
package/name="PKey probe"
package/signed=true
permissions/internet=true
polaris_key/android_flavor="$flavor"
polaris_key/outlet="$outlet"
${PRESET_EXTRA:-}
EOT
}

# export_one <tag> <flavor> <versionCode> <format> <package> [outlet]
export_one() {
  local tag="$1" B="$OUT/proj/$1" ext
  project "$B" "$2" "$3" "$4" "$5" "${6:-}"
  ext=$([ "$4" = 1 ] && echo aab || echo apk)
  "$GODOT" --headless --path "$B" --import >"$LOGS/import_$tag.log" 2>&1 || true
  local t0
  t0=$(date +%s)
  if ! "$GODOT" --headless --path "$B" --export-"${MODE:-release}" Android "$OUT/$tag.$ext" >"$LOGS/export_$tag.log" 2>&1; then
    tail -40 "$LOGS/export_$tag.log"
    fail "export $tag"
    return 1
  fi
  echo "── $tag: exported in $(($(date +%s) - t0)) s ($(du -k "$OUT/$tag.$ext" | cut -f1) KB)"
  grep -h "Polaris Key Android plugin" "$LOGS/export_$tag.log" | sed 's/^/  /' || true
}

dex_has() { # dex_has <apk> <regex> -> count
  local d="$OUT/dex_$$" n=0
  rm -rf "$d" && mkdir -p "$d"
  unzip -q -o "$1" 'classes*.dex' -d "$d"
  for f in "$d"/classes*.dex; do
    n=$((n + $("$BT/dexdump" -d "$f" 2>/dev/null | grep -c -E "$2" || true)))
  done
  rm -rf "$d"
  echo "$n"
}

# The native redirect (I-48.17b): the redirect activity is always merged (not exported, no filter); with a scheme or
# link registered it is exported with exactly that filter. $3 = scheme (or "") and $4 = claimed host (or "") expected.
check_redirect() { # check_redirect <apk> <label> <scheme|""> <claimed host|"">
  local apk="$1" label="$2" scheme="$3" host="$4" m act
  m="$("$BT/aapt2" dump xmltree "$apk" --file AndroidManifest.xml)"
  # The redirect activity's element: from its name line to the next activity or alias.
  act="$(echo "$m" | awk '/E: activity/{on=0} /android:name.*PKeyGodotRedirectActivity/{on=1} on{print}')"
  echo "$m" | grep -q 'im.plrs.key.godot.PKeyGodotRedirectActivity' && ok "$label: the redirect activity is merged" || { fail "$label: no PKeyGodotRedirectActivity in the merged manifest"; return; }
  [ "$(dex_has "$apk" "Class descriptor *: 'Lim/plrs/key/godot/PKeyGodotRedirectActivity;'")" = 1 ] && ok "$label: redirect activity class packaged" || fail "$label: redirect activity class missing"
  [ -n "$act" ] || { fail "$label: could not read the redirect activity from the manifest"; return; }
  if [ -z "$scheme" ] && [ -z "$host" ]; then
    echo "$act" | grep -q 'android.intent.action.VIEW' && fail "$label: an intent filter without a registered redirect" || ok "$label: no intent filter when nothing is registered"
    echo "$act" | grep -q 'android:exported.*=false' && ok "$label: the redirect activity is not exported" || fail "$label: the redirect activity is exported with nothing registered"
  else
    echo "$act" | grep -q 'android.intent.action.VIEW' && ok "$label: the VIEW filter is present" || fail "$label: no VIEW filter for the registered redirect"
    echo "$act" | grep -q 'android:exported.*=true' && ok "$label: the redirect activity is exported (registered)" || fail "$label: the redirect activity is not exported"
    [ -z "$scheme" ] || { echo "$act" | grep -q "$scheme" && ok "$label: the scheme filter" || fail "$label: no filter for scheme $scheme"; }
    [ -z "$host" ] || { echo "$act" | grep -q "$host" && ok "$label: the claimed link filter" || fail "$label: no filter for host $host"; }
  fi
}

check_apk() { # check_apk <apk> <flavor> [bg: the cloud_sync_background option is on]
  local apk="$1" flavor="$2" bg="${3:-off}" perms manifest
  perms="$("$BT/aapt2" dump permissions "$apk")"
  manifest="$("$BT/aapt2" dump xmltree "$apk" --file AndroidManifest.xml)"
  echo "$manifest" | grep -q 'org.godotengine.plugin.v2.PolarisKeyAndroid' && ok "$flavor: v2 plugin meta-data" || fail "$flavor: no PolarisKeyAndroid meta-data"
  [ "$(dex_has "$apk" "Class descriptor *: 'Lim/plrs/key/godot/PolarisKeyAndroidPlugin;'")" = 1 ] && ok "$flavor: plugin class packaged" || fail "$flavor: plugin class missing"
  # P6-10: the binding is one thin layer over polaris-key-platform. No other SDK module (:core,
  # :license, :update, :packs, :sdk) is in the game: Godot verifies in its own GDScript core.
  local sdk_all sdk_ours
  sdk_all="$(dex_has "$apk" "Class descriptor *: 'Lim/plrs/key/")"
  sdk_ours="$(dex_has "$apk" "Class descriptor *: 'Lim/plrs/key/(godot|platform)/")"
  if [ "$sdk_ours" -gt 0 ] && [ "$sdk_all" = "$sdk_ours" ]; then
    ok "$flavor: only im.plrs.key.godot and im.plrs.key.platform classes from the SDK ($sdk_ours)"
  else
    fail "$flavor: an SDK class outside the binding and the platform module is packaged"
  fi
  # U-41.6b: the AARs carry no transitive dependencies, so the export adds WorkManager; D-10 declares the job and
  # notification permissions only when the preset opted in.
  [ "$(dex_has "$apk" "Class descriptor *: 'Landroidx/work/WorkManager;'")" = 1 ] && ok "$flavor: androidx.work (WorkManager) packaged" || fail "$flavor: androidx.work missing from the dex (SyncTransfers would not link)"
  for p in RUN_USER_INITIATED_JOBS POST_NOTIFICATIONS; do
    if [ "$bg" = on ]; then
      echo "$perms" | grep -q "android.permission.$p" && ok "$flavor (background on): $p kept" || fail "$flavor (background on): $p missing"
    else
      echo "$perms" | grep -q "android.permission.$p" && fail "$flavor (background off): $p present" || ok "$flavor (background off): no $p"
    fi
  done
  echo "$manifest" | grep -q 'im.plrs.key.platform.transfer.SyncTransferJob' && ok "$flavor: the transfer job service is merged" || fail "$flavor: no SyncTransferJob in the merged manifest"
  if [ "$flavor" = direct ]; then
    for p in REQUEST_INSTALL_PACKAGES UPDATE_PACKAGES_WITHOUT_USER_ACTION; do
      echo "$perms" | grep -q "android.permission.$p" && ok "direct: $p" || fail "direct: no $p"
    done
    echo "$perms" | grep -q ENFORCE_UPDATE_OWNERSHIP && fail "direct: ENFORCE_UPDATE_OWNERSHIP present" || ok "direct: no ENFORCE_UPDATE_OWNERSHIP"
    echo "$manifest" | grep -q 'im.plrs.key.platform.direct.InstallStatusReceiver' && ok "direct: install-status receiver" || fail "direct: no receiver"
    [ "$(dex_has "$apk" 'Lcom/google/android/play/')" = 0 ] && ok "direct: no Play Core" || fail "direct: Play Core present"
    [ "$(dex_has "$apk" 'Landroidx/credentials/|Lcom/google/android/libraries/identity/googleid/')" = 0 ] && ok "direct: no Credential Manager or googleid" || fail "direct: Credential Manager or googleid present"
  else
    for p in REQUEST_INSTALL_PACKAGES UPDATE_PACKAGES_WITHOUT_USER_ACTION ENFORCE_UPDATE_OWNERSHIP; do
      echo "$perms" | grep -q "android.permission.$p" && fail "play: $p present" || ok "play: no $p"
    done
    [ "$(dex_has "$apk" 'PackageInstaller;\.createSession|PackageInstaller\$Session;\.commit')" = 0 ] && ok "play: no session creation or commit" || fail "play: session code present"
    [ "$(dex_has "$apk" "Class descriptor *: 'Lim/plrs/key/platform/direct/")" = 0 ] && ok "play: no direct class" || fail "play: direct class present"
    [ "$(dex_has "$apk" "Class descriptor *: 'Lim/plrs/key/platform/play/InAppUpdates;'")" = 1 ] && ok "play: In-App Updates packaged" || fail "play: In-App Updates missing"
    [ "$(dex_has "$apk" "Class descriptor *: 'Lcom/google/android/play/core/integrity/StandardIntegrityManager;'")" = 1 ] && ok "play: the Play Integrity library packaged" || fail "play: the Play Integrity library missing (PlayIntegrity would not link)"
    [ "$(dex_has "$apk" "Class descriptor *: 'Landroidx/credentials/CredentialManager;'")" = 1 ] && ok "play: androidx/credentials packaged" || fail "play: androidx/credentials missing (GoogleSignIn would not link)"
    [ "$(dex_has "$apk" "Class descriptor *: 'Lcom/google/android/libraries/identity/googleid/GetGoogleIdOption;'")" = 1 ] && ok "play: googleid packaged" || fail "play: googleid missing"
  fi
}

export_one direct-v1 direct 1 0 im.plrs.key.probe.direct
export_one direct-v2 direct 2 0 im.plrs.key.probe.direct
export_one play-v1 play 1 1 im.plrs.key.probe.play
# Background transfer on (U-41.6b): a debuggable direct export that allows cleartext, so the device run can send
# to a loopback server (the plugin takes loopback http only from a debuggable app).
PRESET_EXTRA=$'polaris_key/cloud_sync_background=true' MODE=debug CLEARTEXT=1 \
  export_one direct-bg direct 1 0 im.plrs.key.probe.bg
# The native redirect registration (I-48.17b): a scheme and a claimed link in the project settings, on a direct export.
PROJECT_EXTRA=$'[polaris_key]\n\nnative_redirect/scheme="com.example.probe"\nnative_redirect/claimed_uri="https://probe.example.test/open/pkey"' \
  export_one direct-redirect direct 1 0 im.plrs.key.probe.redirect
# The Play Games opt-in (I-48.7a): the library and the APP_ID meta-data arrive only with the option on.
PRESET_EXTRA=$'polaris_key/play_games=true\npolaris_key/play_games_app_id="123456789012"' \
  export_one play-games play 1 1 im.plrs.key.probe.playgames
# The direct flavour on a Play outlet is an export ERROR (Play forbids self-update).
B="$OUT/proj/direct-on-play"
project "$B" direct 1 0 im.plrs.key.probe.refused play
"$GODOT" --headless --path "$B" --import >"$LOGS/import_direct-on-play.log" 2>&1 || true
if "$GODOT" --headless --path "$B" --export-release Android "$OUT/direct-on-play.apk" >"$LOGS/export_direct-on-play.log" 2>&1 && [ -f "$OUT/direct-on-play.apk" ]; then
  fail "a direct flavour on a Play outlet exported"
elif grep -q "The export is refused" "$LOGS/export_direct-on-play.log"; then
  ok "a direct flavour on a Play outlet is refused (export failed, the error names why)"
else
  fail "the direct-on-play export failed without the plugin's error"
fi
echo "── checks"
aab_dex() { # aab_dex <aab> <regex> -> count of dexdump lines matching, over base/dex
  local d="$OUT/aab_dex_$$" n=0 f
  rm -rf "$d" && mkdir -p "$d"
  unzip -q -o "$1" 'base/dex/*.dex' -d "$d"
  for f in "$d"/base/dex/*.dex; do
    n=$((n + $("$BT/dexdump" -d "$f" 2>/dev/null | grep -c -E "$2" || true)))
  done
  rm -rf "$d"
  echo "$n"
}
aab_manifest_has() { # aab_manifest_has <aab> <text> -> yes|no (the AAB manifest is protobuf: its strings are still plain)
  unzip -p "$1" base/manifest/AndroidManifest.xml 2>/dev/null | grep -aq "$2" && echo yes || echo no
}
aab_manifest_exact() { # aab_manifest_exact <aab> <digits> -> yes only if the id is stored as \u003<digits> and never as "\ <digits>"
  python3 - "$1" "$2" <<'PY'
import sys, zipfile
data = zipfile.ZipFile(sys.argv[1]).read("base/manifest/AndroidManifest.xml")
v = sys.argv[2].encode()
# The protobuf manifest keeps the attribute as written, length-prefixed; aapt2 (`convert` to binary, as
# bundletool does for the APK) resolves \u003 to the digit, so the installed value is the bare digits.
good = b"\\u003" + v
bad = b"\\ " + v
print("yes" if bytes([len(good)]) + good in data and bad not in data else "no")
PY
}
if [ -f "$OUT/play-v1.aab" ] && [ -f "$OUT/play-games.aab" ]; then
  [ "$(aab_dex "$OUT/play-v1.aab" "Class descriptor *: 'Lcom/google/android/gms/games/")" = 0 ] && ok "play: no Play Games library without the opt-in" || fail "play: Play Games library present without the opt-in"
  [ "$(aab_manifest_has "$OUT/play-v1.aab" com.google.android.gms.games.APP_ID)" = no ] && ok "play: no Play Games APP_ID without the opt-in" || fail "play: APP_ID present without the opt-in"
  [ "$(aab_dex "$OUT/play-games.aab" "Class descriptor *: 'Lcom/google/android/gms/games/PlayGames;'")" = 1 ] && ok "play-games: the Play Games library packaged" || fail "play-games: the Play Games library missing"
  [ "$(aab_manifest_has "$OUT/play-games.aab" com.google.android.gms.games.APP_ID)" = yes ] && ok "play-games: the APP_ID meta-data is in the manifest" || fail "play-games: no APP_ID meta-data"
  # The exact value (B2): stored as \u003 and the digits, which aapt2 resolves to the digits alone; the old
  # "\ <digits>" form resolved to a string with a leading space.
  [ "$(aab_manifest_exact "$OUT/play-games.aab" 123456789012)" = yes ] && ok "play-games: the APP_ID value is \\u003 and the digits (the installed string is the digits alone)" || fail "play-games: the APP_ID value is not \\u003123456789012"
  [ "$(aab_dex "$OUT/play-games.aab" "Class descriptor *: 'Landroidx/credentials/CredentialManager;'")" = 1 ] && ok "play-games: androidx/credentials packaged" || fail "play-games: androidx/credentials missing"
  [ "$(aab_dex "$OUT/play-v1.aab" "Class descriptor *: 'Landroidx/credentials/CredentialManager;'")" = 1 ] && ok "play: androidx/credentials packaged" || fail "play: androidx/credentials missing"
fi
check_apk "$OUT/direct-v1.apk" direct
check_redirect "$OUT/direct-v1.apk" "direct (nothing registered)" "" ""
[ -f "$OUT/direct-redirect.apk" ] && check_redirect "$OUT/direct-redirect.apk" "direct (registered)" "com.example.probe" "probe.example.test"
[ -f "$OUT/direct-bg.apk" ] && check_apk "$OUT/direct-bg.apk" direct on
if [ -n "${BUNDLETOOL:-}" ] && [ -f "$OUT/play-v1.aab" ]; then
  "$JAVA_HOME/bin/java" -jar "$BUNDLETOOL" build-apks --local-testing --overwrite --bundle "$OUT/play-v1.aab" \
    --output "$OUT/play-v1.apks" --ks "$OUT/keys/probe.keystore" --ks-key-alias probe --ks-pass pass:probetest \
    --key-pass pass:probetest >"$LOGS/bundletool.log" 2>&1 || { tail -20 "$LOGS/bundletool.log"; fail "bundletool"; }
  "$JAVA_HOME/bin/java" -jar "$BUNDLETOOL" build-apks --mode universal --overwrite --bundle "$OUT/play-v1.aab" \
    --output "$OUT/play-v1-universal.apks" --ks "$OUT/keys/probe.keystore" --ks-key-alias probe --ks-pass pass:probetest \
    --key-pass pass:probetest >>"$LOGS/bundletool.log" 2>&1
  unzip -q -o "$OUT/play-v1-universal.apks" universal.apk -d "$OUT/play-universal"
  check_apk "$OUT/play-universal/universal.apk" play
else
  echo "  (no BUNDLETOOL: the play AAB is exported but not unpacked and checked)"
fi

# 4. The device run.
if [ -n "${DEVICE:-}" ]; then
  A() { "$ADB" -s "$DEVICE" "$@"; }
  # Godot's exporter may stop the adb server; start it again and wait for the device to come back.
  "$ADB" start-server >/dev/null 2>&1 || true
  for _ in $(seq 1 60); do A get-state 2>/dev/null | grep -q device && break; sleep 1; done
  A get-state >/dev/null 2>&1 || "$ADB" connect "$DEVICE" >/dev/null
  # run_plan <pkg> <case> <steps-json> [versionCode] [timeout]: launch the probe, wait, pull.
  run_plan() { # run_plan <pkg> <case> <steps> [versionCode] [timeout] [extra plan members, ending in a comma]
    local pkg="$1" case="$2" steps="$3" vc="${4:--1}" tmo="${5:-90}" extra="${6:-}" ext="/sdcard/Android/data/$1/files"
    printf '{%s"case":"%s","versionCode":%s,"steps":%s}' "$extra" "$case" "$vc" "$steps" >"$OUT/plan_$case.json"
    A shell mkdir -p "$ext"
    A push "$OUT/plan_$case.json" "$ext/plan.json" >/dev/null
    A shell rm -f "$ext/result_$case.json"
    A shell am force-stop "$pkg"
    A shell am start -W -n "$pkg/com.godot.game.GodotAppLauncher" >/dev/null
    for _ in $(seq 1 $((tmo * 2))); do
      A shell "grep -q '\"done\"' $ext/result_$case.json 2>/dev/null && echo y" | grep -q y && break
      sleep 0.5
    done
    A pull "$ext/result_$case.json" "$OUT/result_$case.json" >/dev/null 2>&1 || true
  }
  # expect <case> <python boolean expression over r (the result) and s (steps by name)> <label>.
  # The expressions are literals in this script (never input), so eval() runs only our own code.
  expect() {
    if python3 - "$OUT/result_$1.json" "$2" <<'EOP'; then ok "$3"; else fail "$3"; fi
import json, sys
try:
    r = json.load(open(sys.argv[1]))
except Exception:
    sys.exit(1)
s = {st["step"]: st for st in r.get("steps", [])}
sys.exit(0 if eval(sys.argv[2]) else 1)
EOP
  }
  echo "── device $DEVICE: direct"
  P=im.plrs.key.probe.direct
  A uninstall "$P" >/dev/null 2>&1 || true
  A install "$OUT/direct-v1.apk" >/dev/null
  A shell appops set "$P" REQUEST_INSTALL_PACKAGES allow
  A shell mkdir -p "/sdcard/Android/data/$P/files"
  A push "$OUT/direct-v2.apk" "/sdcard/Android/data/$P/files/update.apk" >/dev/null
  run_plan "$P" d_basic '["caps","source","outcome","keystore","update_check","verify_public","verify_wrong_hash"]' 2
  expect d_basic 'r.get("done") and s["caps"]["detail"]["flavor"] == "direct" and s["caps"]["detail"]["packageInstaller"]' "direct: plugin present, direct flavour"
  expect d_basic 's["keystore"]["ok"]' "direct: Keystore round trip in AndroidKeyStore"
  expect d_basic 's["update_check"]["code"] == "unsupported" and s["update_check"]["detail"]["reason"] == "outlet"' "direct: In-App Updates unsupported (outlet)"
  expect d_basic '"path_not_private" in s["verify_public"]["detail"]["verify"]["refused"]' "direct: an APK in public storage is refused"
  expect d_basic 's["verify_wrong_hash"]["detail"]["verify"]["refused"] == ["hash_mismatch"]' "direct: a wrong hash is refused"
  # The update driver end to end: the direct adapter downloads v2 from a loopback server (adb
  # reverse), checks it against the record's artifact and installs it through the plugin.
  APK_SHA="$(shasum -a 256 "$OUT/direct-v2.apk" | cut -d' ' -f1)"
  APK_SIZE="$(wc -c <"$OUT/direct-v2.apk" | tr -d ' ')"
  (cd "$OUT" && exec python3 -m http.server 8765 --bind 127.0.0.1 >"$LOGS/http.log" 2>&1) &
  HTTP_PID=$!
  A reverse tcp:8765 tcp:8765 >/dev/null
  sleep 1
  run_plan "$P" d_update '["adapter_install"]' 2 120 "\"apkUrl\":\"http://127.0.0.1:8765/direct-v2.apk\",\"apkSha256\":\"$APK_SHA\",\"apkSize\":$APK_SIZE,"
  kill "$HTTP_PID" 2>/dev/null || true
  A reverse --remove tcp:8765 >/dev/null 2>&1 || true
  expect d_update 's["adapter_install"]["plan"]["bridge"] == "apk" and s["adapter_install"]["plan"]["behaviour"] == "hook"' "direct: the adapter offers the apk install"
  expect d_update 's["adapter_install"]["ok"] and s["adapter_install"]["detail"]["bridge"] == "apk" and not s["adapter_install"]["opened"]' "direct: the adapter downloaded, verified and committed v2 (no link opened)"
  for _ in $(seq 1 30); do
    A shell dumpsys package "$P" | grep -q 'versionCode=2' && break
    sleep 1
  done
  A shell dumpsys package "$P" | grep -q 'versionCode=2' && ok "direct: v2 installed with no prompt" || fail "direct: v2 not installed"
  run_plan "$P" d_after '["outcome","source"]' 2
  expect d_after 's["outcome"]["last"]["name"] == "success"' "direct: the next launch reads the journaled success"
  expect d_after 's["source"]["detail"]["selfUpdated"] and s["source"]["detail"]["installer"] == "'"$P"'"' "direct: install source is self-updated"
  if [ -f "$OUT/play-v1.apks" ]; then
    echo "── device $DEVICE: play"
    P=im.plrs.key.probe.play
    A uninstall "$P" >/dev/null 2>&1 || true
    "$JAVA_HOME/bin/java" -jar "$BUNDLETOOL" install-apks --apks "$OUT/play-v1.apks" --device-id "$DEVICE" >"$LOGS/install_play.log" 2>&1
    run_plan "$P" p_basic '["caps","source","keystore","update_check","pack_status:probeod","pack_fetch:probeod","pack_mount:probeod"]'
    expect p_basic 's["caps"]["detail"]["flavor"] == "play" and s["caps"]["detail"]["inAppUpdates"]' "play: plugin present, play flavour"
    expect p_basic 's["keystore"]["ok"]' "play: Keystore round trip"
    expect p_basic 's["update_check"]["detail"]["reason"] == "outlet"' "play: In-App Updates unsupported for a non-Play install (outlet)"
    expect p_basic 'int(s["pack_status:probeod"]["detail"]["state"]["status"]) == 8' "play: the on-demand pack starts NOT_INSTALLED"
    expect p_basic 's["pack_mount:probeod"]["ok"]' "play: fetched, COMPLETED, located and mounted"
  fi
  # U-41.6b: a 30 MiB save sent to the background. Four 7.5 MiB parts go to a throttled loopback server; the
  # script presses Home once the first part is in flight, then needs the "Syncing" notification and every part.
  if [ -f "$OUT/direct-bg.apk" ]; then
    echo "── device $DEVICE: background transfer"
    P=im.plrs.key.probe.bg
    SIZE=31457280
    A uninstall "$P" >/dev/null 2>&1 || true
    A install -r "$OUT/direct-bg.apk" >/dev/null
    A shell pm grant "$P" android.permission.POST_NOTIFICATIONS >/dev/null 2>&1 || true
    : >"$OUT/bulk.log"
    python3 "$HERE/e2e/bulk_server.py" 8766 "$OUT/bulk.log" >"$LOGS/bulk_server.log" 2>&1 &
    BULK_PID=$!
    A reverse tcp:8766 tcp:8766 >/dev/null
    sleep 1
    EXT="/sdcard/Android/data/$P/files"
    printf '{"serverOrigin":"http://127.0.0.1:8766","size":%s,"case":"bg_upload","versionCode":-1,"steps":["bulk_upload"]}' "$SIZE" >"$OUT/plan_bg_upload.json"
    A shell mkdir -p "$EXT"
    A push "$OUT/plan_bg_upload.json" "$EXT/plan.json" >/dev/null
    A shell rm -f "$EXT/result_bg_upload.json"
    A shell am force-stop "$P"
    A shell am start -W -n "$P/com.godot.game.GodotAppLauncher" >/dev/null
    for _ in $(seq 1 120); do grep -q '^START' "$OUT/bulk.log" 2>/dev/null && break; sleep 0.5; done
    if grep -q '^START' "$OUT/bulk.log"; then
      A shell input keyevent KEYCODE_HOME
      ok "bg: the first part is in flight; Home pressed"
      NOTIFIED=0
      for _ in $(seq 1 40); do
        if A shell dumpsys notification --noredact | grep -q 'Syncing'; then NOTIFIED=1; break; fi
        sleep 0.5
      done
      [ "$NOTIFIED" = 1 ] && ok "bg: the notification reads \"Syncing\" while the game is in the background" || fail "bg: no \"Syncing\" notification"
      for _ in $(seq 1 240); do
        [ "$(grep -c '^PART' "$OUT/bulk.log")" -ge 4 ] && break
        sleep 0.5
      done
      GOT="$(awk '/^PART/ {n++; b += $3} END {print n+0, b+0}' "$OUT/bulk.log")"
      [ "$GOT" = "4 $SIZE" ] && ok "bg: every part arrived while the game was in the background (4 parts, $SIZE bytes)" || fail "bg: parts arrived: '$GOT', expected '4 $SIZE'"
      grep -q '^BAD' "$OUT/bulk.log" && fail "bg: the server saw a request without the bearer or on a bad path" || ok "bg: every request carried the bearer and a file route"
      A shell am start -W -n "$P/com.godot.game.GodotAppLauncher" >/dev/null
      for _ in $(seq 1 120); do
        A shell "grep -q '\"done\"' $EXT/result_bg_upload.json 2>/dev/null && echo y" | grep -q y && break
        sleep 0.5
      done
      A pull "$EXT/result_bg_upload.json" "$OUT/result_bg_upload.json" >/dev/null 2>&1 || true
      expect bg_upload 'r.get("done") and s["bulk_upload"]["ok"] and s["bulk_upload"]["statuses"] == [204, 204, 204, 204]' "bg: the game resumed to four 204 answers"
    else
      fail "bg: the probe never reached the server"
    fi
    kill "$BULK_PID" 2>/dev/null || true
    A reverse --remove tcp:8766 >/dev/null 2>&1 || true
    A shell am force-stop "$P" >/dev/null 2>&1 || true
  fi
  for f in "$OUT"/result_*.json; do echo "  $(basename "$f"): $(python3 -c 'import json,sys; r=json.load(open(sys.argv[1])); print([(s["step"], round(s["ms"],1)) for s in r.get("steps",[])])' "$f")"; done
fi

if [ "$FAILED" != 0 ]; then
  echo "export_check: FAILED (logs: $LOGS)"
  exit 1
fi
echo "export_check: ok"
