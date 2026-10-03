@tool
class_name PKeyExportPlugin
extends EditorExportPlugin
## Stamps every export with `res://.polaris_key/build.json` (PKeyBuildStamp) and adds the
## matching `pkey_outlet_<id>` and `pkey_channel_<channel>` feature tags. Registered by plugin.gd.
##
## Per-preset options, each overridable from CI through `get_or_env` (headless
## `--export-release` included):
##
##   polaris_key/outlet        PKEY_BUILD_OUTLET   the product's outlet id: a kind or its own id
##                                                 (direct on the desktop, play on Android,
##                                                 app-store on iOS, web on web)
##   polaris_key/outlet_kind   PKEY_BUILD_OUTLET_KIND  one of the 17 kinds; empty means the outlet
##                                                 when that is a kind (itch-beta needs `itch`)
##   polaris_key/outlet_subkind PKEY_BUILD_OUTLET_SUBKIND  optional: homebrew, scoop, flatpak, …
##   polaris_key/format        PKEY_BUILD_FORMAT   optional: the build's format (zip, dmg, exe, …)
##   polaris_key/channel       PKEY_BUILD_CHANNEL  §5.1 channel (default stable)
##   polaris_key/build_number  PKEY_BUILD_NUMBER   integer build number
##   polaris_key/outlet_ids    PKEY_OUTLET_IDS     JSON object of the product's outlet identities
##                                                 (`pkey distribution outlet-ids --outlet <id>`)
##   polaris_key/apple_background_assets  PKEY_APPLE_BACKGROUND_ASSETS  iOS only: auto, on or off
##                                                 (PKeyAppleExport, P5-05): marks the exported
##                                                 Info.plist so the post-export Xcode patch adds
##                                                 the Background Assets extension to store builds
##                                                 and leaves it out of sideload builds
##
## The plugin never reads `.pkey/distribution`: it may be YAML, which Godot cannot parse, and it
## sits at the product repo root, which need not be the project root. `bundleId` comes from the
## preset (application/bundle_identifier, package/unique_name) and wins over the option's.
##
## An export plugin cannot fail an export, so a bad value is a dialog warning
## (`_get_export_option_warning`, editor only) and, at export, a push_warning a headless log shows.
##
## macOS presets also get P5-07's Sparkle options (`polaris_key/sparkle/*`, PKeyNativeExport): the
## Info.plist keys, the Disable Library Validation entitlement, never an unsigned export, and the
## executable bits Sparkle's helpers lose in Godot's copy. Windows exports take the plugins' DLLs and
## the Velopack shim from the Windows GDExtension's [dependencies]; the plugin removes them again
## from a Microsoft Store export (outlet kind ms-store), whose only updater is StoreContext.

const S := preload("res://addons/polaris_key/core/build_stamp.gd")
const Apple := preload("res://addons/polaris_key/native/apple_export.gd")
const N := preload("res://addons/polaris_key/export/native_export.gd")

var _export_path := ""
var _export_macos := false
var _export_windows_store := false


func _get_name() -> String:
	return "PolarisKey"


func _supports_platform(_platform: EditorExportPlatform) -> bool:
	return true


func _get_export_options(platform: EditorExportPlatform) -> Array[Dictionary]:
	var p := S.platform_for(platform.get_os_name(), PackedStringArray())
	var options: Array[Dictionary] = [
		{
			"option": {"name": S.OPTION_OUTLET, "type": TYPE_STRING, "hint": PROPERTY_HINT_ENUM_SUGGESTION, "hint_string": ",".join(S.OUTLETS)},
			"default_value": S.default_outlet(p),
			"update_visibility": true,
		},
		{
			"option": {"name": S.OPTION_OUTLET_KIND, "type": TYPE_STRING, "hint": PROPERTY_HINT_ENUM_SUGGESTION, "hint_string": ",".join(S.OUTLETS)},
			"default_value": "",
			"update_visibility": true,
		},
		{
			"option": {"name": S.OPTION_OUTLET_SUBKIND, "type": TYPE_STRING, "hint": PROPERTY_HINT_ENUM_SUGGESTION, "hint_string": ",".join(S.OUTLET_SUBKINDS)},
			"default_value": "",
			"update_visibility": true,
		},
		{
			"option": {"name": S.OPTION_FORMAT, "type": TYPE_STRING},
			"default_value": "",
			"update_visibility": true,
		},
		{
			"option": {"name": S.OPTION_CHANNEL, "type": TYPE_STRING, "hint": PROPERTY_HINT_ENUM_SUGGESTION, "hint_string": "stable,beta,dev"},
			"default_value": S.DEFAULT_CHANNEL,
			"update_visibility": true,
		},
		{
			"option": {"name": S.OPTION_BUILD_NUMBER, "type": TYPE_INT, "hint": PROPERTY_HINT_RANGE, "hint_string": "0,2147483647,1"},
			"default_value": 0,
			"update_visibility": true,
		},
		{
			"option": {"name": S.OPTION_OUTLET_IDS, "type": TYPE_STRING, "hint": PROPERTY_HINT_MULTILINE_TEXT},
			"default_value": "{}",
			"update_visibility": true,
		},
	]
	if p == "ios":
		options.append({
			"option": {"name": Apple.OPTION, "type": TYPE_STRING, "hint": PROPERTY_HINT_ENUM, "hint_string": ",".join(Apple.MODES)},
			"default_value": "auto",
			"update_visibility": true,
		})
	if p == "macos":
		options.append_array(N.options())
	return options


