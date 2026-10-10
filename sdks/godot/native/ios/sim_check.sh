#!/usr/bin/env bash
# sim_check.sh: the Godot iOS binding end to end on the iOS simulator (P5-05; notes/S-09 §Recommendation
# 9d). Local only: it needs an arm64 simulator libgodot.a, which the official 4.7.2 template lacks
# (its simulator slice is x86_64 only; build one from the same tag with
# `scons platform=ios target=template_release arch=arm64 simulator=yes`).
#
# It builds the xcframework, exports a throwaway project whose main scene drives PKeyApple through
# the real GDExtension (ping, capabilities, the launch distributor read, a Keychain round trip,
# products, Background Assets in a build without the extension), builds it for the simulator
# (ad hoc), installs and launches it, and checks the JSON lines the app writes to user://.
#
#   GODOT_SIM_LIB  the arm64 simulator libgodot.ios.template_release.arm64.simulator.a (required)
#   GODOT_BIN      the 4.7.2 editor with the iOS export templates installed (default: godot)
#   SIM_UDID       a simulator (default: a dedicated "pkey-godot-apple" iPhone, created if needed)
#   OUT            the work directory (default: sdks/godot/build/ios_sim_check)

set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
SDK="$(cd "$HERE/../.." && pwd)"
GODOT="${GODOT_BIN:-godot}"
OUT="${OUT:-$SDK/build/ios_sim_check}"
SIM_LIB="${GODOT_SIM_LIB:?set GODOT_SIM_LIB to an arm64 simulator libgodot.a}"
BID="dev.polariskey.simcheck"
fail() { echo "sim_check: FAIL: $*" >&2; exit 1; }

"$HERE/build.sh"

rm -rf "$OUT"
mkdir -p "$OUT/project/addons" "$OUT/export" "$OUT/logs"
cp -R "$SDK/addons/polaris_key" "$OUT/project/addons/"
OUT_ICON="$OUT/project/icon.png" python3 - <<'PY'
import os, struct, zlib
w = h = 256
raw = b"".join(b"\x00" + bytes((0x1a, 0x23, 0x5c, 0xff)) * w for _ in range(h))
def chunk(t, d): return struct.pack(">I", len(d)) + t + d + struct.pack(">I", zlib.crc32(t + d) & 0xffffffff)
png = b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", w, h, 8, 6, 0, 0, 0)) + chunk(b"IDAT", zlib.compress(raw)) + chunk(b"IEND", b"")
open(os.environ["OUT_ICON"], "wb").write(png)
PY
cat >"$OUT/project/project.godot" <<'EOF'
config_version=5

[application]

config/name="PKeySimCheck"
config/version="1.0.0"
config/icon="res://icon.png"
run/main_scene="res://main.tscn"

[audio]

driver/driver="Dummy"

[autoload]

PolarisKey="*res://addons/polaris_key/polaris_key.gd"

[rendering]

renderer/rendering_method="gl_compatibility"
renderer/rendering_method.mobile="gl_compatibility"
textures/vram_compression/import_etc2_astc=true
EOF
cat >"$OUT/project/main.tscn" <<'EOF'
[gd_scene load_steps=2 format=3]

[ext_resource type="Script" path="res://main.gd" id="1"]

[node name="Main" type="Node"]
script = ExtResource("1")
EOF
cat >"$OUT/project/main.gd" <<'EOF'
extends Node
# Drives PKeyApple through the real PolarisKeyApple GDExtension and writes one JSON line per
# observation to user://pkey_apple_check.jsonl (stdout does not reliably reach simctl).

var _log: FileAccess


func _line(label: String, value: Variant) -> void:
	var s := JSON.stringify({"label": label, "value": value})
	print("PKEYCHECK ", s)
	_log.store_line(s)
	_log.flush()


func _r(r: PKeyResult) -> Dictionary:
	return {"ok": r.ok, "code": String(r.code), "detail": r.detail}


