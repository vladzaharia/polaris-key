class_name PKeyAppleExport
extends RefCounted
## The iOS export switches of the Apple platform plugin (P5-05), as pure functions the export
## plugin calls and the headless tests drive.
##
## One per-preset option, `polaris_key/apple_background_assets` (env
## PKEY_APPLE_BACKGROUND_ASSETS): `auto` (the default), `on` or `off`. `auto` is on for the store
## outlets (`app-store`, `testflight`) and off for every other outlet, so a sideload IPA (AltStore,
## AltStore PAL, a direct download) ships no Background Assets extension: a free Apple ID gets 3
## apps and 10 App IDs a week, and each extension uses one (report §4.1).
##
## Godot's export cannot add an app extension target, so the switch only marks the exported
## Info.plist: `PKeyAppleBackgroundAssets` (bool) and `PKeyAppleAppGroup` (`group.<bundle id>`).
## The post-export step (sdks/godot/native/ios/patch_export.sh, which runs S-01's patch_ba.rb
## unchanged) reads them and adds the extension target, the App Group on both targets and the
## `BAAppGroupID` / `BAHasManagedAssetPacks` / `BAUsesAppleHosting` keys only where the mark is
## true. The plist content goes through `add_apple_embedded_platform_plist_content` (4.5+) or
## `add_ios_plist_content` (4.4).
##
## The xcframework is iOS 17.0 (PolarisKeyPlatform's floor), so a preset below 17.0 is warned
## about: a framework newer than the app fails to load on the older devices.

const OPTION := "polaris_key/apple_background_assets"
const ENV := "PKEY_APPLE_BACKGROUND_ASSETS"
const MODES := ["auto", "on", "off"]
const STORE_KINDS := ["app-store", "testflight"]
const SIDELOAD_KINDS := ["altstore", "altstore-pal", "direct"]
## PolarisKeyPlatform's iOS floor, and the xcframework's (sdks/godot/native/ios/build.sh).
const MIN_IOS := "18.0"
const XCFRAMEWORK := "res://addons/polaris_key/native/ios/pkey_apple.xcframework"


## Whether the Background Assets extension is wanted for `mode` and the build's outlet kind.
static func enabled(mode: String, outlet_kind: String) -> bool:
	match mode.strip_edges().to_lower():
		"on":
			return true
		"off":
			return false
	return STORE_KINDS.has(outlet_kind)


## The Info.plist fragment for this export ("" when there is no bundle id to name the group).
static func plist_content(on: bool, bundle_id: String) -> String:
	var lines := PackedStringArray()
	lines.append("<key>PKeyAppleBackgroundAssets</key>")
	lines.append("<true/>" if on else "<false/>")
	if on and bundle_id != "":
		lines.append("<key>PKeyAppleAppGroup</key>")
		lines.append("<string>group.%s</string>" % bundle_id.xml_escape())
	return "\n".join(lines) + "\n"


## A warning for the option ("" when none).
static func mode_warning(mode: String, outlet_kind: String) -> String:
	var m := mode.strip_edges().to_lower()
	if not MODES.has(m):
		return "%s must be auto, on or off, not '%s' (auto is used)." % [OPTION, mode]
	if m == "on" and SIDELOAD_KINDS.has(outlet_kind):
		return "%s is on for the sideload outlet '%s': the Background Assets extension costs an App ID on a free Apple ID and the app falls back to pkey-cdn anyway." % [OPTION, outlet_kind]
	return ""


## A warning when the preset's minimum iOS is below the plugin's floor ("" when fine).
static func min_ios_warning(min_ios: String) -> String:
	if min_ios.strip_edges() == "":
		return ""
	if _version_less(min_ios.strip_edges(), MIN_IOS):
		return "application/min_ios_version %s is below the Polaris Key Apple plugin's iOS %s: the plugin's framework would not load on older devices. Raise it, or build without pkey_apple.xcframework." % [min_ios, MIN_IOS]
	return ""


static func _version_less(a: String, b: String) -> bool:
	var pa := a.split(".")
	var pb := b.split(".")
	for i in range(maxi(pa.size(), pb.size())):
		var x := int(pa[i]) if i < pa.size() else 0
		var y := int(pb[i]) if i < pb.size() else 0
		if x != y:
			return x < y
	return false