func _get_export_option_warning(_platform: EditorExportPlatform, option: String) -> String:
	match option:
		S.OPTION_OUTLET:
			return S.outlet_warning(str(get_option(S.OPTION_OUTLET)))
		S.OPTION_OUTLET_KIND:
			return S.outlet_kind_warning(str(get_option(S.OPTION_OUTLET)).strip_edges(), str(get_option(S.OPTION_OUTLET_KIND)).strip_edges())
		S.OPTION_OUTLET_SUBKIND:
			return S.outlet_subkind_warning(str(get_option(S.OPTION_OUTLET_SUBKIND)).strip_edges())
		S.OPTION_CHANNEL:
			return S.channel_warning(str(get_option(S.OPTION_CHANNEL)), _version())
		S.OPTION_BUILD_NUMBER:
			return _join([S.version_warning(_version()), S.parse_build_number(get_option(S.OPTION_BUILD_NUMBER))["problem"]])
		Apple.OPTION:
			var v := _values("ios")
			return _join([Apple.mode_warning(str(get_option(Apple.OPTION)), _outlet_kind(v)), Apple.min_ios_warning(_preset_string("application/min_ios_version"))])
		S.OPTION_OUTLET_IDS:
			var raw = get_option(S.OPTION_OUTLET_IDS)
			var parsed: Dictionary = S.parse_outlet_ids(raw)
			return _join([S.outlet_ids_warning(raw)] + S.merge_bundle_id(parsed["ids"], _preset_bundle_id())["problems"])
		N.OPTION_ENABLED, N.OPTION_PUBLIC_KEY, N.OPTION_FEED_URL:
			var sp := _sparkle()
			return _join(Array(N.problems(sp["key"], sp["feed_url"]))) if sp["enabled"] else ""
	return ""


## The Sparkle options of this macOS preset, environment over preset: {enabled, key, feed_url,
## automatic_checks}.
func _sparkle() -> Dictionary:
	return {
		"enabled": N.truthy(_get_or_env(N.OPTION_ENABLED, N.ENV_ENABLED, false)),
		"key": N.public_key(_get_or_env(N.OPTION_PUBLIC_KEY, N.ENV_PUBLIC_KEY, "")),
		"feed_url": str(_get_or_env(N.OPTION_FEED_URL, N.ENV_FEED_URL, "")).strip_edges(),
		"automatic_checks": N.truthy(_get_or_env(N.OPTION_AUTOMATIC_CHECKS, "", false)),
	}


func _get_export_options_overrides(platform: EditorExportPlatform) -> Dictionary:
	var preset := get_export_preset()
	if preset == null or S.platform_for(platform.get_os_name(), PackedStringArray()) != "macos":
		return {}
	var sp := _sparkle()
	if not sp["enabled"]:
		return {}
	var existing := str(preset.get(N.PLIST)) if preset.has(N.PLIST) else ""
	var codesign := int(preset.get(N.CODESIGN)) if preset.has(N.CODESIGN) else N.CODESIGN_BUILT_IN
	return N.overrides(existing, codesign, sp["key"], sp["feed_url"], sp["automatic_checks"])