func _ready() -> void:
	_log = FileAccess.open("user://pkey_apple_check.jsonl", FileAccess.WRITE)
	var apple := PKeyApple.shared()
	_line("class", ClassDB.class_exists("PolarisKeyApple"))
	_line("available", apple.unsupported_reason())
	_line("ping", apple.call_sync({"op": "ping"}))
	_line("capabilities", _r(apple.capabilities()))
	_line("distributor", _r(await apple.distributor(1.0)))
	_line("kc_set", _r(apple.keychain_set("simcheck", "token", "pkeyt_sim")))
	_line("kc_get", _r(apple.keychain_get("simcheck", "token")))
	_line("kc_delete", _r(apple.keychain_delete("simcheck", "token")))
	_line("products", _r(await apple.products(PackedStringArray(["dev.polariskey.simcheck.pack"]))))
	_line("pack_status", _r(await apple.pack_status("foes-c3")))
	_line("listen", _r(await apple.listen()))
	# The autoload started the launch read on iOS; give it its 2 s deadline.
	await get_tree().create_timer(2.5).timeout
	_line("launch_distributor", PKeyApple.launch_distributor())
	_line("outlet_env", PKeyOutletEnv.new().ios_app_distributor())
	_line("launch_listening", PKeyApple.launch_listening())
	_line("done", true)
	get_tree().quit()
EOF
cat >"$OUT/project/export_presets.cfg" <<EOF
[preset.0]

name="iOS"
platform="iOS"
runnable=true
dedicated_server=false
custom_features=""
export_filter="all_resources"
include_filter=""
exclude_filter=""
export_path="$OUT/export/PKeySimCheck.ipa"
patches=PackedStringArray()
encryption_include_filters=""
encryption_exclude_filters=""
seed=0
encrypt_pck=false
encrypt_directory=false
script_export_mode=2

[preset.0.options]

application/app_store_team_id="ABCDE12345"
application/export_project_only=true
application/bundle_identifier="$BID"
application/min_ios_version="18.0"
application/short_version="1.0.0"
application/version="1"
application/export_method_debug=1
application/export_method_release=0
polaris_key/outlet="altstore"
polaris_key/apple_background_assets="auto"
EOF

"$GODOT" --headless --path "$OUT/project" --import >"$OUT/logs/import.log" 2>&1 || true
"$GODOT" --headless --path "$OUT/project" --export-release "iOS" "$OUT/export/PKeySimCheck.ipa" >"$OUT/logs/export.log" 2>&1 || true
[ -d "$OUT/export/PKeySimCheck.xcodeproj" ] || { tail -20 "$OUT/logs/export.log"; fail "no Xcode project exported"; }

# The official simulator slice is x86_64 only: add the arm64 one.
slice="$(find "$OUT/export/PKeySimCheck.xcframework" -path '*simulator*' -name libgodot.a | head -n 1)"
[ -n "$slice" ] || fail "no simulator libgodot.a in the export"
lipo -create "$SIM_LIB" "$slice" -output "$slice.fat" && mv "$slice.fat" "$slice"

(cd "$OUT/export" && xcodebuild -project PKeySimCheck.xcodeproj -scheme PKeySimCheck -configuration Release \
  -sdk iphonesimulator -destination 'generic/platform=iOS Simulator' -derivedDataPath "$OUT/dd" \
  CODE_SIGN_IDENTITY=- CODE_SIGN_STYLE=Manual DEVELOPMENT_TEAM= PROVISIONING_PROFILE_SPECIFIER= ARCHS=arm64 build \
  >"$OUT/logs/build.log" 2>&1) || { tail -30 "$OUT/logs/build.log"; fail "simulator build failed"; }
APP="$OUT/dd/Build/Products/Release-iphonesimulator/PKeySimCheck.app"
[ -d "$APP/Frameworks/pkey_apple.framework" ] || fail "pkey_apple.framework is not embedded"

