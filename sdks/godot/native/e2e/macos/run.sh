#!/usr/bin/env bash
# run.sh [--work DIR] [--deps DIR] [--port N] [--template macos.zip]
#
# P5-07's macOS end-to-end run (notes/S-11 §8 step 6), unattended and without certificates:
#
#   1. build the Sparkle bridge (native/macos/build.sh) and a per-run throwaway Ed25519 key;
#   2. export the probe project (e2e/game) three times through the SDK's export plugin with
#      polaris_key/sparkle/enabled: 1.0.0 (build 1), 1.0.1 (build 2), and a fixture bundle with no
#      SUPublicEDKey. The preset says codesign/codesign=0 on purpose: the plugin must turn that
#      into the built-in ad-hoc signature (Sparkle rejects updates to an unsigned export);
#   3. check each bundle: `codesign --verify --deep --strict`, the Disable Library Validation
#      entitlement, SUPublicEDKey, and the executable bit on Sparkle's five Mach-O files;
#   4. re-sign both with macos/sign_and_notarize.sh (ad hoc: inside-out, no notarisation), take its
#      zip of 1.0.1, BinaryDelta from 1.0.0, sign both with sign_update, and render the appcasts with
#      the Worker's own renderer and verifier (e2e/gen_feeds.mts); serve them on 127.0.0.1;
#   5. cases: the facades with and without Sparkle.framework (`dependency`), the bridge refusing
#      a bundle without SUPublicEDKey, and a delta and a full update through PKeySparkleBridge
#      (headless user driver) that relaunch into build 2, with the bearer on the appcast and the
#      download.
#
# Env: GODOT_BIN (the editor; default `godot`). Needs Node 22 with the workspace installed and the
# worker's dependencies built (`pnpm --filter "@polaris-key/worker^..." build`), python3, and the
# Xcode command-line tools. Logs and bundles stay in --work (default $TMPDIR/pkey-e2e-macos).

set -u

HERE="$(cd "$(dirname "$0")" && pwd)"
E2E="$(cd "$HERE/.." && pwd)"
NATIVE="$(cd "$E2E/.." && pwd)"
SDK="$(cd "$NATIVE/.." && pwd)"
REPO="$(cd "$SDK/../.." && pwd)"
WORK="${TMPDIR:-/tmp}/pkey-e2e-macos"
DEPS="$NATIVE/.deps"
PORT=8711
TEMPLATE=""
GODOT="${GODOT_BIN:-godot}"
while [ $# -gt 0 ]; do
  case "$1" in
    --work) WORK="$2"; shift 2 ;;
    --deps) DEPS="$2"; shift 2 ;;
    --port) PORT="$2"; shift 2 ;;
    --template) TEMPLATE="$2"; shift 2 ;;
    *) echo "run.sh: unknown argument $1" >&2; exit 2 ;;
  esac
done

FAILED=0
pass() { echo "PASS $1"; }
fail() { echo "FAIL $1${2:+ — $2}"; FAILED=$((FAILED + 1)); }
check() { if [ "$2" = 0 ]; then pass "$1"; else fail "$1" "${3:-}"; fi; }
die() { echo "run.sh: $*" >&2; exit 1; }

rm -rf "$WORK"
mkdir -p "$WORK"/{keys,out,serve/sparkle,run,logs,install}
WORK="$(cd "$WORK" && pwd -P)"
APP_NAME=PKeyE2E
BUNDLE_ID=org.polariskey.e2e.sparkle
SRV_PID=""
cleanup() {
  [ -n "$SRV_PID" ] && kill "$SRV_PID" 2>/dev/null
  pkill -f "$WORK/install/" 2>/dev/null
  true
}
trap cleanup EXIT

