@tool
class_name PKeyNativeExport
extends RefCounted
## The export-time half of P5-07's macOS Sparkle bridge (notes/S-11 §4.1, §8 step 3), used by
## PKeyExportPlugin on macOS presets. Per-preset options, each overridable from CI through
## `get_or_env`:
##
##   polaris_key/sparkle/enabled           PKEY_SPARKLE            this build ships the Sparkle
##                                                                 bridge (sdks/godot/native/macos)
##   polaris_key/sparkle/public_ed_key     PKEY_SPARKLE_PUBLIC_KEY SUPublicEDKey; empty: the
##                                                                 project's PKeyOptions
##                                                                 update_eddsa_public_key
##   polaris_key/sparkle/feed_url          PKEY_SPARKLE_FEED_URL   SUFeedURL, a fallback only (the
##                                                                 bridge passes discovery's)
##   polaris_key/sparkle/automatic_checks                          SUEnableAutomaticChecks
##
## With Sparkle enabled the plugin overrides three macOS preset options:
##
##   application/additional_plist_content  the preset's own content plus SUPublicEDKey, SUFeedURL
##                                          and SUEnableAutomaticChecks (a key the preset already
##                                          sets is left alone)
##   codesign/entitlements/disable_library_validation  on: a GDExtension in a hardened-runtime app
##                                          needs it (notes/E4 §2.1)
##   codesign/codesign                      never Disabled: 0 becomes 1 (built-in ad-hoc), because
##                                          a disabled export keeps the template's Developer ID
##                                          signature on a modified bundle and Sparkle rejects
##                                          every update to it ("code signing signature is
##                                          corrupted"). Release jobs use 3 (Xcode codesign) with a
##                                          Developer ID, then sign_and_notarize.sh
##
## After an export to a `.app` the plugin restores the executable bit Godot's [dependencies] copy
## drops on Sparkle's five Mach-O files (`chmod 0755`; the mode is not sealed, so the signature
## stays valid). A `.zip` or `.dmg` export cannot be fixed afterwards: export the `.app` and package
## it with sdks/godot/native/macos/sign_and_notarize.sh, which also restores the bits.

const OPTION_ENABLED := "polaris_key/sparkle/enabled"
const OPTION_PUBLIC_KEY := "polaris_key/sparkle/public_ed_key"
const OPTION_FEED_URL := "polaris_key/sparkle/feed_url"
const OPTION_AUTOMATIC_CHECKS := "polaris_key/sparkle/automatic_checks"
const ENV_ENABLED := "PKEY_SPARKLE"
const ENV_PUBLIC_KEY := "PKEY_SPARKLE_PUBLIC_KEY"
const ENV_FEED_URL := "PKEY_SPARKLE_FEED_URL"

const PLIST := "application/additional_plist_content"
const LIBRARY_VALIDATION := "codesign/entitlements/disable_library_validation"
const CODESIGN := "codesign/codesign"
## codesign/codesign: Disabled, Built-in (ad-hoc only), rcodesign, Xcode codesign.
const CODESIGN_DISABLED := 0
const CODESIGN_BUILT_IN := 1

## Sparkle's Mach-O files inside Contents/Frameworks/Sparkle.framework/Versions/B.
const HELPERS := [
	"Sparkle",
	"Autoupdate",
	"Updater.app/Contents/MacOS/Updater",
	"XPCServices/Downloader.xpc/Contents/MacOS/Downloader",
	"XPCServices/Installer.xpc/Contents/MacOS/Installer",
]


static func options() -> Array[Dictionary]:
	return [
		{"option": {"name": OPTION_ENABLED, "type": TYPE_BOOL}, "default_value": false, "update_visibility": true},
		{"option": {"name": OPTION_PUBLIC_KEY, "type": TYPE_STRING}, "default_value": "", "update_visibility": true},
		{"option": {"name": OPTION_FEED_URL, "type": TYPE_STRING}, "default_value": ""},
		{"option": {"name": OPTION_AUTOMATIC_CHECKS, "type": TYPE_BOOL}, "default_value": false},
	]


