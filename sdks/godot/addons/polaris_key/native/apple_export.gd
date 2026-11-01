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
## Capabilities (I-48.4b, Q-7): `polaris_key/apple_sign_in` (env PKEY_APPLE_SIGN_IN), a boolean that is
## `off` by default, adds the `com.apple.developer.applesignin` entitlement to an iOS export through
## the preset's `entitlements/additional` option (the plugin overrides it, keeping the preset's own
## text). It is off by default because an entitlement the App ID lacks breaks signing. A macOS preset
## has no such option in Godot: the setting there only warns, and the entitlement goes into the
## preset's custom entitlements file.
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
const SIGN_IN_OPTION := "polaris_key/apple_sign_in"
const SIGN_IN_ENV := "PKEY_APPLE_SIGN_IN"
## The iOS preset option whose text lands in the app's .entitlements <dict>.
const IOS_ENTITLEMENTS_OPTION := "entitlements/additional"
const ENTITLEMENT_SIGN_IN := "com.apple.developer.applesignin"
const GAME_CENTER_OPTION := "polaris_key/game_center"
const GAME_CENTER_ENV := "PKEY_APPLE_GAME_CENTER"
const ENTITLEMENT_GAME_CENTER := "com.apple.developer.game-center"
## The opt-in Game Center extension's .gdextension files (native/ios/build.sh and
## native/macos/build_apple.sh with EXTENSION=gamecenter install them): its presence in the project is
## the opt-in, because Godot exports every GDExtension it finds and an export plugin cannot keep one out.
const GAME_CENTER_EXTENSION_FILES := {
	"ios": "res://addons/polaris_key/native/ios/pkey_gamecenter.gdextension",
	"macos": "res://addons/polaris_key/native/bin/pkey_gamecenter_macos.gdextension",
}
const XCFRAMEWORK := "res://addons/polaris_key/native/ios/pkey_apple.xcframework"
## Cloud Connect's LAN discovery plist entries (see `local_network_plist`).
const BONJOUR_SERVICE := "_pkeypeer._tcp"
const LOCAL_NETWORK_KEY := "NSLocalNetworkUsageDescription"
const BONJOUR_KEY := "NSBonjourServices"
const DEFAULT_LOCAL_NETWORK_USAGE := "Find your other devices on this network."


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


## The entitlement entries (plist fragments) the switches ask for.
static func entitlement_fragments(sign_in: bool, game_center := false) -> PackedStringArray:
	var out := PackedStringArray()
	if sign_in:
		out.append("<key>%s</key>\n<array><string>Default</string></array>" % ENTITLEMENT_SIGN_IN)
	if game_center:
		out.append("<key>%s</key>\n<true/>" % ENTITLEMENT_GAME_CENTER)
	return out


## Whether the opt-in Game Center extension is installed in this project for `platform` (ios, macos).
static func extension_installed(platform: String, exists := Callable()) -> bool:
	if not GAME_CENTER_EXTENSION_FILES.has(platform):
		return false
	var path: String = GAME_CENTER_EXTENSION_FILES[platform]
	return bool(exists.call(path)) if exists.is_valid() else FileAccess.file_exists(path)


## A warning when the Game Center option and the installed extension disagree ("" when they agree).
static func game_center_warning(on: bool, installed: bool) -> String:
	if on and not installed:
		var how := "Build it with EXTENSION=gamecenter (native/ios/build.sh or native/macos/build_apple.sh)."
		return "%s is on but the Game Center extension is not installed: the entitlement is added and the rung answers unavailable. %s" % [GAME_CENTER_OPTION, how]
	if installed and not on:
		var fix := "Turn the option on, or remove pkey_gamecenter from the project."
		return "the Game Center extension is installed, so GameKit is linked, but %s is off: the entitlement is not added. %s" % [GAME_CENTER_OPTION, fix]
	return ""


## `existing` (the preset's own `entitlements/additional` text) plus the fragments whose key it does
## not already name. The preset's text is never changed or reordered.
static func merge_entitlements(existing: String, fragments: PackedStringArray) -> String:
	var out := existing
	for f in fragments:
		var key := f.get_slice("</key>", 0).trim_prefix("<key>")
		if existing.contains("<key>%s</key>" % key):
			continue
		out += ("" if out == "" or out.ends_with("\n") else "\n") + f + "\n"
	return out


## A warning for an entitlement option on a macOS preset ("" otherwise): Godot's macOS export has no
## entitlement text option, so the entitlement goes into the preset's custom entitlements file.
static func sign_in_warning(on: bool, platform: String, option := SIGN_IN_OPTION, entitlement := ENTITLEMENT_SIGN_IN) -> String:
	if on and platform == "macos":
		var why := "Godot's macOS export has no entitlement text option. Add %s to the preset's custom entitlements file."
		return "%s: %s" % [option, why % entitlement]
	return ""


## What Cloud Connect's LAN discovery needs in an iOS Info.plist (CC-14b.4, D-16): NSBonjourServices
## listing the peer service type and a Local Network usage sentence. The OS refuses to browse or
## advertise without them (`not-configured`). Each key is added only when `existing` (the preset's
## own additional plist content) does not already carry it, so a key is never doubled. The
## permission prompt appears when Connect first browses, not at launch.

static func local_network_plist(existing: String, description := DEFAULT_LOCAL_NETWORK_USAGE) -> String:
	var lines := PackedStringArray()
	if not existing.contains(BONJOUR_KEY):
		lines.append("<key>%s</key>" % BONJOUR_KEY)
		lines.append("<array>")
		lines.append("<string>%s</string>" % BONJOUR_SERVICE)
		lines.append("</array>")
	if not existing.contains(LOCAL_NETWORK_KEY):
		var text := description.strip_edges() if description.strip_edges() != "" else DEFAULT_LOCAL_NETWORK_USAGE
		lines.append("<key>%s</key>" % LOCAL_NETWORK_KEY)
		lines.append("<string>%s</string>" % text.xml_escape())
	return "" if lines.is_empty() else "\n".join(lines) + "\n"


## A warning when the preset's own NSBonjourServices does not list the peer service.
static func bonjour_warning(existing: String) -> String:
	if existing.contains(BONJOUR_KEY) and not existing.contains(BONJOUR_SERVICE):
		return "additional_plist_content has %s without %s: Cloud Connect's local discovery will answer not-configured." % [BONJOUR_KEY, BONJOUR_SERVICE]
	return ""


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