# 1. The bridge and a key.
"$NATIVE/macos/build.sh" --deps "$DEPS" --out "$WORK/ext" >"$WORK/logs/build.log" 2>&1 || { tail -40 "$WORK/logs/build.log"; die "build failed"; }
SPARKLE="$DEPS/sparkle"
node -e '
const c = require("crypto"), fs = require("fs");
const { privateKey, publicKey } = c.generateKeyPairSync("ed25519");
fs.writeFileSync(process.argv[1] + "/seed.b64", privateKey.export({ format: "der", type: "pkcs8" }).subarray(-32).toString("base64"));
fs.writeFileSync(process.argv[1] + "/pub.b64", publicKey.export({ format: "der", type: "spki" }).subarray(-32).toString("base64"));
' "$WORK/keys" || die "key generation failed"
PUB="$(cat "$WORK/keys/pub.b64")"

# 2. The probe project, with the addon and the bridge installed.
GAME="$WORK/game"
cp -R "$E2E/game" "$GAME"
mkdir -p "$GAME/addons"
cp -R "$SDK/addons/polaris_key" "$GAME/addons/polaris_key"
rm -rf "$GAME/addons/polaris_key/native/bin"
mkdir -p "$GAME/addons/polaris_key/native/bin"
ditto "$WORK/ext/Sparkle.framework" "$GAME/addons/polaris_key/native/bin/Sparkle.framework"
cp "$WORK/ext/libpkey_sparkle.dylib" "$WORK/ext/pkey_sparkle.gdextension" "$GAME/addons/polaris_key/native/bin/"
printf '{"config": "%s"}\n' "$WORK/run/config.json" >"$GAME/e2e.json"

# The first import of a project holding the extension has crashed the editor on exit (notes/S-11
# §4.1); the second is clean.
"$GODOT" --headless --path "$GAME" --import >"$WORK/logs/import1.log" 2>&1 || true
"$GODOT" --headless --path "$GAME" --import >"$WORK/logs/import2.log" 2>&1 || { tail -30 "$WORK/logs/import2.log"; die "import failed"; }

FEED_URL="http://127.0.0.1:$PORT/sparkle/appcast.xml"
# export_app <name> <version> <short> <build> <key>
export_app() {
  local name="$1" version="$2" short="$3" build="$4" key="$5" tpl=""
  if [ -n "$TEMPLATE" ]; then
    tpl="custom_template/debug=\"$TEMPLATE\"
custom_template/release=\"$TEMPLATE\""
  fi
  sed -i '' "s/^config\/version=.*/config\/version=\"$version\"/" "$GAME/project.godot"
  cat >"$GAME/export_presets.cfg" <<P
[preset.0]

name="macOS"
platform="macOS"
runnable=true
dedicated_server=false
custom_features=""
export_filter="all_resources"
include_filter="e2e.json"
exclude_filter=""
export_path=""
script_export_mode=2

[preset.0.options]

$tpl
binary_format/architecture="universal"
application/bundle_identifier="$BUNDLE_ID"
application/short_version="$short"
application/version="$build"
codesign/codesign=0
notarization/notarization=0
polaris_key/outlet="direct"
polaris_key/sparkle/enabled=true
polaris_key/sparkle/public_ed_key="$key"
polaris_key/sparkle/feed_url="$FEED_URL"
P
  mkdir -p "$WORK/out/$name"
  "$GODOT" --headless --path "$GAME" --export-release macOS "$WORK/out/$name/$APP_NAME.app" >"$WORK/logs/export-$name.log" 2>&1
  local rc=$?
  check "export $name ($version, build $build)" "$([ $rc = 0 ] && [ -d "$WORK/out/$name/$APP_NAME.app" ] && echo 0 || echo 1)" "$(tail -5 "$WORK/logs/export-$name.log")"
}