func _get_export_features(platform: EditorExportPlatform, _debug: bool) -> PackedStringArray:
	var v := _values(S.platform_for(platform.get_os_name(), PackedStringArray()))
	return S.feature_tags(v["outlet"], v["channel"], v["outlet_kind"])


func _export_begin(features: PackedStringArray, is_debug: bool, path: String, _flags: int) -> void:
	var platform := S.platform_for(get_export_platform().get_os_name() if get_export_platform() != null else "", features)
	_export_path = path
	_export_macos = platform == "macos" and _sparkle()["enabled"]
	var store_values := _values(platform)
	_export_windows_store = platform == "windows" and S.feature_tags(store_values["outlet"], "", store_values["outlet_kind"]).has("pkey_outlet_ms_store")
	if _export_macos:
		var sp := _sparkle()
		for problem in N.problems(sp["key"], sp["feed_url"]):
			push_warning("Polaris Key Sparkle: %s" % problem)
		var preset := get_export_preset()
		if preset != null and preset.has(N.CODESIGN) and int(preset.get(N.CODESIGN)) == N.CODESIGN_DISABLED:
			push_warning("Polaris Key Sparkle: codesign/codesign was Disabled; exporting with the built-in ad-hoc signature instead (Sparkle rejects updates to an unsigned export).")
	var v := _values(platform)
	for problem in v["problems"]:
		push_warning("Polaris Key build stamp: %s" % problem)
	var defaults := S.editor_defaults()
	var stamp := S.build({
		"product": defaults["product"],
		"version": _version(),
		"build": v["build"],
		"outlet": v["outlet"],
		"outlet_kind": v["outlet_kind"],
		"outlet_subkind": v["outlet_subkind"],
		"format": v["format"],
		"channel": v["channel"],
		"platform": platform,
		"arch": S.arch_for(platform, features),
		"debug": is_debug,
		"outlet_ids": v["outlet_ids"],
	})
	add_file(S.PATH, S.encode(stamp), false)
	if platform == "ios":
		_export_apple(v)


## The iOS switches (PKeyAppleExport): the Background Assets mark in the Info.plist, and the
## warnings a headless log shows.
func _export_apple(v: Dictionary) -> void:
	var mode := str(_get_or_env(Apple.OPTION, Apple.ENV, "auto"))
	var kind := _outlet_kind(v)
	for w in [Apple.mode_warning(mode, kind), Apple.min_ios_warning(_preset_string("application/min_ios_version"))]:
		if w != "":
			push_warning("Polaris Key Apple plugin: %s" % w)
	var on := Apple.enabled(mode, kind)
	var bundle_id := _preset_bundle_id()
	if on and bundle_id == "":
		push_warning("Polaris Key Apple plugin: no application/bundle_identifier, so no App Group can be named; Background Assets is left off.")
		on = false
	var content := Apple.plist_content(on, bundle_id)
	if has_method("add_apple_embedded_platform_plist_content"):
		call("add_apple_embedded_platform_plist_content", content)
	else:
		call("add_ios_plist_content", content)


## The outlet kind this export stamps: the explicit kind, else the outlet when it is one.
static func _outlet_kind(v: Dictionary) -> String:
	var kind := str(v.get("outlet_kind", ""))
	return kind if kind != "" else str(v.get("outlet", ""))


func _preset_string(key: String) -> String:
	var preset := get_export_preset()
	if preset == null or not preset.has(key):
		return ""
	return str(preset.get(key))


func _export_end() -> void:
	if _export_windows_store:
		_export_windows_store = false
		var failed := PackedStringArray()
		var dir := _export_path.get_base_dir()
		N.strip_store_updaters(ProjectSettings.globalize_path(dir) if dir.begins_with("res://") else dir, failed)
		if not failed.is_empty():
			push_warning("Polaris Key: could not remove %s from the Microsoft Store export; a Store build must ship no updater but StoreContext." % ", ".join(failed))
	if not _export_macos:
		return
	_export_macos = false
	var path := _export_path
	if not path.ends_with(".app"):
		push_warning("Polaris Key Sparkle: %s is not a .app, so Sparkle's helpers keep the non-executable mode Godot's copy gave them. Export the .app and package it with sdks/godot/native/macos/sign_and_notarize.sh." % path)
		return
	var failed := N.restore_executable_bits(ProjectSettings.globalize_path(path) if path.begins_with("res://") else path)
	if not failed.is_empty():
		push_warning("Polaris Key Sparkle: could not chmod 0755 %s (is Sparkle.framework listed in pkey_sparkle.gdextension's [dependencies]?)." % ", ".join(failed))


