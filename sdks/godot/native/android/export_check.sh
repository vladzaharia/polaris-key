#!/usr/bin/env bash
# export_check.sh: the Godot Android binding end to end (P5-06). Exports the device probe
# (e2e/game, with the Polaris Key addon copied in) through Godot's Gradle build, headless, with the
# real export plugin, and checks what each preset carries:
#
#   direct  APK, versionCodes 1 and 2: the merged manifest has REQUEST_INSTALL_PACKAGES and
#           UPDATE_PACKAGES_WITHOUT_USER_ACTION (and not ENFORCE_UPDATE_OWNERSHIP), the
#           PolarisKeyAndroid v2 meta-data and the install-status receiver; the dex has the direct
#           classes and no Play Core
#   play    AAB with one on-demand asset pack (`probeod`, a 2 MB data-only .pck), then a
#           `bundletool build-apks --local-testing` set: no install permission, no session commit,
#           no direct class
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

# project <dir> <flavor> <versionCode> <format 0 apk | 1 aab> <package>
project() {
  local B="$1" flavor="$2" vc="$3" format="$4" pkg="$5"
  rm -rf "$B" && mkdir -p "$B/addons"
  cp -R "$HERE/e2e/game/." "$B/"
  rsync -a --exclude 'native/ios/' "$SDKG/addons/polaris_key" "$B/addons/"
  mkdir -p "$B/android/build"
  (cd "$B/android/build" && unzip -q "$TPL/android_source.zip")
  echo "$TVER" >"$B/android/.build_version"
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
polaris_key/outlet="$([ "$flavor" = play ] && echo play || echo direct)"
EOT
}

# export_one <tag> <flavor> <versionCode> <format> <package>
export_one() {
  local tag="$1" B="$OUT/proj/$1" ext
  project "$B" "$2" "$3" "$4" "$5"
  ext=$([ "$4" = 1 ] && echo aab || echo apk)
  "$GODOT" --headless --path "$B" --import >"$LOGS/import_$tag.log" 2>&1 || true
  local t0
  t0=$(date +%s)
  if ! "$GODOT" --headless --path "$B" --export-release Android "$OUT/$tag.$ext" >"$LOGS/export_$tag.log" 2>&1; then
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

check_apk() { # check_apk <apk> <flavor>
  local apk="$1" flavor="$2" perms manifest
  perms="$("$BT/aapt2" dump permissions "$apk")"
  manifest="$("$BT/aapt2" dump xmltree "$apk" --file AndroidManifest.xml)"
  echo "$manifest" | grep -q 'org.godotengine.plugin.v2.PolarisKeyAndroid' && ok "$flavor: v2 plugin meta-data" || fail "$flavor: no PolarisKeyAndroid meta-data"
  [ "$(dex_has "$apk" "Class descriptor *: 'Lim/plrs/key/godot/PolarisKeyAndroidPlugin;'")" = 1 ] && ok "$flavor: plugin class packaged" || fail "$flavor: plugin class missing"
  if [ "$flavor" = direct ]; then
    for p in REQUEST_INSTALL_PACKAGES UPDATE_PACKAGES_WITHOUT_USER_ACTION; do
      echo "$perms" | grep -q "android.permission.$p" && ok "direct: $p" || fail "direct: no $p"
    done
    echo "$perms" | grep -q ENFORCE_UPDATE_OWNERSHIP && fail "direct: ENFORCE_UPDATE_OWNERSHIP present" || ok "direct: no ENFORCE_UPDATE_OWNERSHIP"
    echo "$manifest" | grep -q 'im.plrs.key.platform.direct.InstallStatusReceiver' && ok "direct: install-status receiver" || fail "direct: no receiver"
    [ "$(dex_has "$apk" 'Lcom/google/android/play/')" = 0 ] && ok "direct: no Play Core" || fail "direct: Play Core present"
  else
    for p in REQUEST_INSTALL_PACKAGES UPDATE_PACKAGES_WITHOUT_USER_ACTION ENFORCE_UPDATE_OWNERSHIP; do
      echo "$perms" | grep -q "android.permission.$p" && fail "play: $p present" || ok "play: no $p"
    done
    [ "$(dex_has "$apk" 'PackageInstaller;\.createSession|PackageInstaller\$Session;\.commit')" = 0 ] && ok "play: no session creation or commit" || fail "play: session code present"
    [ "$(dex_has "$apk" "Class descriptor *: 'Lim/plrs/key/platform/direct/")" = 0 ] && ok "play: no direct class" || fail "play: direct class present"
    [ "$(dex_has "$apk" "Class descriptor *: 'Lim/plrs/key/platform/play/InAppUpdates;'")" = 1 ] && ok "play: In-App Updates packaged" || fail "play: In-App Updates missing"
  fi
}

export_one direct-v1 direct 1 0 im.plrs.key.probe.direct
export_one direct-v2 direct 2 0 im.plrs.key.probe.direct
export_one play-v1 play 1 1 im.plrs.key.probe.play
echo "── checks"
check_apk "$OUT/direct-v1.apk" direct
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
  for f in "$OUT"/result_*.json; do echo "  $(basename "$f"): $(python3 -c 'import json,sys; r=json.load(open(sys.argv[1])); print([(s["step"], round(s["ms"],1)) for s in r.get("steps",[])])' "$f")"; done
fi

if [ "$FAILED" != 0 ]; then
  echo "export_check: FAILED (logs: $LOGS)"
  exit 1
fi
echo "export_check: ok"