# check_bundle <name> <expect-key: yes|no>
check_bundle() {
  local app="$WORK/out/$1/$APP_NAME.app" b
  b="$app/Contents/Frameworks/Sparkle.framework/Versions/B"
  codesign --verify --deep --strict "$app" >"$WORK/logs/verify-$1.log" 2>&1
  check "$1: codesign --verify --deep --strict (the plugin turned codesign 0 into ad-hoc)" $? "$(cat "$WORK/logs/verify-$1.log")"
  codesign -d --entitlements - --xml "$app" 2>/dev/null | grep -q "com.apple.security.cs.disable-library-validation"
  check "$1: the Disable Library Validation entitlement" $?
  local missing=""
  for f in Sparkle Autoupdate Updater.app/Contents/MacOS/Updater XPCServices/Downloader.xpc/Contents/MacOS/Downloader XPCServices/Installer.xpc/Contents/MacOS/Installer; do
    [ -x "$b/$f" ] || missing="$missing $f"
  done
  check "$1: Sparkle's five Mach-O files are executable after export" "$([ -z "$missing" ] && echo 0 || echo 1)" "not executable:$missing"
  local key
  key="$(/usr/libexec/PlistBuddy -c 'Print :SUPublicEDKey' "$app/Contents/Info.plist" 2>/dev/null)"
  if [ "$2" = yes ]; then
    check "$1: SUPublicEDKey and SUFeedURL in Info.plist" "$([ "$key" = "$PUB" ] && [ "$(/usr/libexec/PlistBuddy -c 'Print :SUFeedURL' "$app/Contents/Info.plist")" = "$FEED_URL" ] && echo 0 || echo 1)" "key=$key"
  else
    check "$1: no SUPublicEDKey (fixture)" "$([ -z "$key" ] && echo 0 || echo 1)"
  fi
}

export_app v1 1.0.0 1.0 1 "$PUB"
export_app v2 1.0.1 1.1 2 "$PUB"
[ "$FAILED" = 0 ] || die "export failed; see $WORK/logs/export-*.log"
check_bundle v1 yes
check_bundle v2 yes
# The fixture bundle: Sparkle enabled without a public key. The plugin warns (an export plugin
# cannot stop an export); the bridge must refuse to start in it.
export_app nokey 1.0.0 1.0 1 ""
grep -q "Sparkle is enabled without a public key" "$WORK/logs/export-nokey.log"
check "nokey: the export warns that Sparkle has no public key" $?
check_bundle nokey no

# The release job's signing script, ad hoc (no certificate): inside-out, then the Sparkle archive.
S="$WORK/serve/sparkle"
"$NATIVE/macos/sign_and_notarize.sh" --app "$WORK/out/v1/$APP_NAME.app" --identity - >"$WORK/logs/sign-v1.log" 2>&1
check "sign_and_notarize.sh (ad hoc) re-signs 1.0.0 inside-out and verifies" $? "$(tail -5 "$WORK/logs/sign-v1.log")"
"$NATIVE/macos/sign_and_notarize.sh" --app "$WORK/out/v2/$APP_NAME.app" --identity - --zip "$S/$APP_NAME-1.0.1.zip" >"$WORK/logs/sign-v2.log" 2>&1
check "sign_and_notarize.sh (ad hoc) re-signs 1.0.1 and writes the Sparkle archive" "$([ $? = 0 ] && [ -s "$S/$APP_NAME-1.0.1.zip" ] && echo 0 || echo 1)" "$(tail -5 "$WORK/logs/sign-v2.log")"
codesign -d --entitlements - --xml "$WORK/out/v2/$APP_NAME.app" 2>/dev/null | grep -q "com.apple.security.cs.disable-library-validation"
check "the re-signed app keeps the Disable Library Validation entitlement" $?

