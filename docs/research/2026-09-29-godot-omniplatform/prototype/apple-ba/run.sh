#!/usr/bin/env bash
# S-01 harness: export the probe for iOS, prove the unpatched export builds, patch a copy with
# the Background Assets extension, build it, and run the parts a Mac without an Apple account can
# run (simulator). Every stage writes a log under build/logs/.
#
# usage: ./run.sh <stage>...   stages: shim packs export build sim ids   (or: all)
#
# Environment:
#   A6_OUT          dir holding A6's v1.pck and v2.pck (prototype/patching README, steps 1–2)
#   GODOT_SIM_LIB   optional: an arm64 iOS-simulator libgodot.a built from the 4.7.2-stable tag
#                   (`scons platform=ios target=template_release arch=arm64 simulator=yes`).
#                   The official 4.7.2 template's simulator slice is x86_64 only, so without it
#                   the simulator link fails on Apple Silicon without Rosetta.
#   APP_GROUP       default group.dev.polariskey.research.pkba (placeholder; the real one is the
#                   team's, never committed)
#   SIM_DEVICE      simulator name, default "iPhone 17 Pro"
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
b="$here/build"
logs="$b/logs"
mkdir -p "$logs"
APP_GROUP="${APP_GROUP:-group.dev.polariskey.research.pkba}"
SIM_DEVICE="${SIM_DEVICE:-iPhone 17 Pro}"
BUNDLE_ID="dev.polariskey.research.pkba"
export GEM_HOME="$here/.gems" GEM_PATH="$here/.gems:$(gem env gempath)"

ts() { python3 -c 'import time;print(f"{time.time():.3f}")'; }
timed() { # <log-name> <cmd...>: run, log, print wall seconds and the xcodebuild verdict
  local name="$1"; shift
  local t0; t0=$(ts)
  local rc=0
  "$@" >"$logs/$name.log" 2>&1 || rc=$?
  printf '%-28s rc=%d %6.1fs %s\n' "$name" "$rc" "$(python3 -c "print($(ts)-$t0)")" \
    "$(grep -Eo '\*\* (BUILD|EXPORT) [A-Z]+ \*\*' "$logs/$name.log" | tail -1)"
  return $rc
}

stage_shim() { timed shim "$here/shim/build.sh"; }

stage_packs() {
  : "${A6_OUT:?set A6_OUT to the dir with A6 v1.pck and v2.pck}"
  timed packs python3 "$here/packs/make_packs.py" "$b/packs" "$A6_OUT/v1.pck" "$A6_OUT/v2.pck"
  cat "$logs/packs.log"
}

stage_export() {
  rm -rf "$b/export" && mkdir -p "$b/export"
  timed import godot --headless --path "$here/godot" --import || true
  timed export godot --headless --path "$here/godot" --export-release iOS "$b/export/probe.ipa"
  test -d "$b/export/probe.xcodeproj"
}

prep_copy() { # <dst>: fresh copy of the export, with the simulator libgodot swapped if given
  rm -rf "$1" && cp -R "$b/export" "$1"
  if [ -n "${GODOT_SIM_LIB:-}" ]; then
    local slice="$1/probe.xcframework/ios-arm64_x86_64-simulator/libgodot.a"
    lipo -create "$GODOT_SIM_LIB" "$slice" -output "$slice.fat" && mv "$slice.fat" "$slice"
  fi
}

xb() { # <projdir> <sdk> <dd> [extra settings...]
  local proj="$1" sdk="$2" dd="$3"; shift 3
  local dest="generic/platform=iOS"; [ "$sdk" = iphonesimulator ] && dest="generic/platform=iOS Simulator"
  (cd "$proj" && xcodebuild -project probe.xcodeproj -scheme probe -configuration Release -sdk "$sdk" \
    -destination "$dest" -derivedDataPath "$dd" "$@" build)
}
# Device builds are unsigned (no Apple account here). Simulator builds are ad-hoc signed ("-")
# so the App Group entitlement is embedded.
DEV=(CODE_SIGNING_ALLOWED=NO)
SIM=(CODE_SIGN_IDENTITY=- CODE_SIGN_STYLE=Manual DEVELOPMENT_TEAM= PROVISIONING_PROFILE_SPECIFIER= ARCHS=arm64)