## The effective values for this export (environment over preset), and every problem with them.
## {outlet, outlet_kind, outlet_subkind, format, channel, build, outlet_ids, problems}.
func _values(platform: String) -> Dictionary:
	var problems: Array[String] = []
	var version := _version()
	var outlet := str(_get_or_env(S.OPTION_OUTLET, S.ENV_OUTLET, S.default_outlet(platform))).strip_edges()
	if outlet == "":
		outlet = S.default_outlet(platform)
	var w := S.outlet_warning(outlet)
	if w != "":
		problems.append("%s%s" % [w, _from_env(S.ENV_OUTLET)])
	var kind := str(_get_or_env(S.OPTION_OUTLET_KIND, S.ENV_OUTLET_KIND, "")).strip_edges()
	w = S.outlet_kind_warning(outlet, kind)
	if w != "":
		problems.append("%s%s" % [w, _from_env(S.ENV_OUTLET_KIND)])
	var subkind := str(_get_or_env(S.OPTION_OUTLET_SUBKIND, S.ENV_OUTLET_SUBKIND, "")).strip_edges()
	w = S.outlet_subkind_warning(subkind)
	if w != "":
		problems.append("%s%s" % [w, _from_env(S.ENV_OUTLET_SUBKIND)])
	var format := str(_get_or_env(S.OPTION_FORMAT, S.ENV_FORMAT, "")).strip_edges()
	var raw_channel := str(_get_or_env(S.OPTION_CHANNEL, S.ENV_CHANNEL, S.DEFAULT_CHANNEL)).strip_edges()
	var channel = S.canonical_channel(raw_channel, version)
	w = S.channel_warning(raw_channel, version)
	if w != "":
		problems.append("%s%s" % [w, _from_env(S.ENV_CHANNEL)])
	if channel == null:
		# Stamped as given: PolarisKey.configure() refuses a malformed stamped channel.
		channel = raw_channel
	var b: Dictionary = S.parse_build_number(_get_or_env(S.OPTION_BUILD_NUMBER, S.ENV_BUILD_NUMBER, 0))
	if b["problem"] != "":
		problems.append("%s%s" % [b["problem"], _from_env(S.ENV_BUILD_NUMBER)])
	w = S.version_warning(version)
	if w != "":
		problems.append(w)
	var ids: Dictionary = S.parse_outlet_ids(_get_or_env(S.OPTION_OUTLET_IDS, S.ENV_OUTLET_IDS, ""))
	var source := " (from the environment variable %s)" % S.ENV_OUTLET_IDS if OS.get_environment(S.ENV_OUTLET_IDS) != "" else " (from the export option %s)" % S.OPTION_OUTLET_IDS
	for p in ids["problems"]:
		problems.append("outlet_ids %s%s; left out of the stamp" % [p, source])
	var merged: Dictionary = S.merge_bundle_id(ids["ids"], _preset_bundle_id())
	for p in merged["problems"]:
		problems.append(p)
	return {"outlet": outlet, "outlet_kind": kind, "outlet_subkind": subkind, "format": format, "channel": channel, "build": b["value"], "outlet_ids": merged["ids"], "problems": problems}


func _get_or_env(option: String, env: String, default: Variant) -> Variant:
	var preset := get_export_preset()
	if preset == null:
		var e := OS.get_environment(env)
		return e if e != "" else default
	var v = preset.get_or_env(option, env)
	return v if v != null else default


static func _join(lines: Array) -> String:
	var out := PackedStringArray()
	for l in lines:
		if str(l) != "":
			out.append(str(l))
	return "\n".join(out)


static func _from_env(env: String) -> String:
	return " (from the environment variable %s)" % env if OS.get_environment(env) != "" else ""


func _version() -> String:
	return str(ProjectSettings.get_setting("application/config/version", ""))


func _preset_bundle_id() -> String:
	var preset := get_export_preset()
	var platform := get_export_platform()
	if preset == null or platform == null:
		return ""
	var key: String = S.BUNDLE_ID_OPTIONS.get(S.platform_for(platform.get_os_name(), PackedStringArray()), "")
	if key == "" or not preset.has(key):
		return ""
	return S.resolve_bundle_id(str(preset.get(key)).strip_edges())
