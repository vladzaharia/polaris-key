extends RefCounted
# GENERATED FILE — do not edit by hand. Source: conformance/parity/api.json; regenerate with `pnpm gen api`.
# The api_surface suite (SP-35.3): every api.json row the Godot SDK ships exists under its own name,
# checked on the scripts (methods, properties, signals), and every `removed` name is gone.

const SDK := preload("res://addons/polaris_key/polaris_key.gd")

## [concept, script, kind, name]
const ROWS := [
	["client.create", SDK, "method", "configure"],
	["client.boot", SDK, "method", "boot"],
	["options.productSlug", "res://addons/polaris_key/core/options.gd", "property", "product"],
	["options.pinnedKeys", "res://addons/polaris_key/core/options.gd", "property", "pinned_trust_keys"],
	["options.pinnedReleaseKeys", "res://addons/polaris_key/core/options.gd", "property", "pinned_release_keys"],
	["options.baseUrl", "res://addons/polaris_key/core/options.gd", "property", "base_url"],
	["options.expectedServices", "res://addons/polaris_key/core/options.gd", "property", "expected_services"],
	["config.get", "res://addons/polaris_key/services/config.gd", "method", "get_value"],
	["config.getConfigSource", "res://addons/polaris_key/services/config.gd", "method", "get_source"],
	["config.getSecret", "res://addons/polaris_key/services/config.gd", "method", "get_secret"],
	["config.mintToken", "res://addons/polaris_key/services/config.gd", "method", "mint_token"],
	["config.set", "res://addons/polaris_key/services/config.gd", "method", "set_value"],
	["config.clear", "res://addons/polaris_key/services/config.gd", "method", "clear"],
	["config.clearAll", "res://addons/polaris_key/services/config.gd", "method", "clear_all"],
	["config.onConfigChange", "res://addons/polaris_key/services/config.gd", "signal", "config_changed"],
	["config.setting", "res://addons/polaris_key/services/config.gd", "method", "setting"],
	["config.setting.value", "res://addons/polaris_key/services/config/setting.gd", "property", "value"],
	["config.setting.source", "res://addons/polaris_key/services/config/setting.gd", "property", "source"],
	["config.setting.locked", "res://addons/polaris_key/services/config/setting.gd", "property", "locked"],
	["config.setting.set", "res://addons/polaris_key/services/config/setting.gd", "method", "set_value"],
	["config.setting.clear", "res://addons/polaris_key/services/config/setting.gd", "method", "clear"],
	["config.setting.on", "res://addons/polaris_key/services/config/setting.gd", "signal", "changed"],
	["license.activateWithKey", "res://addons/polaris_key/services/license.gd", "method", "activate_with_key"],
	["entitlements.has", "res://addons/polaris_key/services/license.gd", "method", "is_entitled"],
	["entitlements.all", "res://addons/polaris_key/services/license.gd", "method", "get_entitlements"],
	["identity.signOut", "res://addons/polaris_key/services/identity.gd", "method", "sign_out"],
]

## [concept, script, name]
const REMOVED := [

]


func _names(script: Script, kind: String) -> PackedStringArray:
	var list: Array[Dictionary]
	match kind:
		"method":
			list = script.get_script_method_list()
		"signal":
			list = script.get_script_signal_list()
		_:
			list = script.get_script_property_list()
	var out := PackedStringArray()
	for d in list:
		out.append(String(d["name"]))
	return out


func run(t: PKeyTestContext, _args: PackedStringArray) -> bool:
	for row in ROWS:
		var script: Script = load(row[1]) if row[1] is String else row[1]
		t.check("%s: %s %s" % [row[0], row[2], row[3]], script != null and _names(script, row[2]).has(row[3]), str(row[1]))
	for row in REMOVED:
		var script: Script = load(row[1]) if row[1] is String else row[1]
		var present := false
		for kind in ["method", "signal", "property"]:
			present = present or _names(script, kind).has(row[2])
		t.check("removed: %s" % row[0], not present, str(row[1]))
	return true