udid="${SIM_UDID:-}"
if [ -z "$udid" ]; then
  udid="$(xcrun simctl list devices available -j | python3 -c '
import json, sys
for devs in json.load(sys.stdin)["devices"].values():
    for d in devs:
        if d["name"] == "pkey-godot-apple":
            print(d["udid"]); raise SystemExit')"
  if [ -z "$udid" ]; then
    read -r runtime device_type <<<"$(xcrun simctl list runtimes -j | python3 -c '
import json, sys
rts = sorted((r for r in json.load(sys.stdin)["runtimes"] if r["platform"] == "iOS" and r["isAvailable"]), key=lambda r: [int(x) for x in r["version"].split(".")])
phones = [t for t in rts[-1].get("supportedDeviceTypes", []) if t["name"].startswith("iPhone")]
print(rts[-1]["identifier"], phones[-1]["identifier"])')"
    udid="$(xcrun simctl create pkey-godot-apple "$device_type" "$runtime")"
  fi
fi
xcrun simctl boot "$udid" 2>/dev/null || true
xcrun simctl bootstatus "$udid" -b >/dev/null
xcrun simctl uninstall "$udid" "$BID" 2>/dev/null || true
xcrun simctl install "$udid" "$APP"
xcrun simctl launch "$udid" "$BID" >"$OUT/logs/launch.log" 2>&1

data="$(xcrun simctl get_app_container "$udid" "$BID" data)"
log=""
for _ in $(seq 1 60); do
  log="$(find "$data" -name pkey_apple_check.jsonl 2>/dev/null | head -n 1)"
  if [ -n "$log" ] && grep -q '"label":"done"' "$log"; then break; fi
  sleep 1
done
[ -n "$log" ] || fail "the app wrote no log"
cp "$log" "$OUT/logs/pkey_apple_check.jsonl"
cat "$OUT/logs/pkey_apple_check.jsonl"
xcrun simctl terminate "$udid" "$BID" 2>/dev/null || true

python3 - "$OUT/logs/pkey_apple_check.jsonl" <<'PY'
import json, sys
rows = {}
for line in open(sys.argv[1]):
    o = json.loads(line)
    rows[o["label"]] = o["value"]
def need(cond, what):
    if not cond:
        print("sim_check: FAIL:", what); sys.exit(1)
need(rows.get("done") is True, "the plan did not finish")
need(rows["class"] is True, "PolarisKeyApple is not registered")
need(rows["available"] == "", "PKeyApple says unsupported: %r" % rows["available"])
need(rows["ping"].get("ok") is True and rows["ping"].get("mainThread") is True, "ping: %r" % rows["ping"])
caps = rows["capabilities"]["detail"]
need(caps.get("platform") == "ios" and caps.get("appDistributor") is True, "capabilities: %r" % caps)
need(caps.get("backgroundAssetsConfigured") is False, "a sideload build must not be Background Assets configured")
d = rows["distributor"]["detail"]
need(rows["distributor"]["ok"] and d.get("signal") in ("unavailable", "appStore", "testFlight", "other"), "distributor: %r" % d)
need(d.get("bundleIdentifier") == "dev.polariskey.simcheck" and d.get("provisioned") is False, "bundle evidence: %r" % d)
need(rows["kc_set"]["ok"] and rows["kc_get"]["detail"].get("value") == "pkeyt_sim" and rows["kc_delete"]["ok"], "keychain round trip")
need(rows["products"]["ok"], "products: %r" % rows["products"])
ps = rows["pack_status"]
need(ps["code"] == "unsupported" and ps["detail"]["reason"] == "outlet", "pack_status in a sideload build: %r" % ps)
need(rows["listen"]["ok"], "listen")
need(isinstance(rows["launch_distributor"], dict), "the autoload's launch read did not arrive")
need(rows["launch_listening"] is True, "the autoload did not start the Transaction.updates listener")
print("sim_check: OK")
PY