## A truthy option or environment value (`true`, `1`, `yes`, `on`).
static func truthy(v: Variant) -> bool:
	if v is bool:
		return v
	return str(v).strip_edges().to_lower() in ["1", "true", "yes", "on"]


## The public key: the option (or PKEY_SPARKLE_PUBLIC_KEY), else PKeyOptions'.
static func public_key(option_value: Variant, config_path := PKeyBuildStamp.CONFIG_PATH) -> String:
	var k := str(option_value if option_value != null else "").strip_edges()
	if k != "":
		return k
	if config_path != "" and ResourceLoader.exists(config_path):
		var opts = load(config_path)
		if opts is PKeyOptions:
			return str(opts.get("update_eddsa_public_key")).strip_edges()
	return ""


## The preset's plist content with Sparkle's keys appended (each only when the content lacks it).
static func plist_content(existing: String, key: String, feed_url: String, automatic_checks: bool) -> String:
	var out := existing
	if key != "" and not existing.contains("<key>SUPublicEDKey</key>"):
		out += "<key>SUPublicEDKey</key><string>%s</string>" % key.xml_escape()
	if feed_url != "" and not existing.contains("<key>SUFeedURL</key>"):
		out += "<key>SUFeedURL</key><string>%s</string>" % feed_url.xml_escape()
	if not existing.contains("<key>SUEnableAutomaticChecks</key>"):
		out += "<key>SUEnableAutomaticChecks</key><%s/>" % ("true" if automatic_checks else "false")
	return out


## The option overrides for a Sparkle-enabled macOS preset (see the class doc).
static func overrides(existing_plist: String, codesign: int, key: String, feed_url: String, automatic_checks: bool) -> Dictionary:
	var o := {
		PLIST: plist_content(existing_plist, key, feed_url, automatic_checks),
		LIBRARY_VALIDATION: true,
	}
	if codesign == CODESIGN_DISABLED:
		o[CODESIGN] = CODESIGN_BUILT_IN
	return o


## What is wrong with a Sparkle-enabled preset (empty when nothing): the export dialog's warnings
## and, at export, push_warning lines. They do not stop an export (a plugin cannot); the bridge
## refuses to start in a bundle without SUPublicEDKey.
static func problems(key: String, feed_url: String) -> PackedStringArray:
	var out := PackedStringArray()
	if key == "":
		out.append("Sparkle is enabled without a public key: set %s (or PKeyOptions.update_eddsa_public_key). The bridge refuses to start without SUPublicEDKey." % OPTION_PUBLIC_KEY)
	elif not PKeyCore.is_eddsa_public_key(key):
		out.append("%s must be the base64 Ed25519 public key generate_keys prints (32 bytes)." % OPTION_PUBLIC_KEY)
	if feed_url != "" and not (feed_url.begins_with("https://") or feed_url.begins_with("http://127.0.0.1:") or feed_url.begins_with("http://localhost:")):
		out.append("%s must be https (App Transport Security lets Sparkle use plain http only on loopback)." % OPTION_FEED_URL)
	return out


## Sparkle's Mach-O files in an exported `.app`.
static func helper_paths(app: String) -> PackedStringArray:
	var base := app.path_join("Contents/Frameworks/Sparkle.framework/Versions/B")
	var out := PackedStringArray()
	for h in HELPERS:
		out.append(base.path_join(h))
	return out


## chmod 0755 on Sparkle's Mach-O files in `app`: the paths it could not change.
static func restore_executable_bits(app: String) -> PackedStringArray:
	var failed := PackedStringArray()
	for p in helper_paths(app):
		if not FileAccess.file_exists(p) or FileAccess.set_unix_permissions(p, 0x1ED) != OK:
			failed.append(p)
	return failed