stage_build() {
  prep_copy "$b/unpatched"
  timed build-unpatched-device xb "$b/unpatched" iphoneos "$b/dd/unpatched-device" "${DEV[@]}" || true
  timed build-unpatched-sim xb "$b/unpatched" iphonesimulator "$b/dd/unpatched-sim" "${SIM[@]}" || true

  prep_copy "$b/patched"
  timed patch ruby "$here/patch/patch_ba.rb" "$b/patched/probe.xcodeproj" --app-group "$APP_GROUP"
  cat "$logs/patch.log"
  local h1; h1=$(cd "$b/patched" && find probe.xcodeproj PKBADownloader probe -type f -not -path '*/xcuserdata/*' -print0 | sort -z | xargs -0 shasum | shasum)
  timed patch-rerun ruby "$here/patch/patch_ba.rb" "$b/patched/probe.xcodeproj" --app-group "$APP_GROUP"
  local h2; h2=$(cd "$b/patched" && find probe.xcodeproj PKBADownloader probe -type f -not -path '*/xcuserdata/*' -print0 | sort -z | xargs -0 shasum | shasum)
  [ "$h1" = "$h2" ] && echo "patch re-run: byte-identical project" || echo "patch re-run: CHANGED the project"
  timed build-patched-device xb "$b/patched" iphoneos "$b/dd/patched-device" "${DEV[@]}" || true
  timed build-patched-sim xb "$b/patched" iphonesimulator "$b/dd/patched-sim" "${SIM[@]}" || true
}

sim_udid() { xcrun simctl list devices available -j | python3 -c "
import json,sys
for rt,ds in json.load(sys.stdin)['devices'].items():
    for d in ds:
        if d['name']=='$SIM_DEVICE' and 'iOS' in rt: print(d['udid']); sys.exit()"; }

launch() { # <udid> <plan> <seconds>: launch with console, terminate after <seconds> if still running
  ( sleep "$3"; xcrun simctl terminate "$1" "$BUNDLE_ID" 2>/dev/null ) & local w=$!
  xcrun simctl launch --console-pty --terminate-running-process "$1" "$BUNDLE_ID" -- "--plan=$2" || true
  kill "$w" 2>/dev/null || true
}

stage_sim() {
  local udid app; udid=$(sim_udid); app="$b/dd/patched-sim/Build/Products/Release-iphonesimulator/probe.app"
  test -d "$app" || { echo "no simulator build; run the build stage first"; return 1; }
  xcrun simctl boot "$udid" 2>/dev/null || true
  xcrun simctl bootstatus "$udid" -b >/dev/null
  xcrun simctl uninstall "$udid" "$BUNDLE_ID" 2>/dev/null || true
  timed sim-install xcrun simctl install "$udid" "$app"
  # Plan "install": the real Background Assets calls (no mock server or Apple CDN is reachable).
  timed sim-plan-install launch "$udid" install 180
  # Plan "emulate": copy v1 PCKs into the App Group container, as Background Assets would, and mount.
  local grp; grp=$(xcrun simctl get_app_container "$udid" "$BUNDLE_ID" "$APP_GROUP")
  rm -rf "$grp/pkba-emul" && mkdir -p "$grp/pkba-emul"
  cp -R "$b/packs/src_v1/"* "$grp/pkba-emul/"
  timed sim-plan-emulate launch "$udid" emulate 120
  grep -h '^PKBA ' "$logs/sim-plan-install.log" "$logs/sim-plan-emulate.log" | cut -c1-400
}

stage_ids() { "$here/packs/id_rules.sh" "$b/idrules" | tee "$logs/ids.log"; }

stages=("$@"); [ "${stages[0]:-all}" = all ] && stages=(shim packs export build sim ids)
for s in "${stages[@]}"; do echo "== $s"; "stage_$s"; done