# 4. Feeds: the Worker's renderer and verifier over sign_update's signatures.
"$SPARKLE/bin/sign_update" --ed-key-file "$WORK/keys/seed.b64" -p "$S/$APP_NAME-1.0.1.zip" >"$S/$APP_NAME-1.0.1.zip.sig"
"$SPARKLE/bin/BinaryDelta" create "$WORK/out/v1/$APP_NAME.app" "$WORK/out/v2/$APP_NAME.app" "$S/$APP_NAME-2-1.delta" >"$WORK/logs/delta.log" 2>&1
check "BinaryDelta create 1 -> 2" $? "$(tail -3 "$WORK/logs/delta.log")"
"$SPARKLE/bin/sign_update" --ed-key-file "$WORK/keys/seed.b64" -p "$S/$APP_NAME-2-1.delta" >"$S/$APP_NAME-2-1.delta.sig"
spec() {
  local feed="$1" deltas="$2"
  cat <<J
{"outDir": "$S", "feedName": "$feed", "baseUrl": "http://127.0.0.1:$PORT/sparkle", "publicKey": "$PUB",
 "productName": "$APP_NAME", "kind": "sparkle",
 "releases": [{"version": "1.1", "build": "2", "minOs": "12.0", "file": "$S/$APP_NAME-1.0.1.zip", "sig": "$S/$APP_NAME-1.0.1.zip.sig"$deltas}]}
J
}
spec appcast.xml ", \"deltas\": [{\"file\": \"$S/$APP_NAME-2-1.delta\", \"sig\": \"$S/$APP_NAME-2-1.delta.sig\", \"deltaFrom\": \"1\"}]" >"$WORK/run/spec-delta.json"
spec appcast-full.xml "" >"$WORK/run/spec-full.json"
for f in delta full; do
  (cd "$REPO" && pnpm exec tsx "$E2E/gen_feeds.mts" "$WORK/run/spec-$f.json") >"$WORK/logs/feed-$f.log" 2>&1
  python3 -c 'import json,sys; r=json.loads(open(sys.argv[1]).read().strip().splitlines()[-1]); s=r["signatures"]; sys.exit(0 if s and all(x["verified"] for x in s) else 1)' "$WORK/logs/feed-$f.log"
  check "appcast ($f) rendered by the Worker, every signature verified by its verifier" $? "$(tail -3 "$WORK/logs/feed-$f.log")"
done
grep -q 'sparkle:edSignature' "$S/appcast.xml" && grep -q 'sparkle:deltaFrom="1"' "$S/appcast.xml"
check "the appcast carries the delta and both signatures" $?

python3 "$E2E/server.py" "$PORT" "$WORK/serve" "$WORK/srv.log" &
SRV_PID=$!
sleep 1

# run_case <name> <bundle> <case> <feed> <timeout_s> → leaves $WORK/logs/case-<name>.jsonl
run_case() {
  local name="$1" bundle="$2" kase="$3" feed="$4" timeout="$5" log="$WORK/logs/case-$1.jsonl" i
  rm -rf "$WORK/install/$name"
  mkdir -p "$WORK/install/$name"
  ditto "$bundle" "$WORK/install/$name/$APP_NAME.app"
  defaults delete "$BUNDLE_ID" >/dev/null 2>&1
  rm -rf "$HOME/Library/Caches/$BUNDLE_ID" "$HOME/Library/Application Support/$BUNDLE_ID" 2>/dev/null
  cat >"$WORK/run/config.json" <<J
{"case": "$kase", "feed": "$feed", "log": "$log", "headers": {"Authorization": "Bearer e2e-token"},
 "target_version": "1.0.1", "quit_after_s": $timeout}
J
  : >"$WORK/srv.log.mark"
  SRV_MARK=$(wc -l <"$WORK/srv.log" 2>/dev/null || echo 0)
  local started=$(date +%s)
  open -n "$WORK/install/$name/$APP_NAME.app"
  for i in $(seq 1 $((timeout * 2))); do
    sleep 0.5
    if grep -q '"event":"target_reached"\|"event":"exit_tree"' "$log" 2>/dev/null; then
      # an update case keeps waiting until the relaunched build reports in
      if [ "$kase" != sparkle_update ] || grep -q '"event":"target_reached"' "$log"; then break; fi
    fi
  done
  sleep 1
  echo "── case $name: $(($(date +%s) - started)) s"
  cut -c1-400 "$log" 2>/dev/null
}

event() { grep "\"event\":\"$2\"" "$WORK/logs/case-$1.jsonl" 2>/dev/null | tail -1; }
# jcheck <name> <case> <event> <python expression over d, the event's detail>
jcheck() {
  python3 "$E2E/jcheck.py" "$WORK/logs/case-$2.jsonl" "$3" "$4"
  check "$1" $? "$(event "$2" "$3" | cut -c1-600)"
}

# 5a. The facades in a full build.
run_case facades "$WORK/out/v1/$APP_NAME.app" facades "" 30
jcheck "facades: PKeySparkle is available in the exported 1.0.0" facades facades 'd["availability"]["sparkle"]["ok"] and d["classes"]["PKeySparkleNative"]'

# 5b. Without Sparkle.framework the weak-linked extension still loads and answers dependency.
NOFW="$WORK/out/noframework/$APP_NAME.app"
mkdir -p "$(dirname "$NOFW")"
ditto "$WORK/out/v1/$APP_NAME.app" "$NOFW"
rm -rf "$NOFW/Contents/Frameworks/Sparkle.framework"
codesign --force --deep -s - "$NOFW" >/dev/null 2>&1
run_case noframework "$NOFW" facades "" 30
jcheck "facades: without Sparkle.framework the extension loads and PKeySparkle answers unsupported (dependency)" noframework facades 'd["classes"]["PKeySparkleNative"] and d["availability"]["sparkle"]["code"] == "unsupported" and d["availability"]["sparkle"]["detail"]["reason"] == "dependency"'

# 5c. The fixture bundle without SUPublicEDKey: the bridge refuses to start.
run_case missingkey "$WORK/out/nokey/$APP_NAME.app" sparkle_missing_key "$FEED_URL" 30
jcheck "SUPublicEDKey absent: PKeySparkle.start() refuses (invalid-options), no updater" missingkey sparkle_start 'd["code"] == "invalid-options" and "SUPublicEDKey" in d["message"] and d["detail"]["error"] == "missing_public_key"'

# 5d/e. Updates through PKeySparkleBridge.
for c in delta full; do
  feed="$FEED_URL"
  [ "$c" = full ] && feed="http://127.0.0.1:$PORT/sparkle/appcast-full.xml"
  run_case "update-$c" "$WORK/out/v1/$APP_NAME.app" sparkle_update "$feed" 120
  installed="$(/usr/libexec/PlistBuddy -c 'Print :CFBundleVersion' "$WORK/install/update-$c/$APP_NAME.app/Contents/Info.plist" 2>/dev/null)"
  check "update ($c): PKeySparkleBridge hands off and the app relaunches as 1.0.1 (build 2)" "$([ -n "$(event "update-$c" target_reached)" ] && [ "$installed" = 2 ] && echo 0 || echo 1)" "installed=$installed"
  codesign --verify --deep --strict "$WORK/install/update-$c/$APP_NAME.app" >/dev/null 2>&1
  check "update ($c): the installed bundle still verifies" $?
  tail -n +$((SRV_MARK + 1)) "$WORK/srv.log" >"$WORK/logs/http-$c.jsonl"
  grep '"path": "/sparkle/appcast' "$WORK/logs/http-$c.jsonl" | grep -q '"auth": "Bearer e2e-token"'
  check "update ($c): the bearer reached the appcast" $?
  if [ "$c" = delta ]; then
    grep -q '"path": "/sparkle/'$APP_NAME'-2-1.delta".*"auth": "Bearer e2e-token"' "$WORK/logs/http-$c.jsonl" && ! grep -q "\"path\": \"/sparkle/$APP_NAME-1.0.1.zip\"" "$WORK/logs/http-$c.jsonl"
    check "update (delta): only the delta was downloaded, with the bearer" $? "$(cut -c1-200 "$WORK/logs/http-$c.jsonl")"
  else
    grep -q "\"path\": \"/sparkle/$APP_NAME-1.0.1.zip\".*\"auth\": \"Bearer e2e-token\"" "$WORK/logs/http-$c.jsonl"
    check "update (full): the zip was downloaded, with the bearer" $? "$(cut -c1-200 "$WORK/logs/http-$c.jsonl")"
  fi
done

echo "── macOS e2e: $FAILED failed; logs in $WORK/logs"
[ "$FAILED" = 0 ]
